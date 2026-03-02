import React, { useCallback, useEffect, useState } from 'react'
import { useColors } from '../ThemeContext'

const API = window.location.origin

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('automate_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

interface SubagentProfile {
  name: string
  model?: string
  systemPrompt?: string
  maxIterations?: number
  timeoutMs?: number
}

interface SubagentConfig {
  defaultModel?: string
  useParentApiKey: boolean
  maxConcurrent: number
  profiles: SubagentProfile[]
}

interface ProfileForm {
  name: string
  model: string
  systemPrompt: string
  maxIterations: string
  timeoutMs: string
}

const emptyProfile: ProfileForm = {
  name: '',
  model: '',
  systemPrompt: '',
  maxIterations: '',
  timeoutMs: '',
}

export default function Subagents() {
  const colors = useColors()
  const [subagent, setSubagent] = useState<SubagentConfig>({
    defaultModel: '',
    useParentApiKey: true,
    maxConcurrent: 3,
    profiles: [],
  })
  const [profileForm, setProfileForm] = useState<ProfileForm>(emptyProfile)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  const showMessage = (text: string, error = false) => {
    setMessage({ text, error })
    setTimeout(() => setMessage(null), 3000)
  }

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/config/full`, { headers: authHeaders() })
      const data = await res.json()
      const current = data?.config?.agent?.subagent || {}
      setSubagent({
        defaultModel: current.defaultModel || '',
        useParentApiKey: current.useParentApiKey !== false,
        maxConcurrent: current.maxConcurrent || 3,
        profiles: Array.isArray(current.profiles) ? current.profiles : [],
      })
    } catch (err) {
      showMessage((err as Error).message || 'Failed to load config', true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const saveConfig = async () => {
    setSaving(true)
    try {
      const res = await fetch(`${API}/api/config`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: {
            subagent: {
              defaultModel: subagent.defaultModel || undefined,
              useParentApiKey: subagent.useParentApiKey,
              maxConcurrent: Math.max(1, Math.min(20, Number(subagent.maxConcurrent) || 3)),
              profiles: subagent.profiles,
            },
          },
        }),
      })
      const data = await res.json()
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Save failed')
      showMessage('Subagent configuration saved')
      await loadConfig()
    } catch (err) {
      showMessage((err as Error).message || 'Save failed', true)
    } finally {
      setSaving(false)
    }
  }

  const addOrUpdateProfile = () => {
    const name = profileForm.name.trim()
    if (!name) {
      showMessage('Profile name is required', true)
      return
    }

    const profile: SubagentProfile = {
      name,
      model: profileForm.model.trim() || undefined,
      systemPrompt: profileForm.systemPrompt.trim() || undefined,
      maxIterations: profileForm.maxIterations.trim() ? Number(profileForm.maxIterations) : undefined,
      timeoutMs: profileForm.timeoutMs.trim() ? Number(profileForm.timeoutMs) : undefined,
    }

    if (profile.maxIterations && (profile.maxIterations < 1 || profile.maxIterations > 200)) {
      showMessage('Max iterations must be between 1 and 200', true)
      return
    }
    if (profile.timeoutMs && profile.timeoutMs < 1000) {
      showMessage('Timeout must be at least 1000ms', true)
      return
    }

    setSubagent(prev => {
      const profiles = [...prev.profiles]
      if (editingIndex === null) profiles.push(profile)
      else profiles[editingIndex] = profile
      return { ...prev, profiles }
    })
    setProfileForm(emptyProfile)
    setEditingIndex(null)
  }

  const editProfile = (index: number) => {
    const profile = subagent.profiles[index]
    setProfileForm({
      name: profile.name,
      model: profile.model || '',
      systemPrompt: profile.systemPrompt || '',
      maxIterations: profile.maxIterations ? String(profile.maxIterations) : '',
      timeoutMs: profile.timeoutMs ? String(profile.timeoutMs) : '',
    })
    setEditingIndex(index)
  }

  const removeProfile = (index: number) => {
    setSubagent(prev => ({ ...prev, profiles: prev.profiles.filter((_, i) => i !== index) }))
    if (editingIndex === index) {
      setProfileForm(emptyProfile)
      setEditingIndex(null)
    }
  }

  const card: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 16,
  }

  const input: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: colors.bgTertiary,
    border: `1px solid ${colors.borderLight}`,
    color: colors.textPrimary,
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13,
  }

  if (loading) return <div style={{ padding: 24, color: colors.textSecondary }}>Loading subagent config...</div>

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0, color: colors.textPrimary }}>Subagents</h2>
      <p style={{ color: colors.textSecondary, marginTop: 0 }}>
        Configure default subagent behavior and reusable custom subagent profiles.
      </p>

      {message && (
        <div style={{ ...card, marginBottom: 12, background: colors.bgSecondary, color: message.error ? colors.error : colors.success }}>
          {message.text}
        </div>
      )}

      <div style={{ ...card, marginBottom: 12 }}>
        <h3 style={{ marginTop: 0, color: colors.textPrimary }}>Defaults</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <label style={{ color: colors.textSecondary, fontSize: 12 }}>
            Default Model
            <input
              value={subagent.defaultModel || ''}
              onChange={e => setSubagent(prev => ({ ...prev, defaultModel: e.target.value }))}
              style={{ ...input, marginTop: 6 }}
              placeholder="e.g. gpt-5.1, claude-sonnet-4.5, fast"
            />
          </label>
          <label style={{ color: colors.textSecondary, fontSize: 12 }}>
            Max Concurrent
            <input
              type="number"
              min={1}
              max={20}
              value={subagent.maxConcurrent}
              onChange={e => setSubagent(prev => ({ ...prev, maxConcurrent: Number(e.target.value) || 1 }))}
              style={{ ...input, marginTop: 6 }}
            />
          </label>
          <label style={{ color: colors.textSecondary, fontSize: 12, display: 'flex', alignItems: 'center', gap: 10, marginTop: 24 }}>
            <input
              type="checkbox"
              checked={subagent.useParentApiKey}
              onChange={e => setSubagent(prev => ({ ...prev, useParentApiKey: e.target.checked }))}
            />
            Use parent API key by default
          </label>
        </div>
      </div>

      <div style={{ ...card, marginBottom: 12 }}>
        <h3 style={{ marginTop: 0, color: colors.textPrimary }}>Custom Profiles</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
          <input value={profileForm.name} onChange={e => setProfileForm(prev => ({ ...prev, name: e.target.value }))} style={input} placeholder="Profile name" />
          <input value={profileForm.model} onChange={e => setProfileForm(prev => ({ ...prev, model: e.target.value }))} style={input} placeholder="Model (optional)" />
          <input value={profileForm.maxIterations} onChange={e => setProfileForm(prev => ({ ...prev, maxIterations: e.target.value }))} style={input} placeholder="Max iterations (optional)" />
          <input value={profileForm.timeoutMs} onChange={e => setProfileForm(prev => ({ ...prev, timeoutMs: e.target.value }))} style={input} placeholder="Timeout ms (optional)" />
        </div>
        <textarea
          value={profileForm.systemPrompt}
          onChange={e => setProfileForm(prev => ({ ...prev, systemPrompt: e.target.value }))}
          style={{ ...input, minHeight: 90, marginBottom: 10, resize: 'vertical' }}
          placeholder="System prompt override (optional)"
        />
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button
            onClick={addOrUpdateProfile}
            style={{ padding: '8px 12px', background: colors.accent, color: colors.accentContrast, border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
          >
            {editingIndex === null ? 'Add Profile' : 'Update Profile'}
          </button>
          {editingIndex !== null && (
            <button
              onClick={() => { setEditingIndex(null); setProfileForm(emptyProfile) }}
              style={{ padding: '8px 12px', background: colors.bgTertiary, color: colors.textSecondary, border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer' }}
            >
              Cancel Edit
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {subagent.profiles.length === 0 && <div style={{ color: colors.textMuted, fontSize: 12 }}>No custom profiles yet.</div>}
          {subagent.profiles.map((profile, index) => (
            <div key={`${profile.name}-${index}`} style={{ background: colors.bgSecondary, border: `1px solid ${colors.borderLight}`, borderRadius: 6, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, color: colors.textPrimary }}>{profile.name}</div>
                  <div style={{ fontSize: 12, color: colors.textSecondary }}>
                    model: {profile.model || '(inherit)'} · maxIterations: {profile.maxIterations ?? 'default'} · timeoutMs: {profile.timeoutMs ?? 'default'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => editProfile(index)}
                    style={{ padding: '6px 10px', background: colors.bgTertiary, color: colors.accent, border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer' }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => removeProfile(index)}
                    style={{ padding: '6px 10px', background: colors.bgTertiary, color: colors.error, border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
              {profile.systemPrompt && (
                <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, marginBottom: 0, color: colors.textMuted, fontSize: 11, fontFamily: 'monospace' }}>
                  {profile.systemPrompt}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={saveConfig}
        disabled={saving}
        style={{ padding: '10px 16px', background: colors.accent, color: colors.accentContrast, border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}
      >
        {saving ? 'Saving…' : 'Save Subagent Config'}
      </button>
    </div>
  )
}
