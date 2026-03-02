import React, { useCallback, useEffect, useState } from 'react'
import { useColors } from '../ThemeContext'

const API = window.location.origin

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('automate_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

type Transport = 'stdio' | 'sse' | 'http'

interface MCPServerForm {
  name: string
  enabled: boolean
  description: string
  transport: Transport
  command: string
  url: string
  argsText: string
  envText: string
}

const blankServer: MCPServerForm = {
  name: '',
  enabled: true,
  description: '',
  transport: 'stdio',
  command: '',
  url: '',
  argsText: '',
  envText: '',
}

export default function MCP() {
  const colors = useColors()
  const [servers, setServers] = useState<MCPServerForm[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  const showMessage = (text: string, error = false) => {
    setMessage({ text, error })
    setTimeout(() => setMessage(null), 3500)
  }

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/config/full`, { headers: authHeaders() })
      const data = await res.json()
      const loaded = Array.isArray(data?.config?.mcp?.servers) ? data.config.mcp.servers : []
      setServers(loaded.map((s: any) => ({
        name: s.name || '',
        enabled: s.enabled !== false,
        description: s.description || '',
        transport: (s.transport || 'stdio') as Transport,
        command: s.command || '',
        url: s.url || '',
        argsText: Array.isArray(s.args) ? s.args.join('\n') : '',
        envText: s.env && typeof s.env === 'object'
          ? Object.entries(s.env).map(([k, v]) => `${k}=${String(v)}`).join('\n')
          : '',
      })))
    } catch (err) {
      showMessage((err as Error).message || 'Failed to load MCP config', true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const parseArgs = (argsText: string): string[] =>
    argsText
      .split(/\r?\n|,/)
      .map(s => s.trim())
      .filter(Boolean)

  const parseEnv = (envText: string): Record<string, string> =>
    envText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .reduce<Record<string, string>>((acc, line) => {
        const eq = line.indexOf('=')
        if (eq > 0) {
          const key = line.slice(0, eq).trim()
          const value = line.slice(eq + 1).trim()
          if (key) acc[key] = value
        }
        return acc
      }, {})

  const saveConfig = async () => {
    setSaving(true)
    try {
      const normalized = servers
        .map((server) => ({
          name: server.name.trim(),
          enabled: server.enabled,
          description: server.description.trim() || undefined,
          transport: server.transport,
          command: server.command.trim() || undefined,
          url: server.url.trim() || undefined,
          args: parseArgs(server.argsText),
          env: parseEnv(server.envText),
        }))
        .filter(server => server.name)

      const res = await fetch(`${API}/api/config`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcp: { servers: normalized } }),
      })
      const data = await res.json()
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Failed to save MCP config')
      showMessage('MCP configuration saved')
      await loadConfig()
    } catch (err) {
      showMessage((err as Error).message || 'Save failed', true)
    } finally {
      setSaving(false)
    }
  }

  const updateServer = (index: number, patch: Partial<MCPServerForm>) => {
    setServers(prev => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const addServer = () => setServers(prev => [...prev, { ...blankServer }])
  const removeServer = (index: number) => setServers(prev => prev.filter((_, i) => i !== index))

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

  if (loading) return <div style={{ padding: 24, color: colors.textSecondary }}>Loading MCP config...</div>

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0, color: colors.textPrimary }}>MCP Servers</h2>
      <p style={{ color: colors.textSecondary, marginTop: 0 }}>
        MCP (Model Context Protocol) is a standard way for AI applications to connect to external tools and data sources.
        Configure MCP servers here so they can be managed from your AutoMate config.
      </p>

      {message && (
        <div style={{ ...card, marginBottom: 12, color: message.error ? colors.error : colors.success }}>
          {message.text}
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {servers.length === 0 && (
          <div style={{ ...card, color: colors.textMuted, fontSize: 12 }}>No MCP servers configured yet.</div>
        )}
        {servers.map((server, index) => (
          <div key={index} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong style={{ color: colors.textPrimary }}>Server {index + 1}</strong>
              <button
                onClick={() => removeServer(index)}
                style={{ padding: '6px 10px', background: colors.bgTertiary, color: colors.error, border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer' }}
              >
                Remove
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <label style={{ color: colors.textSecondary, fontSize: 12 }}>
                Name
                <input value={server.name} onChange={e => updateServer(index, { name: e.target.value })} style={{ ...input, marginTop: 6 }} placeholder="filesystem" />
              </label>
              <label style={{ color: colors.textSecondary, fontSize: 12 }}>
                Transport
                <select
                  value={server.transport}
                  onChange={e => updateServer(index, { transport: e.target.value as Transport })}
                  style={{ ...input, marginTop: 6 }}
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">sse</option>
                  <option value="http">http</option>
                </select>
              </label>
              <label style={{ color: colors.textSecondary, fontSize: 12, display: 'flex', alignItems: 'center', gap: 10, marginTop: 24 }}>
                <input type="checkbox" checked={server.enabled} onChange={e => updateServer(index, { enabled: e.target.checked })} />
                Enabled
              </label>
            </div>

            <label style={{ color: colors.textSecondary, fontSize: 12, display: 'block', marginTop: 10 }}>
              Description
              <input value={server.description} onChange={e => updateServer(index, { description: e.target.value })} style={{ ...input, marginTop: 6 }} placeholder="What this server provides" />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
              <label style={{ color: colors.textSecondary, fontSize: 12 }}>
                Command (for stdio)
                <input value={server.command} onChange={e => updateServer(index, { command: e.target.value })} style={{ ...input, marginTop: 6 }} placeholder="npx" />
              </label>
              <label style={{ color: colors.textSecondary, fontSize: 12 }}>
                URL (for sse/http)
                <input value={server.url} onChange={e => updateServer(index, { url: e.target.value })} style={{ ...input, marginTop: 6 }} placeholder="http://127.0.0.1:3001/sse" />
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
              <label style={{ color: colors.textSecondary, fontSize: 12 }}>
                Args (newline or comma separated)
                <textarea
                  value={server.argsText}
                  onChange={e => updateServer(index, { argsText: e.target.value })}
                  style={{ ...input, minHeight: 90, marginTop: 6, resize: 'vertical' }}
                  placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path"
                />
              </label>
              <label style={{ color: colors.textSecondary, fontSize: 12 }}>
                Environment (KEY=VALUE per line)
                <textarea
                  value={server.envText}
                  onChange={e => updateServer(index, { envText: e.target.value })}
                  style={{ ...input, minHeight: 90, marginTop: 6, resize: 'vertical' }}
                  placeholder="HOME=/tmp&#10;API_KEY=..."
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button
          onClick={addServer}
          style={{ padding: '9px 14px', background: colors.bgTertiary, color: colors.accent, border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
        >
          Add MCP Server
        </button>
        <button
          onClick={saveConfig}
          disabled={saving}
          style={{ padding: '9px 14px', background: colors.accent, color: colors.accentContrast, border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}
        >
          {saving ? 'Saving…' : 'Save MCP Config'}
        </button>
      </div>
    </div>
  )
}
