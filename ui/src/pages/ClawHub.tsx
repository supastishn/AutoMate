import React, { useEffect, useState } from 'react'

interface ClawHubSkill {
  name: string; description: string; repo: string; author: string; version: string; tags: string[]; downloads?: number;
}

interface InstalledMeta {
  name: string; repo: string; version: string; installedAt: string; source: string;
}

interface VetFlag {
  severity: 'high' | 'medium' | 'low'; pattern: string; reason: string; line: number;
}

interface PreviewData {
  repo: string; content: string; vet: { safe: boolean; flags: VetFlag[] };
}

const card: React.CSSProperties = {
  background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 20,
}

const API = ''

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('automate_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export default function ClawHub() {
  const [registry, setRegistry] = useState<ClawHubSkill[]>([])
  const [installed, setInstalled] = useState<InstalledMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const [tab, setTab] = useState<'browse' | 'installed'>('browse')
  const [manualRepo, setManualRepo] = useState('')

  const showToast = (msg: string, err = false) => {
    setToast({ msg, err })
    setTimeout(() => setToast(null), 4000)
  }

  const loadData = () => {
    setLoading(true)
    Promise.all([
      fetch(`${API}/api/clawhub/browse`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${API}/api/clawhub/installed`, { headers: authHeaders() }).then(r => r.json()),
    ])
      .then(([browse, inst]) => {
        setRegistry(browse.skills || [])
        setInstalled(inst.installed || [])
      })
      .catch(() => showToast('Failed to load registry', true))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadData() }, [])

  const doSearch = () => {
    if (!search.trim()) { loadData(); return }
    setSearching(true)
    fetch(`${API}/api/clawhub/search?q=${encodeURIComponent(search)}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setRegistry(d.skills || []))
      .catch(() => showToast('Search failed', true))
      .finally(() => setSearching(false))
  }

  const doPreview = (repo: string) => {
    setPreviewLoading(true)
    fetch(`${API}/api/clawhub/preview`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) { showToast(d.error, true); return }
        setPreview(d)
      })
      .catch(() => showToast('Preview failed', true))
      .finally(() => setPreviewLoading(false))
  }

  const doInstall = (repo: string) => {
    if (!confirm(`Install skill from ${repo}?`)) return
    setInstalling(repo)
    fetch(`${API}/api/clawhub/install`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) { showToast(`Installed "${d.name}"`); loadData() }
        else showToast(d.error || 'Install failed', true)
      })
      .catch(() => showToast('Install failed', true))
      .finally(() => setInstalling(null))
  }

  const doUninstall = (name: string) => {
    if (!confirm(`Uninstall skill "${name}"?`)) return
    setUninstalling(name)
    fetch(`${API}/api/clawhub/uninstall`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) { showToast(`Uninstalled "${name}"`); loadData() }
        else showToast(d.error || 'Uninstall failed', true)
      })
      .catch(() => showToast('Uninstall failed', true))
      .finally(() => setUninstalling(null))
  }

  const doUpdate = (name: string) => {
    setUpdating(name)
    fetch(`${API}/api/clawhub/update`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) { showToast(`Updated "${name}"`); loadData() }
        else showToast(d.error || 'Update failed', true)
      })
      .catch(() => showToast('Update failed', true))
      .finally(() => setUpdating(null))
  }

  const doUpdateAll = () => {
    if (!confirm('Update all installed ClawHub skills?')) return
    setUpdatingAll(true)
    fetch(`${API}/api/clawhub/update`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
      .then(r => r.json())
      .then(d => {
        const msg = `Updated: ${(d.updated || []).join(', ') || 'none'}, Failed: ${(d.failed || []).join(', ') || 'none'}`
        showToast(msg, (d.failed || []).length > 0)
        loadData()
      })
      .catch(() => showToast('Update all failed', true))
      .finally(() => setUpdatingAll(false))
  }

  const installedNames = new Set(installed.map(i => i.name))

  const sevColor = (s: string) => s === 'high' ? '#f44336' : s === 'medium' ? '#ff9800' : '#ffc107'

  return (
    <div style={{ padding: 30, maxWidth: 1000 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8, fontWeight: 600 }}>ClawHub Registry</h1>
      <div style={{ fontSize: 13, color: '#888', marginBottom: 20 }}>
        Browse, preview, and install community skills from the ClawHub registry.
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {(['browse', 'installed'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', background: tab === t ? '#1a1a2e' : '#111',
            color: tab === t ? '#4fc3f7' : '#888', border: tab === t ? '1px solid #4fc3f7' : '1px solid #333',
            borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: tab === t ? 600 : 400,
            textTransform: 'capitalize',
          }}>
            {t === 'installed' ? `Installed (${installed.length})` : 'Browse'}
          </button>
        ))}
      </div>

      {/* Preview modal */}
      {preview && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={() => setPreview(null)}>
          <div style={{
            ...card, maxWidth: 700, maxHeight: '80vh', overflow: 'auto', width: '100%',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, margin: 0 }}>Preview: {preview.repo}</h3>
              <button onClick={() => setPreview(null)} style={{
                background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer',
              }}>{'\u2715'}</button>
            </div>

            {/* Security scan */}
            <div style={{
              padding: 12, borderRadius: 6, marginBottom: 16,
              background: preview.vet.safe ? '#0d1f0d' : '#1f0d0d',
              border: `1px solid ${preview.vet.safe ? '#1a3a1a' : '#3a1a1a'}`,
            }}>
              <div style={{
                fontSize: 14, fontWeight: 600, marginBottom: 8,
                color: preview.vet.safe ? '#66bb6a' : '#f44336',
              }}>
                {preview.vet.safe
                  ? (preview.vet.flags.length === 0 ? 'SAFE: No suspicious patterns detected' : 'CAUTION: Some patterns worth reviewing')
                  : 'BLOCKED: High-severity security issues found'}
              </div>
              {preview.vet.flags.length > 0 && (
                <div style={{ fontSize: 12, fontFamily: 'monospace' }}>
                  {preview.vet.flags.map((f, i) => (
                    <div key={i} style={{ marginBottom: 4, color: sevColor(f.severity) }}>
                      [{f.severity.toUpperCase()}] Line {f.line}: {f.reason}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Content */}
            <div style={{
              background: '#0a0a0a', padding: 12, borderRadius: 4, fontSize: 12,
              fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#ccc',
              maxHeight: 400, overflow: 'auto',
            }}>
              {preview.content.slice(0, 5000)}
              {preview.content.length > 5000 && `\n\n... (${preview.content.length - 5000} more chars)`}
            </div>

            {/* Actions */}
            <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setPreview(null)} style={{
                padding: '8px 16px', background: '#222', color: '#888', border: '1px solid #333',
                borderRadius: 4, cursor: 'pointer', fontSize: 13,
              }}>Close</button>
              {preview.vet.safe && (
                <button onClick={() => { doInstall(preview.repo); setPreview(null) }} style={{
                  padding: '8px 16px', background: '#4fc3f7', color: '#000', border: 'none',
                  borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}>Install</button>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'browse' && (
        <>
          {/* Search */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              placeholder="Search skills by name, tag, or keyword..."
              style={{
                flex: 1, padding: '8px 12px', background: '#1a1a1a', border: '1px solid #333',
                borderRadius: 4, color: '#e0e0e0', fontSize: 13, outline: 'none',
              }}
            />
            <button onClick={doSearch} disabled={searching} style={{
              padding: '8px 16px', background: '#4fc3f7', color: '#000', border: 'none',
              borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              opacity: searching ? 0.5 : 1,
            }}>
              {searching ? 'Searching...' : 'Search'}
            </button>
            {search && (
              <button onClick={() => { setSearch(''); loadData() }} style={{
                padding: '8px 12px', background: '#222', color: '#888', border: '1px solid #333',
                borderRadius: 4, cursor: 'pointer', fontSize: 13,
              }}>Clear</button>
            )}
          </div>

          {/* Manual install from repo */}
          <div style={{
            ...card, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20,
            padding: '12px 16px',
          }}>
            <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap', flexShrink: 0 }}>Install from repo:</span>
            <input
              value={manualRepo}
              onChange={e => setManualRepo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && manualRepo.trim() && doInstall(manualRepo.trim())}
              placeholder="user/repo or https://github.com/user/repo"
              style={{
                flex: 1, padding: '6px 10px', background: '#0a0a0a', border: '1px solid #333',
                borderRadius: 4, color: '#e0e0e0', fontSize: 12, fontFamily: 'monospace', outline: 'none',
              }}
            />
            <button
              onClick={() => manualRepo.trim() && doPreview(manualRepo.trim())}
              disabled={!manualRepo.trim() || previewLoading}
              style={{
                padding: '6px 12px', background: '#1a1a2e', color: '#4fc3f7',
                border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                opacity: !manualRepo.trim() ? 0.4 : 1,
              }}
            >Preview</button>
            <button
              onClick={() => { if (manualRepo.trim()) { doInstall(manualRepo.trim()); setManualRepo('') } }}
              disabled={!manualRepo.trim() || installing === manualRepo.trim()}
              style={{
                padding: '6px 12px', background: !manualRepo.trim() ? '#333' : '#4fc3f7',
                color: !manualRepo.trim() ? '#888' : '#000',
                border: 'none', borderRadius: 4, cursor: !manualRepo.trim() ? 'default' : 'pointer',
                fontSize: 11, fontWeight: 600,
              }}
            >Install</button>
          </div>

          {/* Registry grid */}
          {loading ? (
            <div style={{ color: '#666', fontSize: 13, padding: 20 }}>Loading registry...</div>
          ) : registry.length === 0 ? (
            <div style={{ ...card, color: '#666', fontSize: 13 }}>
              No skills found. {search ? 'Try a different search query.' : 'The registry may be unavailable.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {registry.map(skill => {
                const isInstalled = installedNames.has(skill.name)
                return (
                  <div key={skill.repo} style={{
                    ...card, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: '#4fc3f7' }}>{skill.name}</div>
                        {skill.downloads != null && (
                          <span style={{ fontSize: 11, color: '#666' }}>{'\u2B50'} {skill.downloads}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8, lineHeight: 1.4 }}>
                        {skill.description || 'No description'}
                      </div>
                      <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>
                        by <span style={{ color: '#888' }}>{skill.author}</span> &middot; {skill.repo}
                      </div>
                      {skill.tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                          {skill.tags.slice(0, 5).map(t => (
                            <span key={t} style={{
                              padding: '2px 6px', background: '#1a1a2e', color: '#4fc3f7',
                              borderRadius: 3, fontSize: 10, border: '1px solid #2a2a3e',
                            }}>#{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                      <button onClick={() => doPreview(skill.repo)} disabled={previewLoading} style={{
                        padding: '5px 10px', background: '#1a1a2e', color: '#4fc3f7',
                        border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                        flex: 1,
                      }}>Preview</button>
                      {isInstalled ? (
                        <span style={{ padding: '5px 10px', fontSize: 11, color: '#66bb6a' }}>Installed</span>
                      ) : (
                        <button onClick={() => doInstall(skill.repo)} disabled={installing === skill.repo} style={{
                          padding: '5px 10px', background: installing === skill.repo ? '#333' : '#4fc3f7',
                          color: installing === skill.repo ? '#888' : '#000',
                          border: 'none', borderRadius: 4, cursor: installing === skill.repo ? 'default' : 'pointer',
                          fontSize: 11, fontWeight: 600, flex: 1,
                        }}>
                          {installing === skill.repo ? 'Installing...' : 'Install'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {tab === 'installed' && (
        <>
          {installed.length > 0 && (
            <div style={{ marginBottom: 16, textAlign: 'right' }}>
              <button onClick={doUpdateAll} disabled={updatingAll} style={{
                padding: '8px 16px', background: updatingAll ? '#333' : '#1a1a2e',
                color: updatingAll ? '#888' : '#4fc3f7', border: '1px solid #333',
                borderRadius: 4, cursor: updatingAll ? 'default' : 'pointer', fontSize: 13,
              }}>
                {updatingAll ? 'Updating All...' : 'Update All'}
              </button>
            </div>
          )}

          {installed.length === 0 ? (
            <div style={{ ...card, color: '#666', fontSize: 13 }}>
              No ClawHub skills installed. Browse the registry to find and install skills.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {installed.map(skill => (
                <div key={skill.name} style={{
                  ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#4fc3f7', marginBottom: 4 }}>
                      {skill.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      from {skill.repo} &middot; installed {skill.installedAt.split('T')[0]}
                      &middot; source: {skill.source}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => doUpdate(skill.name)} disabled={updating === skill.name} style={{
                      padding: '5px 12px', background: '#1a1a2e', color: '#4fc3f7',
                      border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                    }}>
                      {updating === skill.name ? 'Updating...' : 'Update'}
                    </button>
                    <button onClick={() => doUninstall(skill.name)} disabled={uninstalling === skill.name} style={{
                      padding: '5px 12px', background: '#2e1a1a', color: '#f44336',
                      border: '1px solid #4a2a2a', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                    }}>
                      {uninstalling === skill.name ? 'Removing...' : 'Uninstall'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 30, right: 30, padding: '12px 24px',
          background: toast.err ? '#b71c1c' : '#1b5e20', color: '#fff',
          borderRadius: 8, fontSize: 13, zIndex: 300, maxWidth: 400,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
