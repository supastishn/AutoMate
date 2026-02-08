import React, { useState } from 'react'
import Dashboard from './pages/Dashboard'
import Chat from './pages/Chat'
import Sessions from './pages/Sessions'
import Skills from './pages/Skills'

const tabs = ['Dashboard', 'Chat', 'Sessions', 'Skills'] as const
type Tab = typeof tabs[number]

const styles = {
  app: { display: 'flex', height: '100vh', background: '#0a0a0a', color: '#e0e0e0' } as React.CSSProperties,
  sidebar: { width: 220, background: '#111', borderRight: '1px solid #222', display: 'flex', flexDirection: 'column' as const, padding: '16px 0' } as React.CSSProperties,
  logo: { padding: '0 20px 20px', fontSize: 20, fontWeight: 700, color: '#4fc3f7', letterSpacing: 1 } as React.CSSProperties,
  tab: (active: boolean) => ({
    padding: '10px 20px', cursor: 'pointer', background: active ? '#1a1a2e' : 'transparent',
    borderLeft: active ? '3px solid #4fc3f7' : '3px solid transparent',
    color: active ? '#4fc3f7' : '#888', fontSize: 14, fontWeight: active ? 600 : 400,
    transition: 'all 0.15s',
  }) as React.CSSProperties,
  main: { flex: 1, overflow: 'auto' } as React.CSSProperties,
}

export default function App() {
  const [tab, setTab] = useState<Tab>('Dashboard')

  return (
    <div style={styles.app}>
      <div style={styles.sidebar}>
        <div style={styles.logo}>AutoMate</div>
        {tabs.map(t => (
          <div key={t} style={styles.tab(tab === t)} onClick={() => setTab(t)}>{t}</div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ padding: '10px 20px', fontSize: 11, color: '#555' }}>v0.1.0</div>
      </div>
      <div style={styles.main}>
        {tab === 'Dashboard' && <Dashboard />}
        {tab === 'Chat' && <Chat />}
        {tab === 'Sessions' && <Sessions />}
        {tab === 'Skills' && <Skills />}
      </div>
    </div>
  )
}
