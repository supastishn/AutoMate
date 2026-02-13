import React, { useEffect, useState } from 'react'
import { useColors } from '../ThemeContext'

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

// ── Styles (theme-dependent) ──────────────────────────────────────────
function makeStyles(colors: Record<string, string>) {
  const card: React.CSSProperties = {
    background: colors.bgSecondary, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', background: colors.bgTertiary, border: `1px solid ${colors.borderLight}`,
    borderRadius: 4, color: colors.textPrimary, fontSize: 12, outline: 'none', fontFamily: 'monospace',
    boxSizing: 'border-box' as const,
  }

  const btnPrimary: React.CSSProperties = {
    padding: '7px 18px', background: colors.accent, color: colors.accentContrast, border: 'none',
    borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
  }

  const btnGhost: React.CSSProperties = {
    padding: '5px 12px', background: 'transparent', color: colors.accent,
    border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
  }

  const btnDanger: React.CSSProperties = {
    padding: '5px 12px', background: colors.bgDanger, color: colors.error,
    border: `1px solid ${colors.borderDanger}`, borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
  }

  const badge = (active: boolean): React.CSSProperties => ({
    fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
    background: active ? colors.accentMuted : colors.bgHover,
    color: active ? colors.accent : colors.textMuted,
    border: `1px solid ${active ? colors.borderFocus : colors.borderLight}`,
  })

  const metaRow: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.textMuted, marginBottom: 2,
  }

  const metaLabel: React.CSSProperties = {
    color: colors.textMuted, minWidth: 70, flexShrink: 0,
  }

  const metaValue: React.CSSProperties = {
    color: colors.textSecondary, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' as const,
  }

  const sectionHeader: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: colors.textMuted, textTransform: 'uppercase' as const,
    letterSpacing: 1, marginBottom: 8, marginTop: 16,
  }

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: colors.bgTertiary, border: `1px solid ${colors.borderLight}`, borderRadius: 12,
    padding: '2px 10px', fontSize: 11, color: colors.textPrimary, marginRight: 4, marginBottom: 4,
  }

  return { card, inputStyle, btnPrimary, btnGhost, btnDanger, badge, metaRow, metaLabel, metaValue, sectionHeader, chipStyle }
}

// ── Agent Card ──────────────────────────────────────────────────
function AgentCard({ agent, onReload, showToast, colors }: {
  agent: AgentInfo
  onReload: () => void
  showToast: (msg: string, err?: boolean) => void
  colors: Record<string, string>
}) {
  const styles = makeStyles(colors)
  const { card, inputStyle, btnPrimary, btnGhost, btnDanger, badge, metaRow, metaLabel, metaValue, sectionHeader, chipStyle } = styles
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
    <div style={{ ...card, borderLeft: agent.isDefault ? `3px solid ${colors.accent}` : '3px solid transparent' }}>
      {/* Header bar */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: colors.accent }}>{agent.name}</span>
          {agent.isDefault && <span style={badge(true)}>default</span>}
          {agent.heartbeat && <span style={badge(agent.heartbeat.active)}>♥ {agent.heartbeat.active ? 'on' : 'off'}</span>}
          <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 'auto', flexShrink: 0 }}>
            {agent.sessionCount || 0} sessions · {agent.skillCount || 0} skills
          </span>
        </div>
        <span style={{ color: colors.textMuted, fontSize: 14, marginLeft: 12, transition: 'transform .2s', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
      </div>

      {/* Summary row (always visible) */}
      <div style={{ padding: '0 20px 12px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: colors.textSecondary }}>
        {agent.model && <span>Model: <span style={{ color: colors.textPrimary, fontFamily: 'monospace' }}>{agent.model}</span></span>}
        <span>Channels: <span style={{ color: colors.textPrimary }}>{agent.channels.join(', ')}</span></span>
        <span>Allow: <span style={{ color: colors.textPrimary }}>{agent.allowFrom.join(', ')}</span></span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${colors.border}`, padding: 20 }}>
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
            <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>
              Channels
              <span onClick={() => { setEditChannels(!editChannels); setChannelsInput(agent.channels.join(', ')) }}
                style={{ color: colors.accent, marginLeft: 8, cursor: 'pointer', fontSize: 11 }}>
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
            <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>
              Allow From
              <span onClick={() => { setEditAllowFrom(!editAllowFrom); setAllowFromInput(agent.allowFrom.join(', ')) }}
                style={{ color: colors.accent, marginLeft: 8, cursor: 'pointer', fontSize: 11 }}>
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
                  <span style={{ fontSize: 11, color: colors.textMuted }}>Allow: </span>
                  {agent.tools.allow.map((t, i) => <span key={i} style={{ ...chipStyle, borderColor: colors.borderSuccess, color: colors.success }}>{t}</span>)}
                </div>
              )}
              {agent.tools.deny.length > 0 && (
                <div>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>Deny: </span>
                  {agent.tools.deny.map((t, i) => <span key={i} style={{ ...chipStyle, borderColor: colors.borderDanger, color: colors.error }}>{t}</span>)}
                </div>
              )}
            </>
          )}

          {/* System Prompt preview */}
          <div style={sectionHeader}>System Prompt</div>
          <div style={{
            background: colors.bgPrimary, border: `1px solid ${colors.border}`, borderRadius: 4,
            padding: 12, fontSize: 12, color: colors.textSecondary, fontFamily: 'monospace',
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
function CreateAgentForm({ onCreated, showToast, colors }: {
  onCreated: () => void
  showToast: (msg: string, err?: boolean) => void
  colors: Record<string, string>
}) {
  const styles = makeStyles(colors)
  const { inputStyle, btnPrimary } = styles
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
    <div style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 20, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, marginBottom: 14, color: colors.textPrimary }}>Create New Agent</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Name *</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. coder" style={inputStyle}
            onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Model (optional — inherits default)</div>
          <input value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. claude-sonnet-4-20250514" style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Channel patterns (comma-separated)</div>
          <input value={channels} onChange={e => setChannels(e.target.value)} placeholder="* (all)" style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Allow from (comma-separated user IDs)</div>
          <input value={allowFrom} onChange={e => setAllowFrom(e.target.value)} placeholder="* (all)" style={inputStyle} />
        </div>
      </div>

      {/* Advanced toggle */}
      <div onClick={() => setShowAdvanced(!showAdvanced)}
        style={{ fontSize: 12, color: colors.accent, cursor: 'pointer', marginTop: 12, userSelect: 'none' }}>
        {showAdvanced ? '▼' : '▶'} Advanced options
      </div>
      {showAdvanced && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Max Tokens</div>
              <input type="number" value={maxTokens} onChange={e => setMaxTokens(e.target.value)} placeholder="8192" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>Temperature</div>
              <input type="number" step="0.1" value={temperature} onChange={e => setTemperature(e.target.value)} placeholder="0.3" style={inputStyle} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>System Prompt</div>
          <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Custom system prompt for this agent (leave empty to use default)…"
            style={{ ...inputStyle, minHeight: 100, resize: 'vertical' as const, lineHeight: 1.5 }} />
        </div>
      )}

      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={!name.trim() || creating} style={{
          ...btnPrimary,
          background: name.trim() && !creating ? colors.accent : colors.borderLight,
          color: name.trim() && !creating ? colors.accentContrast : colors.textMuted,
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
  const colors = useColors()
  const styles = makeStyles(colors)
  const { btnPrimary, btnGhost } = styles
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
    <div style={{ padding: 30, maxWidth: 1000, minHeight: '100vh', background: colors.bgPrimary }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: colors.textPrimary }}>Agents</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadAgents} style={btnGhost} title="Refresh">↻</button>
          <button onClick={() => setShowCreate(!showCreate)} style={{
            ...btnPrimary,
            background: showCreate ? colors.borderLight : colors.accent,
            color: showCreate ? colors.textSecondary : colors.accentContrast,
          }}>
            {showCreate ? 'Cancel' : '+ New Agent'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: 20 }}>
        Multi-agent system with isolated memory, sessions, skills, and channel-based routing.
        Click an agent to expand its full configuration.
      </div>

      {showCreate && <CreateAgentForm onCreated={() => { setShowCreate(false); loadAgents() }} showToast={showToast} colors={colors} />}

      {loading ? (
        <div style={{ color: colors.textMuted, fontSize: 13, padding: 20, textAlign: 'center' }}>Loading agents…</div>
      ) : agents.length === 0 ? (
        <div style={{ background: colors.bgSecondary, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 24, color: colors.textMuted, fontSize: 13 }}>
          No multi-agent profiles configured. The system is running with a single default agent.
          <br /><br />
          Add agent profiles in your <code style={{ color: colors.accent }}>automate.json</code> under the{' '}
          <code style={{ color: colors.accent }}>"agents"</code> array, or click <b>+ New Agent</b> above.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map(agent => (
            <AgentCard key={agent.name} agent={agent} onReload={loadAgents} showToast={showToast} colors={colors} />
          ))}
        </div>
      )}

      {/* Info card */}
      <div style={{ background: colors.bgSecondary, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 20, marginTop: 20 }}>
        <h3 style={{ fontSize: 13, marginBottom: 8, color: colors.textMuted, fontWeight: 600 }}>How Multi-Agent Routing Works</h3>
        <div style={{ fontSize: 12, color: colors.textMuted, lineHeight: 1.7 }}>
          Each agent has <b style={{ color: colors.textSecondary }}>isolated memory, sessions, and skills</b>. Messages are routed based
          on channel patterns (e.g., <code style={{ color: colors.accent }}>discord:*</code> routes all Discord
          messages to a specific agent). The <b style={{ color: colors.textSecondary }}>default agent</b> handles messages that don't match any pattern.
          Agents share a common <code style={{ color: colors.accent }}>shared_memory</code> directory for coordination.
          <br /><br />
          Chat commands: <code style={{ color: colors.accent }}>/agents list</code> · <code style={{ color: colors.accent }}>/agents switch &lt;name&gt;</code>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 30, right: 30, padding: '12px 24px',
          background: toast.err ? colors.error : colors.success, color: '#fff',
          borderRadius: 8, fontSize: 13, zIndex: 300, maxWidth: 400,
          boxShadow: `0 4px 12px ${colors.shadow}`,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
