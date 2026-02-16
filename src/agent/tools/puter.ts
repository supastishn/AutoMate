/**
 * Puter.js AI tool — chat and image generation via Puter's free AI services.
 * Uses @heyputer/puter.js Node.js SDK.
 */

import { init } from '@heyputer/puter.js/src/init.cjs';
import type { Tool } from '../tool-registry.js';

let puter: any = null;
let apiToken: string | undefined;
let defaultModel = 'claude';

function getPuter(): any {
  if (!puter) {
    if (!apiToken) {
      throw new Error('Puter.js auth token not configured. Set config.puter.authToken or environment variable puterAuthToken');
    }
    puter = init(apiToken);
  }
  return puter;
}

export function setPuterConfig(token?: string, model?: string): void {
  apiToken = token;
  if (model) defaultModel = model;
}

export const puterTools: Tool[] = [
  {
    name: 'puter',
    description: [
      'AI services via Puter.js: chat with multiple models, generate images.',
      'Actions: chat, txt2img.',
      'chat — Send a message to an AI model (Claude, Gemini, GPT, etc.). Supports streaming.',
      'txt2img — Generate an image from text description. Returns an HTML <img> element.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: chat|txt2img',
        },
        // For chat
        message: { type: 'string', description: 'User message (for chat)' },
        model: { type: 'string', description: 'Model to use (for chat, e.g. "claude", "gemini-2.0-flash")' },
        stream: { type: 'boolean', description: 'Stream response (for chat, default false)' },
        // For txt2img
        prompt: { type: 'string', description: 'Text description of image to generate (for txt2img)' },
        quality: { type: 'string', description: 'Quality level (for txt2img: "low", "medium", "high", default "medium")' },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      const action = params.action as string;
      // Config is set via setPuterConfig, using module-level variables

      try {
        const puter = getPuter();
      } catch (err: any) {
        return { output: '', error: err.message };
      }

      switch (action) {
        case 'chat': {
          const message = params.message as string;
          if (!message) return { output: '', error: 'message is required for chat' };
          const model = (params.model as string) || defaultModel;
          const stream = (params.stream as boolean) || false;

          try {
            if (stream) {
              const response = await puter.ai.chat(message, { model, stream: false });
              return { output: response?.text || '' };
            } else {
              const response = await puter.ai.chat(message, { model, stream: false });
              return { output: response?.text || '' };
            }
          } catch (err: any) {
            return { output: '', error: `Puter.ai.chat failed: ${err.message}` };
          }
        }

        case 'txt2img': {
          const prompt = params.prompt as string;
          if (!prompt) return { output: '', error: 'prompt is required for txt2img' };
          const quality = (params.quality as string) || 'medium';
          const model = (params.model as string) || 'gpt-image-1';

          try {
            const image = await puter.ai.txt2img(prompt, { model, quality });
            let result = `Image generated: ${prompt}\n`;
            if (image.src) {
              result += `Image URL: ${image.src}\n`;
            }
            result += 'The image element has been returned in the response.';
            return { output: result };
          } catch (err: any) {
            return { output: '', error: `Puter.ai.txt2img failed: ${err.message}` };
          }
        }

        default:
          return { output: '', error: `Unknown action "${action}". Valid: chat, txt2img` };
      }
    },
  },
];
