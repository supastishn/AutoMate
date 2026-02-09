import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from '../tool-registry.js';

let apiBase = 'http://localhost:4141/v1';
let defaultModel = 'claude-opus-4.6';

export function setImageConfig(base: string, model: string): void {
  apiBase = base;
  defaultModel = model;
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'image/png';
}

function isUrl(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://');
}

const analyzeImageTool: Tool = {
  name: 'analyze_image',
  description:
    'Analyze an image using a vision-capable model. Can describe contents, read text (OCR), answer questions about images. Supports local file paths and URLs.',
  parameters: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: 'File path or URL of the image',
      },
      question: {
        type: 'string',
        description: 'Question to ask about the image',
        default: 'Describe this image in detail.',
      },
      model: {
        type: 'string',
        description: "Vision model to use (defaults to agent's model)",
      },
    },
    required: ['image'],
  },
  async execute(params, ctx) {
    const image = params.image as string;
    const question = (params.question as string) || 'Describe this image in detail.';
    const model =
      (params.model as string) ||
      process.env.AUTOMATE_VISION_MODEL ||
      defaultModel;

    let imageUrl: string;

    if (isUrl(image)) {
      imageUrl = image;
    } else {
      const filePath = resolve(ctx.workdir, image);
      if (!existsSync(filePath)) {
        return { output: '', error: `Image file not found: ${filePath}` };
      }
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
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: question },
                {
                  type: 'image_url',
                  image_url: { url: imageUrl },
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { output: '', error: `API error ${response.status}: ${text}` };
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };

      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        return { output: '', error: 'No content in API response' };
      }

      return { output: content };
    } catch (err) {
      return { output: '', error: `Vision API request failed: ${err}` };
    }
  },
};

export const imageTools: Tool[] = [analyzeImageTool];
