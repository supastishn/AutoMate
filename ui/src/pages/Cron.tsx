import React from 'react'
import { onDataUpdate } from '../hooks/useDataUpdates'

interface CronJob {
  id: string
  name: string
  prompt: string
  schedule: { type: 'once' | 'interval' | 'cron'; at?: string; every?: number; cron?: string }
  sessionId?: string
  enabled: boolean
  lastRun?: string
  nextRun?: string
  createdAt: string
  runCount: number
}

interface CreateForm {
  name: string
  prompt: string
  scheduleType: 'once' | 'interval' | 'cron'
  cronExpression: string
  intervalMinutes: string
  sessionId: string
}

const colors = {
  bg: '#0a0a0a',
  card: '#141414',
  border: '#222',
  accent: '#4fc3f7',
  green: '#4caf50',
  red: '#f44336',
  orange: '#ff9800',
  textPrimary: '#e0e0e0',
  textSecondary: '#888',
}

const spinnerKeyframes = `
@keyframes cron-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
`

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: colors.bg,
    minHeight: '100vh',
    padding: '24px',
    color: colors.textPrimary,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 700,
    color: colors.textPrimary,
    margin: 0,
  },
  grid: {
    display: 'grid',
    gap: '16px',
    marginBottom: '32px',
  },
  card: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: '8px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardName: {
    fontSize: '16px',
    fontWeight: 600,
    color: colors.textPrimary,
    margin: 0,
  },
  badge: {
    fontSize: '11px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '9999px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  prompt: {
    fontSize: '13px',
    color: colors.textSecondary,
    lineHeight: '1.4',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '12px',
    fontSize: '12px',
    color: colors.textSecondary,
  },
  metaItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  metaLabel: {
    color: colors.textSecondary,
  },
  metaValue: {
    color: colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: '12px',
  },
  actions: {
    display: 'flex',
    gap: '8px',
    marginTop: '4px',
  },
  btnToggle: {
    flex: 1,
    padding: '6px 12px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
  },
  btnDelete: {
    padding: '6px 12px',
    borderRadius: '4px',
    border: `1px solid ${colors.red}`,
    background: 'transparent',
    color: colors.red,
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
  },
  formSection: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: '8px',
    padding: '20px',
  },
  formTitle: {
    fontSize: '18px',
    fontWeight: 600,
    marginBottom: '16px',
    color: colors.textPrimary,
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  formGroupFull: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
    gridColumn: '1 / -1',
  },
  label: {
    fontSize: '12px',
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  input: {
    padding: '8px 12px',
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    borderRadius: '4px',
    color: colors.textPrimary,
    fontSize: '14px',
    fontFamily: 'inherit',
    outline: 'none',
  },
  textarea: {
    padding: '8px 12px',
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    borderRadius: '4px',
    color: colors.textPrimary,
    fontSize: '14px',
    fontFamily: 'inherit',
    outline: 'none',
    resize: 'vertical' as const,
    minHeight: '80px',
  },
  select: {
    padding: '8px 12px',
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    borderRadius: '4px',
    color: colors.textPrimary,
    fontSize: '14px',
    fontFamily: 'inherit',
    outline: 'none',
  },
  btnCreate: {
    padding: '10px 20px',
    background: colors.accent,
    color: '#000',
    border: 'none',
    borderRadius: '4px',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '8px',
  },
  empty: {
    textAlign: 'center' as const,
    color: colors.textSecondary,
    padding: '48px 0',
    fontSize: '14px',
  },
  scheduleChip: {
    fontFamily: 'monospace',
    fontSize: '11px',
    padding: '2px 6px',
    borderRadius: '4px',
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    color: colors.accent,
  },
}

function formatSchedule(schedule: CronJob['schedule']): string {
  switch (schedule.type) {
    case 'once':
      return schedule.at ? `Once at ${new Date(schedule.at).toLocaleString()}` : 'Once'
    case 'interval':
      return `Every ${schedule.every ?? '?'} min`
    case 'cron':
      return schedule.cron ?? 'cron'
    default:
      return String(schedule.type)
  }
}

function formatTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString()
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function Cron() {
  const [jobs, setJobs] = React.useState<CronJob[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<CreateForm>({
    name: '',
    prompt: '',
    scheduleType: 'interval',
    cronExpression: '',
    intervalMinutes: '60',
    sessionId: '',
  })
  const [creating, setCreating] = React.useState(false)
  const [isMobile, setIsMobile] = React.useState(window.innerWidth < 360)

  React.useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 360)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const fetchJobs = React.useCallback(async () => {
    try {
      const res = await fetch('/api/cron')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setJobs(Array.isArray(data) ? data : data.jobs ?? [])
      setError(null)
    } catch (e: any) {
      setError(e.message ?? 'Failed to fetch jobs')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    fetchJobs()
    const interval = setInterval(fetchJobs, 30000)
    return () => clearInterval(interval)
  }, [fetchJobs])

  // Refetch when cron data changes via WebSocket push
  React.useEffect(() => {
    return onDataUpdate((resource) => {
      if (resource === 'cron') fetchJobs()
    })
  }, [fetchJobs])

  const toggleJob = async (id: string) => {
    try {
      await fetch(`/api/cron/${id}/toggle`, { method: 'PUT' })
      await fetchJobs()
    } catch {}
  }

  const deleteJob = async (id: string) => {
    try {
      await fetch(`/api/cron/${id}`, { method: 'DELETE' })
      await fetchJobs()
    } catch {}
  }

  const createJob = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.prompt.trim()) return
    setCreating(true)
    try {
      const schedule: any = { type: form.scheduleType }
      if (form.scheduleType === 'cron') {
        schedule.cron = form.cronExpression
      } else if (form.scheduleType === 'interval') {
        schedule.every = parseInt(form.intervalMinutes, 10) || 60
      }
      const body: any = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule,
      }
      if (form.sessionId.trim()) {
        body.sessionId = form.sessionId.trim()
      }
      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setForm({
        name: '',
        prompt: '',
        scheduleType: 'interval',
        cronExpression: '',
        intervalMinutes: '60',
        sessionId: '',
      })
      await fetchJobs()
    } catch (e: any) {
      setError(e.message ?? 'Failed to create job')
    } finally {
      setCreating(false)
    }
  }

  const gridStyle: React.CSSProperties = {
    ...styles.grid,
    gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(360px, 1fr))',
  }

  return (
    <div style={styles.page}>
      <style>{spinnerKeyframes}</style>
      <div style={styles.header}>
        <h1 style={styles.title}>Cron Jobs</h1>
        <span style={{ fontSize: '13px', color: colors.textSecondary }}>
          {jobs.length} job{jobs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {error && (
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(244,67,54,0.1)',
            border: `1px solid ${colors.red}`,
            borderRadius: '4px',
            color: colors.red,
            fontSize: '13px',
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: colors.red,
              cursor: 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              padding: '0 4px',
              marginLeft: '12px',
              fontWeight: 700,
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ ...styles.empty, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '24px',
              height: '24px',
              border: `3px solid ${colors.border}`,
              borderTop: `3px solid ${colors.accent}`,
              borderRadius: '50%',
              animation: 'cron-spin 0.8s linear infinite',
            }}
          />
          <span>Loading jobs…</span>
        </div>
      ) : jobs.length === 0 ? (
        <div style={styles.empty}>
          <div style={{ fontSize: '32px', marginBottom: '8px', opacity: 0.4 }}>⏰</div>
          No cron jobs. Create one below.
        </div>
      ) : (
        <div style={gridStyle}>
          {jobs.map((job) => (
            <div key={job.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <h3 style={styles.cardName}>{job.name}</h3>
                <span
                  style={{
                    ...styles.badge,
                    background: job.enabled ? 'rgba(76,175,80,0.15)' : 'rgba(136,136,136,0.15)',
                    color: job.enabled ? colors.green : colors.textSecondary,
                  }}
                >
                  {job.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              <div style={styles.prompt} title={job.prompt}>
                {truncate(job.prompt, 100)}
              </div>

              <div style={styles.meta}>
                <span style={styles.metaItem}>
                  <span style={styles.metaLabel}>Schedule:</span>
                  <span style={styles.scheduleChip}>{formatSchedule(job.schedule)}</span>
                </span>
                <span style={styles.metaItem}>
                  <span style={styles.metaLabel}>Next:</span>
                  <span style={styles.metaValue}>{formatTime(job.nextRun)}</span>
                </span>
                <span style={styles.metaItem}>
                  <span style={styles.metaLabel}>Runs:</span>
                  <span style={styles.metaValue}>{job.runCount}</span>
                </span>
              </div>

              {job.sessionId && (
                <div style={{ fontSize: '11px', color: colors.textSecondary }}>
                  Session:{' '}
                  <span style={{ fontFamily: 'monospace', color: colors.orange }}>
                    {job.sessionId}
                  </span>
                </div>
              )}

              <div style={styles.actions}>
                <button
                  style={{
                    ...styles.btnToggle,
                    background: job.enabled ? 'rgba(255,152,0,0.15)' : 'rgba(76,175,80,0.15)',
                    color: job.enabled ? colors.orange : colors.green,
                  }}
                  onClick={() => toggleJob(job.id)}
                >
                  {job.enabled ? 'Disable' : 'Enable'}
                </button>
                <button style={styles.btnDelete} onClick={() => deleteJob(job.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={styles.formSection}>
        <div style={styles.formTitle}>Create Job</div>
        <form onSubmit={createJob}>
          <div style={styles.formGrid}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Name</label>
              <input
                style={styles.input}
                type="text"
                placeholder="Job name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Schedule Type</label>
              <select
                style={styles.select}
                value={form.scheduleType}
                onChange={(e) =>
                  setForm({ ...form, scheduleType: e.target.value as CreateForm['scheduleType'] })
                }
              >
                <option value="once">Once</option>
                <option value="interval">Interval</option>
                <option value="cron">Cron</option>
              </select>
            </div>

            <div style={styles.formGroupFull}>
              <label style={styles.label}>Prompt</label>
              <textarea
                style={styles.textarea}
                placeholder="What should this job do?"
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              />
            </div>

            {form.scheduleType === 'cron' && (
              <div style={styles.formGroup}>
                <label style={styles.label}>Cron Expression</label>
                <input
                  style={{ ...styles.input, fontFamily: 'monospace' }}
                  type="text"
                  placeholder="*/5 * * * *"
                  value={form.cronExpression}
                  onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
                />
              </div>
            )}

            {form.scheduleType === 'interval' && (
              <div style={styles.formGroup}>
                <label style={styles.label}>Interval (minutes)</label>
                <input
                  style={{ ...styles.input, fontFamily: 'monospace' }}
                  type="number"
                  min="1"
                  placeholder="60"
                  value={form.intervalMinutes}
                  onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })}
                />
              </div>
            )}

            <div style={styles.formGroup}>
              <label style={styles.label}>Session ID (optional)</label>
              <input
                style={{ ...styles.input, fontFamily: 'monospace' }}
                type="text"
                placeholder="Existing session ID"
                value={form.sessionId}
                onChange={(e) => setForm({ ...form, sessionId: e.target.value })}
              />
            </div>
          </div>

          <button type="submit" style={styles.btnCreate} disabled={creating}>
            {creating ? 'Creating…' : 'Create Job'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Cron
