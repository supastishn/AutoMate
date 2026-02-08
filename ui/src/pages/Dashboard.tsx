import React, { useEffect, useState } from 'react'

interface Status {
  uptime: number
  sessions: number
  webchat_clients: number
  model: string
}

interface Health {
  status: string
  uptime: number
  model: string
  version: string
}

const card = {
  background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 20, marginBottom: 16,
} as React.CSSProperties

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')

  const fetchData = async () => {
    try {
      const [h, s] = await Promise.all([
        fetch('/api/health').then(r => r.json()),
        fetch('/api/status').then(r => r.json()),
      ])
      setHealth(h as Health)
      setStatus(s as Status)
      setError('')
    } catch {
      setError('Cannot connect to gateway')
    }
  }

  useEffect(() => {
    fetchData()
    const i = setInterval(fetchData, 5000)
    return () => clearInterval(i)
  }, [])

  const fmtUptime = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`
  }

  if (error) return <div style={{ padding: 40, color: '#f44' }}>{error}</div>

  return (
    <div style={{ padding: 30, maxWidth: 900 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24, fontWeight: 600 }}>Dashboard</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div style={card}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>STATUS</div>
          <div style={{ fontSize: 22, color: health?.status === 'ok' ? '#4caf50' : '#f44' }}>
            {health?.status === 'ok' ? 'Online' : 'Offline'}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>UPTIME</div>
          <div style={{ fontSize: 22 }}>{health ? fmtUptime(health.uptime) : '-'}</div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>MODEL</div>
          <div style={{ fontSize: 16, color: '#4fc3f7' }}>{health?.model || '-'}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>ACTIVE SESSIONS</div>
          <div style={{ fontSize: 28 }}>{status?.sessions ?? '-'}</div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>WEBCHAT CLIENTS</div>
          <div style={{ fontSize: 28 }}>{status?.webchat_clients ?? '-'}</div>
        </div>
      </div>

      <div style={{ ...card, marginTop: 8 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>SYSTEM INFO</div>
        <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#aaa', lineHeight: 1.8 }}>
          <div>Version: {health?.version || '-'}</div>
          <div>Gateway: ws://127.0.0.1:18789</div>
          <div>Node: {typeof process !== 'undefined' ? 'v22+' : 'Browser'}</div>
        </div>
      </div>
    </div>
  )
}
