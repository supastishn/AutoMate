import type { Tool } from '../agent/tool-registry.js';

/**
 * Canvas (A2UI) - Unified agent-driven visual workspace tool.
 */

export interface CanvasState {
  id: string;
  title: string;
  content: string;
  contentType: 'html' | 'markdown' | 'json' | 'text' | 'code';
  language?: string;
  updatedAt: string;
  history: { content: string; timestamp: string }[];
}

export type CanvasBroadcaster = (event: CanvasEvent) => void;

export interface CanvasEvent {
  type: 'canvas_push' | 'canvas_reset' | 'canvas_snapshot';
  canvas: {
    id: string;
    title: string;
    content: string;
    contentType: string;
    language?: string;
  };
}

const canvases: Map<string, CanvasState> = new Map();
let broadcaster: CanvasBroadcaster | null = null;

export function setCanvasBroadcaster(fn: CanvasBroadcaster): void {
  broadcaster = fn;
}

function broadcast(event: CanvasEvent): void {
  if (broadcaster) broadcaster(event);
}

function getOrCreateCanvas(sessionId: string): CanvasState {
  let canvas = canvases.get(sessionId);
  if (!canvas) {
    canvas = {
      id: sessionId, title: 'Canvas', content: '',
      contentType: 'markdown', updatedAt: new Date().toISOString(), history: [],
    };
    canvases.set(sessionId, canvas);
  }
  return canvas;
}

export function getCanvas(sessionId: string): CanvasState | undefined {
  return canvases.get(sessionId);
}

export function getAllCanvases(): CanvasState[] {
  return Array.from(canvases.values());
}

export const canvasTools: Tool[] = [
  {
    name: 'canvas',
    description: [
      'Visual Canvas workspace for displaying rich content to connected clients.',
      'Actions: push, reset, snapshot.',
      'push — push HTML/Markdown/JSON/code/text content to the canvas (rendered in real-time). Use mode=append (default) to add to existing content, or mode=overwrite to replace it.',
      'reset — clear the canvas.',
      'snapshot — get the current canvas state and content.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: push|reset|snapshot',
        },
        title: { type: 'string', description: 'Title for the canvas content (for push)' },
        content: { type: 'string', description: 'Content to display: HTML, Markdown, JSON, text, or code (for push)' },
        content_type: {
          type: 'string',
          enum: ['html', 'markdown', 'json', 'text', 'code'],
          description: 'Content type (for push, default: markdown)',
        },
        language: { type: 'string', description: 'Programming language for code content_type (for push)' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'Push mode: append adds to existing content (default), overwrite replaces content',
        },
      },
      required: ['action'],
    },
    async execute(params, ctx) {
      const action = params.action as string;

      switch (action) {
        case 'push': {
          const content = params.content as string;
          if (!content) return { output: '', error: 'content is required for push' };
          const canvas = getOrCreateCanvas(ctx.sessionId);
          const title = (params.title as string) || canvas.title;
          const contentType = (params.content_type as string) || 'markdown';
          const language = params.language as string | undefined;
          const mode = (params.mode as string) || 'append';

          if (canvas.content) {
            canvas.history.push({ content: canvas.content, timestamp: canvas.updatedAt });
            if (canvas.history.length > 20) canvas.history = canvas.history.slice(-20);
          }

          canvas.title = title;
          canvas.content = mode === 'append' ? canvas.content + content : content;
          canvas.contentType = contentType as any;
          canvas.language = language;
          canvas.updatedAt = new Date().toISOString();

          broadcast({
            type: 'canvas_push',
            canvas: { id: canvas.id, title, content: canvas.content, contentType, language },
          });

          const modeLabel = mode === 'append' ? 'appended' : 'updated';
          return { output: `Canvas ${modeLabel}: "${title}" (${contentType}, ${canvas.content.length} chars)` };
        }

        case 'reset': {
          const canvas = getOrCreateCanvas(ctx.sessionId);
          canvas.content = '';
          canvas.title = 'Canvas';
          canvas.contentType = 'markdown';
          canvas.language = undefined;
          canvas.updatedAt = new Date().toISOString();

          broadcast({
            type: 'canvas_reset',
            canvas: { id: canvas.id, title: 'Canvas', content: '', contentType: 'markdown' },
          });

          return { output: 'Canvas cleared.' };
        }

        case 'snapshot': {
          const canvas = canvases.get(ctx.sessionId);
          if (!canvas || !canvas.content) return { output: 'Canvas is empty.' };

          return {
            output: JSON.stringify({
              title: canvas.title,
              contentType: canvas.contentType,
              language: canvas.language,
              contentLength: canvas.content.length,
              content: canvas.content.slice(0, 2000),
              historyCount: canvas.history.length,
              updatedAt: canvas.updatedAt,
            }, null, 2),
          };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: push, reset, snapshot` };
      }
    },
  },
];
