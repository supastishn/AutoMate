import React, { useEffect, useState } from 'react'
import { onDataUpdate } from '../hooks/useDataUpdates'

// ── Types matching /api/dashboard response ──────────────────────────────

interface DeferredTool { name: string; summary: string; actions?: string[] }
interface SessionToolInfo { sessionId: string; promotedTools: string[] }
interface ToolStats {
  coreToolCount: number
  coreTools: string[]
  deferredToolCount: number
  deferredTools: DeferredTool[]
  sessionCount: number
  sessions: SessionToolInfo[]
  totalPromotions: number
  totalDemotions: number
}

interface IdentityFile { name: string; size: number; exists: boolean }
interface MemoryStats {
  indexEnabled: boolean
  totalChunks: number
  indexedFiles: string[]
  identityFiles: IdentityFile[]
}

interface SessionBreakdown {
  total: number
  byChannel: Record<string, number>
  totalMessages: number
}

interface PresenceState {
  agentId: string
  status: 'online' | 'idle' | 'busy' | 'offline'
  typing: boolean
  lastActivity: number
  currentSession?: string
}

interface SkillInfo { name: string; description: string }
interface PluginInfo { name: string; summary: string; actions?: string[] }

interface HeartbeatLogEntry {
  timestamp: number
  status: 'ok-empty' | 'ok-token' | 'sent' | 'skipped' | 'failed'
  sessionId: string
  content?: string
  responseLength?: number
  error?: string
}

interface DashboardData {
  uptime: number
  model: string
  tools: ToolStats
  memory: MemoryStats | null
  sessions: SessionBreakdown
  webchatClients: number
  canvasClients: number
  presence: PresenceState
  skills: SkillInfo[]
  plugins: PluginInfo[]
  heartbeatLog: HeartbeatLogEntry[]
}

interface InlineStatus {
  message: string
  type: 'success' | 'error'
}

// ── Styles ──────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#141414', border: '1px solid #222', borderRadius: 8,
  padding: 16, marginBottom: 12,
}
const sectionTitle: React.CSSProperties = {
  fontSize: 13, color: '#888', marginBottom: 8, fontWeight: 600,
  textTransform: 'uppercase' as const, letterSpacing: 1,
}
const statNum: React.CSSProperties = { fontSize: 26, fontWeight: 700 }
const statLabel: React.CSSProperties = { fontSize: 11, color: '#888', marginTop: 2 }
const pill: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px', borderRadius: 12,
  fontSize: 11, margin: '2px 3px', background: '#1a2a3a', color: '#4fc3f7',
}
const pillGreen: React.CSSProperties = { ...pill, background: '#1a2e1a', color: '#4caf50' }
const pillRed: React.CSSProperties = { ...pill, background: '#2e1a1a', color: '#f44336' }
const mono: React.CSSProperties = { fontFamily: 'monospace', fontSize: 12, color: '#aaa' }
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }
const grid3: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }

const overlay: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000,
}
const modal: React.CSSProperties = {
  background: '#1a1a1a', border: '1px solid #333', borderRadius: 12,
  padding: 24, maxWidth: 600, width: '90%', maxHeight: '80vh',
  overflowY: 'auto', position: 'relative',
}
const statusBadge = (status: string): React.CSSProperties => {
  const isOk = status === 'ok-empty' || status === 'ok-token' || status === 'skipped'
  const isFail = status === 'failed'
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 10,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const,
    background: isOk ? '#1a2e1a' : isFail ? '#2e1a1a' : '#1a2a3a',
    color: isOk ? '#4caf50' : isFail ? '#f44336' : '#4fc3f7',
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(s % 60)}s`
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

function statusColor(s: string): string {
  switch (s) {
    case 'online': return '#4caf50'
    case 'busy': return '#ff9800'
    case 'idle': return '#ffeb3b'
    case 'offline': return '#f44336'
    default: return '#888'
  }
}

function timeSince(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ── Heartbeat Detail Modal ───────────────────────────────────────────

function HeartbeatModal({ entry, onClose }: { entry: HeartbeatLogEntry; onClose: () => void }) {
  const statusLabel: Record<string, string> = {
    'ok-empty': 'OK (empty response)',
    'ok-token': 'OK (acknowledged)',
    'sent': 'Alert sent',
    'skipped': 'Skipped (empty checklist)',
    'failed': 'Failed',
  }
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 12, right: 12, background: 'none',
            border: 'none', color: '#888', fontSize: 20, cursor: 'pointer',
          }}
        >
          x
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={statusBadge(entry.status)}>{entry.status.replace(/-/g, ' ')}</span>
          <span style={{ fontSize: 13, color: '#aaa' }}>{fmtDate(entry.timestamp)}</span>
          <span style={{ fontSize: 11, color: '#666' }}>({timeSince(entry.timestamp)})</span>
        </div>

        <div style={{ ...mono, color: '#aaa', marginBottom: 16 }}>
          {statusLabel[entry.status] || entry.status}
          {entry.responseLength != null && (
            <span style={{ color: '#666', marginLeft: 12 }}>{entry.responseLength} chars</span>
          )}
        </div>

        {entry.content && (
          <div style={{
            marginBottom: 16, padding: '12px 14px', borderRadius: 8,
            background: '#111', border: '1px solid #333',
            ...mono, lineHeight: 1.6, whiteSpace: 'pre-wrap',
          }}>
            {entry.content}
          </div>
        )}

        {entry.error && (
          <div style={{
            marginBottom: 16, padding: '12px 14px', borderRadius: 8,
            background: '#1a1010', border: '1px solid #4a2020',
            ...mono, color: '#f44336', lineHeight: 1.6,
          }}>
            {entry.error}
          </div>
        )}

        <div style={{ ...mono, fontSize: 10, color: '#555' }}>
          Session: {entry.sessionId}
        </div>
      </div>
    </div>
  )
}

// ── Stat Card ───────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={card}>
      <div style={statLabel}>{label}</div>
      <div style={{ ...statNum, color: color || '#e0e0e0' }}>{value}</div>
    </div>
  )
}

// ── Component ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  const [expandedSessions, setExpandedSessions] = useState(false)
  const [indexStatus, setIndexStatus] = useState<InlineStatus | null>(null)
  const [heartbeatStatus, setHeartbeatStatus] = useState<InlineStatus | null>(null)
  const [selectedHeartbeat, setSelectedHeartbeat] = useState<HeartbeatLogEntry | null>(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const fetchData = async () => {
    try {
      const res = await fetch('/api/dashboard')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json() as DashboardData)
      setError('')
    } catch {
      setError('Cannot connect to gateway')
    }
  }

  useEffect(() => {
    fetchData()
    const i = setInterval(fetchData, 30000)
    return () => clearInterval(i)
  }, [])

  // Refetch when any relevant resource changes via WebSocket
  useEffect(() => {
    return onDataUpdate((resource) => {
      if (['cron', 'plugins', 'tools', 'memory_files', 'sessions', 'heartbeat_log'].includes(resource)) {
        fetchData()
      }
    })
  }, [])

  const showInlineStatus = (
    setter: React.Dispatch<React.SetStateAction<InlineStatus | null>>,
    message: string,
    type: 'success' | 'error'
  ) => {
    setter({ message, type })
    setTimeout(() => setter(null), 3000)
  }

  const handleIndexAction = (action: string) => {
    fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `/index ${action}` }) })
      .then(r => r.json())
      .then((d: any) => showInlineStatus(setIndexStatus, d.result || 'Done', 'success'))
      .catch(() => showInlineStatus(setIndexStatus, 'Command failed', 'error'))
  }

  const handleHeartbeatAction = (action: string) => {
    fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `/heartbeat ${action}` }) })
      .then(r => r.json())
      .then((d: any) => showInlineStatus(setHeartbeatStatus, d.result || 'Done', 'success'))
      .catch(() => showInlineStatus(setHeartbeatStatus, 'Command failed', 'error'))
  }

  const grid4Style: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr 1fr 1fr',
    gap: 12,
  }

  if (error) return (
    <div style={{ padding: 40, color: '#f44336', textAlign: 'center' }}>
      <div style={{ fontSize: 20, marginBottom: 8 }}>{error}</div>
      <div style={{ fontSize: 12, color: '#888' }}>Retrying every 5s...</div>
    </div>
  )

  if (!data) return (
    <div style={{ padding: 40, color: '#888', textAlign: 'center' }}>Loading dashboard...</div>
  )

  const { tools, memory, sessions, presence, skills, plugins } = data

  return (
    <div style={{ padding: 20, maxWidth: 960 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Dashboard</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: statusColor(presence.status),
            boxShadow: `0 0 6px ${statusColor(presence.status)}`,
          }} />
          <span style={{ fontSize: 13, color: '#aaa', textTransform: 'capitalize' as const }}>
            {presence.status}{presence.typing ? ' (typing...)' : ''}
          </span>
        </div>
      </div>

      {/* ── Top Stats Row ──────────────────────────────────────────── */}
      <div style={grid4Style}>
        <StatCard label="UPTIME" value={fmtUptime(data.uptime)} />
        <StatCard label="MODEL" value={data.model.split('/').pop() || data.model} color="#4fc3f7" />
        <StatCard label="SESSIONS" value={sessions.total} />
        <StatCard label="MESSAGES" value={sessions.totalMessages} />
      </div>

      {/* ── Tool Loading Stats ─────────────────────────────────────── */}
      <div style={{ ...card, marginTop: 4 }}>
        <div style={sectionTitle}>Tool Registry</div>
        <div style={grid4Style}>
          <div>
            <div style={{ ...statNum, fontSize: 22 }}>{tools.coreToolCount}</div>
            <div style={statLabel}>CORE (ALWAYS LOADED)</div>
          </div>
          <div>
            <div style={{ ...statNum, fontSize: 22 }}>{tools.deferredToolCount}</div>
            <div style={statLabel}>DEFERRED (ON-DEMAND)</div>
          </div>
          <div>
            <div style={{ ...statNum, fontSize: 22, color: '#4caf50' }}>{tools.totalPromotions}</div>
            <div style={statLabel}>TOTAL LOADS</div>
          </div>
          <div>
            <div style={{ ...statNum, fontSize: 22, color: '#ff9800' }}>{tools.totalDemotions}</div>
            <div style={statLabel}>TOTAL UNLOADS</div>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Core Tools</div>
          <div>{tools.coreTools.map(t => (
              <span key={t} style={{ ...pillGreen, cursor: 'pointer' }} onClick={() => {
                fetch('/api/tools/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: t }) })
                  .then(() => fetchData()).catch(() => {})
              }} title="Click to unload">
                {t} ×
              </span>
            ))}</div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Deferred Catalog</div>
          <div>{tools.deferredTools.map(t => (
              <span key={t.name} style={{ ...pill, cursor: 'pointer' }} title={t.summary + (t.actions ? `\nActions: ${t.actions.join(', ')}` : '') + '\nClick to load'} onClick={() => {
                fetch('/api/tools/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: t.name }) })
                  .then(() => fetchData()).catch(() => {})
              }}>
                + {t.name}{t.actions ? ` (${t.actions.length})` : ''}
              </span>
            ))}</div>
        </div>

        {/* Per-session promotions */}
        {tools.sessionCount > 0 && (
          <div style={{ marginTop: 10 }}>
            <div
              style={{ fontSize: 11, color: '#666', marginBottom: 4, cursor: 'pointer' }}
              onClick={() => setExpandedSessions(!expandedSessions)}
            >
              Per-Session Promotions ({tools.sessionCount} sessions) {expandedSessions ? '[-]' : '[+]'}
            </div>
            {expandedSessions && tools.sessions.map(s => (
              <div key={s.sessionId} style={{ ...mono, marginBottom: 4, paddingLeft: 8 }}>
                <span style={{ color: '#666' }}>{s.sessionId.slice(0, 20)}...</span>
                {s.promotedTools.length > 0
                  ? s.promotedTools.map(t => <span key={t} style={{ ...pill, fontSize: 10 }}>{t}</span>)
                  : <span style={{ color: '#555', marginLeft: 8 }}>none</span>
                }
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Sessions & Clients Row ─────────────────────────────────── */}
      <div style={grid3}>
        <div style={card}>
          <div style={sectionTitle}>Channels</div>
          {Object.entries(sessions.byChannel).length > 0
            ? Object.entries(sessions.byChannel).map(([ch, count]) => (
                <div key={ch} style={{ display: 'flex', justifyContent: 'space-between', ...mono, marginBottom: 4 }}>
                  <span style={{ textTransform: 'capitalize' as const }}>{ch}</span>
                  <span style={{ color: '#4fc3f7' }}>{count}</span>
                </div>
              ))
            : <div style={mono}>No active channels</div>
          }
        </div>
        <div style={card}>
          <div style={sectionTitle}>Connected Clients</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...mono, marginBottom: 4 }}>
            <span>Webchat</span><span style={{ color: '#4fc3f7' }}>{data.webchatClients}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...mono }}>
            <span>Canvas</span><span style={{ color: '#4fc3f7' }}>{data.canvasClients}</span>
          </div>
        </div>
        <div style={card}>
          <div style={sectionTitle}>Presence</div>
          <div style={mono}>
            <div style={{ marginBottom: 4 }}>
              Status: <span style={{ color: statusColor(presence.status) }}>{presence.status}</span>
            </div>
            <div style={{ marginBottom: 4 }}>Agent: {presence.agentId}</div>
            <div>Last active: {timeSince(presence.lastActivity)}</div>
          </div>
        </div>
      </div>

      {/* ── Memory Stats ───────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionTitle}>Memory</div>
        {memory ? (
          <>
            <div style={grid3}>
              <div>
                <div style={{ ...statNum, fontSize: 20, color: memory.indexEnabled ? '#4caf50' : '#f44336' }}>
                  {memory.indexEnabled ? 'Active' : 'Disabled'}
                </div>
                <div style={statLabel}>SEMANTIC INDEX</div>
              </div>
              <div>
                <div style={{ ...statNum, fontSize: 20 }}>{memory.totalChunks}</div>
                <div style={statLabel}>CHUNKS INDEXED</div>
              </div>
              <div>
                <div style={{ ...statNum, fontSize: 20 }}>{memory.indexedFiles.length}</div>
                <div style={statLabel}>FILES INDEXED</div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>Identity Files</div>
              <div style={grid3}>
                {memory.identityFiles.map(f => (
                  <div key={f.name} style={{
                    ...mono, padding: '6px 10px', borderRadius: 6,
                    background: f.exists ? '#0d1f0d' : '#1a1a1a',
                    border: `1px solid ${f.exists ? '#1a3a1a' : '#222'}`,
                  }}>
                    <div style={{ color: f.exists ? '#4caf50' : '#555', marginBottom: 2 }}>{f.name}</div>
                    <div style={{ fontSize: 10, color: '#666' }}>
                      {f.exists ? fmtBytes(f.size) : 'not found'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div style={mono}>Memory manager not initialized</div>
        )}
      </div>

      {/* ── Skills & Plugins Row ───────────────────────────────────── */}
      <div style={grid2}>
        <div style={card}>
          <div style={sectionTitle}>Skills ({skills.length})</div>
          {skills.length > 0 ? skills.map(s => (
            <div key={s.name} style={{ ...mono, marginBottom: 6 }}>
              <div style={{ color: '#4fc3f7' }}>{s.name}</div>
              <div style={{ fontSize: 10, color: '#666' }}>{s.description}</div>
            </div>
          )) : <div style={mono}>No skills loaded</div>}
        </div>
        <div style={card}>
          <div style={sectionTitle}>Plugins ({plugins.length})</div>
          {plugins.length > 0 ? plugins.map(p => (
            <div key={p.name} style={{ ...mono, marginBottom: 6 }}>
              <div style={{ color: '#ff9800' }}>{p.name}</div>
              <div style={{ fontSize: 10, color: '#666' }}>
                {p.summary.replace(/^Plugin tool:\s*/, '')}
              </div>
              {p.actions && (
                <div style={{ marginTop: 2 }}>
                  {p.actions.map(a => <span key={a} style={{ ...pill, fontSize: 9, background: '#1a1a2e', color: '#9e9eff' }}>{a}</span>)}
                </div>
              )}
            </div>
          )) : <div style={mono}>No plugin tools registered</div>}
        </div>
      </div>

      {/* ── Index & Heartbeat Controls ──────────────────────────────── */}
      <div style={grid2}>
        <div style={card}>
          <div style={sectionTitle}>Index Controls</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['on', 'off', 'rebuild'].map(action => (
              <button key={action} onClick={() => handleIndexAction(action)} style={{
                padding: '6px 16px', background: '#1a1a2e', color: '#4fc3f7',
                border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 12,
                textTransform: 'capitalize' as const,
              }}>
                {action === 'on' ? 'Enable' : action === 'off' ? 'Disable' : 'Rebuild'}
              </button>
            ))}
          </div>
          {indexStatus && (
            <div style={{
              marginTop: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              padding: '6px 10px',
              borderRadius: 4,
              background: indexStatus.type === 'success' ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)',
              color: indexStatus.type === 'success' ? '#4caf50' : '#f44336',
              border: `1px solid ${indexStatus.type === 'success' ? '#4caf50' : '#f44336'}`,
            }}>
              {indexStatus.message}
            </div>
          )}
        </div>
        <div style={card}>
          <div style={sectionTitle}>Heartbeat Controls</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['on', 'off', 'now'].map(action => (
              <button key={action} onClick={() => handleHeartbeatAction(action)} style={{
                padding: '6px 16px', background: '#1a1a2e', color: '#4fc3f7',
                border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 12,
                textTransform: 'capitalize' as const,
              }}>
                {action === 'on' ? 'Enable' : action === 'off' ? 'Disable' : 'Trigger Now'}
              </button>
            ))}
          </div>
          {heartbeatStatus && (
            <div style={{
              marginTop: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              padding: '6px 10px',
              borderRadius: 4,
              background: heartbeatStatus.type === 'success' ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)',
              color: heartbeatStatus.type === 'success' ? '#4caf50' : '#f44336',
              border: `1px solid ${heartbeatStatus.type === 'success' ? '#4caf50' : '#f44336'}`,
            }}>
              {heartbeatStatus.message}
            </div>
          )}
        </div>
      </div>

      {/* ── Heartbeat History ──────────────────────────────────────────── */}
      <div style={card}>
        <div style={sectionTitle}>Heartbeat History</div>
        {data.heartbeatLog && data.heartbeatLog.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.heartbeatLog.map((entry, i) => (
              <div
                key={entry.sessionId + i}
                onClick={() => setSelectedHeartbeat(entry)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderRadius: 6,
                  background: '#111', border: '1px solid #222',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = '#444')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = '#222')}
              >
                <span style={statusBadge(entry.status)}>
                  {entry.status === 'sent' ? 'ALERT' : entry.status === 'failed' ? 'ERR' : 'OK'}
                </span>
                <span style={{ ...mono, color: '#888', minWidth: 70, fontSize: 11 }}>
                  {timeSince(entry.timestamp)}
                </span>
                <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...mono, fontSize: 11, color: '#aaa' }}>
                  {entry.content ? entry.content.slice(0, 80) : entry.error ? entry.error.slice(0, 80) : entry.status.replace(/-/g, ' ')}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...mono, color: '#555', padding: '12px 0' }}>
            No heartbeat runs yet. Enable heartbeat and trigger one to see results here.
          </div>
        )}
      </div>

      {/* Heartbeat Detail Modal */}
      {selectedHeartbeat && (
        <HeartbeatModal entry={selectedHeartbeat} onClose={() => setSelectedHeartbeat(null)} />
      )}
    </div>
  )
}
