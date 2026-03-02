import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { useColors } from '../ThemeContext'

interface CanvasData {
  id: string
  title: string
  content: string
  contentType: string
  language?: string
}

interface UploadResult {
  ok: boolean
  filename: string
  savedAs: string
  url: string
  path: string
  size: number
  mimetype: string
}

export default function Canvas() {
  const colors = useColors()
  const [canvases, setCanvases] = useState<CanvasData[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [connected, setConnected] = useState(false)
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadedImages, setUploadedImages] = useState<UploadResult[]>([])
  const [showUploads, setShowUploads] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    connect()
    return () => { wsRef.current?.close() }
  }, [])

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/canvas`)

    ws.onopen = () => setConnected(true)
    ws.onclose = () => { setConnected(false); setTimeout(connect, 3000) }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)

        if (msg.type === 'connected' && msg.canvases) {
          setCanvases(msg.canvases)
          if (msg.canvases.length > 0) setActiveIdx(0)
        }

        if (msg.type === 'canvas_push' && msg.canvas) {
          setCanvases(prev => {
            const idx = prev.findIndex(c => c.id === msg.canvas.id)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = msg.canvas
              return updated
            }
            return [...prev, msg.canvas]
          })
        }

        if (msg.type === 'canvas_reset' && msg.canvas) {
          setCanvases(prev => prev.filter(c => c.id !== msg.canvas.id))
        }

        if (msg.type === 'canvas_delete' && msg.canvas_id) {
          setCanvases(prev => {
            const filtered = prev.filter(c => c.id !== msg.canvas_id)
            // Adjust activeIdx if needed
            if (filtered.length === 0) {
              setActiveIdx(0)
            } else if (activeIdx >= filtered.length) {
              setActiveIdx(filtered.length - 1)
            }
            return filtered
          })
        }
      } catch {}
    }

    wsRef.current = ws
  }

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    const results: UploadResult[] = []

    for (const file of Array.from(files)) {
      const formData = new FormData()
      formData.append('file', file)
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData })
        const data = await res.json() as UploadResult
        if (data.ok) {
          results.push(data)
        }
      } catch (err) {
        console.error('Upload failed:', err)
      }
    }

    if (results.length > 0) {
      setUploadedImages(prev => [...results, ...prev])
      // If single image uploaded, push it to canvas as HTML immediately
      if (results.length === 1 && results[0].mimetype?.startsWith('image/')) {
        const r = results[0]
        const html = `<!DOCTYPE html>
<html><head><style>
  body { margin:0; padding:16px; background:#111; display:flex; flex-direction:column; align-items:center; font-family:sans-serif; }
  img { max-width:100%; height:auto; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5); }
  .title { color:#ccc; font-size:14px; margin-bottom:12px; }
  .meta { color:#666; font-size:11px; margin-top:8px; }
</style></head><body>
  <div class="title">${r.filename}</div>
  <img src="${r.url}" alt="${r.filename}" />
  <div class="meta">${r.savedAs} · ${(r.size / 1024).toFixed(1)} KB</div>
</body></html>`

        // Push via WS if connected
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'canvas_upload',
            title: r.filename,
            content: html,
            contentType: 'html',
            url: r.url,
          }))
        }

        // Also update local state directly for instant feedback
        setCanvases(prev => {
          const imgCanvas: CanvasData = {
            id: 'upload-' + Date.now(),
            title: r.filename,
            content: html,
            contentType: 'html',
          }
          return [...prev, imgCanvas]
        })
        setActiveIdx(canvases.length) // switch to the new one
      }
    }

    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  const canvas = canvases[activeIdx] || null

  const renderContent = () => {
    if (!canvas || !canvas.content) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: colors.textMuted }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>&#9634;</div>
            <div style={{ fontSize: 16 }}>Canvas is empty</div>
            <div style={{ fontSize: 13, marginTop: 8, color: colors.textMuted }}>
              Push content via the agent, or upload an image below
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                marginTop: 16, padding: '8px 20px', background: colors.accent, color: colors.accentContrast,
                border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}
            >
              📤 Upload Image
            </button>
          </div>
        </div>
      )
    }

    if (canvas.contentType === 'html') {
      return (
        <iframe
          key={canvas.id + '-' + canvas.content.length}
          srcDoc={canvas.content}
          style={{
            width: '100%', height: '100%', border: 'none',
            background: '#fff', borderRadius: 4,
          }}
          sandbox="allow-scripts"
          title={canvas.title}
        />
      )
    }

    if (canvas.contentType === 'code') {
      return (
        <div style={{ height: '100%', overflow: 'auto' }}>
          <div style={{ padding: '4px 12px', background: colors.bgTertiary, borderBottom: `1px solid ${colors.borderLight}`, fontSize: 11, color: colors.textSecondary }}>
            {canvas.language || 'code'}
          </div>
          <pre style={{
            margin: 0, padding: 16, fontSize: 13, lineHeight: 1.6,
            fontFamily: '"Fira Code", monospace', color: colors.textPrimary, whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {canvas.content}
          </pre>
        </div>
      )
    }

    if (canvas.contentType === 'json') {
      let formatted = canvas.content
      try { formatted = JSON.stringify(JSON.parse(canvas.content), null, 2) } catch {}
      return (
        <pre style={{
          margin: 0, padding: 16, fontSize: 13, lineHeight: 1.6,
          fontFamily: 'monospace', color: colors.syntaxString, whiteSpace: 'pre-wrap',
          overflow: 'auto', height: '100%',
        }}>
          {formatted}
        </pre>
      )
    }

    if (canvas.contentType === 'markdown') {
      const html = marked.parse(canvas.content, { async: false }) as string
      return (
        <div
          className="canvas-markdown"
          style={{
            padding: 24, fontSize: 14, lineHeight: 1.8,
            color: colors.textPrimary, overflow: 'auto', height: '100%',
            wordBreak: 'break-word',
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )
    }

    return (
      <div style={{
        padding: 24, fontSize: 14, lineHeight: 1.8,
        fontFamily: canvas.contentType === 'text' ? 'monospace' : 'inherit',
        color: colors.textPrimary, overflow: 'auto', height: '100%',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {canvas.content}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`
        .canvas-markdown h1, .canvas-markdown h2, .canvas-markdown h3,
        .canvas-markdown h4, .canvas-markdown h5, .canvas-markdown h6 {
          color: var(--accent); margin: 0.8em 0 0.4em; line-height: 1.3;
        }
        .canvas-markdown h1 { font-size: 1.8em; border-bottom: 1px solid var(--borderLight); padding-bottom: 0.3em; }
        .canvas-markdown h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
        .canvas-markdown h3 { font-size: 1.15em; }
        .canvas-markdown p { margin: 0.6em 0; }
        .canvas-markdown a { color: var(--accent); text-decoration: none; }
        .canvas-markdown a:hover { text-decoration: underline; }
        .canvas-markdown code {
          background: var(--bgTertiary); padding: 2px 6px; border-radius: 3px;
          font-family: "Fira Code", monospace; font-size: 0.9em; color: var(--heartbeat);
        }
        .canvas-markdown pre {
          background: var(--bgSecondary); border: 1px solid var(--border); border-radius: 6px;
          padding: 14px; overflow-x: auto; margin: 0.8em 0;
        }
        .canvas-markdown pre code {
          background: none; padding: 0; color: var(--textPrimary); font-size: 13px;
        }
        .canvas-markdown blockquote {
          border-left: 3px solid var(--accent); margin: 0.8em 0; padding: 0.4em 1em;
          color: var(--textSecondary); background: var(--bgTertiary);
        }
        .canvas-markdown ul, .canvas-markdown ol { padding-left: 1.5em; margin: 0.5em 0; }
        .canvas-markdown li { margin: 0.3em 0; }
        .canvas-markdown table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
        .canvas-markdown th, .canvas-markdown td {
          border: 1px solid var(--borderLight); padding: 8px 12px; text-align: left;
        }
        .canvas-markdown th { background: var(--bgTertiary); color: var(--accent); }
        .canvas-markdown hr { border: none; border-top: 1px solid var(--borderLight); margin: 1.2em 0; }
        .canvas-markdown img { max-width: 100%; border-radius: 4px; }
        .upload-btn:hover { opacity: 0.85; }
        .upload-grid-item:hover { opacity: 0.8; outline: 2px solid var(--accent); }
      `}</style>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,.pdf,.txt,.json,.html,.css,.js,.ts,.py,.md"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => handleUpload(e.target.files)}
      />

      {/* Header */}
      <div style={{
        padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? colors.success : colors.error }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: colors.textPrimary }}>
            {canvas?.title || 'Canvas'}
          </span>
          {canvas && (
            <span style={{ fontSize: 11, color: colors.inputPlaceholder, marginLeft: 8 }}>
              {canvas.contentType}{canvas.language ? ` (${canvas.language})` : ''}
              {' \u00B7 '}
              {canvas.content.length} chars
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Canvas tabs if multiple */}
          {canvases.length > 1 && canvases.map((c, i) => (
            <div
              key={c.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 0,
                background: i === activeIdx ? colors.bgTertiary : 'transparent',
                border: i === activeIdx ? `1px solid ${colors.accent}` : `1px solid ${colors.borderLight}`,
                borderRadius: 4, overflow: 'hidden',
              }}
            >
              <button
                onClick={() => setActiveIdx(i)}
                style={{
                  padding: '2px 8px', background: 'transparent',
                  color: i === activeIdx ? colors.accent : colors.inputPlaceholder,
                  border: 'none', cursor: 'pointer', fontSize: 11,
                }}
              >
                {c.title || c.id}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'canvas_delete', canvas_id: c.id }))
                  }
                }}
                style={{
                  padding: '2px 6px', background: colors.error,
                  color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11,
                  fontWeight: 'bold', marginLeft: 1,
                }}
                title="Delete canvas"
              >
                ✕
              </button>
            </div>
          ))}

          {/* Single canvas delete button */}
          {canvases.length === 1 && canvas && canvas.content && (
            <button
              onClick={() => {
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'canvas_delete', canvas_id: canvas.id }))
                }
              }}
              style={{
                padding: '4px 10px', background: colors.bgDanger, color: colors.error,
                border: `1px solid ${colors.error}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
                fontWeight: 600,
              }}
              title="Delete canvas"
            >
              ✕ Delete
            </button>
          )}

          {/* Upload button */}
          <button
            className="upload-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              padding: '4px 12px', background: colors.bgTertiary, color: colors.warning,
              border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
              fontWeight: 600, opacity: uploading ? 0.5 : 1,
            }}
          >
            {uploading ? '⏳ Uploading...' : '📤 Upload'}
          </button>

          {/* Uploads gallery toggle */}
          {uploadedImages.length > 0 && (
            <button
              onClick={() => setShowUploads(!showUploads)}
              style={{
                padding: '4px 12px', background: showUploads ? colors.accent : colors.bgTertiary,
                color: showUploads ? colors.accentContrast : colors.textSecondary,
                border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              🖼 {uploadedImages.length}
            </button>
          )}

          {canvas?.contentType === 'html' && (
            <button
              onClick={() => {
                if (canvas) {
                  const w = window.open('', '_blank')
                  if (w) { w.document.write(canvas.content); w.document.close() }
                }
              }}
              style={{
                padding: '4px 12px', background: colors.bgTertiary, color: colors.accent,
                border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              Open in tab
            </button>
          )}
          {canvas && canvas.contentType !== 'html' && /```html\n([\s\S]*?)```/.test(canvas.content) && (
            <button
              onClick={() => {
                if (canvas) {
                  const match = canvas.content.match(/```html\n([\s\S]*?)```/)
                  if (match) setHtmlPreview(match[1])
                }
              }}
              style={{
                padding: '4px 12px', background: colors.bgTertiary, color: colors.heartbeat,
                border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
                fontWeight: 600,
              }}
            >
              Preview HTML
            </button>
          )}
          {canvas && (
            <>
              <button
                onClick={() => {
                  if (isEditing) {
                    // Save changes
                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({
                        type: 'canvas_edit',
                        canvas_id: canvas.id,
                        title: editTitle || canvas.title,
                        content: editContent,
                        contentType: canvas.contentType,
                      }))
                    }
                    setIsEditing(false)
                  } else {
                    // Enter edit mode
                    setEditContent(canvas.content)
                    setEditTitle(canvas.title)
                    setIsEditing(true)
                  }
                }}
                style={{
                  padding: '4px 12px', background: isEditing ? colors.success : colors.accent,
                  color: isEditing ? '#fff' : colors.accentContrast,
                  border: `1px solid ${isEditing ? colors.success : colors.accent}`,
                  borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                }}
              >
                {isEditing ? '💾 Save' : '✏️ Edit'}
              </button>
              {isEditing && (
                <button
                  onClick={() => setIsEditing(false)}
                  style={{
                    padding: '4px 12px', background: colors.bgTertiary, color: colors.textSecondary,
                    border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => { if (canvas) navigator.clipboard.writeText(canvas.content) }}
                style={{
                  padding: '4px 12px', background: colors.bgTertiary, color: colors.textSecondary,
                  border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
                }}
              >
                Copy
              </button>
            </>
          )}
        </div>
      </div>

      {/* Edit mode panel */}
      {isEditing && canvas && (
        <div style={{
          padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
          background: colors.bgSecondary,
        }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Canvas title"
              style={{
                padding: '6px 12px', background: colors.bgTertiary, color: colors.textPrimary,
                border: `1px solid ${colors.borderLight}`, borderRadius: 4, fontSize: 13,
                width: 200,
              }}
            />
            <span style={{ fontSize: 12, color: colors.textMuted, lineHeight: '32px' }}>
              Type: {canvas.contentType}
            </span>
          </div>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            style={{
              width: '100%', minHeight: 300, padding: 12,
              background: colors.bgTertiary, color: colors.textPrimary,
              border: `1px solid ${colors.borderLight}`, borderRadius: 4,
              fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5,
              resize: 'vertical',
            }}
            placeholder="Enter canvas content..."
          />
        </div>
      )}

      {/* Uploads gallery panel */}
      {showUploads && (
        <div style={{
          padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
          background: colors.bgSecondary, maxHeight: 200, overflowY: 'auto',
        }}>
          <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 8 }}>
            Uploaded files ({uploadedImages.length})
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {uploadedImages.map((img, i) => (
              <div
                key={i}
                className="upload-grid-item"
                onClick={() => {
                  // Click to view in canvas
                  if (img.mimetype?.startsWith('image/')) {
                    const html = `<!DOCTYPE html>
<html><head><style>
  body { margin:0; padding:16px; background:#111; display:flex; flex-direction:column; align-items:center; }
  img { max-width:100%; height:auto; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5); }
  .meta { color:#666; font-size:11px; margin-top:8px; font-family:sans-serif; }
</style></head><body>
  <img src="${img.url}" alt="${img.filename}" />
  <div class="meta">${img.filename} · ${formatSize(img.size)}</div>
</body></html>`
                    setCanvases(prev => {
                      const newCanvas: CanvasData = { id: 'view-' + Date.now(), title: img.filename, content: html, contentType: 'html' }
                      return [...prev, newCanvas]
                    })
                    setActiveIdx(canvases.length)
                  }
                }}
                style={{
                  width: 80, height: 80, borderRadius: 6, overflow: 'hidden', cursor: 'pointer',
                  border: `1px solid ${colors.borderLight}`, position: 'relative', flexShrink: 0,
                }}
              >
                {img.mimetype?.startsWith('image/') ? (
                  <img src={img.url} alt={img.filename} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{
                    width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: colors.bgTertiary, fontSize: 10, color: colors.textSecondary, textAlign: 'center', padding: 4,
                  }}>
                    {img.filename}
                  </div>
                )}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.7)',
                  fontSize: 9, color: '#ccc', padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {formatSize(img.size)}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: colors.textMuted }}>
            URL format: <code style={{ background: colors.bgTertiary, padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>/api/uploads/filename</code>
          </div>
        </div>
      )}

      {/* Canvas content area — supports drag & drop */}
      <div
        style={{ flex: 1, overflow: 'hidden', background: colors.bgSecondary, position: 'relative' }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          handleUpload(e.dataTransfer.files)
        }}
      >
        {renderContent()}
      </div>

      {/* HTML Preview Modal */}
      {htmlPreview && (
        <div
          onClick={() => setHtmlPreview(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: colors.bgOverlay, zIndex: 1000,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '90%', maxWidth: 1000, height: '80%',
              background: '#fff', borderRadius: 12, overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
              boxShadow: `0 20px 60px ${colors.shadow}`,
            }}
          >
            <div style={{
              padding: '8px 16px', background: colors.bgTertiary,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: `1px solid ${colors.borderLight}`,
            }}>
              <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>HTML Preview</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => {
                    const w = window.open('', '_blank')
                    if (w) { w.document.write(htmlPreview); w.document.close() }
                  }}
                  style={{
                    padding: '3px 10px', background: colors.bgActive, color: colors.accent,
                    border: `1px solid ${colors.accent}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  }}
                >
                  Open in tab
                </button>
                <button
                  onClick={() => setHtmlPreview(null)}
                  style={{
                    padding: '3px 10px', background: colors.bgDanger, color: colors.error,
                    border: `1px solid ${colors.error}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <iframe
              srcDoc={htmlPreview}
              style={{ flex: 1, border: 'none', background: '#fff' }}
              sandbox="allow-scripts"
              title="HTML Preview"
            />
          </div>
        </div>
      )}
    </div>
  )
}
