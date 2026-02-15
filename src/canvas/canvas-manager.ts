import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { Tool } from '../agent/tool-registry.js';

/**
 * Canvas (A2UI) - Unified agent-driven visual workspace tool.
 * Supports persistence, image uploads, file serving, and full service access.
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

// ── Core service refs (same shape as plugin services) ────────────────────
export interface CanvasServices {
  memory?: any;
  sessions?: any;
  scheduler?: any;
  agent?: any;
  sendToSession?: (sessionId: string, payload: Record<string, unknown>) => void;
  broadcastToAll?: (payload: Record<string, unknown>) => void;
}

const canvases: Map<string, CanvasState> = new Map();
let broadcaster: CanvasBroadcaster | null = null;
let persistPath: string | null = null;
let uploadDir: string | null = null;
let coreServices: CanvasServices = {};

export function setCanvasBroadcaster(fn: CanvasBroadcaster): void {
  broadcaster = fn;
}

/** Set the file path for canvas persistence and load existing data */
export function setCanvasPersistPath(path: string): void {
  persistPath = path;
  loadCanvases();
}

/** Set the uploads directory (usually ~/.automate/uploads) */
export function setCanvasUploadDir(dir: string): void {
  uploadDir = dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Inject core services (memory, sessions, scheduler, agent, broadcast fns) */
export function setCanvasServices(services: CanvasServices): void {
  coreServices = { ...coreServices, ...services };
}

/** Save all canvases to disk */
function saveCanvases(): void {
  if (!persistPath) return;
  try {
    const data: Record<string, CanvasState> = {};
    for (const [id, canvas] of canvases) {
      if (canvas.content) {
        data[id] = canvas;
      }
    }
    writeFileSync(persistPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Persistence errors are non-fatal
  }
}

/** Load canvases from disk */
function loadCanvases(): void {
  if (!persistPath || !existsSync(persistPath)) return;
  try {
    const data = readFileSync(persistPath, 'utf-8');
    const parsed = JSON.parse(data) as Record<string, CanvasState>;
    for (const [id, canvas] of Object.entries(parsed)) {
      canvases.set(id, canvas);
    }
  } catch {
    // Load errors are non-fatal
  }
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

// ── Upload helpers ──────────────────────────────────────────────────────

function getUploadDir(): string {
  if (!uploadDir) {
    // Fallback: derive from persistPath
    const dir = persistPath ? join(persistPath, '..', 'uploads') : '/tmp/automate-uploads';
    uploadDir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return uploadDir;
}

/** Copy a local file to uploads and return { filename, url } */
function uploadLocalFile(filePath: string): { filename: string; url: string; size: number } {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const dir = getUploadDir();
  const ext = extname(filePath);
  const base = basename(filePath, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${Date.now()}-${base}${ext}`;
  const dest = join(dir, filename);
  copyFileSync(filePath, dest);
  const size = statSync(dest).size;
  return { filename, url: `/api/uploads/${filename}`, size };
}

/** List all uploaded files */
function listUploads(): { filename: string; url: string; size: number; modified: string }[] {
  const dir = getUploadDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(f => {
      const fp = join(dir, f);
      try {
        const st = statSync(fp);
        if (!st.isFile()) return null;
        return { filename: f, url: `/api/uploads/${f}`, size: st.size, modified: st.mtime.toISOString() };
      } catch { return null; }
    })
    .filter(Boolean) as any[];
}

/** Delete an uploaded file */
function deleteUpload(filename: string): boolean {
  const dir = getUploadDir();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const fp = join(dir, safe);
  if (!existsSync(fp)) return false;
  try { unlinkSync(fp); return true; } catch { return false; }
}

// ── Tool definition ─────────────────────────────────────────────────────

export const canvasTools: Tool[] = [
  {
    name: 'canvas',
    description: [
      'Visual Canvas workspace for displaying rich content to connected clients.',
      'Actions: push, reset, snapshot, upload, uploads, delete_upload, send_image, broadcast, services.',
      'push — push HTML/Markdown/JSON/code/text content to the canvas (rendered in real-time). Use mode=append (default) to add to existing content, or mode=overwrite to replace it.',
      'reset — clear the canvas.',
      'snapshot — get the current canvas state and content.',
      'upload — upload a local file (by path) to make it serveable via URL. Returns the URL. Great for screenshots, captchas, etc.',
      'uploads — list all uploaded files with URLs and sizes.',
      'delete_upload — delete an uploaded file by filename.',
      'send_image — upload a local image and push it to the canvas as HTML (one step). Params: file_path, title, width (optional).',
      'broadcast — send a raw event to all connected clients (same as plugin broadcastToAll).',
      'services — check which core services are available (memory, sessions, agent, etc.).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: push|reset|snapshot|upload|uploads|delete_upload|send_image|broadcast|services',
        },
        title: { type: 'string', description: 'Title for the canvas content (for push, send_image)' },
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
        file_path: { type: 'string', description: 'Local file path (for upload, send_image)' },
        filename: { type: 'string', description: 'Filename to delete (for delete_upload)' },
        width: { type: 'string', description: 'Image display width, e.g. "100%", "500px" (for send_image, default: 100%)' },
        event_type: { type: 'string', description: 'Event type string (for broadcast)' },
        event_data: { type: 'object', description: 'Event data payload (for broadcast)' },
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

          saveCanvases();

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

          saveCanvases();

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

        // ── Upload a local file to make it serveable ──────────────────
        case 'upload': {
          const filePath = params.file_path as string;
          if (!filePath) return { output: '', error: 'file_path is required for upload' };
          try {
            const result = uploadLocalFile(filePath);
            return {
              output: `File uploaded!\n  Filename: ${result.filename}\n  URL: ${result.url}\n  Size: ${(result.size / 1024).toFixed(1)} KB\n\nUse this URL in HTML: <img src="${result.url}">`,
            };
          } catch (err) {
            return { output: '', error: (err as Error).message };
          }
        }

        // ── List all uploads ──────────────────────────────────────────
        case 'uploads': {
          const files = listUploads();
          if (files.length === 0) return { output: 'No uploaded files.' };
          const lines = files.map(f =>
            `  ${f.filename} — ${(f.size / 1024).toFixed(1)} KB — ${f.url}`
          );
          return { output: `Uploads (${files.length}):\n${lines.join('\n')}` };
        }

        // ── Delete an upload ──────────────────────────────────────────
        case 'delete_upload': {
          const filename = params.filename as string;
          if (!filename) return { output: '', error: 'filename is required for delete_upload' };
          const ok = deleteUpload(filename);
          return { output: ok ? `Deleted: ${filename}` : `File not found: ${filename}` };
        }

        // ── Upload + push as image in one step ────────────────────────
        case 'send_image': {
          const filePath = params.file_path as string;
          if (!filePath) return { output: '', error: 'file_path is required for send_image' };
          try {
            const result = uploadLocalFile(filePath);
            const title = (params.title as string) || 'Image';
            const width = (params.width as string) || '100%';
            const htmlContent = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; padding: 16px; background: #111; display: flex; flex-direction: column; align-items: center; font-family: sans-serif; }
  img { max-width: ${width}; height: auto; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
  .title { color: #ccc; font-size: 14px; margin-bottom: 12px; }
  .meta { color: #666; font-size: 11px; margin-top: 8px; }
</style></head><body>
  <div class="title">${title}</div>
  <img src="${result.url}" alt="${title}" />
  <div class="meta">${result.filename} · ${(result.size / 1024).toFixed(1)} KB</div>
</body></html>`;

            const canvas = getOrCreateCanvas(ctx.sessionId);
            if (canvas.content) {
              canvas.history.push({ content: canvas.content, timestamp: canvas.updatedAt });
              if (canvas.history.length > 20) canvas.history = canvas.history.slice(-20);
            }
            canvas.title = title;
            canvas.content = htmlContent;
            canvas.contentType = 'html';
            canvas.language = undefined;
            canvas.updatedAt = new Date().toISOString();

            broadcast({
              type: 'canvas_push',
              canvas: { id: canvas.id, title, content: htmlContent, contentType: 'html' },
            });
            saveCanvases();

            return {
              output: `Image pushed to canvas!\n  Title: ${title}\n  URL: ${result.url}\n  Size: ${(result.size / 1024).toFixed(1)} KB`,
            };
          } catch (err) {
            return { output: '', error: (err as Error).message };
          }
        }

        // ── Broadcast raw event (same as plugin broadcastToAll) ───────
        case 'broadcast': {
          if (!coreServices.broadcastToAll) return { output: '', error: 'broadcastToAll service not available. Gateway not wired.' };
          const eventType = (params.event_type as string) || 'canvas_custom';
          const eventData = (params.event_data as Record<string, unknown>) || {};
          coreServices.broadcastToAll({ type: eventType, ...eventData });
          return { output: `Broadcast sent: ${eventType}` };
        }

        // ── Check available services ──────────────────────────────────
        case 'services': {
          const available = Object.entries(coreServices)
            .filter(([_, v]) => v != null)
            .map(([k]) => k);
          return { output: `Available services: ${available.join(', ') || 'none'}` };
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: push, reset, snapshot, upload, uploads, delete_upload, send_image, broadcast, services` };
      }
    },
  },
];
