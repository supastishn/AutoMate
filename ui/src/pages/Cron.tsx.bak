import React from 'react'
import { onDataUpdate } from '../hooks/useDataUpdates'
import { useColors } from '../ThemeContext'

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

const spinnerKeyframes = `
@keyframes cron-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
`

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m`
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function formatSchedule(schedule: CronJob['schedule']): string {
  switch (schedule.type) {
    case 'once':
      return schedule.at ? `Once at ${new Date(schedule.at).toLocaleString()}` : 'Once'
    case 'interval': {
      const every = schedule.every
      if (every == null) return 'Every ?'
      // Values >= 1000 are milliseconds (from scheduler/heartbeat); smaller values are legacy minutes
      const label = every >= 1000 ? formatDuration(every) : `${every}m`
      return `Every ${label}`
    }
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
  const colors = useColors()
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
        schedule.every = (parseInt(form.intervalMinutes, 10) || 60) * 60 * 1000
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
    display: 'grid',
    gap: 16,
    marginBottom: 32,
    gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(360px, 1fr))',
  }

  const cardStyle: React.CSSProperties = {
    background: colors.bgCard,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  }

  const inputStyle: React.CSSProperties = {
    padding: '8px 12px',
    background: colors.bgPrimary,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    color: colors.textPrimary,
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
  }

  return (
    <div style={{ background: colors.bgPrimary, minHeight: '100vh', padding: 24, color: colors.textPrimary }}>
      <style>{spinnerKeyframes}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Cron Jobs</h1>
        <span style={{ fontSize: 13, color: colors.textSecondary }}>
          {jobs.length} job{jobs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px',
          background: colors.errorMuted,
          border: `1px solid ${colors.error}`,
          borderRadius: 4,
          color: colors.error,
          fontSize: 13,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: colors.error,
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: '0 4px',
              marginLeft: 12,
              fontWeight: 700,
            }}
          >
            ×
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', color: colors.textSecondary, padding: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 24,
            height: 24,
            border: `3px solid ${colors.border}`,
            borderTop: `3px solid ${colors.accent}`,
            borderRadius: '50%',
            animation: 'cron-spin 0.8s linear infinite',
          }} />
          <span>Loading jobs…</span>
        </div>
      ) : jobs.length === 0 ? (
        <div style={{ textAlign: 'center', color: colors.textSecondary, padding: 48, fontSize: 14 }}>
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>⏰</div>
          No cron jobs. Create one below.
        </div>
      ) : (
        <div style={gridStyle}>
          {jobs.map((job) => (
            <div key={job.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{job.name}</h3>
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  background: job.enabled ? colors.successMuted : colors.bgTertiary,
                  color: job.enabled ? colors.success : colors.textSecondary,
                }}>
                  {job.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              <div style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.prompt}>
                {truncate(job.prompt, 100)}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, color: colors.textSecondary }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>Schedule:</span>
                  <span style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: colors.bgPrimary,
                    border: `1px solid ${colors.border}`,
                    color: colors.accent,
                  }}>{formatSchedule(job.schedule)}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>Next:</span>
                  <span style={{ color: colors.textPrimary, fontFamily: 'monospace', fontSize: 12 }}>{formatTime(job.nextRun)}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>Runs:</span>
                  <span style={{ color: colors.textPrimary, fontFamily: 'monospace', fontSize: 12 }}>{job.runCount}</span>
                </span>
              </div>

              {job.sessionId && (
                <div style={{ fontSize: 11, color: colors.textSecondary }}>
                  Session:{' '}
                  <span style={{ fontFamily: 'monospace', color: colors.warning }}>
                    {job.sessionId}
                  </span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    borderRadius: 4,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    background: job.enabled ? colors.warningMuted : colors.successMuted,
                    color: job.enabled ? colors.warning : colors.success,
                  }}
                  onClick={() => toggleJob(job.id)}
                >
                  {job.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  style={{
                    padding: '6px 12px',
                    borderRadius: 4,
                    border: `1px solid ${colors.error}`,
                    background: 'transparent',
                    color: colors.error,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                  onClick={() => deleteJob(job.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{
        background: colors.bgCard,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 20,
      }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Create Job</div>
        <form onSubmit={createJob}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Name</label>
              <input
                style={inputStyle}
                type="text"
                placeholder="Job name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Schedule Type</label>
              <select
                style={inputStyle}
                value={form.scheduleType}
                onChange={(e) => setForm({ ...form, scheduleType: e.target.value as CreateForm['scheduleType'] })}
              >
                <option value="once">Once</option>
                <option value="interval">Interval</option>
                <option value="cron">Cron</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Prompt</label>
              <textarea
                style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
                placeholder="What should this job do?"
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              />
            </div>

            {form.scheduleType === 'cron' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Cron Expression</label>
                <input
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                  type="text"
                  placeholder="*/5 * * * *"
                  value={form.cronExpression}
                  onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
                />
              </div>
            )}

            {form.scheduleType === 'interval' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Interval (minutes)</label>
                <input
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                  type="number"
                  min="1"
                  placeholder="60"
                  value={form.intervalMinutes}
                  onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })}
                />
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>Session ID (optional)</label>
              <input
                style={{ ...inputStyle, fontFamily: 'monospace' }}
                type="text"
                placeholder="Existing session ID"
                value={form.sessionId}
                onChange={(e) => setForm({ ...form, sessionId: e.target.value })}
              />
            </div>
          </div>

          <button type="submit" style={{
            padding: '10px 20px',
            background: colors.accent,
            color: colors.accentContrast,
            border: 'none',
            borderRadius: 4,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            marginTop: 8,
          }} disabled={creating}>
            {creating ? 'Creating…' : 'Create Job'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Cron
