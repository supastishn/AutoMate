import React from 'react'
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

interface MemoryFile {
  name: string
  size: number
  modified: string
}

interface SearchResult {
  file: string
  content: string
  score: number
}

interface Toast {
  id: number
  message: string
  type: 'success' | 'error'
}

const spinnerKeyframes = `
@keyframes mem-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes mem-toast-in {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
`

const Memory: React.FC = () => {
  const colors = useColors()
  const [files, setFiles] = React.useState<MemoryFile[]>([])
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null)
  const [fileContent, setFileContent] = React.useState<string>('')
  const [editing, setEditing] = React.useState(false)
  const [editContent, setEditContent] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([])
  const [searching, setSearching] = React.useState(false)
  const [loadingContent, setLoadingContent] = React.useState(false)
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const toastIdRef = React.useRef(0)

  // Mobile sidebar
  const [isMobile, setIsMobile] = React.useState(window.innerWidth < 768)
  const [sidebarOpen, setSidebarOpen] = React.useState(false)

  React.useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768
      setIsMobile(mobile)
      if (!mobile) setSidebarOpen(false)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const addToast = React.useCallback((message: string, type: 'success' | 'error') => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 3000)
  }, [])

  const loadFiles = React.useCallback(() => {
    fetch(`${API}/api/memory/files`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (data.files) setFiles(data.files)
      })
      .catch(() => {})
  }, [])

  React.useEffect(() => {
    loadFiles()
  }, [loadFiles])

  const selectFile = (name: string) => {
    setSelectedFile(name)
    setEditing(false)
    setSearchResults([])
    setLoadingContent(true)
    if (isMobile) setSidebarOpen(false)
    fetch(`${API}/api/memory/file/${encodeURIComponent(name)}`, {
      headers: authHeaders(),
    })
      .then((r) => r.json())
      .then((data) => {
        setFileContent(data.content ?? '')
        setEditContent(data.content ?? '')
      })
      .catch(() => {
        setFileContent('')
        setEditContent('')
      })
      .finally(() => setLoadingContent(false))
  }

  const saveFile = () => {
    if (!selectedFile) return
    setSaving(true)
    fetch(`${API}/api/memory/file/${encodeURIComponent(selectedFile)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ content: editContent }),
    })
      .then((r) => {
        if (r.ok) {
          setFileContent(editContent)
          setEditing(false)
          loadFiles()
          addToast('File saved successfully', 'success')
        } else {
          addToast(`Save failed: HTTP ${r.status}`, 'error')
        }
      })
      .catch(() => {
        addToast('Save failed: network error', 'error')
      })
      .finally(() => setSaving(false))
  }

  const doSearch = () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSelectedFile(null)
    setSearchResults([])
    fetch(`${API}/api/memory/search`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ query: searchQuery, limit: 10 }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setSearchResults(data)
        else if (data.results) setSearchResults(data.results)
      })
      .catch(() => {})
      .finally(() => setSearching(false))
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const btnStyle = (color: string, disabled?: boolean): React.CSSProperties => ({
    background: color,
    color: color === colors.accent || color === colors.success ? colors.accentContrast : '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 14px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 600,
    fontSize: 13,
    marginLeft: 8,
    opacity: disabled ? 0.5 : 1,
  })

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: colors.bgPrimary,
      color: colors.textPrimary,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      position: 'relative',
    }}>
      <style>{spinnerKeyframes}</style>
      {/* Search Bar */}
      <div style={{
        display: 'flex',
        gap: 8,
        padding: '12px 16px',
        borderBottom: `1px solid ${colors.border}`,
        background: colors.bgCard,
        alignItems: 'center',
      }}>
        {isMobile && (
          <button
            style={{
              background: colors.bgCard,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              color: colors.accent,
              cursor: 'pointer',
              padding: '6px 10px',
              fontSize: 16,
              lineHeight: 1,
              fontWeight: 700,
              flexShrink: 0,
            }}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle sidebar"
          >
            ☰
          </button>
        )}
        <input
          style={{
            flex: 1,
            background: colors.bgPrimary,
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            padding: '8px 12px',
            color: colors.textPrimary,
            fontSize: 14,
            outline: 'none',
            fontFamily: 'inherit',
          }}
          placeholder="Search memory..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doSearch()
          }}
        />
        <button
          style={{
            background: colors.accent,
            color: colors.accentContrast,
            border: 'none',
            borderRadius: 4,
            padding: '8px 16px',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 14,
            opacity: searching ? 0.6 : 1,
          }}
          onClick={doSearch}
          disabled={searching}
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {/* Body */}
      <div style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        flexDirection: isMobile ? 'column' : 'row',
      }}>
        {/* Mobile overlay backdrop */}
        {isMobile && sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: colors.bgOverlay,
              zIndex: 10,
            }}
          />
        )}

        {/* Sidebar */}
        <div style={isMobile
          ? {
              position: 'absolute' as const,
              top: 0,
              left: 0,
              width: '80%',
              maxWidth: 300,
              height: '100%',
              zIndex: 20,
              borderRight: `1px solid ${colors.border}`,
              overflowY: 'auto',
              background: colors.bgCard,
              transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.2s ease',
              boxShadow: sidebarOpen ? `4px 0 20px ${colors.shadow}` : 'none',
            }
          : {
              width: 240,
              minWidth: 240,
              borderRight: `1px solid ${colors.border}`,
              overflowY: 'auto',
              background: colors.bgCard,
            }
        }>
          <div style={{
            padding: '12px 16px',
            fontSize: 12,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 1,
            color: colors.textMuted,
            borderBottom: `1px solid ${colors.border}`,
          }}>Memory Files</div>
          {files.length === 0 && (
            <div style={{ padding: 16, color: colors.textMuted, fontSize: 13 }}>
              No files found
            </div>
          )}
          {files.map((f) => (
            <div
              key={f.name}
              style={{
                padding: '10px 16px',
                cursor: 'pointer',
                borderBottom: `1px solid ${colors.border}`,
                background: selectedFile === f.name ? colors.bgPrimary : 'transparent',
                borderLeft: selectedFile === f.name ? `3px solid ${colors.accent}` : '3px solid transparent',
                transition: 'background 0.15s',
              }}
              onClick={() => selectFile(f.name)}
            >
              <div style={{
                fontSize: 13,
                fontWeight: selectedFile === f.name ? 600 : 400,
                color: selectedFile === f.name ? colors.accent : colors.textPrimary,
                wordBreak: 'break-all',
                fontFamily: 'monospace',
              }}>{f.name}</div>
              <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                {formatSize(f.size)} &middot;{' '}
                {new Date(f.modified).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>

        {/* Main Area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {searchResults.length > 0 ? (
            <>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 20px',
                borderBottom: `1px solid ${colors.border}`,
                background: colors.bgCard,
              }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  Search Results ({searchResults.length})
                </span>
                <button
                  style={btnStyle(colors.error)}
                  onClick={() => setSearchResults([])}
                >
                  Clear
                </button>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
                {searchResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      background: colors.bgCard,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 6,
                      padding: 16,
                      marginBottom: 12,
                      cursor: 'pointer',
                    }}
                    onClick={() => selectFile(r.file)}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: colors.accent, fontFamily: 'monospace', marginBottom: 8 }}>{r.file}</div>
                    <div style={{ fontSize: 12, color: colors.textMuted, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, maxHeight: 100, overflow: 'hidden' }}>{r.content}</div>
                    <div style={{ fontSize: 11, color: colors.success, marginTop: 8, fontWeight: 600 }}>
                      Score: {(r.score * 100).toFixed(1)}%
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : selectedFile ? (
            <>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 20px',
                borderBottom: `1px solid ${colors.border}`,
                background: colors.bgCard,
              }}>
                <span style={{ fontSize: 14, fontWeight: 600, fontFamily: 'monospace', color: colors.accent }}>{selectedFile}</span>
                <div>
                  {editing ? (
                    <>
                      <button
                        style={btnStyle(colors.error)}
                        onClick={() => {
                          setEditing(false)
                          setEditContent(fileContent)
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        style={btnStyle(colors.success, saving)}
                        onClick={saveFile}
                        disabled={saving}
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </>
                  ) : (
                    <button
                      style={btnStyle(colors.accent)}
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
                {loadingContent ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10 }}>
                    <div
                      style={{
                        width: 20,
                        height: 20,
                        border: `3px solid ${colors.border}`,
                        borderTop: `3px solid ${colors.accent}`,
                        borderRadius: '50%',
                        animation: 'mem-spin 0.8s linear infinite',
                      }}
                    />
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>Loading file…</span>
                  </div>
                ) : editing ? (
                  <textarea
                    style={{
                      width: '100%',
                      height: '100%',
                      background: colors.bgPrimary,
                      color: colors.textPrimary,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 4,
                      padding: 16,
                      fontFamily: 'monospace',
                      fontSize: 13,
                      lineHeight: 1.6,
                      resize: 'none',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    spellCheck={false}
                  />
                ) : (
                  <pre style={{
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: colors.textPrimary,
                    margin: 0,
                  }}>{fileContent}</pre>
                )}
              </div>
            </>
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
              color: colors.textMuted,
              fontSize: 14,
              flexDirection: 'column',
              gap: 8,
            }}>
              <div style={{ fontSize: 28, opacity: 0.3 }}>📁</div>
              Select a file from the sidebar or search memory
            </div>
          )}
        </div>
      </div>

      {/* Toast notifications */}
      <div style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        {toasts.map(t => (
          <div
            key={t.id}
            style={{
              padding: '10px 16px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: t.type === 'success' ? colors.success : colors.error,
              boxShadow: `0 4px 16px ${colors.shadow}`,
              animation: 'mem-toast-in 0.25s ease-out',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 200,
            }}
          >
            <span>{t.type === 'success' ? '✓' : '✕'}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Memory
