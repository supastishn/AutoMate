import React, { useEffect, useState, useCallback } from 'react'
import { useColors } from '../ThemeContext'

const API = window.location.origin

function getToken(): string | null {
  return localStorage.getItem('automate_token')
}

function authHeaders(): Record<string, string> {
  const t = getToken()
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (t) h['Authorization'] = `Bearer ${t}`
  return h
}

interface Provider {
  name: string
  model: string
  apiBase: string
  apiKey?: string
  apiType?: 'chat' | 'responses'
  maxTokens?: number
  temperature?: number
  priority?: number
  active?: boolean
  contextWindow?: number
}

interface PrimaryModel {
  model: string
  apiBase: string
  apiKey?: string
  apiType: 'chat' | 'responses'
  maxTokens: number
  temperature: number
  thinkingLevel: string
}

interface ModelFormData {
  name: string
  model: string
  apiBase: string
  apiKey: string
  apiType: 'chat' | 'responses'
  maxTokens: string
  temperature: string
  thinkingLevel: string
  priority: string
  contextWindow: string
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const API_TYPES: { value: 'chat' | 'responses'; label: string }[] = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses API' },
]

const emptyForm: ModelFormData = {
  name: '',
  model: '',
  apiBase: '',
  apiKey: '',
  apiType: 'chat',
  maxTokens: '8192',
  temperature: '0.3',
  thinkingLevel: 'off',
  priority: '0',
  contextWindow: '',
}

export default function Models() {
  const colors = useColors()
  const [providers, setProviders] = useState<Provider[]>([])
  const [primaryModel, setPrimaryModel] = useState<PrimaryModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const [editName, setEditName] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [form, setForm] = useState<ModelFormData>(emptyForm)

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 3000)
  }

  const fetchModels = useCallback(async () => {
    try {
      const [modelsRes, configRes] = await Promise.all([
        fetch(`${API}/api/models`, { headers: authHeaders() }),
        fetch(`${API}/api/config/full`, { headers: authHeaders() }),
      ])
      const modelsData = await modelsRes.json()
      const configData = await configRes.json()

      setProviders(modelsData.providers || [])
      setPrimaryModel(modelsData.primaryModel || null)
    } catch (e) {
      showToast('Failed to load models', true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const handleSwitch = async (name: string) => {
    try {
      const r = await fetch(`${API}/api/models/switch`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name }),
      })
      const data = await r.json()
      if (data.success) {
        showToast(`Switched to ${data.model}`)
        fetchModels()
      } else {
        showToast(data.error || 'Failed to switch', true)
      }
    } catch {
      showToast('Failed to switch model', true)
    }
  }

  const handleSave = async () => {
    if (editName === null) return
    setSaving(true)

    const provider: any = {
      name: form.name || form.model,
      model: form.model,
      apiBase: form.apiBase,
      apiKey: form.apiKey || undefined,
      apiType: form.apiType,
      maxTokens: parseInt(form.maxTokens) || undefined,
      temperature: parseFloat(form.temperature) || undefined,
      contextWindow: form.contextWindow ? parseInt(form.contextWindow) : undefined,
    }

    // Primary model has extra fields
    if (editName === 'primary') {
      provider.thinkingLevel = form.thinkingLevel
    } else {
      provider.priority = parseInt(form.priority) || 0
    }

    try {
      const r = await fetch(`${API}/api/models/${encodeURIComponent(editName)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ provider }),
      })
      const data = await r.json()
      if (data.success) {
        showToast('Model updated')
        setEditName(null)
        fetchModels()
      } else {
        showToast(data.error || 'Failed to update', true)
      }
    } catch {
      showToast('Failed to update model', true)
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = async () => {
    if (!form.model || !form.apiBase) {
      showToast('Model and API Base are required', true)
      return
    }
    setSaving(true)

    const provider = {
      name: form.name || form.model,
      model: form.model,
      apiBase: form.apiBase,
      apiKey: form.apiKey || undefined,
      apiType: form.apiType,
      maxTokens: parseInt(form.maxTokens) || undefined,
      temperature: parseFloat(form.temperature) || undefined,
      priority: parseInt(form.priority) || 0,
      contextWindow: form.contextWindow ? parseInt(form.contextWindow) : undefined,
    }

    try {
      const r = await fetch(`${API}/api/models/add`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ provider }),
      })
      const data = await r.json()
      if (data.success) {
        showToast('Model added')
        setShowAddModal(false)
        setForm(emptyForm)
        fetchModels()
      } else {
        showToast(data.error || 'Failed to add', true)
      }
    } catch {
      showToast('Failed to add model', true)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (name: string) => {
    if (name === 'primary') {
      showToast('Cannot delete primary model', true)
      return
    }
    if (!confirm('Delete this model?')) return

    try {
      // Don't send Content-Type for DELETE without body
      const headers: Record<string, string> = {}
      const t = getToken()
      if (t) headers['Authorization'] = `Bearer ${t}`

      const r = await fetch(`${API}/api/models/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers,
      })
      const data = await r.json()
      if (data.success) {
        showToast('Model deleted')
        fetchModels()
      } else {
        showToast(data.error || 'Failed to delete', true)
      }
    } catch {
      showToast('Failed to delete model', true)
    }
  }

  const openEdit = (name: string) => {
    const p = providers.find(prov => prov.name === name)
    if (!p) return
    const isPrimary = name === 'primary'
    setForm({
      name: p.name || '',
      model: p.model || '',
      apiBase: p.apiBase || '',
      apiKey: '',
      apiType: (p as any).apiType || (isPrimary ? primaryModel?.apiType : 'chat') || 'chat',
      maxTokens: String(p.maxTokens || (isPrimary ? primaryModel?.maxTokens : 8192) || 8192),
      temperature: String(p.temperature ?? (isPrimary ? primaryModel?.temperature : 0.3) ?? 0.3),
      thinkingLevel: isPrimary ? (primaryModel?.thinkingLevel || 'off') : 'off',
      priority: String((p as any).priority || 0),
      contextWindow: p.contextWindow ? String(p.contextWindow) : '',
    })
    setEditName(name)
  }

  const cardStyle: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 4,
    border: `1px solid ${colors.border}`,
    background: colors.bgPrimary,
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: 'monospace',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    marginBottom: 4,
    display: 'block',
  }

  const btnStyle = (bg: string, disabled = false): React.CSSProperties => ({
    background: bg,
    color: bg === colors.accent || bg === colors.success ? colors.accentContrast : '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 14px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 600,
    fontSize: 13,
    opacity: disabled ? 0.5 : 1,
  })

  if (loading) {
    return (
      <div style={{ padding: 32, color: colors.textSecondary }}>Loading models...</div>
    )
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 1000,
          padding: '12px 20px', borderRadius: 6, fontWeight: 600, fontSize: 13,
          background: toast.err ? colors.error : colors.success,
          color: '#fff', boxShadow: `0 4px 16px ${colors.shadow}`,
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: colors.textPrimary, margin: 0 }}>
          Models Manager
        </h1>
        <button style={btnStyle(colors.accent)} onClick={() => { setForm(emptyForm); setShowAddModal(true) }}>
          + Add Model
        </button>
      </div>

      {/* Models List */}
      {providers.map((p, i) => (
        <div key={i} style={{ ...cardStyle, borderLeft: p.active ? `3px solid ${colors.success}` : `3px solid transparent` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: colors.textPrimary }}>
                  {p.name}
                </span>
                {p.name === 'primary' && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: colors.accentMuted, color: colors.accent,
                  }}>
                    PRIMARY
                  </span>
                )}
                {p.active && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: colors.bgSuccess, color: colors.success,
                  }}>
                    ACTIVE
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: colors.textSecondary, fontFamily: 'monospace', marginBottom: 4 }}>
                {p.model}
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                {p.apiBase}
              </div>
              {p.name === 'primary' && primaryModel && (
                <div style={{ marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>
                    API: <span style={{ color: colors.textSecondary }}>{primaryModel.apiType === 'responses' ? 'Responses' : 'Chat'}</span>
                  </span>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>
                    Max Tokens: <span style={{ color: colors.textSecondary }}>{primaryModel.maxTokens}</span>
                  </span>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>
                    Temp: <span style={{ color: colors.textSecondary }}>{primaryModel.temperature}</span>
                  </span>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>
                    Thinking: <span style={{ color: colors.textSecondary }}>{primaryModel.thinkingLevel}</span>
                  </span>
                  {providers[0]?.contextWindow && (
                    <span style={{ fontSize: 11, color: colors.textMuted }}>
                      Context: <span style={{ color: colors.textSecondary }}>{providers[0].contextWindow?.toLocaleString()}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {!p.active && (
                <button style={btnStyle(colors.success)} onClick={() => handleSwitch(p.name)}>
                  Activate
                </button>
              )}
              <button style={btnStyle(colors.bgHover)} onClick={() => openEdit(p.name)}>
                Edit
              </button>
              {p.name !== 'primary' && (
                <button style={btnStyle(colors.error)} onClick={() => handleDelete(p.name)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      {providers.length === 0 && (
        <div style={{ textAlign: 'center', padding: 48, color: colors.textMuted }}>
          No models configured
        </div>
      )}



      {/* Edit Modal */}
      {editName !== null && (
        <div style={{
          position: 'fixed', inset: 0, background: colors.bgOverlay, zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setEditName(null)}>
          <div style={{
            background: colors.bgCard, borderRadius: 12, padding: 24, width: 500, maxWidth: '90vw',
            maxHeight: '90vh', overflow: 'auto', boxShadow: `0 8px 32px ${colors.shadow}`,
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 600, color: colors.textPrimary }}>
              Edit {editName === 'primary' ? 'Primary Model' : 'Failover Model'}
            </h2>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Name</label>
              <input
                style={inputStyle}
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="Display name"
                disabled={editName === 'primary'}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Model ID *</label>
              <input
                style={inputStyle}
                value={form.model}
                onChange={e => setForm({ ...form, model: e.target.value })}
                placeholder="e.g. claude-opus-4-20250514"
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>API Base URL *</label>
              <input
                style={inputStyle}
                value={form.apiBase}
                onChange={e => setForm({ ...form, apiBase: e.target.value })}
                placeholder="e.g. https://api.anthropic.com/v1"
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>API Key</label>
              <input
                style={inputStyle}
                type="password"
                value={form.apiKey}
                onChange={e => setForm({ ...form, apiKey: e.target.value })}
                placeholder="Leave empty to keep existing, or 'default' to use default API key"
              />
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                Enter 'default' to use the API key from settings.
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>API Type</label>
              <select
                style={{ ...inputStyle, cursor: 'pointer' }}
                value={form.apiType}
                onChange={e => setForm({ ...form, apiType: e.target.value as 'chat' | 'responses' })}
              >
                {API_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                Chat Completions = standard OpenAI-style API. Responses API = OpenAI's newer response format.
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={labelStyle}>Max Tokens</label>
                <input
                  style={inputStyle}
                  type="number"
                  value={form.maxTokens}
                  onChange={e => setForm({ ...form, maxTokens: e.target.value })}
                />
              </div>
              <div>
                <label style={labelStyle}>Temperature</label>
                <input
                  style={inputStyle}
                  type="number"
                  step="0.1"
                  value={form.temperature}
                  onChange={e => setForm({ ...form, temperature: e.target.value })}
                />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Context Window (tokens)</label>
              <input
                style={inputStyle}
                type="number"
                value={form.contextWindow}
                onChange={e => setForm({ ...form, contextWindow: e.target.value })}
                placeholder="Leave empty to use default"
              />
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                Override the default context limit for this model. Leave empty to use the global default.
              </div>
            </div>

            {editName === 'primary' ? (
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Thinking Level</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={form.thinkingLevel}
                  onChange={e => setForm({ ...form, thinkingLevel: e.target.value })}
                >
                  {THINKING_LEVELS.map(l => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Priority (lower = higher priority)</label>
                <input
                  style={inputStyle}
                  type="number"
                  value={form.priority}
                  onChange={e => setForm({ ...form, priority: e.target.value })}
                />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
              <button style={btnStyle(colors.bgHover)} onClick={() => setEditName(null)}>
                Cancel
              </button>
              <button style={btnStyle(colors.accent, saving)} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div style={{
          position: 'fixed', inset: 0, background: colors.bgOverlay, zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setShowAddModal(false)}>
          <div style={{
            background: colors.bgCard, borderRadius: 12, padding: 24, width: 500, maxWidth: '90vw',
            maxHeight: '90vh', overflow: 'auto', boxShadow: `0 8px 32px ${colors.shadow}`,
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 600, color: colors.textPrimary }}>
              Add Failover Model
            </h2>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Name</label>
              <input
                style={inputStyle}
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="Display name (optional)"
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Model ID *</label>
              <input
                style={inputStyle}
                value={form.model}
                onChange={e => setForm({ ...form, model: e.target.value })}
                placeholder="e.g. gpt-4-turbo"
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>API Base URL *</label>
              <input
                style={inputStyle}
                value={form.apiBase}
                onChange={e => setForm({ ...form, apiBase: e.target.value })}
                placeholder="e.g. https://api.openai.com/v1"
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>API Key</label>
              <input
                style={inputStyle}
                type="password"
                value={form.apiKey}
                onChange={e => setForm({ ...form, apiKey: e.target.value })}
                placeholder="Optional, or 'default' to use default API key"
              />
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                Leave empty for no key, or enter 'default' to use the API key from settings.
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>API Type</label>
              <select
                style={{ ...inputStyle, cursor: 'pointer' }}
                value={form.apiType}
                onChange={e => setForm({ ...form, apiType: e.target.value as 'chat' | 'responses' })}
              >
                {API_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={labelStyle}>Max Tokens</label>
                <input
                  style={inputStyle}
                  type="number"
                  value={form.maxTokens}
                  onChange={e => setForm({ ...form, maxTokens: e.target.value })}
                />
              </div>
              <div>
                <label style={labelStyle}>Temperature</label>
                <input
                  style={inputStyle}
                  type="number"
                  step="0.1"
                  value={form.temperature}
                  onChange={e => setForm({ ...form, temperature: e.target.value })}
                />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Context Window (tokens)</label>
              <input
                style={inputStyle}
                type="number"
                value={form.contextWindow}
                onChange={e => setForm({ ...form, contextWindow: e.target.value })}
                placeholder="Leave empty to use default"
              />
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                Override the default context limit for this model. Leave empty to use the global default.
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Priority (lower = higher priority)</label>
              <input
                style={inputStyle}
                type="number"
                value={form.priority}
                onChange={e => setForm({ ...form, priority: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
              <button style={btnStyle(colors.bgHover)} onClick={() => setShowAddModal(false)}>
                Cancel
              </button>
              <button style={btnStyle(colors.accent, saving)} onClick={handleAdd} disabled={saving}>
                {saving ? 'Adding...' : 'Add Model'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
