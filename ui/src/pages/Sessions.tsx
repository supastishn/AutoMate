import React, { useEffect, useState } from 'react'

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

export default function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selected, setSelected] = useState<any>(null)

  const fetchSessions = async () => {
    try {
      const r = await fetch('/api/sessions')
      const data = await r.json() as any
      setSessions(data.sessions || [])
    } catch { /* ignore */ }
  }

  useEffect(() => {
    fetchSessions()
    const i = setInterval(fetchSessions, 5000)
    return () => clearInterval(i)
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

  const ago = (date: string) => {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
  }

  return (
    <div style={{ padding: 30, maxWidth: 1000 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24, fontWeight: 600 }}>Sessions</h1>

      {sessions.length === 0 ? (
        <div style={{ color: '#666', padding: 20 }}>No active sessions</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {sessions.map(s => (
            <div key={s.id} style={card} onClick={() => viewSession(s.id)}
              onMouseEnter={e => (e.currentTarget.style.borderColor = '#4fc3f7')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#222')}>
              <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#4fc3f7', marginBottom: 6 }}>{s.id}</div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#888' }}>
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
              <button onClick={() => resetSession(selected.session.id)}
                style={{ padding: '6px 12px', background: '#f44336', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Reset
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
                <span style={{ color: m.role === 'user' ? '#4fc3f7' : m.role === 'assistant' ? '#81c784' : '#ffb74d', marginRight: 8 }}>
                  [{m.role}]
                </span>
                <span style={{ color: '#ccc' }}>
                  {(m.content || '(tool call)').slice(0, 300)}
                  {m.content && m.content.length > 300 ? '...' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
