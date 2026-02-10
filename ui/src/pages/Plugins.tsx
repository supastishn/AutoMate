import React from 'react'

interface PluginTool {
  name: string
  description?: string
}

interface PluginManifest {
  name: string
  version: string
  description?: string
  type: string
}

interface Plugin {
  manifest: PluginManifest
  tools: PluginTool[]
  channel?: unknown
  middleware?: unknown
}

const card: React.CSSProperties = {
  background: '#141414',
  border: '1px solid #222',
  borderRadius: 8,
  padding: 20,
}

const btnBase: React.CSSProperties = {
  border: 'none',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity 0.15s',
}

const inputStyle: React.CSSProperties = {
  background: '#0a0a0a',
  border: '1px solid #333',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 13,
  color: '#e0e0e0',
  outline: 'none',
  flex: 1,
  minWidth: 140,
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  flex: 'none',
  minWidth: 140,
  cursor: 'pointer',
}

function typeBadgeColor(type: string): string {
  switch (type) {
    case 'tool': return '#4fc3f7'
    case 'channel': return '#4caf50'
    case 'middleware': return '#ff9800'
    default: return '#888'
  }
}

export default function Plugins() {
  const [plugins, setPlugins] = React.useState<Plugin[]>([])
  const [loading, setLoading] = React.useState(true)
  const [reloading, setReloading] = React.useState(false)
  const [scaffoldName, setScaffoldName] = React.useState('')
  const [scaffoldType, setScaffoldType] = React.useState<'tool' | 'channel' | 'middleware'>('tool')
  const [scaffoldStatus, setScaffoldStatus] = React.useState<string | null>(null)

  const fetchPlugins = React.useCallback(() => {
    fetch('/api/plugins')
      .then(r => r.json())
      .then((data: any) => {
        setPlugins(data.plugins || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    fetchPlugins()
    const interval = setInterval(fetchPlugins, 5000)
    return () => clearInterval(interval)
  }, [fetchPlugins])

  const handleReload = () => {
    setReloading(true)
    fetch('/api/plugins/reload', { method: 'POST' })
      .then(() => fetchPlugins())
      .catch(() => {})
      .finally(() => setReloading(false))
  }

  const handleScaffold = () => {
    const name = scaffoldName.trim()
    if (!name) return
    setScaffoldStatus(null)
    fetch('/api/plugins/scaffold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: scaffoldType }),
    })
      .then(r => {
        if (!r.ok) throw new Error('Scaffold failed')
        setScaffoldStatus(`Plugin "${name}" scaffolded successfully.`)
        setScaffoldName('')
        fetchPlugins()
      })
      .catch(() => setScaffoldStatus('Failed to scaffold plugin.'))
  }

  return (
    <div style={{ padding: 30, maxWidth: 960, background: '#0a0a0a', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0, color: '#e0e0e0' }}>Plugins</h1>
        <button
          onClick={handleReload}
          disabled={reloading}
          style={{
            ...btnBase,
            background: reloading ? '#333' : '#4fc3f7',
            color: reloading ? '#888' : '#000',
            opacity: reloading ? 0.7 : 1,
          }}
        >
          {reloading ? 'Reloading...' : 'Reload All'}
        </button>
      </div>

      {/* Scaffold form */}
      <div style={{ ...card, marginBottom: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginTop: 0, marginBottom: 12, color: '#ccc' }}>
          Scaffold New Plugin
        </h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Plugin name"
            value={scaffoldName}
            onChange={e => setScaffoldName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleScaffold()}
            style={inputStyle}
          />
          <select
            value={scaffoldType}
            onChange={e => setScaffoldType(e.target.value as 'tool' | 'channel' | 'middleware')}
            style={selectStyle}
          >
            <option value="tool">tool</option>
            <option value="channel">channel</option>
            <option value="middleware">middleware</option>
          </select>
          <button
            onClick={handleScaffold}
            disabled={!scaffoldName.trim()}
            style={{
              ...btnBase,
              background: scaffoldName.trim() ? '#4caf50' : '#333',
              color: scaffoldName.trim() ? '#000' : '#666',
            }}
          >
            Create
          </button>
        </div>
        {scaffoldStatus && (
          <div style={{
            marginTop: 10,
            fontSize: 13,
            color: scaffoldStatus.includes('Failed') ? '#f44336' : '#4caf50',
          }}>
            {scaffoldStatus}
          </div>
        )}
      </div>

      {/* Plugin list */}
      {loading ? (
        <div style={{ color: '#666', fontSize: 13 }}>Loading plugins...</div>
      ) : plugins.length === 0 ? (
        <div style={{ ...card, color: '#666', fontSize: 13 }}>
          No plugins installed. Use the scaffold form above or install plugins manually.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380, 1fr))', gap: 16 }}>
          {plugins.map(p => {
            const m = p.manifest
            const badgeColor = typeBadgeColor(m.type)
            return (
              <div key={m.name} style={{ ...card }}>
                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 600, color: '#e0e0e0' }}>{m.name}</span>
                  <span style={{
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: '#888',
                    background: '#0a0a0a',
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}>
                    v{m.version}
                  </span>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: badgeColor,
                    border: `1px solid ${badgeColor}`,
                    padding: '2px 8px',
                    borderRadius: 4,
                    marginLeft: 'auto',
                  }}>
                    {m.type}
                  </span>
                </div>

                {/* Description */}
                {m.description && (
                  <div style={{ fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>
                    {m.description}
                  </div>
                )}

                {/* Tools */}
                {p.tools && p.tools.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: '#555', textTransform: 'uppercase', marginBottom: 6, letterSpacing: 0.5 }}>
                      Tools ({p.tools.length})
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {p.tools.map(t => (
                        <span
                          key={t.name}
                          title={t.description || t.name}
                          style={{
                            fontSize: 12,
                            fontFamily: 'monospace',
                            background: '#0d0d0d',
                            border: '1px solid #1a1a1a',
                            borderRadius: 12,
                            padding: '3px 10px',
                            color: '#4fc3f7',
                            cursor: 'default',
                          }}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Channel / Middleware indicators */}
                {(p.channel || p.middleware) && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    {p.channel && (
                      <span style={{ fontSize: 11, color: '#4caf50', fontFamily: 'monospace' }}>
                        + channel
                      </span>
                    )}
                    {p.middleware && (
                      <span style={{ fontSize: 11, color: '#ff9800', fontFamily: 'monospace' }}>
                        + middleware
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
