import React, { useEffect, useState, useRef } from 'react'
import { onDataUpdate } from '../hooks/useDataUpdates'

interface Session {
  id: string
  channel: string
  userId: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

const card = {
  background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 16, cursor: 'pointer',
  transition: 'border-color 0.15s',
} as React.CSSProperties

export default function Sessions({ onOpenInChat }: { onOpenInChat?: (sessionId: string) => void }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [folder, setFolder] = useState<'normal' | 'heartbeat'>('normal')
  const [mainSessionId, setMainSessionId] = useState<string | null>(null)

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const fetchSessions = async () => {
    try {
      const r = await fetch('/api/sessions')
      const data = await r.json() as any
      setSessions(data.sessions || [])
    } catch { /* ignore */ }
  }

  const fetchMainSession = async () => {
    try {
      const r = await fetch('/api/sessions/main')
      const data = await r.json() as any
      setMainSessionId(data.mainSessionId || null)
    } catch { /* ignore */ }
  }

  const toggleMainSession = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    const newId = mainSessionId === id ? null : id
    try {
      await fetch('/api/sessions/main', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: newId }),
      })
      setMainSessionId(newId)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    fetchSessions()
    fetchMainSession()
    const i = setInterval(fetchSessions, 30000)
    return () => clearInterval(i)
  }, [])

  // Refetch when sessions change via WebSocket push
  useEffect(() => {
    return onDataUpdate((resource) => {
      if (resource === 'sessions') fetchSessions()
    })
  }, [])

  const viewSession = async (id: string) => {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
      const data = await r.json()
      setSelected(data)
    } catch { /* ignore */ }
  }

  const resetSession = async (id: string) => {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    fetchSessions()
    setSelected(null)
  }

  const deleteSession = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    if (!confirm(`Delete session "${id}" permanently?`)) return
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setSessions(prev => prev.filter(s => s.id !== id))
    if (selected?.session?.id === id) setSelected(null)
  }

  const exportSession = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    window.open('/api/sessions/' + encodeURIComponent(id) + '/export')
  }

  const duplicateSession = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/duplicate`, { method: 'POST' })
      const data = await r.json() as any
      if (data.ok) {
        fetchSessions()
      }
    } catch { /* ignore */ }
  }

  const exportAll = async () => {
    try {
      const allSessions: any[] = []
      for (const s of sessions) {
        const r = await fetch(`/api/sessions/${encodeURIComponent(s.id)}`)
        const data = await r.json()
        if (data.session) allSessions.push(data.session)
      }
      const blob = new Blob([JSON.stringify({ version: '1.0', exportedAt: new Date().toISOString(), sessions: allSessions }, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `all-sessions-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch { /* ignore */ }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportStatus(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const payload = parsed.session || parsed
      const r = await fetch('/api/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: payload }),
      })
      const result = await r.json() as any
      if (r.ok && result.ok) {
        setImportStatus({ type: 'success', message: `Imported ${result.messageCount} messages into session "${result.sessionId}"` })
        fetchSessions()
      } else {
        setImportStatus({ type: 'error', message: result.error || 'Import failed' })
      }
    } catch (err: any) {
      setImportStatus({ type: 'error', message: err.message || 'Failed to parse file' })
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const ago = (date: string) => {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
  }

  const isHeartbeat = (s: Session) => s.id.startsWith('heartbeat:') || s.channel === 'heartbeat'
  const filtered = sessions.filter(s => folder === 'heartbeat' ? isHeartbeat(s) : !isHeartbeat(s))
  const heartbeatCount = sessions.filter(isHeartbeat).length
  const normalCount = sessions.length - heartbeatCount

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
    gap: 12,
  }

  return (
    <div style={{ padding: 30, maxWidth: 1000 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Sessions</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={exportAll}
            style={{ padding: '6px 14px', background: '#1a2a3a', color: '#4fc3f7', border: '1px solid #2a4a6a', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
            Export All
          </button>
        </div>
      </div>

      {/* Folder tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid #222' }}>
        <button
          onClick={() => setFolder('normal')}
          style={{
            padding: '8px 20px', fontSize: 13, fontWeight: folder === 'normal' ? 600 : 400,
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: folder === 'normal' ? '#4fc3f7' : '#666',
            borderBottom: folder === 'normal' ? '2px solid #4fc3f7' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          Normal ({normalCount})
        </button>
        <button
          onClick={() => setFolder('heartbeat')}
          style={{
            padding: '8px 20px', fontSize: 13, fontWeight: folder === 'heartbeat' ? 600 : 400,
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: folder === 'heartbeat' ? '#e57373' : '#666',
            borderBottom: folder === 'heartbeat' ? '2px solid #e57373' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          Heartbeat ({heartbeatCount})
        </button>
      </div>

      {/* Import Section */}
      <div style={{ background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#888' }}>Import Session:</span>
          <label style={{ padding: '4px 12px', background: '#1a2a3a', color: '#4fc3f7', border: '1px solid #2a4a6a', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
            Choose JSON file
            <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />
          </label>
        </div>
        {importStatus && (
          <div style={{ marginTop: 8, fontSize: 12, color: importStatus.type === 'success' ? '#81c784' : '#f44' }}>
            {importStatus.message}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ color: '#666', padding: 40, textAlign: 'center' as const }}>
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>{folder === 'heartbeat' ? '\u{1F493}' : '\u{1F4AC}'}</div>
          No {folder === 'heartbeat' ? 'heartbeat' : 'active'} sessions
        </div>
      ) : (
        <div style={gridStyle}>
          {filtered.map(s => (
            <div key={s.id} style={card} onClick={() => viewSession(s.id)}
              onMouseEnter={e => (e.currentTarget.style.borderColor = '#4fc3f7')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#222')}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden' }}>
                  <button onClick={(e) => toggleMainSession(s.id, e)}
                    title={mainSessionId === s.id ? 'Unset as main session' : 'Set as main session'}
                    style={{
                      padding: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16,
                      color: mainSessionId === s.id ? '#ffb74d' : '#333',
                      flexShrink: 0,
                    }}>
                    {mainSessionId === s.id ? '\u2605' : '\u2606'}
                  </button>
                  <div style={{ fontSize: 13, fontFamily: 'monospace', color: mainSessionId === s.id ? '#ffb74d' : '#4fc3f7', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.id}</div>
                </div>
                <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
                  {onOpenInChat && (
                    <button onClick={(e) => { e.stopPropagation(); onOpenInChat(s.id) }}
                      title="Open in Chat"
                      style={{ padding: '2px 8px', background: '#1a2a3a', color: '#4fc3f7', border: '1px solid #2a4a6a', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                      Chat
                    </button>
                  )}
                  <button onClick={(e) => exportSession(s.id, e)}
                    title="Export session"
                    style={{ padding: '2px 8px', background: '#1a2a1a', color: '#81c784', border: '1px solid #2a4a2a', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    Export
                  </button>
                  <button onClick={(e) => duplicateSession(s.id, e)}
                    title="Duplicate session"
                    style={{ padding: '2px 8px', background: '#1a1a2a', color: '#b39ddb', border: '1px solid #2a2a4a', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    Dup
                  </button>
                  <button onClick={(e) => deleteSession(s.id, e)}
                    title="Delete session"
                    style={{ padding: '2px 8px', background: '#2a1a1a', color: '#f44', border: '1px solid #4a2a2a', borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    Del
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#888', flexWrap: 'wrap' as const }}>
                <span>Channel: {s.channel}</span>
                <span>Messages: {s.messageCount}</span>
                <span>Updated: {ago(s.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected?.session && (
        <div style={{ marginTop: 24, background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, fontFamily: 'monospace' }}>{selected.session.id}</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              {onOpenInChat && (
                <button onClick={() => onOpenInChat(selected.session.id)}
                  style={{ padding: '6px 12px', background: '#1a3a5c', color: '#4fc3f7', border: '1px solid #2a5a8c', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                  Open in Chat
                </button>
              )}
              <button onClick={() => exportSession(selected.session.id)}
                style={{ padding: '6px 12px', background: '#1a3a1c', color: '#81c784', border: '1px solid #2a5a2c', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Export
              </button>
              <button onClick={() => deleteSession(selected.session.id)}
                style={{ padding: '6px 12px', background: '#f44336', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Delete
              </button>
              <button onClick={() => setSelected(null)}
                style={{ padding: '6px 12px', background: '#333', color: '#ccc', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Close
              </button>
            </div>
          </div>
          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            {(selected.session.messages || []).map((m: any, i: number) => (
              <div key={i} style={{ padding: 8, borderBottom: '1px solid #1a1a1a', fontSize: 13, fontFamily: 'monospace' }}>
                <span style={{ color: m.role === 'user' ? '#4fc3f7' : m.role === 'assistant' ? '#81c784' : m.role === 'tool' ? '#ffb74d' : '#888', marginRight: 8 }}>
                  [{m.role}]
                </span>
                <span style={{ color: '#ccc' }}>
                  {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && !m.content
                    ? m.tool_calls.map((tc: any) => tc.function?.name || tc.name || 'unknown').join(', ')
                    : m.role === 'tool' && !m.content
                    ? '(result)'
                    : (m.content || '').slice(0, 300)}
                  {m.content && m.content.length > 300 ? '...' : ''}
                </span>
                {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 10, color: '#666' }}>
                    [{m.tool_calls.map((tc: any) => tc.function?.name || tc.name || '?').join(', ')}]
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}