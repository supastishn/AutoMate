import type { Tool } from '../agent/tool-registry.js';

/**
 * Canvas (A2UI) - Agent-driven visual workspace
 * 
 * The agent can push HTML/Markdown/JSON content to connected Canvas clients
 * via WebSocket. Clients render the content in a visual workspace panel.
 * 
 * This is similar to OpenClaw's Live Canvas / A2UI feature.
 */

export interface CanvasState {
  id: string;
  title: string;
  content: string;
  contentType: 'html' | 'markdown' | 'json' | 'text' | 'code';
  language?: string;     // for code type: 'javascript', 'python', etc.
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

// Global state - each session can have one canvas
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
      id: sessionId,
      title: 'Canvas',
      content: '',
      contentType: 'markdown',
      updatedAt: new Date().toISOString(),
      history: [],
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

// --- Agent Tools ---

export const canvasTools: Tool[] = [
  {
    name: 'canvas_push',
    description: 'Push content to the visual Canvas workspace. Connected clients will render it in real-time. Use this to show HTML pages, markdown documents, code snippets, data visualizations, tables, or any visual content to the user.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title for the canvas content',
        },
        content: {
          type: 'string',
          description: 'The content to display. Can be HTML, Markdown, JSON, plain text, or code.',
        },
        content_type: {
          type: 'string',
          enum: ['html', 'markdown', 'json', 'text', 'code'],
          description: 'The type of content being pushed. Default: markdown',
        },
        language: {
          type: 'string',
          description: 'For code content_type: the programming language (e.g. javascript, python, typescript)',
        },
      },
      required: ['content'],
    },
    async execute(params, ctx) {
      const canvas = getOrCreateCanvas(ctx.sessionId);
      const title = (params.title as string) || canvas.title;
      const content = params.content as string;
      const contentType = (params.content_type as string) || 'markdown';
      const language = params.language as string | undefined;

      // Save to history
      if (canvas.content) {
        canvas.history.push({
          content: canvas.content,
          timestamp: canvas.updatedAt,
        });
        // Keep last 20 history entries
        if (canvas.history.length > 20) {
          canvas.history = canvas.history.slice(-20);
        }
      }

      canvas.title = title;
      canvas.content = content;
      canvas.contentType = contentType as any;
      canvas.language = language;
      canvas.updatedAt = new Date().toISOString();

      broadcast({
        type: 'canvas_push',
        canvas: { id: canvas.id, title, content, contentType, language },
      });

      return { output: `Canvas updated: "${title}" (${contentType}, ${content.length} chars)` };
    },
  },

  {
    name: 'canvas_reset',
    description: 'Clear the Canvas workspace, removing all content.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(_params, ctx) {
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
    },
  },

  {
    name: 'canvas_snapshot',
    description: 'Get the current state of the Canvas workspace, including content and history.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(_params, ctx) {
      const canvas = canvases.get(ctx.sessionId);
      if (!canvas || !canvas.content) {
        return { output: 'Canvas is empty.' };
      }

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
    },
  },
];
