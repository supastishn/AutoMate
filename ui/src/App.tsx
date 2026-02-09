import React, { useState, useEffect } from 'react'
import Dashboard from './pages/Dashboard'
import Chat from './pages/Chat'
import Sessions from './pages/Sessions'
import Skills from './pages/Skills'
import Canvas from './pages/Canvas'
import Settings from './pages/Settings'

const tabs = ['Dashboard', 'Chat', 'Canvas', 'Sessions', 'Skills', 'Settings'] as const
type Tab = typeof tabs[number]

const tabIcons: Record<Tab, string> = {
  Dashboard: '\u{1F4CA}',
  Chat: '\u{1F4AC}',
  Canvas: '\u{1F3A8}',
  Sessions: '\u{1F4C1}',
  Skills: '\u26A1',
  Settings: '\u2699\uFE0F',
}

export default function App() {
  const [tab, setTab] = useState<Tab>('Dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768
      setIsMobile(mobile)
      if (mobile) setSidebarOpen(false)
    }
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0a0a0a', color: '#e0e0e0', overflow: 'hidden' }}>
      {/* Mobile menu toggle */}
      {isMobile && (
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          style={{
            position: 'fixed', top: 10, left: 10, zIndex: 100,
            background: '#1a1a2e', border: '1px solid #333', borderRadius: 6,
            color: '#4fc3f7', padding: '6px 10px', cursor: 'pointer', fontSize: 18,
          }}
        >
          {sidebarOpen ? '\u2715' : '\u2630'}
        </button>
      )}

      {/* Sidebar */}
      <div style={{
        width: isMobile ? 200 : 220,
        background: '#111',
        borderRight: '1px solid #222',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 0',
        position: isMobile ? 'fixed' : 'relative',
        left: sidebarOpen ? 0 : isMobile ? -220 : 0,
        top: 0, bottom: 0,
        zIndex: 50,
        transition: 'left 0.2s ease',
        boxShadow: isMobile && sidebarOpen ? '4px 0 20px rgba(0,0,0,0.5)' : 'none',
      }}>
        <div style={{ padding: '0 20px 20px', fontSize: 20, fontWeight: 700, color: '#4fc3f7', letterSpacing: 1 }}>
          AutoMate
        </div>
        {tabs.map(t => (
          <div
            key={t}
            style={{
              padding: '10px 20px', cursor: 'pointer',
              background: tab === t ? '#1a1a2e' : 'transparent',
              borderLeft: tab === t ? '3px solid #4fc3f7' : '3px solid transparent',
              color: tab === t ? '#4fc3f7' : '#888', fontSize: 14,
              fontWeight: tab === t ? 600 : 400,
              transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', gap: 10,
            }}
            onClick={() => { setTab(t); if (isMobile) setSidebarOpen(false) }}
          >
            <span style={{ fontSize: 16 }}>{tabIcons[t]}</span>
            {t}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ padding: '10px 20px', fontSize: 11, color: '#555' }}>v0.1.0</div>
      </div>

      {/* Overlay for mobile sidebar */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 40,
          }}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'auto', marginLeft: isMobile ? 0 : undefined }}>
        {tab === 'Dashboard' && <Dashboard />}
        {tab === 'Chat' && <Chat />}
        {tab === 'Canvas' && <Canvas />}
        {tab === 'Sessions' && <Sessions />}
        {tab === 'Skills' && <Skills />}
        {tab === 'Settings' && <Settings />}
      </div>
    </div>
  )
}
