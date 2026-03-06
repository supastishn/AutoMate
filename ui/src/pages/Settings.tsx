import React, { useEffect, useState } from 'react'
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

// deep get/set helpers
function deepGet(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function deepSet(obj: any, path: string, value: any): any {
  const clone = JSON.parse(JSON.stringify(obj))
  const keys = path.split('.')
  let cur = clone
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
  return clone
}

interface FieldDef {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'skills' | 'enum'
  options?: string[]  // Options for enum type
}

interface SectionDef {
  title: string
  fields: FieldDef[]
}

const SECTIONS: SectionDef[] = [
  {
    title: 'AI Model',
    fields: [
      { key: 'agent.model', label: 'Model', type: 'string' },
      { key: 'agent.apiBase', label: 'API Base URL', type: 'string' },
      { key: 'agent.apiKey', label: 'API Key', type: 'string' },
      { key: 'agent.apiType', label: 'API Type', type: 'enum', options: ['chat', 'responses', 'puter'] },
      { key: 'agent.maxTokens', label: 'Max Tokens', type: 'number' },
      { key: 'agent.temperature', label: 'Temperature', type: 'number' },
      { key: 'agent.thinkingLevel', label: 'Thinking Level', type: 'enum', options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    ],
  },
  {
    title: 'Power Steering',
    fields: [
      { key: 'agent.powerSteering.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'agent.powerSteering.interval', label: 'Interval (messages)', type: 'number' },
      { key: 'agent.powerSteering.role', label: 'Role', type: 'enum', options: ['system', 'user', 'both'] },
      { key: 'agent.powerSteering.mode', label: 'Mode', type: 'enum', options: ['separate', 'append'] },
    ],
  },
  {
    title: 'Response Normalization',
    fields: [
      { key: 'agent.normalizePunctuation.enabled', label: 'Enabled', type: 'boolean' },
    ],
  },
  {
    title: 'Gateway',
    fields: [
      { key: 'gateway.host', label: 'Host', type: 'string' },
      { key: 'gateway.port', label: 'Port', type: 'number' },
      { key: 'gateway.auth.mode', label: 'Auth Mode', type: 'enum', options: ['none', 'token', 'password'] },
      { key: 'gateway.auth.token', label: 'Auth Token', type: 'string' },
      { key: 'gateway.auth.password', label: 'Auth Password', type: 'string' },
    ],
  },
  {
    title: 'Discord',
    fields: [
      { key: 'channels.discord.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'channels.discord.token', label: 'Bot Token', type: 'string' },
      { key: 'channels.discord.clientId', label: 'Client ID', type: 'string' },
      { key: 'channels.discord.publicMode', label: 'Public Mode', type: 'boolean' },
      { key: 'channels.discord.ownerIds', label: 'Owner IDs', type: 'array' },
      { key: 'channels.discord.publicTools', label: 'Public Tools', type: 'array' },
      { key: 'channels.discord.allowFrom', label: 'Allow From', type: 'array' },
      { key: 'channels.discord.allowChannels', label: 'Allow Channels', type: 'array' },
      { key: 'channels.discord.proactiveChannelId', label: 'Proactive Channel ID', type: 'string' },
      { key: 'channels.discord.useEmbeds', label: 'Use Embeds', type: 'boolean' },
      { key: 'channels.discord.useThreads', label: 'Use Threads', type: 'boolean' },
      { key: 'channels.discord.threadThreshold', label: 'Thread Threshold (msgs)', type: 'number' },
      { key: 'channels.discord.streamEdits', label: 'Stream Edits', type: 'boolean' },
      { key: 'channels.discord.streamEditInterval', label: 'Stream Edit Interval (ms)', type: 'number' },
      { key: 'channels.discord.showButtons', label: 'Show Buttons', type: 'boolean' },
      { key: 'channels.discord.registerSlashCommands', label: 'Register Slash Commands', type: 'boolean' },
      { key: 'channels.discord.reactOnReceive', label: 'React On Receive', type: 'boolean' },
      { key: 'channels.discord.trackEdits', label: 'Track Edits', type: 'boolean' },
      { key: 'channels.discord.trackDeletes', label: 'Track Deletes', type: 'boolean' },
    ],
  },
  {
    title: 'Browser',
    fields: [
      { key: 'browser.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'browser.headless', label: 'Headless', type: 'boolean' },
      { key: 'browser.profileDir', label: 'Profile Directory', type: 'string' },
      { key: 'browser.extensions', label: 'Extensions (comma-separated paths)', type: 'string' },
    ],
  },
  {
    title: 'Features',
    fields: [
      { key: 'cron.enabled', label: 'Cron', type: 'boolean' },
      { key: 'webhooks.enabled', label: 'Webhooks', type: 'boolean' },
      { key: 'webhooks.token', label: 'Webhook Token', type: 'string' },
      { key: 'canvas.enabled', label: 'Canvas', type: 'boolean' },
      { key: 'plugins.enabled', label: 'Plugins', type: 'boolean' },
      { key: 'plugins.notificationSession', label: 'Plugin Notification Session', type: 'string' },
    ],
  },
  {
    title: 'Heartbeat',
    fields: [
      { key: 'heartbeat.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'heartbeat.intervalMinutes', label: 'Interval (min)', type: 'number' },
      { key: 'heartbeat.jitterMinutes', label: 'Jitter ±(min)', type: 'number' },
      { key: 'heartbeat.separateSession', label: 'Use Separate Session', type: 'boolean' },
      { key: 'heartbeat.sessionId', label: 'Custom Session ID', type: 'string' },
      { key: 'heartbeat.adaptiveInterval', label: 'Adaptive Intervals (auto-adjust by goal urgency)', type: 'boolean' },
      { key: 'heartbeat.dailyReport.enabled', label: 'Daily Autonomous Report', type: 'boolean' },
      { key: 'heartbeat.dailyReport.timeHour', label: 'Report Hour (0-23)', type: 'number' },
      { key: 'heartbeat.autoProcessGoals', label: 'Auto-Process Goals', type: 'boolean' },
      { key: 'heartbeat.maxInProgressGoals', label: 'Max In-Progress Goals', type: 'number' },
      { key: 'heartbeat.escalation', label: 'Priority Auto-Escalation', type: 'boolean' },
      { key: 'heartbeat.autoApproveMinutes', label: 'Auto-Approve Suggested Goals (min, -1=never)', type: 'number' },
      { key: 'heartbeat.maxRetries', label: 'Max Goal Retries', type: 'number' },
      { key: 'heartbeat.termuxScheduler', label: 'Termux Job Scheduler (Android sleep)', type: 'boolean' },
    ],
  },
  {
    title: 'Skills',
    fields: [
      { key: 'skills.directory', label: 'Skills Directory', type: 'string' },
      { key: 'skills.extraDirs', label: 'Extra Directories', type: 'array' },
      { key: 'skills.autoLoad', label: 'Auto-Load Skills', type: 'skills' },
    ],
  },
  {
    title: 'Load Balancing',
    fields: [
      { key: 'agent.loadBalancing.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'agent.loadBalancing.switchEvery', label: 'Switch Every N Requests', type: 'number' },
      { key: 'agent.loadBalancing.strategy', label: 'Strategy', type: 'enum', options: ['round-robin', 'random'] },
    ],
  },
  {
    title: 'Rate Limiting',
    fields: [
      { key: 'agent.rateLimit.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'agent.rateLimit.minDelayMs', label: 'Min Delay (ms)', type: 'number' },
      { key: 'agent.rateLimit.maxDelayMs', label: 'Max Delay (ms)', type: 'number' },
      { key: 'agent.rateLimit.perTokenDelayMs', label: 'Per-Token Delay (ms)', type: 'number' },
    ],
  },
  {
    title: 'Subagents',
    fields: [
      { key: 'agent.subagent.defaultModel', label: 'Default Model', type: 'string' },
      { key: 'agent.subagent.useParentApiKey', label: 'Use Parent API Key', type: 'boolean' },
      { key: 'agent.subagent.maxConcurrent', label: 'Max Concurrent', type: 'number' },
    ],
  },
  {
    title: 'Memory',
    fields: [
      { key: 'memory.directory', label: 'Memory Directory', type: 'string' },
      { key: 'memory.sharedDirectory', label: 'Shared Memory Directory', type: 'string' },
      { key: 'memory.indexTranscripts', label: 'Index Transcripts', type: 'boolean' },
      { key: 'memory.citations', label: 'Citations Mode', type: 'enum', options: ['full', 'file-only', 'none'] },
      { key: 'memory.autoSearch.enabled', label: 'Auto Search', type: 'boolean' },
      { key: 'memory.autoSearch.maxResults', label: 'Auto Search Max Results', type: 'number' },
      { key: 'memory.autoSearch.minScore', label: 'Auto Search Min Score', type: 'number' },
    ],
  },
  {
    title: 'Embedding',
    fields: [
      { key: 'memory.embedding.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'memory.embedding.provider', label: 'Provider', type: 'enum', options: ['openai', 'gemini', 'voyage', 'local'] },
      { key: 'memory.embedding.model', label: 'Model', type: 'string' },
      { key: 'memory.embedding.apiBase', label: 'API Base', type: 'string' },
      { key: 'memory.embedding.apiKey', label: 'API Key', type: 'string' },
      { key: 'memory.embedding.chunkSize', label: 'Chunk Size (chars)', type: 'number' },
      { key: 'memory.embedding.chunkOverlap', label: 'Chunk Overlap (chars)', type: 'number' },
      { key: 'memory.embedding.vectorWeight', label: 'Vector Weight', type: 'number' },
      { key: 'memory.embedding.bm25Weight', label: 'BM25 Weight', type: 'number' },
      { key: 'memory.embedding.topK', label: 'Top K Results', type: 'number' },
    ],
  },
  {
    title: 'Sessions',
    fields: [
      { key: 'sessions.directory', label: 'Sessions Directory', type: 'string' },
      { key: 'sessions.contextLimit', label: 'Context Limit (tokens)', type: 'number' },
      { key: 'sessions.reserveTokens', label: 'Reserve Tokens', type: 'number' },
      { key: 'sessions.compactAt', label: 'Compact At (ratio)', type: 'number' },
      { key: 'sessions.compactMode', label: 'Compact Mode', type: 'enum', options: ['summary', 'truncate', 'rolling'] },
      { key: 'sessions.compactRetainCount', label: 'Messages to Retain After Compact', type: 'number' },
      { key: 'sessions.rollingChunkSize', label: 'Rolling Chunk Size', type: 'number' },
      { key: 'sessions.autoResetHour', label: 'Auto Reset Hour (-1=off)', type: 'number' },
    ],
  },
  {
    title: 'Tools',
    fields: [
      { key: 'tools.deferredLoading', label: 'Deferred Loading', type: 'boolean' },
      { key: 'tools.disableFilePagination', label: 'Disable File Pagination (always read full files)', type: 'boolean' },
    ],
  },
  {
    title: 'Context Pruning',
    fields: [
      { key: 'sessions.pruning.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'sessions.pruning.maxToolResults', label: 'Max Tool Results', type: 'number' },
      { key: 'sessions.pruning.maxToolResultChars', label: 'Max Tool Result Chars', type: 'number' },
      { key: 'sessions.pruning.keepLastAssistants', label: 'Keep Last N Assistant Turns', type: 'number' },
      { key: 'sessions.pruning.softTrimRatio', label: 'Soft Trim Ratio', type: 'number' },
      { key: 'sessions.pruning.hardClearRatio', label: 'Hard Clear Ratio', type: 'number' },
      { key: 'sessions.pruning.minPrunableChars', label: 'Min Prunable Chars', type: 'number' },
      { key: 'sessions.pruning.softTrim.maxChars', label: 'Soft Trim Max Chars', type: 'number' },
      { key: 'sessions.pruning.softTrim.headChars', label: 'Soft Trim Head Chars', type: 'number' },
      { key: 'sessions.pruning.softTrim.tailChars', label: 'Soft Trim Tail Chars', type: 'number' },
      { key: 'sessions.pruning.hardClear.enabled', label: 'Hard Clear Enabled', type: 'boolean' },
      { key: 'sessions.pruning.hardClear.placeholder', label: 'Hard Clear Placeholder', type: 'string' },
    ],
  },
  {
    title: 'Tool Policy',
    fields: [
      { key: 'tools.allow', label: 'Allow List', type: 'array' },
      { key: 'tools.deny', label: 'Deny List', type: 'array' },
      { key: 'tools.requireApproval', label: 'Require Approval', type: 'array' },
    ],
  },
  {
    title: 'TTS (Text-to-Speech)',
    fields: [
      { key: 'tts.enabled', label: 'Enabled', type: 'boolean' },
      { key: 'tts.provider', label: 'Provider', type: 'enum', options: ['elevenlabs', 'openai'] },
      { key: 'tts.apiKey', label: 'API Key', type: 'string' },
      { key: 'tts.voice', label: 'Voice', type: 'string' },
      { key: 'tts.model', label: 'Model', type: 'string' },
      { key: 'tts.outputDir', label: 'Output Directory', type: 'string' },
    ],
  },
  {
    title: 'Directories',
    fields: [
      { key: 'cron.directory', label: 'Cron Directory', type: 'string' },
      { key: 'plugins.directory', label: 'Plugins Directory', type: 'string' },
    ],
  },
]

const MASKED = '***'

interface ProviderInfo {
  name: string
  model: string
  active: boolean
}

export default function Settings() {
  const colors = useColors()
  const [config, setConfig] = useState<any>(null)
  const [original, setOriginal] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({})
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [switching, setSwitching] = useState(false)

  // Styles using theme
  const cardStyle: React.CSSProperties = {
    background: colors.bgSecondary,
    border: `1px solid ${colors.borderLight}`,
    borderRadius: 8,
    marginBottom: 12,
    overflow: 'hidden',
  }

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 20px',
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: 15,
    fontWeight: 600,
    color: colors.textPrimary,
  }

  const fieldRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    borderTop: `1px solid ${colors.border}`,
    gap: 16,
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: colors.textSecondary,
    minWidth: 180,
    flexShrink: 0,
  }

  const inputStyle: React.CSSProperties = {
    background: colors.bgTertiary,
    border: `1px solid ${colors.borderLight}`,
    borderRadius: 4,
    color: colors.textPrimary,
    padding: '6px 10px',
    fontSize: 13,
    flex: 1,
    maxWidth: 400,
    outline: 'none',
    fontFamily: 'monospace',
  }

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: colors.bgTertiary,
    border: `1px solid ${colors.borderLight}`,
    borderRadius: 14,
    padding: '3px 10px',
    fontSize: 12,
    color: colors.textPrimary,
    marginRight: 6,
    marginBottom: 4,
  }

  const chipRemoveStyle: React.CSSProperties = {
    cursor: 'pointer',
    color: colors.textSecondary,
    fontWeight: 700,
    fontSize: 14,
    lineHeight: 1,
  }

  const toastStyle = (isError: boolean): React.CSSProperties => ({
    position: 'fixed',
    bottom: 24,
    right: 24,
    background: isError ? colors.error : colors.success,
    color: '#fff',
    padding: '12px 24px',
    borderRadius: 8,
    fontSize: 14,
    zIndex: 9999,
    boxShadow: `0 4px 20px ${colors.shadow}`,
  })

  useEffect(() => {
    fetch(`${API}/api/config/full`, { headers: authHeaders() })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: any) => {
        const cfg = data.config || data
        setConfig(cfg)
        setOriginal(JSON.parse(JSON.stringify(cfg)))
        setLoading(false)
      })
      .catch((e: any) => {
        showToast(`Failed to load config: ${e.message}`, true)
        setLoading(false)
      })

    fetch(`${API}/api/models`, { headers: authHeaders() })
      .then(r => r.json())
      .then((d: any) => {
        setProviders(d.providers || [])
        setCurrentModel(d.current?.model || '')
      })
      .catch(() => {})
  }, [])

  function switchProvider(name: string) {
    setSwitching(true)
    fetch(`${API}/api/models/switch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    })
      .then(r => r.json())
      .then((d: any) => {
        if (d.success) {
          setCurrentModel(d.model || name)
          setProviders(prev => prev.map(p => ({ ...p, active: p.name === name })))
          showToast(`Switched to ${name}`, false)
        } else {
          showToast(d.error || 'Switch failed', true)
        }
      })
      .catch(e => showToast(`Switch failed: ${e.message}`, true))
      .finally(() => setSwitching(false))
  }

  function showToast(msg: string, err: boolean) {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 3000)
  }

  function toggleSection(title: string) {
    setCollapsed(prev => ({ ...prev, [title]: !prev[title] }))
  }

  function handleChange(key: string, value: any) {
    setConfig((prev: any) => deepSet(prev, key, value))
  }

  function handleSave() {
    if (!config) return
    setSaving(true)

    // Build payload: strip masked fields that haven't been changed
    const payload = JSON.parse(JSON.stringify(config))
    for (const section of SECTIONS) {
      for (const field of section.fields) {
        const val = deepGet(payload, field.key)
        const origVal = deepGet(original, field.key)
        if (val === MASKED && origVal === MASKED) {
          // User didn't change this masked field — remove it so backend keeps original
          const keys = field.key.split('.')
          let cur = payload
          for (let i = 0; i < keys.length - 1; i++) {
            if (cur[keys[i]] == null) break
            cur = cur[keys[i]]
          }
          delete cur[keys[keys.length - 1]]
        }
      }
    }

    fetch(`${API}/api/config`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(() => {
        showToast('Settings saved successfully', false)
        setOriginal(JSON.parse(JSON.stringify(config)))
      })
      .catch((e: any) => {
        showToast(`Failed to save: ${e.message}`, true)
      })
      .finally(() => setSaving(false))
  }

  function addTag(key: string) {
    const val = (tagInputs[key] || '').trim()
    if (!val) return
    const arr: string[] = deepGet(config, key) || []
    if (!arr.includes(val)) {
      handleChange(key, [...arr, val])
    }
    setTagInputs(prev => ({ ...prev, [key]: '' }))
  }

  function removeTag(key: string, idx: number) {
    const arr: string[] = deepGet(config, key) || []
    handleChange(key, arr.filter((_: string, i: number) => i !== idx))
  }

  function renderField(field: FieldDef) {
    const value = deepGet(config, field.key)
    const isMasked = value === MASKED

    if (field.type === 'boolean') {
      const checked = !!value
      return (
        <div key={field.key} style={fieldRowStyle}>
          <span style={labelStyle}>{field.label}</span>
          <div
            onClick={() => handleChange(field.key, !checked)}
            style={{
              width: 44,
              height: 24,
              borderRadius: 12,
              background: checked ? colors.accent : colors.borderLight,
              position: 'relative',
              cursor: 'pointer',
              transition: 'background .2s',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                background: colors.bgSecondary,
                position: 'absolute',
                top: 3,
                left: checked ? 23 : 3,
                transition: 'left .2s',
              }}
            />
          </div>
        </div>
      )
    }

    if (field.type === 'array' || field.type === 'skills') {
      const arr: string[] = Array.isArray(value) ? value : []
      const inputVal = tagInputs[field.key] || ''
      return (
        <div key={field.key} style={{ ...fieldRowStyle, flexDirection: 'column', alignItems: 'flex-start' }}>
          <span style={{ ...labelStyle, marginBottom: 8 }}>{field.label}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', marginBottom: 6, width: '100%' }}>
            {arr.map((tag: string, idx: number) => (
              <span key={idx} style={chipStyle}>
                {tag}
                <span style={chipRemoveStyle} onClick={() => removeTag(field.key, idx)}>×</span>
              </span>
            ))}
            {arr.length === 0 && <span style={{ fontSize: 12, color: colors.textMuted }}>No items</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, width: '100%', maxWidth: 420 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={inputVal}
              onChange={e => setTagInputs(prev => ({ ...prev, [field.key]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(field.key) } }}
              placeholder="Type skill name and press Enter"
            />
            <button
              onClick={() => addTag(field.key)}
              style={{
                background: colors.accent,
                border: 'none',
                borderRadius: 4,
                color: colors.accentContrast,
                padding: '6px 12px',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Add
            </button>
          </div>
        </div>
      )
    }

    if (field.type === 'number') {
      return (
        <div key={field.key} style={fieldRowStyle}>
          <span style={labelStyle}>{field.label}</span>
          <input
            type="number"
            style={inputStyle}
            value={value ?? ''}
            onChange={e => {
              const v = e.target.value
              handleChange(field.key, v === '' ? undefined : Number(v))
            }}
          />
        </div>
      )
    }

    if (field.type === 'enum' && field.options) {
      return (
        <div key={field.key} style={fieldRowStyle}>
          <span style={labelStyle}>{field.label}</span>
          <select
            style={{
              ...inputStyle,
              background: colors.bgTertiary,
              border: `1px solid ${colors.borderLight}`,
              borderRadius: 4,
              padding: '6px 10px',
              fontSize: 13,
              color: colors.textPrimary,
            }}
            value={value ?? ''}
            onChange={e => handleChange(field.key, e.target.value)}
          >
            {field.options.map((option: string) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
      )
    }

    // string
    return (
      <div key={field.key} style={fieldRowStyle}>
        <span style={labelStyle}>{field.label}</span>
        <input
          type="text"
          style={inputStyle}
          value={value ?? ''}
          placeholder={isMasked ? MASKED : ''}
          onChange={e => handleChange(field.key, e.target.value)}
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ padding: 40, color: colors.textSecondary }}>Loading settings...</div>
    )
  }

  if (!config) {
    return (
      <div style={{ padding: 40, color: colors.error }}>Failed to load configuration.</div>
    )
  }

  return (
    <div style={{ padding: 30, maxWidth: 900, background: colors.bgPrimary, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 24, marginBottom: 24, fontWeight: 600, color: colors.textPrimary }}>Settings</h1>

      {SECTIONS.map(section => {
        const isCollapsed = !!collapsed[section.title]
        return (
          <div key={section.title} style={cardStyle}>
            <div style={sectionHeaderStyle} onClick={() => toggleSection(section.title)}>
              <span>{section.title}</span>
              <span style={{ color: colors.textSecondary, fontSize: 18, transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .2s' }}>
                ▼
              </span>
            </div>
            {!isCollapsed && (
              <div>
                {section.fields.map(f => renderField(f))}
              </div>
            )}
          </div>
        )
      })}

      {/* System Prompt Editor */}
      <div style={cardStyle}>
        <div style={sectionHeaderStyle} onClick={() => toggleSection('System Prompt')}>
          <span>System Prompt</span>
          <span style={{ color: colors.textSecondary, fontSize: 18, transform: collapsed['System Prompt'] ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .2s' }}>
            ▼
          </span>
        </div>
        {!collapsed['System Prompt'] && (
          <div style={{ padding: 20 }}>
            <textarea
              value={deepGet(config, 'agent.systemPrompt') || ''}
              onChange={e => handleChange('agent.systemPrompt', e.target.value)}
              style={{
                width: '100%', minHeight: 300, resize: 'vertical',
                background: colors.bgTertiary, border: `1px solid ${colors.borderLight}`, borderRadius: 4,
                color: colors.textPrimary, padding: 16, fontFamily: 'monospace', fontSize: 13,
                lineHeight: 1.6, outline: 'none', boxSizing: 'border-box' as const,
              }}
              spellCheck={false}
            />
            <div style={{ fontSize: 11, color: colors.inputPlaceholder, marginTop: 6 }}>
              This prompt is injected at the start of every conversation. Markdown supported.
            </div>
          </div>
        )}
      </div>

      {/* Reminder Prompt Editor */}
      <div style={cardStyle}>
        <div style={sectionHeaderStyle} onClick={() => toggleSection('Reminder Prompt')}>
          <span>Reminder Prompt</span>
          <span style={{ color: colors.textSecondary, fontSize: 18, transform: collapsed['Reminder Prompt'] ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .2s' }}>
            ▼
          </span>
        </div>
        {!collapsed['Reminder Prompt'] && (
          <div style={{ padding: 20 }}>
            <textarea
              value={deepGet(config, 'agent.reminderPrompt') || ''}
              onChange={e => handleChange('agent.reminderPrompt', e.target.value)}
              placeholder="Leave empty to use full system prompt for power steering reminders..."
              style={{
                width: '100%', minHeight: 150, resize: 'vertical',
                background: colors.bgTertiary, border: `1px solid ${colors.borderLight}`, borderRadius: 4,
                color: colors.textPrimary, padding: 16, fontFamily: 'monospace', fontSize: 13,
                lineHeight: 1.6, outline: 'none', boxSizing: 'border-box' as const,
              }}
              spellCheck={false}
            />
            <div style={{ fontSize: 11, color: colors.inputPlaceholder, marginTop: 6 }}>
              Shorter prompt used for power steering (periodic reminders). Falls back to system prompt if empty.
            </div>
          </div>
        )}
      </div>

      {/* Providers / Model Switcher */}
      <div style={cardStyle}>
        <div style={sectionHeaderStyle} onClick={() => toggleSection('Providers')}>
          <span>Providers</span>
          <span style={{ color: colors.textSecondary, fontSize: 18, transform: collapsed['Providers'] ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .2s' }}>
            ▼
          </span>
        </div>
        {!collapsed['Providers'] && (
          <div style={{ padding: 20 }}>
            {currentModel && (
              <div style={{ marginBottom: 16, fontSize: 13, color: colors.textSecondary }}>
                Current model: <span style={{ color: colors.accent, fontFamily: 'monospace' }}>{currentModel}</span>
              </div>
            )}
            {providers.length === 0 ? (
              <div style={{ fontSize: 13, color: colors.textMuted }}>No providers loaded.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {providers.map((p, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 16px', borderRadius: 6,
                    background: p.active ? colors.accentMuted : colors.bgCard,
                    border: p.active ? `1px solid ${colors.accent}` : `1px solid ${colors.border}`,
                  }}>
                    <div>
                      <div style={{ fontSize: 14, color: p.active ? colors.accent : colors.textSecondary, fontWeight: p.active ? 600 : 400 }}>
                        {p.name}
                        {p.active && <span style={{ marginLeft: 8, fontSize: 10, color: colors.accent, background: colors.accentMuted, border: `1px solid ${colors.accent}`, borderRadius: 10, padding: '2px 8px' }}>active</span>}
                      </div>
                      <div style={{ fontSize: 12, color: colors.inputPlaceholder, fontFamily: 'monospace', marginTop: 2 }}>{p.model}</div>
                    </div>
                    {!p.active && (
                      <button
                        onClick={() => switchProvider(p.name)}
                        disabled={switching}
                        style={{
                          padding: '6px 16px', background: 'transparent', color: colors.accent,
                          border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: switching ? 'not-allowed' : 'pointer',
                          fontSize: 12, fontWeight: 600, opacity: switching ? 0.5 : 1,
                        }}
                      >
                        Switch
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Webhook test */}
      <div style={{ ...cardStyle, padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: colors.textPrimary }}>Test Webhook</div>
            <div style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>Send a test event to verify webhook configuration</div>
          </div>
          <button
            onClick={() => {
              fetch(`${API}/api/webhook`, {
                method: 'POST',
                headers: { ...authHeaders(), 'X-Webhook-Token': deepGet(config, 'webhooks.token') || '' },
                body: JSON.stringify({ event: 'test', data: { message: 'Webhook test from Settings UI', timestamp: new Date().toISOString() } }),
              })
                .then(r => r.json())
                .then((d: any) => showToast(d.ok ? 'Webhook test sent!' : (d.error || 'Failed'), !d.ok))
                .catch(e => showToast(`Webhook test failed: ${e.message}`, true))
            }}
            style={{
              padding: '8px 20px', background: colors.bgTertiary, color: colors.accent,
              border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 13,
            }}
          >
            Send Test
          </button>
        </div>
      </div>

      <div style={{ marginTop: 20, marginBottom: 40, textAlign: 'right' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: saving ? colors.borderLight : colors.accent,
            color: saving ? colors.textSecondary : colors.accentContrast,
            border: 'none',
            borderRadius: 6,
            padding: '12px 36px',
            fontSize: 15,
            fontWeight: 700,
            cursor: saving ? 'not-allowed' : 'pointer',
            transition: 'background .2s',
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Danger Zone */}
      <div style={{ ...cardStyle, padding: 16, marginBottom: 40, border: `1px solid ${colors.borderDanger}` }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, color: colors.error, marginBottom: 8 }}>Danger Zone</h3>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: colors.textPrimary }}>Factory Reset</div>
            <div style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
              Wipes all memory, identity files, sessions, and restores BOOTSTRAP.md. This cannot be undone.
            </div>
          </div>
          <button
            onClick={() => {
              if (!confirm('Are you sure you want to factory reset? This will wipe all memory, identity, and sessions.')) return
              if (!confirm('This CANNOT be undone. Type OK in the next prompt to confirm.')) return
              fetch(`${API}/api/command`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: '/factory-reset' }),
              })
                .then(r => r.json())
                .then((d: any) => showToast(d.result || 'Factory reset complete'))
                .catch(e => showToast(`Factory reset failed: ${e.message}`, true))
            }}
            style={{
              padding: '8px 20px', background: colors.bgDanger, color: colors.error,
              border: `1px solid ${colors.borderDanger}`, borderRadius: 4, cursor: 'pointer',
              fontSize: 13, fontWeight: 600, flexShrink: 0,
            }}
          >
            Factory Reset
          </button>
        </div>
      </div>

      {toast && (
        <div style={toastStyle(toast.err)}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
