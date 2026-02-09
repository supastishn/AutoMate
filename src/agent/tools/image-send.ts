/**
 * Image tools — generate images via API and send them across channels.
 * Supports: image generation (DALL-E compatible API), image sending to
 * Discord and WebSocket clients, and image from URL/file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Tool } from '../tool-registry.js';

// Will be set by the agent during init
let apiBaseRef: string = '';
let apiKeyRef: string | undefined;
let broadcastImageFn: ((event: ImageEvent) => void) | null = null;

export interface ImageEvent {
  type: 'image';
  sessionId: string;
  url?: string;         // URL to image
  base64?: string;      // base64-encoded image data
  mimeType: string;     // image/png, image/jpeg, etc.
  alt?: string;         // description/alt text
  filename?: string;    // original filename
}

export function setImageSendConfig(apiBase: string, apiKey?: string): void {
  apiBaseRef = apiBase;
  apiKeyRef = apiKey;
}

export function setImageBroadcaster(fn: (event: ImageEvent) => void): void {
  broadcastImageFn = fn;
}

export const imageGenerateTool: Tool = {
  name: 'image_generate',
  description: 'Generate an image using an AI image generation API (DALL-E compatible). Returns the image URL or base64 data. The image is also broadcast to connected clients.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image to generate' },
      size: {
        type: 'string',
        description: 'Image size (default "1024x1024")',
        enum: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'],
      },
      model: { type: 'string', description: 'Model to use (default "dall-e-3")' },
      quality: { type: 'string', description: 'Quality level (default "standard")', enum: ['standard', 'hd'] },
      save_path: { type: 'string', description: 'Optional local path to save the image' },
    },
    required: ['prompt'],
  },
  async execute(params, ctx) {
    if (!apiBaseRef) return { output: '', error: 'Image API not configured' };

    const prompt = params.prompt as string;
    const size = (params.size as string) || '1024x1024';
    const model = (params.model as string) || 'dall-e-3';
    const quality = (params.quality as string) || 'standard';
    const savePath = params.save_path as string | undefined;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKeyRef) headers['Authorization'] = `Bearer ${apiKeyRef}`;

    try {
      const res = await fetch(`${apiBaseRef}/images/generations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size,
          quality,
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

      if (!imageData) {
        return { output: '', error: 'No image data returned from API' };
      }

      // Save to file if requested
      if (savePath && imageData.b64_json) {
        const dir = savePath.substring(0, savePath.lastIndexOf('/'));
        if (dir) mkdirSync(dir, { recursive: true });
        writeFileSync(savePath, Buffer.from(imageData.b64_json, 'base64'));
      }

      // Broadcast to connected clients
      if (broadcastImageFn) {
        broadcastImageFn({
          type: 'image',
          sessionId: ctx.sessionId,
          url: imageData.url,
          base64: imageData.b64_json,
          mimeType: 'image/png',
          alt: prompt,
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
  },
};

export const imageSendTool: Tool = {
  name: 'image_send',
  description: 'Send an image to the current chat. Supports sending by URL or local file path. The image is broadcast to all connected WebSocket/Discord clients.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL of the image to send' },
      file_path: { type: 'string', description: 'Local file path of the image to send (alternative to URL)' },
      alt: { type: 'string', description: 'Alt text / description for the image' },
    },
  },
  async execute(params, ctx) {
    const url = params.url as string | undefined;
    const filePath = params.file_path as string | undefined;
    const alt = (params.alt as string) || '';

    if (!url && !filePath) {
      return { output: '', error: 'Provide either url or file_path' };
    }

    let base64: string | undefined;
    let mimeType = 'image/png';
    let filename: string | undefined;

    if (filePath) {
      if (!existsSync(filePath)) {
        return { output: '', error: `File not found: ${filePath}` };
      }
      const data = readFileSync(filePath);
      base64 = data.toString('base64');
      filename = filePath.split('/').pop();

      const ext = extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
      };
      mimeType = mimeMap[ext] || 'image/png';
    }

    if (broadcastImageFn) {
      broadcastImageFn({
        type: 'image',
        sessionId: ctx.sessionId,
        url,
        base64,
        mimeType,
        alt,
        filename,
      });
    }

    return { output: `Image sent: ${url || filePath}${alt ? ` — "${alt}"` : ''}` };
  },
};

export const imageSendingTools = [imageGenerateTool, imageSendTool];
