/**
 * Unified image tool — analyze, generate, and send images.
 * Merges former analyze_image, image_generate, and image_send tools.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { Tool } from '../tool-registry.js';

let apiBase = 'http://localhost:4141/v1';
let defaultModel = 'claude-opus-4.6';
let apiKeyRef: string | undefined;
let broadcastImageFn: ((event: ImageEvent) => void) | null = null;

export interface ImageEvent {
  type: 'image';
  sessionId: string;
  url?: string;
  base64?: string;
  mimeType: string;
  alt?: string;
  filename?: string;
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'image/png';
}

function isUrl(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://');
}

export function setImageConfig(base: string, model: string, apiKey?: string): void {
  apiBase = base;
  defaultModel = model;
  apiKeyRef = apiKey;
}

export function setImageBroadcaster(fn: (event: ImageEvent) => void): void {
  broadcastImageFn = fn;
}

export const imageTools: Tool[] = [
  {
    name: 'image',
    description: [
      'Image operations: analyze, generate, send.',
      'Actions: analyze, generate, send.',
      'analyze — analyze an image using a vision model (OCR, describe, answer questions). Supports files and URLs.',
      'generate — generate an image via AI (DALL-E compatible API). Broadcasts to connected clients.',
      'send — send an existing image (by URL or file path) to the current chat.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: analyze|generate|send',
        },
        // For analyze
        image: { type: 'string', description: 'File path or URL of the image (for analyze)' },
        question: { type: 'string', description: 'Question to ask about the image (for analyze, default: "Describe this image in detail.")' },
        model: { type: 'string', description: 'Vision/generation model to use' },
        // For generate
        prompt: { type: 'string', description: 'Text description of image to generate (for generate)' },
        size: { type: 'string', description: 'Image size (for generate, default "1024x1024")', enum: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'] },
        quality: { type: 'string', description: 'Quality level (for generate, default "standard")', enum: ['standard', 'hd'] },
        save_path: { type: 'string', description: 'Local path to save image (for generate)' },
        // For send
        url: { type: 'string', description: 'URL of image to send (for send)' },
        file_path: { type: 'string', description: 'Local file path of image to send (for send)' },
        alt: { type: 'string', description: 'Alt text / description (for send)' },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      const action = params.action as string;

      switch (action) {
        case 'analyze': {
          const image = params.image as string;
          if (!image) return { output: '', error: 'image (file path or URL) is required for analyze' };
          const question = (params.question as string) || 'Describe this image in detail.';
          const model = (params.model as string) || process.env.AUTOMATE_VISION_MODEL || defaultModel;

          let imageUrl: string;
          if (isUrl(image)) {
            imageUrl = image;
          } else {
            const filePath = resolve(ctx.workdir, image);
            if (!existsSync(filePath)) return { output: '', error: `Image file not found: ${filePath}` };
            try {
              const data = readFileSync(filePath).toString('base64');
              const mime = getMimeType(filePath);
              imageUrl = `data:${mime};base64,${data}`;
            } catch (err) {
              return { output: '', error: `Failed to read image file: ${err}` };
            }
          }

          const endpoint = `${process.env.AUTOMATE_API_BASE || apiBase}/chat/completions`;
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                max_tokens: 2048,
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'text', text: question },
                    { type: 'image_url', image_url: { url: imageUrl } },
                  ],
                }],
              }),
            });

            if (!response.ok) {
              const text = await response.text();
              return { output: '', error: `API error ${response.status}: ${text}` };
            }

            const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
            const content = json.choices?.[0]?.message?.content;
            if (!content) return { output: '', error: 'No content in API response' };
            return { output: content };
          } catch (err) {
            return { output: '', error: `Vision API request failed: ${err}` };
          }
        }

        case 'generate': {
          if (!apiBase) return { output: '', error: 'Image API not configured' };
          const prompt = params.prompt as string;
          if (!prompt) return { output: '', error: 'prompt is required for generate' };
          const size = (params.size as string) || '1024x1024';
          const model = (params.model as string) || 'dall-e-3';
          const quality = (params.quality as string) || 'standard';
          const savePath = params.save_path as string | undefined;

          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (apiKeyRef) headers['Authorization'] = `Bearer ${apiKeyRef}`;

          try {
            const res = await fetch(`${apiBase}/images/generations`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                model, prompt, n: 1, size, quality,
                response_format: savePath ? 'b64_json' : 'url',
              }),
              signal: AbortSignal.timeout(120000),
            });

            if (!res.ok) {
              const text = await res.text();
              return { output: '', error: `Image generation failed (${res.status}): ${text}` };
            }

            const json = await res.json() as any;
            const imageData = json.data?.[0];
            if (!imageData) return { output: '', error: 'No image data returned from API' };

            if (savePath && imageData.b64_json) {
              const dir = savePath.substring(0, savePath.lastIndexOf('/'));
              if (dir) mkdirSync(dir, { recursive: true });
              writeFileSync(savePath, Buffer.from(imageData.b64_json, 'base64'));
            }

            if (broadcastImageFn) {
              broadcastImageFn({
                type: 'image', sessionId: ctx.sessionId,
                url: imageData.url, base64: imageData.b64_json,
                mimeType: 'image/png', alt: prompt,
                filename: savePath ? savePath.split('/').pop() : undefined,
              });
            }

            const output = imageData.url
              ? `Image generated: ${imageData.url}\nRevised prompt: ${imageData.revised_prompt || prompt}`
              : `Image generated and saved to ${savePath}\nRevised prompt: ${imageData.revised_prompt || prompt}`;
            return { output };
          } catch (err) {
            return { output: '', error: `Image generation failed: ${(err as Error).message}` };
          }
        }

        case 'send': {
          const url = params.url as string | undefined;
          const filePath = params.file_path as string | undefined;
          const alt = (params.alt as string) || '';

          if (!url && !filePath) return { output: '', error: 'Provide either url or file_path for send' };

          let base64: string | undefined;
          let mimeType = 'image/png';
          let filename: string | undefined;

          if (filePath) {
            if (!existsSync(filePath)) return { output: '', error: `File not found: ${filePath}` };
            const data = readFileSync(filePath);
            base64 = data.toString('base64');
            filename = filePath.split('/').pop();
            const ext = extname(filePath).toLowerCase();
            mimeType = MIME_TYPES[ext.replace('.', '')] || 'image/png';
          }

          if (broadcastImageFn) {
            broadcastImageFn({
              type: 'image', sessionId: ctx.sessionId,
              url, base64, mimeType, alt, filename,
            });
          }

          return { output: `Image sent: ${url || filePath}${alt ? ` — "${alt}"` : ''}` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: analyze, generate, send` };
      }
    },
  },
];
