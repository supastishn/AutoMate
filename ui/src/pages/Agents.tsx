import React, { useEffect, useState } from 'react'

interface AgentInfo {
  name: string
  channels: string[]
  allowFrom: string[]
  isDefault: boolean
  model?: string
  apiBase?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  memoryDir?: string
  sessionsDir?: string
  skillsDir?: string
  sessionCount?: number
  skillCount?: number
  tools?: { allow: string[]; deny: string[] }
  heartbeat?: { active: boolean } | null
}

const API = ''

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('automate_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ── Styles ──────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: '#111', border: '1px solid #222', borderRadius: 8, overflow: 'hidden',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', background: '#1a1a2e', border: '1px solid #333',
  borderRadius: 4, color: '#e0e0e0', fontSize: 12, outline: 'none', fontFamily: 'monospace',
  boxSizing: 'border-box' as const,
}

const btnPrimary: React.CSSProperties = {
  padding: '7px 18px', background: '#4fc3f7', color: '#000', border: 'none',
  borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
}

const btnGhost: React.CSSProperties = {
  padding: '5px 12px', background: 'transparent', color: '#4fc3f7',
  border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
}

const btnDanger: React.CSSProperties = {
  padding: '5px 12px', background: '#2e1a1a', color: '#f44336',
  border: '1px solid #4a2a2a', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
}

const badge = (active: boolean): React.CSSProperties => ({
  fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
  background: active ? '#0d2137' : '#1a1a1a',
  color: active ? '#4fc3f7' : '#666',
  border: `1px solid ${active ? '#1a5276' : '#333'}`,
})

const metaRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#666', marginBottom: 2,
}

const metaLabel: React.CSSProperties = {
  color: '#555', minWidth: 70, flexShrink: 0,
}

const metaValue: React.CSSProperties = {
  color: '#aaa', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' as const,
}

const sectionHeader: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#555', textTransform: 'uppercase' as const,
  letterSpacing: 1, marginBottom: 8, marginTop: 16,
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  background: '#1a1a2e', border: '1px solid #333', borderRadius: 12,
  padding: '2px 10px', fontSize: 11, color: '#e0e0e0', marginRight: 4, marginBottom: 4,
}

// ── Agent Card ──────────────────────────────────────────────────
function AgentCard({ agent, onReload, showToast }: {
  agent: AgentInfo
  onReload: () => void
  showToast: (msg: string, err?: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [editChannels, setEditChannels] = useState(false)
  const [editAllowFrom, setEditAllowFrom] = useState(false)
  const [channelsInput, setChannelsInput] = useState(agent.channels.join(', '))
  const [allowFromInput, setAllowFromInput] = useState(agent.allowFrom.join(', '))
  const [saving, setSaving] = useState(false)
  const [hbAction, setHbAction] = useState<string | null>(null)

  const switchDefault = () => {
    setSwitching(true)
    fetch(`${API}/api/agents/default`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agent.name }),
    })
      .then(r => r.json())
      .then(d => { if (d.ok) { showToast(`Default → "${agent.name}"`); onReload() } else showToast(d.error || 'Failed', true) })
      .catch(() => showToast('Switch failed', true))
      .finally(() => setSwitching(false))
  }

  const remove = () => {
    if (!confirm(`Remove agent "${agent.name}"? Scheduler stops, sessions saved.`)) return
    setRemoving(true)
    fetch(`${API}/api/agents/${encodeURIComponent(agent.name)}`, { method: 'DELETE', headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (d.ok) { showToast(`"${agent.name}" removed`); onReload() } else showToast(d.error || 'Failed', true) })
      .catch(() => showToast('Remove failed', true))
      .finally(() => setRemoving(false))
  }

  const saveField = (body: Record<string, any>) => {
    setSaving(true)
    fetch(`${API}/api/agents/${encodeURIComponent(agent.name)}`, {
      method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(d => { if (d.ok) { showToast(`Updated ${agent.name}`); onReload() } else showToast(d.error || 'Update failed', true) })
      .catch(() => showToast('Update failed', true))
      .finally(() => { setSaving(false); setEditChannels(false); setEditAllowFrom(false) })
  }

  const heartbeatAction = (action: string) => {
    setHbAction(action)
    fetch(`${API}/api/agents/${encodeURIComponent(agent.name)}`, {
      method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ heartbeat: action }),
    })
      .then(r => r.json())
      .then(d => { if (d.ok) { showToast(`Heartbeat ${action}`); onReload() } else showToast(d.error || 'Failed', true) })
      .catch(() => showToast('Failed', true))
      .finally(() => setHbAction(null))
  }

  const promptPreview = agent.systemPrompt
    ? (agent.systemPrompt.length > 120 ? agent.systemPrompt.slice(0, 120) + '…' : agent.systemPrompt)
    : '(default)'

  return (
    <div style={{ ...card, borderLeft: agent.isDefault ? '3px solid #4fc3f7' : '3px solid transparent' }}>
      {/* Header bar */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: '#4fc3f7' }}>{agent.name}</span>
          {agent.isDefault && <span style={badge(true)}>default</span>}
          {agent.heartbeat && <span style={badge(agent.heartbeat.active)}>♥ {agent.heartbeat.active ? 'on' : 'off'}</span>}
          <span style={{ fontSize: 11, color: '#555', marginLeft: 'auto', flexShrink: 0 }}>
            {agent.sessionCount || 0} sessions · {agent.skillCount || 0} skills
          </span>
        </div>
        <span style={{ color: '#555', fontSize: 14, marginLeft: 12, transition: 'transform .2s', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
      </div>

      {/* Summary row (always visible) */}
      <div style={{ padding: '0 20px 12px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: '#888' }}>
        {agent.model && <span>Model: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{agent.model}</span></span>}
        <span>Channels: <span style={{ color: '#ccc' }}>{agent.channels.join(', ')}</span></span>
        <span>Allow: <span style={{ color: '#ccc' }}>{agent.allowFrom.join(', ')}</span></span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: '1px solid #1e1e1e', padding: 20 }}>
          {/* Actions bar */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {!agent.isDefault && (
              <button onClick={switchDefault} disabled={switching} style={btnGhost}>
                {switching ? 'Switching…' : '⭐ Set Default'}
              </button>
            )}
            {agent.heartbeat && (
              <>
                <button onClick={() => heartbeatAction(agent.heartbeat!.active ? 'off' : 'on')} disabled={!!hbAction} style={btnGhost}>
                  {hbAction ? '…' : agent.heartbeat.active ? '⏸ Stop Heartbeat' : '▶ Start Heartbeat'}
                </button>
                <button onClick={() => heartbeatAction('now')} disabled={!!hbAction} style={btnGhost}>
                  ♥ Trigger Now
                </button>
              </>
            )}
            <button onClick={remove} disabled={removing} style={{ ...btnDanger, marginLeft: 'auto' }}>
              {removing ? 'Removing…' : '🗑 Remove'}
            </button>
          </div>

          {/* Model & Config */}
          <div style={sectionHeader}>Configuration</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px' }}>
            <div style={metaRow}><span style={metaLabel}>Model</span><span style={metaValue}>{agent.model || '(inherited)'}</span></div>
            <div style={metaRow}><span style={metaLabel}>API Base</span><span style={metaValue}>{agent.apiBase || '(inherited)'}</span></div>
            <div style={metaRow}><span style={metaLabel}>Max Tokens</span><span style={metaValue}>{agent.maxTokens ?? '—'}</span></div>
            <div style={metaRow}><span style={metaLabel}>Temperature</span><span style={metaValue}>{agent.temperature ?? '—'}</span></div>
          </div>

          {/* Directories */}
          <div style={sectionHeader}>Directories</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px' }}>
            <div style={metaRow}><span style={metaLabel}>Memory</span><span style={metaValue}>{agent.memoryDir || '—'}</span></div>
            <div style={metaRow}><span style={metaLabel}>Sessions</span><span style={metaValue}>{agent.sessionsDir || '—'}</span></div>
            <div style={metaRow}><span style={metaLabel}>Skills</span><span style={metaValue}>{agent.skillsDir || '—'}</span></div>
          </div>

          {/* Channels (editable) */}
          <div style={sectionHeader}>Routing</div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
              Channels
              <span onClick={() => { setEditChannels(!editChannels); setChannelsInput(agent.channels.join(', ')) }}
                style={{ color: '#4fc3f7', marginLeft: 8, cursor: 'pointer', fontSize: 11 }}>
                {editChannels ? 'cancel' : 'edit'}
              </span>
            </div>
            {editChannels ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={channelsInput} onChange={e => setChannelsInput(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                <button disabled={saving} onClick={() => saveField({ channels: channelsInput.split(',').map(s => s.trim()).filter(Boolean) })} style={btnPrimary}>
                  {saving ? '…' : 'Save'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {agent.channels.map((ch, i) => <span key={i} style={chipStyle}>{ch}</span>)}
              </div>
            )}
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
              Allow From
              <span onClick={() => { setEditAllowFrom(!editAllowFrom); setAllowFromInput(agent.allowFrom.join(', ')) }}
                style={{ color: '#4fc3f7', marginLeft: 8, cursor: 'pointer', fontSize: 11 }}>
                {editAllowFrom ? 'cancel' : 'edit'}
              </span>
            </div>
            {editAllowFrom ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={allowFromInput} onChange={e => setAllowFromInput(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                <button disabled={saving} onClick={() => saveField({ allowFrom: allowFromInput.split(',').map(s => s.trim()).filter(Boolean) })} style={btnPrimary}>
                  {saving ? '…' : 'Save'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {agent.allowFrom.map((u, i) => <span key={i} style={chipStyle}>{u}</span>)}
              </div>
            )}
          </div>

          {/* Tools policy */}
          {agent.tools && (agent.tools.allow.length > 0 || agent.tools.deny.length > 0) && (
            <>
              <div style={sectionHeader}>Tool Policy</div>
              {agent.tools.allow.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: '#555' }}>Allow: </span>
                  {agent.tools.allow.map((t, i) => <span key={i} style={{ ...chipStyle, borderColor: '#2a4a2a', color: '#81c784' }}>{t}</span>)}
                </div>
              )}
              {agent.tools.deny.length > 0 && (
                <div>
                  <span style={{ fontSize: 11, color: '#555' }}>Deny: </span>
                  {agent.tools.deny.map((t, i) => <span key={i} style={{ ...chipStyle, borderColor: '#4a2a2a', color: '#e57373' }}>{t}</span>)}
                </div>
              )}
            </>
          )}

          {/* System Prompt preview */}
          <div style={sectionHeader}>System Prompt</div>
          <div style={{
            background: '#0a0a0a', border: '1px solid #1e1e1e', borderRadius: 4,
            padding: 12, fontSize: 12, color: '#888', fontFamily: 'monospace',
            lineHeight: 1.5, whiteSpace: 'pre-wrap' as const, maxHeight: 200, overflowY: 'auto' as const,
          }}>
            {agent.systemPrompt || '(using default system prompt)'}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Create Form ─────────────────────────────────────────────────
function CreateAgentForm({ onCreated, showToast }: {
  onCreated: () => void
  showToast: (msg: string, err?: boolean) => void
}) {
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [channels, setChannels] = useState('*')
  const [allowFrom, setAllowFrom] = useState('*')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [temperature, setTemperature] = useState('')
  const [creating, setCreating] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const submit = () => {
    if (!name.trim()) return
    setCreating(true)
    const profile: any = {
      name: name.trim(),
      channels: channels.split(',').map(s => s.trim()).filter(Boolean),
      allowFrom: allowFrom.split(',').map(s => s.trim()).filter(Boolean),
    }
    if (model.trim()) profile.model = model.trim()
    if (systemPrompt.trim()) profile.systemPrompt = systemPrompt.trim()
    if (maxTokens) profile.maxTokens = Number(maxTokens)
    if (temperature) profile.temperature = Number(temperature)

    fetch(`${API}/api/agents`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          showToast(`Agent "${name}" created`)
          setName(''); setModel(''); setChannels('*'); setAllowFrom('*')
          setSystemPrompt(''); setMaxTokens(''); setTemperature('')
          onCreated()
        } else showToast(d.error || 'Create failed', true)
      })
      .catch(() => showToast('Create failed', true))
      .finally(() => setCreating(false))
  }

  return (
    <div style={{ background: '#141414', border: '1px solid #333', borderRadius: 8, padding: 20, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, marginBottom: 14, color: '#e0e0e0' }}>Create New Agent</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Name *</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. coder" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Model (optional — inherits default)</div>
          <input value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. claude-sonnet-4-20250514" style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Channel patterns (comma-separated)</div>
          <input value={channels} onChange={e => setChannels(e.target.value)} placeholder="* (all)" style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Allow from (comma-separated user IDs)</div>
          <input value={allowFrom} onChange={e => setAllowFrom(e.target.value)} placeholder="* (all)" style={inputStyle} />
        </div>
      </div>

      {/* Advanced toggle */}
      <div onClick={() => setShowAdvanced(!showAdvanced)}
        style={{ fontSize: 12, color: '#4fc3f7', cursor: 'pointer', marginTop: 12, userSelect: 'none' }}>
        {showAdvanced ? '▼' : '▶'} Advanced options
      </div>
      {showAdvanced && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Max Tokens</div>
              <input type="number" value={maxTokens} onChange={e => setMaxTokens(e.target.value)} placeholder="8192" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Temperature</div>
              <input type="number" step="0.1" value={temperature} onChange={e => setTemperature(e.target.value)} placeholder="0.3" style={inputStyle} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>System Prompt</div>
          <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Custom system prompt for this agent (leave empty to use default)…"
            style={{ ...inputStyle, minHeight: 100, resize: 'vertical' as const, lineHeight: 1.5 }} />
        </div>
      )}

      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={!name.trim() || creating} style={{
          ...btnPrimary,
          background: name.trim() && !creating ? '#4fc3f7' : '#333',
          color: name.trim() && !creating ? '#000' : '#666',
          cursor: name.trim() && !creating ? 'pointer' : 'default',
        }}>
          {creating ? 'Creating…' : 'Create Agent'}
        </button>
      </div>
    </div>
  )
}

// ── Main Page ───────────────────────────────────────────────────
export default function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 4000)
  }

  const loadAgents = () => {
    setLoading(true)
    fetch(`${API}/api/agents`, { headers: authHeaders() })
      .then(r => r.json())
      .then((d: any) => setAgents(d.agents || []))
      .catch(() => showToast('Failed to load agents', true))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadAgents() }, [])

  return (
    <div style={{ padding: 30, maxWidth: 1000, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: '#e0e0e0' }}>Agents</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadAgents} style={btnGhost} title="Refresh">↻</button>
          <button onClick={() => setShowCreate(!showCreate)} style={{
            ...btnPrimary,
            background: showCreate ? '#333' : '#4fc3f7',
            color: showCreate ? '#888' : '#000',
          }}>
            {showCreate ? 'Cancel' : '+ New Agent'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>
        Multi-agent system with isolated memory, sessions, skills, and channel-based routing.
        Click an agent to expand its full configuration.
      </div>

      {showCreate && <CreateAgentForm onCreated={() => { setShowCreate(false); loadAgents() }} showToast={showToast} />}

      {loading ? (
        <div style={{ color: '#555', fontSize: 13, padding: 20, textAlign: 'center' }}>Loading agents…</div>
      ) : agents.length === 0 ? (
        <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 24, color: '#666', fontSize: 13 }}>
          No multi-agent profiles configured. The system is running with a single default agent.
          <br /><br />
          Add agent profiles in your <code style={{ color: '#4fc3f7' }}>automate.json</code> under the{' '}
          <code style={{ color: '#4fc3f7' }}>"agents"</code> array, or click <b>+ New Agent</b> above.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map(agent => (
            <AgentCard key={agent.name} agent={agent} onReload={loadAgents} showToast={showToast} />
          ))}
        </div>
      )}

      {/* Info card */}
      <div style={{ background: '#111', border: '1px solid #1e1e1e', borderRadius: 8, padding: 20, marginTop: 20 }}>
        <h3 style={{ fontSize: 13, marginBottom: 8, color: '#555', fontWeight: 600 }}>How Multi-Agent Routing Works</h3>
        <div style={{ fontSize: 12, color: '#555', lineHeight: 1.7 }}>
          Each agent has <b style={{ color: '#888' }}>isolated memory, sessions, and skills</b>. Messages are routed based
          on channel patterns (e.g., <code style={{ color: '#4fc3f7' }}>discord:*</code> routes all Discord
          messages to a specific agent). The <b style={{ color: '#888' }}>default agent</b> handles messages that don't match any pattern.
          Agents share a common <code style={{ color: '#4fc3f7' }}>shared_memory</code> directory for coordination.
          <br /><br />
          Chat commands: <code style={{ color: '#4fc3f7' }}>/agents list</code> · <code style={{ color: '#4fc3f7' }}>/agents switch &lt;name&gt;</code>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 30, right: 30, padding: '12px 24px',
          background: toast.err ? '#b71c1c' : '#1b5e20', color: '#fff',
          borderRadius: 8, fontSize: 13, zIndex: 300, maxWidth: 400,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
