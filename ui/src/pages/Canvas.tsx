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

export default function Canvas() {
  const colors = useColors()
  const [canvases, setCanvases] = useState<CanvasData[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [connected, setConnected] = useState(false)
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

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

        // Load initial canvases on connect
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
      } catch {}
    }

    wsRef.current = ws
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
              The agent can push content here using canvas_push
            </div>
          </div>
        </div>
      )
    }

    if (canvas.contentType === 'html') {
      return (
        <iframe
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
      `}</style>
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
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Canvas tabs if multiple */}
          {canvases.length > 1 && canvases.map((c, i) => (
            <button
              key={c.id}
              onClick={() => setActiveIdx(i)}
              style={{
                padding: '2px 10px', background: i === activeIdx ? colors.bgTertiary : 'transparent',
                color: i === activeIdx ? colors.accent : colors.inputPlaceholder,
                border: i === activeIdx ? `1px solid ${colors.accent}` : `1px solid ${colors.borderLight}`,
                borderRadius: 4, cursor: 'pointer', fontSize: 11,
              }}
            >
              {c.title || c.id}
            </button>
          ))}
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
            <button
              onClick={() => { if (canvas) navigator.clipboard.writeText(canvas.content) }}
              style={{
                padding: '4px 12px', background: colors.bgTertiary, color: colors.textSecondary,
                border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              Copy
            </button>
          )}
        </div>
      </div>

      {/* Canvas content area */}
      <div style={{ flex: 1, overflow: 'hidden', background: colors.bgSecondary }}>
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
