import React, { useEffect, useRef, useState } from 'react'

interface CanvasData {
  id: string
  title: string
  content: string
  contentType: string
  language?: string
}

export default function Canvas() {
  const [canvases, setCanvases] = useState<CanvasData[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [connected, setConnected] = useState(false)
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>&#9634;</div>
            <div style={{ fontSize: 16 }}>Canvas is empty</div>
            <div style={{ fontSize: 13, marginTop: 8, color: '#444' }}>
              The agent can push content here using canvas_push
            </div>
          </div>
        </div>
      )
    }

    if (canvas.contentType === 'html') {
      const blob = new Blob([canvas.content], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      return (
        <iframe
          src={url}
          style={{
            width: '100%', height: '100%', border: 'none',
            background: '#fff', borderRadius: 4,
          }}
          sandbox="allow-scripts allow-same-origin"
          title={canvas.title}
        />
      )
    }

    if (canvas.contentType === 'code') {
      return (
        <div style={{ height: '100%', overflow: 'auto' }}>
          <div style={{ padding: '4px 12px', background: '#1a1a2e', borderBottom: '1px solid #333', fontSize: 11, color: '#888' }}>
            {canvas.language || 'code'}
          </div>
          <pre style={{
            margin: 0, padding: 16, fontSize: 13, lineHeight: 1.6,
            fontFamily: '"Fira Code", monospace', color: '#e0e0e0', whiteSpace: 'pre-wrap',
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
          fontFamily: 'monospace', color: '#a5d6a7', whiteSpace: 'pre-wrap',
          overflow: 'auto', height: '100%',
        }}>
          {formatted}
        </pre>
      )
    }

    return (
      <div style={{
        padding: 24, fontSize: 14, lineHeight: 1.8,
        fontFamily: canvas.contentType === 'text' ? 'monospace' : 'inherit',
        color: '#e0e0e0', overflow: 'auto', height: '100%',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {canvas.content}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid #222',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#4caf50' : '#f44' }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {canvas?.title || 'Canvas'}
          </span>
          {canvas && (
            <span style={{ fontSize: 11, color: '#666', marginLeft: 8 }}>
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
                padding: '2px 10px', background: i === activeIdx ? '#1a1a2e' : 'transparent',
                color: i === activeIdx ? '#4fc3f7' : '#666',
                border: i === activeIdx ? '1px solid #4fc3f7' : '1px solid #333',
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
                padding: '4px 12px', background: '#1a1a2e', color: '#4fc3f7',
                border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              Open in tab
            </button>
          )}
          {canvas && (
            <button
              onClick={() => { if (canvas) navigator.clipboard.writeText(canvas.content) }}
              style={{
                padding: '4px 12px', background: '#1a1a2e', color: '#888',
                border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              Copy
            </button>
          )}
        </div>
      </div>

      {/* Canvas content area */}
      <div style={{ flex: 1, overflow: 'hidden', background: '#0d0d0d' }}>
        {renderContent()}
      </div>
    </div>
  )
}
