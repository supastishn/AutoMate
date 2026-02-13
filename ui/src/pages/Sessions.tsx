import React, { useEffect, useState, useRef } from 'react'
import { onDataUpdate } from '../hooks/useDataUpdates'
import { useColors } from '../ThemeContext'

interface Session {
  id: string
  channel: string
  userId: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

interface SubAgent {
  id: string
  name: string
  task: string
  status: 'running' | 'completed' | 'timeout' | 'error'
  startTime: number
  endTime?: number
  output?: string
  toolCalls: { name: string; result: string }[]
  error?: string
}


export default function Sessions({ onOpenInChat }: { onOpenInChat?: (sessionId: string) => void }) {
  const colors = useColors()
  const [sessions, setSessions] = useState<Session[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [folder, setFolder] = useState<'normal' | 'heartbeat' | 'subagents'>('normal')
  const [mainSessionId, setMainSessionId] = useState<string | null>(null)
  const [jsonEditor, setJsonEditor] = useState<{ sessionId: string; raw: string } | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonSaving, setJsonSaving] = useState(false)
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const subAgentPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

const fetchSubAgents = async () => {
  try {
    const r = await fetch('/api/subagents')
    const data = await r.json() as any
    setSubAgents(data.agents || [])
  } catch { /* ignore */ }
}

const clearCompletedAgents = async () => {
  try {
    await fetch('/api/subagents/clear', { method: 'POST' })
    fetchSubAgents()
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

  // SubAgents tab: fetch on enter and poll while active (agents may be running)
  useEffect(() => {
    if (folder !== 'subagents') {
      if (subAgentPollRef.current) { clearInterval(subAgentPollRef.current); subAgentPollRef.current = null }
      return
    }
    fetchSubAgents()
    subAgentPollRef.current = setInterval(fetchSubAgents, 3000)
    return () => { if (subAgentPollRef.current) { clearInterval(subAgentPollRef.current); subAgentPollRef.current = null } }
  }, [folder])

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

  const openJsonEditor = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
      const data = await r.json() as any
      if (data.session) {
        setJsonEditor({ sessionId: id, raw: JSON.stringify(data.session.messages, null, 2) })
        setJsonError(null)
      }
    } catch { /* ignore */ }
  }

  const saveJsonEditor = async () => {
    if (!jsonEditor) return
    setJsonError(null)
    let parsed: any[]
    try {
      parsed = JSON.parse(jsonEditor.raw)
      if (!Array.isArray(parsed)) throw new Error('Must be a JSON array')
    } catch (err: any) {
      setJsonError('Invalid JSON: ' + err.message)
      return
    }
    setJsonSaving(true)
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(jsonEditor.sessionId)}/messages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: parsed }),
      })
      const data = await r.json() as any
      if (r.ok && data.ok) {
        setJsonEditor(null)
        fetchSessions()
        if (selected?.session?.id === jsonEditor.sessionId) viewSession(jsonEditor.sessionId)
      } else {
        setJsonError(data.error || 'Save failed')
      }
    } catch (err: any) {
      setJsonError(err.message || 'Save failed')
    } finally {
      setJsonSaving(false)
    }
  }

  const repairSession = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/repair`, { method: 'POST' })
      const data = await r.json() as any
      if (data.ok) {
        alert(data.removed > 0 ? `Repaired: removed ${data.removed} orphaned messages` : 'No issues found')
        fetchSessions()
      }
    } catch { /* ignore */ }
  }

  const isHeartbeat = (s: Session) => s.id.startsWith('heartbeat:') || s.channel === 'heartbeat'
  const filtered = sessions.filter(s => folder === 'heartbeat' ? isHeartbeat(s) : !isHeartbeat(s))
  const heartbeatCount = sessions.filter(isHeartbeat).length
  const normalCount = sessions.length - heartbeatCount

  const card: React.CSSProperties = {
    background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 16, cursor: 'pointer',
    transition: 'border-color 0.15s',
  }

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
            style={{ padding: '6px 14px', background: colors.bgHover, color: colors.accent, border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
            Export All
          </button>
        </div>
      </div>

      {/* Folder tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: `1px solid ${colors.border}` }}>
        <button
          onClick={() => setFolder('normal')}
          style={{
            padding: '8px 20px', fontSize: 13, fontWeight: folder === 'normal' ? 600 : 400,
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: folder === 'normal' ? colors.accent : colors.textMuted,
            borderBottom: folder === 'normal' ? `2px solid ${colors.accent}` : '2px solid transparent',
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
            color: folder === 'heartbeat' ? '#e57373' : colors.textMuted,
            borderBottom: folder === 'heartbeat' ? '2px solid #e57373' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          Heartbeat ({heartbeatCount})
        </button>
        <button
          onClick={() => setFolder('subagents')}
          style={{
            padding: '8px 20px', fontSize: 13, fontWeight: folder === 'subagents' ? 600 : 400,
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: folder === 'subagents' ? '#b39ddb' : colors.textMuted,
            borderBottom: folder === 'subagents' ? '2px solid #b39ddb' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          SubAgents{subAgents.length > 0 ? ` (${subAgents.length})` : ''}
        </button>
      </div>

      {folder === 'subagents' ? (
        /* ── SubAgents panel ─────────────────────────────────────────── */
        <>
          {subAgents.length > 0 && subAgents.some(a => a.status !== 'running') && (
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={clearCompletedAgents}
                style={{ padding: '5px 14px', background: colors.bgHover, color: '#b39ddb', border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                Clear Completed
              </button>
            </div>
          )}
          {subAgents.length === 0 ? (
            <div style={{ color: colors.textMuted, padding: 40, textAlign: 'center' as const }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>{'\u{1F916}'}</div>
              No background sub-agents
            </div>
          ) : (
            <div style={gridStyle}>
              {subAgents.map(a => {
                const duration = ((a.endTime || Date.now()) - a.startTime) / 1000
                const statusIcon = a.status === 'running' ? '\u23F3' : a.status === 'completed' ? '\u2705' : '\u274C'
                const statusColor = a.status === 'running' ? colors.accent : a.status === 'completed' ? '#81c784' : a.status === 'timeout' ? '#ffb74d' : '#f44'
                const isExpanded = expandedAgent === a.id
                return (
                  <div key={a.id} style={{ ...card, borderColor: a.status === 'running' ? colors.borderLight : colors.border }}
                    onClick={() => setExpandedAgent(isExpanded ? null : a.id)}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = '#b39ddb')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = a.status === 'running' ? colors.borderLight : colors.border)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
                        <span style={{ fontSize: 16 }}>{statusIcon}</span>
                        <span style={{ fontWeight: 600, color: '#b39ddb', fontFamily: 'monospace', fontSize: 13 }}>{a.name}</span>
                        <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: 'monospace' }}>{a.id}</span>
                      </div>
                      <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{a.status}</span>
                    </div>
                    <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                      {a.task}
                    </div>
                    <div style={{ display: 'flex', gap: 16, fontSize: 11, color: colors.textMuted }}>
                      <span>Duration: {duration < 60 ? `${duration.toFixed(1)}s` : `${(duration / 60).toFixed(1)}m`}</span>
                      {a.toolCalls.length > 0 && <span>Tools: {a.toolCalls.length}</span>}
                    </div>
                    {isExpanded && (
                      <div style={{ marginTop: 10, borderTop: `1px solid ${colors.border}`, paddingTop: 10 }}>
                        {a.toolCalls.length > 0 && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: 10, color: colors.textMuted, marginBottom: 4 }}>Tools used:</div>
                            <div style={{ fontSize: 11, color: '#b39ddb', fontFamily: 'monospace' }}>
                              {a.toolCalls.map(t => t.name).join(', ')}
                            </div>
                          </div>
                        )}
                        {a.error && (
                          <div style={{ marginBottom: 8, padding: '6px 10px', background: colors.bgHover, borderRadius: 4, fontSize: 12, color: '#f44', fontFamily: 'monospace' }}>
                            {a.error}
                          </div>
                        )}
                        {a.output && (
                          <div>
                            <div style={{ fontSize: 10, color: colors.textMuted, marginBottom: 4 }}>Output:</div>
                            <pre style={{
                              margin: 0, padding: '8px 10px', background: colors.bgPrimary, borderRadius: 4,
                              fontSize: 11, color: colors.textPrimary, fontFamily: '"Fira Code", "JetBrains Mono", monospace',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const,
                              maxHeight: 200, overflow: 'auto',
                            }}>
                              {a.output}
                            </pre>
                          </div>
                        )}
                        {a.status === 'running' && (
                          <div style={{ fontSize: 11, color: colors.accent, fontStyle: 'italic', marginTop: 4 }}>
                            {'\u23F3'} Still running… poll again later.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
      <>
      {/* Import Section */}
      <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: colors.textSecondary }}>Import Session:</span>
          <label style={{ padding: '4px 12px', background: colors.bgHover, color: colors.accent, border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
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
        <div style={{ color: colors.textMuted, padding: 40, textAlign: 'center' as const }}>
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>{folder === 'heartbeat' ? '\u{1F493}' : '\u{1F4AC}'}</div>
          No {folder === 'heartbeat' ? 'heartbeat' : 'active'} sessions
        </div>
      ) : (
        <div style={gridStyle}>
          {filtered.map(s => (
            <div key={s.id} style={card} onClick={() => viewSession(s.id)}
              onMouseEnter={e => (e.currentTarget.style.borderColor = colors.accent)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = colors.border)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden' }}>
                  <button onClick={(e) => toggleMainSession(s.id, e)}
                    title={mainSessionId === s.id ? 'Unset as main session' : 'Set as main session'}
                    style={{
                      padding: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16,
                      color: mainSessionId === s.id ? '#ffb74d' : colors.borderLight,
                      flexShrink: 0,
                    }}>
                    {mainSessionId === s.id ? '\u2605' : '\u2606'}
                  </button>
                  <div style={{ fontSize: 13, fontFamily: 'monospace', color: mainSessionId === s.id ? '#ffb74d' : colors.accent, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.id}</div>
                </div>
                <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
                  {onOpenInChat && (
                    <button onClick={(e) => { e.stopPropagation(); onOpenInChat(s.id) }}
                      title="Open in Chat"
                      style={{ padding: '2px 8px', background: colors.bgHover, color: colors.accent, border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                      Chat
                    </button>
                  )}
                  <button onClick={(e) => exportSession(s.id, e)}
                    title="Export session"
                    style={{ padding: '2px 8px', background: colors.bgHover, color: '#81c784', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    Export
                  </button>
                  <button onClick={(e) => duplicateSession(s.id, e)}
                    title="Duplicate session"
                    style={{ padding: '2px 8px', background: colors.bgHover, color: '#b39ddb', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    Dup
                  </button>
                  <button onClick={(e) => openJsonEditor(s.id, e)}
                    title="Edit raw JSON"
                    style={{ padding: '2px 8px', background: colors.bgHover, color: '#ffb74d', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    JSON
                  </button>
                  <button onClick={(e) => repairSession(s.id, e)}
                    title="Repair broken tool pairs"
                    style={{ padding: '2px 8px', background: colors.bgHover, color: '#80cbc4', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    Repair
                  </button>
                  <button onClick={(e) => deleteSession(s.id, e)}
                    title="Delete session"
                    style={{ padding: '2px 8px', background: colors.bgHover, color: '#f44', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 10 }}>
                    Del
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: colors.textSecondary, flexWrap: 'wrap' as const }}>
                <span>Channel: {s.channel}</span>
                <span>Messages: {s.messageCount}</span>
                <span>Updated: {ago(s.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}

      {selected?.session && (
        <div style={{ marginTop: 24, background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, fontFamily: 'monospace' }}>{selected.session.id}</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              {onOpenInChat && (
                <button onClick={() => onOpenInChat(selected.session.id)}
                  style={{ padding: '6px 12px', background: colors.bgHover, color: colors.accent, border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                  Open in Chat
                </button>
              )}
              <button onClick={() => exportSession(selected.session.id)}
                style={{ padding: '6px 12px', background: colors.bgHover, color: '#81c784', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Export
              </button>
              <button onClick={() => duplicateSession(selected.session.id)}
                style={{ padding: '6px 12px', background: colors.bgHover, color: '#b39ddb', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Duplicate
              </button>
              <button onClick={() => openJsonEditor(selected.session.id)}
                style={{ padding: '6px 12px', background: colors.bgHover, color: '#ffb74d', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Edit JSON
              </button>
              <button onClick={() => repairSession(selected.session.id)}
                style={{ padding: '6px 12px', background: colors.bgHover, color: '#80cbc4', border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Repair
              </button>
              <button onClick={() => deleteSession(selected.session.id)}
                style={{ padding: '6px 12px', background: '#f44336', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Delete
              </button>
              <button onClick={() => setSelected(null)}
                style={{ padding: '6px 12px', background: colors.borderLight, color: colors.textPrimary, border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                Close
              </button>
            </div>
          </div>
          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            {(selected.session.messages || []).map((m: any, i: number) => (
              <div key={i} style={{ padding: 8, borderBottom: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'monospace' }}>
                <span style={{ color: m.role === 'user' ? colors.accent : m.role === 'assistant' ? '#81c784' : m.role === 'tool' ? '#ffb74d' : colors.textSecondary, marginRight: 8 }}>
                  [{m.role}]
                </span>
                <span style={{ color: colors.textPrimary }}>
                  {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && !m.content
                    ? m.tool_calls.map((tc: any) => tc.function?.name || tc.name || 'unknown').join(', ')
                    : m.role === 'tool' && !m.content
                    ? '(result)'
                    : (m.content || '').slice(0, 300)}
                  {m.content && m.content.length > 300 ? '...' : ''}
                </span>
                {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 10, color: colors.textMuted }}>
                    [{m.tool_calls.map((tc: any) => tc.function?.name || tc.name || '?').join(', ')}]
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* JSON Editor Modal */}
      {jsonEditor && (
        <div
          onClick={() => setJsonEditor(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: colors.bgOverlay, zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '90%', maxWidth: 900, height: '80%',
              background: colors.bgCard, borderRadius: 12, overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
              border: `1px solid ${colors.borderLight}`, boxShadow: `0 20px 60px ${colors.shadow}`,
            }}
          >
            <div style={{
              padding: '10px 16px', background: colors.bgTertiary,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: `1px solid ${colors.borderLight}`,
            }}>
              <span style={{ fontSize: 13, color: '#ffb74d', fontWeight: 600, fontFamily: 'monospace' }}>
                Edit: {jsonEditor.sessionId}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={saveJsonEditor}
                  disabled={jsonSaving}
                  style={{
                    padding: '4px 14px', background: colors.accent, color: '#000',
                    border: 'none', borderRadius: 4, cursor: jsonSaving ? 'default' : 'pointer',
                    fontSize: 12, fontWeight: 600, opacity: jsonSaving ? 0.5 : 1,
                  }}
                >
                  {jsonSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setJsonEditor(null)}
                  style={{
                    padding: '4px 14px', background: colors.borderLight, color: colors.textPrimary,
                    border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
            {jsonError && (
              <div style={{ padding: '6px 16px', background: colors.bgHover, color: '#f44', fontSize: 12, borderBottom: `1px solid ${colors.borderLight}` }}>
                {jsonError}
              </div>
            )}
            <textarea
              value={jsonEditor.raw}
              onChange={e => setJsonEditor({ ...jsonEditor, raw: e.target.value })}
              spellCheck={false}
              style={{
                flex: 1, padding: 16, background: colors.bgPrimary, color: colors.textPrimary,
                border: 'none', resize: 'none', outline: 'none',
                fontFamily: '"Fira Code", "JetBrains Mono", monospace', fontSize: 12,
                lineHeight: 1.6,
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}