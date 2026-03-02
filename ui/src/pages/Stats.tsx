import React, { useCallback, useEffect, useState } from 'react'
import { useColors } from '../ThemeContext'

const API = window.location.origin

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('automate_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

interface StatusData {
  uptime: number
  sessions: number
  webchat_clients: number
  canvas_clients: number
  model: string
  presence?: { status?: string; typing?: boolean; currentSession?: string }
}

interface DashboardData {
  tools?: { coreToolCount?: number; deferredToolCount?: number; sessionCount?: number; totalPromotions?: number; totalDemotions?: number }
  sessions?: { total?: number; totalMessages?: number; byChannel?: Record<string, number> }
  memory?: { totalChunks?: number; indexedFiles?: string[]; indexEnabled?: boolean } | null
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(seconds % 60)}s`
}

export default function Stats() {
  const colors = useColors()
  const [status, setStatus] = useState<StatusData | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [tokenStats, setTokenStats] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (firstLoad = false) => {
    if (firstLoad) setLoading(true)
    setRefreshing(!firstLoad)
    setError('')
    try {
      const [statusRes, dashboardRes, commandRes] = await Promise.all([
        fetch(`${API}/api/status`, { headers: authHeaders() }),
        fetch(`${API}/api/dashboard`, { headers: authHeaders() }),
        fetch(`${API}/api/command`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: '/stats', sessionId: 'webchat:stats' }),
        }),
      ])

      const statusData = await statusRes.json()
      const dashboardData = await dashboardRes.json()
      const commandData = await commandRes.json()

      setStatus(statusData)
      setDashboard(dashboardData)
      setTokenStats(commandData?.result || '')
    } catch (err) {
      setError((err as Error).message || 'Failed to load stats')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  const card: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 16,
  }

  if (loading) {
    return <div style={{ padding: 24, color: colors.textSecondary }}>Loading stats...</div>
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: colors.textPrimary }}>Stats</h2>
        <button
          onClick={() => void load(false)}
          disabled={refreshing}
          style={{
            padding: '8px 14px',
            background: colors.accent,
            color: colors.accentContrast,
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ ...card, marginBottom: 12, color: colors.error, background: colors.bgHover }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
        <div style={card}><div style={{ color: colors.textMuted, fontSize: 12 }}>Uptime</div><div style={{ fontSize: 24, fontWeight: 700 }}>{status ? fmtUptime(status.uptime) : '—'}</div></div>
        <div style={card}><div style={{ color: colors.textMuted, fontSize: 12 }}>Model</div><div style={{ fontSize: 16, fontFamily: 'monospace', wordBreak: 'break-all' }}>{status?.model || '—'}</div></div>
        <div style={card}><div style={{ color: colors.textMuted, fontSize: 12 }}>Sessions</div><div style={{ fontSize: 24, fontWeight: 700 }}>{dashboard?.sessions?.total ?? status?.sessions ?? 0}</div></div>
        <div style={card}><div style={{ color: colors.textMuted, fontSize: 12 }}>Messages</div><div style={{ fontSize: 24, fontWeight: 700 }}>{dashboard?.sessions?.totalMessages ?? 0}</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 12 }}>
        <div style={card}>
          <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 8 }}>Runtime</div>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>Webchat clients: <b>{status?.webchat_clients ?? 0}</b></div>
            <div>Canvas clients: <b>{status?.canvas_clients ?? 0}</b></div>
            <div>Presence: <b>{status?.presence?.status || 'unknown'}</b></div>
          </div>
        </div>
        <div style={card}>
          <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 8 }}>Tools</div>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>Core tools: <b>{dashboard?.tools?.coreToolCount ?? 0}</b></div>
            <div>Deferred tools: <b>{dashboard?.tools?.deferredToolCount ?? 0}</b></div>
            <div>Promotions/Demotions: <b>{dashboard?.tools?.totalPromotions ?? 0}</b> / <b>{dashboard?.tools?.totalDemotions ?? 0}</b></div>
          </div>
        </div>
        <div style={card}>
          <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 8 }}>Memory Index</div>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>Enabled: <b>{dashboard?.memory?.indexEnabled ? 'Yes' : 'No'}</b></div>
            <div>Total chunks: <b>{dashboard?.memory?.totalChunks ?? 0}</b></div>
            <div>Indexed files: <b>{dashboard?.memory?.indexedFiles?.length ?? 0}</b></div>
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={{ color: colors.textMuted, fontSize: 12, marginBottom: 8 }}>Token Statistics (/stats)</div>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: colors.textSecondary, fontFamily: 'monospace', fontSize: 12 }}>
          {tokenStats || 'No token data yet for this session.'}
        </pre>
      </div>
    </div>
  )
}
