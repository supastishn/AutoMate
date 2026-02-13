import React, { useState, useEffect, Suspense, lazy } from 'react'
import Dashboard from './pages/Dashboard'
import Chat from './pages/Chat'
import { useTheme, useColors } from './ThemeContext'

const Canvas = lazy(() => import('./pages/Canvas'))
const Sessions = lazy(() => import('./pages/Sessions'))
const Skills = lazy(() => import('./pages/Skills'))
const ClawHub = lazy(() => import('./pages/ClawHub'))
const Cron = lazy(() => import('./pages/Cron'))
const Memory = lazy(() => import('./pages/Memory'))
const Plugins = lazy(() => import('./pages/Plugins'))
const Agents = lazy(() => import('./pages/Agents'))
const Settings = lazy(() => import('./pages/Settings'))
const Doctor = lazy(() => import('./pages/Doctor'))

function LoadingFallback() {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: colors.textSecondary }}>
      Loading...
    </div>
  )
}

const tabs = ['Dashboard', 'Chat', 'Canvas', 'Sessions', 'Skills', 'ClawHub', 'Cron', 'Memory', 'Plugins', 'Agents', 'Settings', 'Doctor'] as const
type Tab = typeof tabs[number]

const tabIcons: Record<Tab, string> = {
  Dashboard: '\u{1F4CA}',
  Chat: '\u{1F4AC}',
  Canvas: '\u{1F3A8}',
  Sessions: '\u{1F4C1}',
  Skills: '\u26A1',
  ClawHub: '\u{1F4E6}',
  Cron: '\u23F0',
  Memory: '\u{1F9E0}',
  Plugins: '\u{1F50C}',
  Agents: '\u{1F916}',
  Settings: '\u2699\uFE0F',
  Doctor: '\u{1FA7A}',
}

export default function App() {
  const [tab, setTab] = useState<Tab>('Dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [loadSessionId, setLoadSessionId] = useState<string | null>(null)
  const { mode, toggleTheme } = useTheme()
  const colors = useColors()

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
    <div style={{ display: 'flex', height: '100vh', background: colors.bgPrimary, color: colors.textPrimary, overflow: 'hidden' }}>
      {/* Mobile menu toggle */}
      {isMobile && (
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          style={{
            position: 'fixed', top: 10, left: 10, zIndex: 100,
            background: colors.bgTertiary, border: `1px solid ${colors.borderLight}`, borderRadius: 6,
            color: colors.accent, padding: '6px 10px', cursor: 'pointer', fontSize: 18,
          }}
        >
          {sidebarOpen ? '\u2715' : '\u2630'}
        </button>
      )}

      {/* Sidebar */}
      <div style={{
        width: isMobile ? 200 : 220,
        background: colors.bgSecondary,
        borderRight: `1px solid ${colors.border}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 0',
        position: isMobile ? 'fixed' : 'relative',
        left: sidebarOpen ? 0 : isMobile ? -220 : 0,
        top: 0, bottom: 0,
        zIndex: 50,
        transition: 'left 0.2s ease',
        boxShadow: isMobile && sidebarOpen ? `4px 0 20px ${colors.shadow}` : 'none',
      }}>
        <div style={{ padding: '0 20px 12px', fontSize: 20, fontWeight: 700, color: colors.accent, letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>AutoMate</span>
          <button
            onClick={toggleTheme}
            title={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 18,
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 4,
              color: colors.textSecondary,
              transition: 'color 0.15s',
            }}
            onMouseOver={e => (e.currentTarget.style.color = colors.accent)}
            onMouseOut={e => (e.currentTarget.style.color = colors.textSecondary)}
          >
            {mode === 'dark' ? '\u2600\uFE0F' : '\u{1F319}'}
          </button>
        </div>
        {tabs.map(t => (
          <div
            key={t}
            style={{
              padding: '10px 20px', cursor: 'pointer',
              background: tab === t ? colors.bgActive : 'transparent',
              borderLeft: tab === t ? `3px solid ${colors.accent}` : '3px solid transparent',
              color: tab === t ? colors.accent : colors.textSecondary, fontSize: 14,
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
        <div style={{ padding: '10px 20px', fontSize: 11, color: colors.textMuted }}>v0.1.0</div>
      </div>

      {/* Overlay for mobile sidebar */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: colors.bgOverlay,
            zIndex: 40,
          }}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'auto', marginLeft: isMobile ? 0 : undefined }}>
        {tab === 'Dashboard' && <Dashboard />}
        {tab === 'Chat' && <Chat loadSessionId={loadSessionId} onSessionLoaded={() => setLoadSessionId(null)} />}
        <Suspense fallback={<LoadingFallback />}>
          {tab === 'Canvas' && <Canvas />}
          {tab === 'Sessions' && <Sessions onOpenInChat={(id) => { setLoadSessionId(id); setTab('Chat') }} />}
          {tab === 'Skills' && <Skills />}
          {tab === 'ClawHub' && <ClawHub />}
          {tab === 'Settings' && <Settings />}
          {tab === 'Cron' && <Cron />}
          {tab === 'Memory' && <Memory />}
          {tab === 'Plugins' && <Plugins />}
          {tab === 'Agents' && <Agents />}
          {tab === 'Doctor' && <Doctor />}
        </Suspense>
      </div>
    </div>
  )
}
