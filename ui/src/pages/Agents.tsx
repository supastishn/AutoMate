import React, { useEffect, useState } from 'react'

interface AgentProfile {
  name: string
  model?: string
  apiBase?: string
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  memoryDir?: string
  sessionsDir?: string
  skillsDir?: string
  elevated?: boolean
  channels?: string[]
  allowFrom?: string[]
  tools?: { allow?: string[]; deny?: string[] }
}

interface ManagedAgentInfo {
  name: string
  channels: string[]
  allowFrom: string[]
  isDefault: boolean
  model?: string
  sessionCount?: number
  skillCount?: number
}

const card: React.CSSProperties = {
  background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 20,
}

const API = ''

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('automate_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export default function Agents() {
  const [agents, setAgents] = useState<ManagedAgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [defaultAgent, setDefaultAgent] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)

  // Create agent form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newChannels, setNewChannels] = useState('*')
  const [newAllowFrom, setNewAllowFrom] = useState('*')
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 4000)
  }

  const loadAgents = () => {
    setLoading(true)
    fetch(`${API}/api/agents`, { headers: authHeaders() })
      .then(r => r.json())
      .then((d: any) => {
        setAgents(d.agents || [])
        setDefaultAgent(d.defaultAgent || null)
      })
      .catch(() => showToast('Failed to load agents', true))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadAgents() }, [])

  const switchDefault = (name: string) => {
    setSwitching(name)
    fetch(`${API}/api/agents/default`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) { showToast(`Default agent switched to "${name}"`); loadAgents() }
        else showToast(d.error || 'Switch failed', true)
      })
      .catch(() => showToast('Switch failed', true))
      .finally(() => setSwitching(null))
  }

  const createAgent = () => {
    if (!newName.trim()) return
    setCreating(true)
    const profile: any = {
      name: newName.trim(),
      channels: newChannels.split(',').map(s => s.trim()).filter(Boolean),
      allowFrom: newAllowFrom.split(',').map(s => s.trim()).filter(Boolean),
    }
    if (newModel.trim()) profile.model = newModel.trim()

    fetch(`${API}/api/agents`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          showToast(`Agent "${newName}" created`)
          setNewName(''); setNewModel(''); setNewChannels('*'); setNewAllowFrom('*')
          setShowCreate(false)
          loadAgents()
        } else showToast(d.error || 'Create failed', true)
      })
      .catch(() => showToast('Create failed', true))
      .finally(() => setCreating(false))
  }

  const removeAgent = (name: string) => {
    if (!confirm(`Remove agent "${name}"? This will stop its scheduler and save sessions.`)) return
    setRemoving(name)
    fetch(`${API}/api/agents/${encodeURIComponent(name)}`, {
      method: 'DELETE', headers: authHeaders(),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) { showToast(`Agent "${name}" removed`); loadAgents() }
        else showToast(d.error || 'Remove failed', true)
      })
      .catch(() => showToast('Remove failed', true))
      .finally(() => setRemoving(null))
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', background: '#1a1a1a', border: '1px solid #333',
    borderRadius: 4, color: '#e0e0e0', fontSize: 13, outline: 'none', fontFamily: 'monospace',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ padding: 30, maxWidth: 1000 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Agents</h1>
        <button onClick={() => setShowCreate(!showCreate)} style={{
          padding: '8px 16px', background: showCreate ? '#222' : '#4fc3f7',
          color: showCreate ? '#888' : '#000', border: 'none', borderRadius: 4,
          cursor: 'pointer', fontSize: 13, fontWeight: 600,
        }}>
          {showCreate ? 'Cancel' : 'New Agent'}
        </button>
      </div>
      <div style={{ fontSize: 13, color: '#888', marginBottom: 20 }}>
        Multi-agent system with isolated memory, sessions, skills, and channel-based routing.
        Each agent operates independently with its own context.
      </div>

      {/* Create agent form */}
      {showCreate && (
        <div style={{ ...card, marginBottom: 20 }}>
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>Create Agent</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Name *</div>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. coder" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Model (optional, inherits default)</div>
              <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder="e.g. claude-sonnet-4-20250514" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Channel patterns (comma-separated)</div>
              <input value={newChannels} onChange={e => setNewChannels(e.target.value)} placeholder="* (all)" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Allow from (comma-separated user IDs)</div>
              <input value={newAllowFrom} onChange={e => setNewAllowFrom(e.target.value)} placeholder="* (all)" style={inputStyle} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={createAgent} disabled={!newName.trim() || creating} style={{
              padding: '8px 20px', background: newName.trim() && !creating ? '#4fc3f7' : '#333',
              color: newName.trim() && !creating ? '#000' : '#666', border: 'none', borderRadius: 4,
              cursor: newName.trim() && !creating ? 'pointer' : 'default', fontWeight: 600, fontSize: 13,
            }}>
              {creating ? 'Creating...' : 'Create Agent'}
            </button>
          </div>
        </div>
      )}

      {/* Agent list */}
      {loading ? (
        <div style={{ color: '#666', fontSize: 13, padding: 20 }}>Loading agents...</div>
      ) : agents.length === 0 ? (
        <div style={{ ...card, color: '#666', fontSize: 13 }}>
          No multi-agent profiles configured. The system is running with a single default agent.
          Add agent profiles in your config file under the "agents" array, or create one above.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {agents.map(agent => (
            <div key={agent.name} style={{
              ...card,
              borderLeft: agent.isDefault ? '3px solid #4fc3f7' : '3px solid transparent',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 16, fontWeight: 600, color: '#4fc3f7' }}>{agent.name}</span>
                    {agent.isDefault && (
                      <span style={{
                        fontSize: 10, padding: '2px 6px', background: '#1a1a2e',
                        color: '#4fc3f7', borderRadius: 3, border: '1px solid #2a2a3e',
                        fontWeight: 600, textTransform: 'uppercase',
                      }}>Default</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                    {agent.model && <>Model: <span style={{ color: '#aaa' }}>{agent.model}</span> &middot; </>}
                    Channels: <span style={{ color: '#aaa' }}>{agent.channels.join(', ')}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    Allow from: {agent.allowFrom.join(', ')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {!agent.isDefault && (
                    <button onClick={() => switchDefault(agent.name)} disabled={switching === agent.name} style={{
                      padding: '5px 12px', background: '#1a1a2e', color: '#4fc3f7',
                      border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                    }}>
                      {switching === agent.name ? 'Switching...' : 'Set Default'}
                    </button>
                  )}
                  <button onClick={() => removeAgent(agent.name)} disabled={removing === agent.name} style={{
                    padding: '5px 12px', background: '#2e1a1a', color: '#f44336',
                    border: '1px solid #4a2a2a', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  }}>
                    {removing === agent.name ? 'Removing...' : 'Remove'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Info card */}
      <div style={{ ...card, marginTop: 20 }}>
        <h3 style={{ fontSize: 14, marginBottom: 8, color: '#888' }}>How Multi-Agent Routing Works</h3>
        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.6 }}>
          Each agent has isolated memory, sessions, and skills directories. Messages are routed based
          on channel patterns (e.g., <code style={{ color: '#4fc3f7' }}>discord:*</code> routes all Discord
          messages to a specific agent). The default agent handles messages that don't match any pattern.
          Use <code style={{ color: '#4fc3f7' }}>/agents list</code> or <code style={{ color: '#4fc3f7' }}>/agents switch &lt;name&gt;</code> in chat.
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
