import React, { useEffect, useState } from 'react'
import { useColors } from '../ThemeContext'

interface Skill {
  name: string
  description?: string
  file?: string
}

export default function Skills() {
  const colors = useColors()
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('# My Skill\n\nDescribe what this skill does...')
  const [creating, setCreating] = useState(false)
  const [editingSkill, setEditingSkill] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [saving, setSaving] = useState(false)

  const card: React.CSSProperties = {
    background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 20,
  }

  useEffect(() => {
    fetch('/api/skills')
      .then(r => r.json())
      .then((data: any) => {
        setSkills(data.skills || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleEdit = (name: string) => {
    setEditingSkill(name)
    fetch('/api/skills/' + name)
      .then(r => r.json())
      .then((data: any) => {
        if (data.content) {
          setEditingContent(data.content)
        } else {
          alert(data.error || 'Failed to load skill')
          setEditingSkill(null)
        }
      })
      .catch(() => {
        alert('Failed to load skill')
        setEditingSkill(null)
      })
  }

  const handleSaveEdit = () => {
    if (!editingSkill) return
    setSaving(true)
    fetch('/api/skills/' + editingSkill, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editingContent }),
    })
      .then(r => r.json())
      .then((res: any) => {
        if (res.ok) {
          setEditingSkill(null)
          setEditingContent('')
          fetch('/api/skills').then(r => r.json()).then((d: any) => setSkills(d.skills || [])).catch(() => {})
        } else {
          alert(res.error || 'Failed to save')
        }
      })
      .catch(() => alert('Failed to save'))
      .finally(() => setSaving(false))
  }

  return (
    <div style={{ padding: 30, maxWidth: 900 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24, fontWeight: 600, color: colors.textPrimary }}>Skills</h1>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 12 }}>
          Skills are plugin modules that extend AutoMate's capabilities.
          Each skill is a directory with a SKILL.md file that gets injected into the agent's system prompt.
        </div>
        <div style={{ fontSize: 13, fontFamily: 'monospace', color: colors.accent }}>
          ~/.automate/skills/
        </div>
      </div>

      {/* Loaded skills */}
      <div style={{ ...card, marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12, color: colors.textPrimary }}>
          Loaded Skills ({skills.length})
        </h3>
        {loading ? (
          <div style={{ color: colors.inputPlaceholder, fontSize: 13 }}>Loading...</div>
        ) : skills.length === 0 ? (
          <div style={{ color: colors.inputPlaceholder, fontSize: 13 }}>
            No skills loaded. Install skills via <code style={{ color: colors.accent }}>automate clawhub browse</code>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {skills.map(s => (
              <div key={s.name} style={{
                padding: 12, background: colors.bgSecondary, borderRadius: 6, border: `1px solid ${colors.border}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: colors.accent, marginBottom: 4 }}>
                    {s.name}
                  </div>
                  {s.description && (
                    <div style={{ fontSize: 12, color: colors.textSecondary }}>{s.description}</div>
                  )}
                </div>
                <button onClick={() => handleEdit(s.name)} style={{
                  padding: '2px 8px', background: colors.bgSecondary, color: colors.accent,
                  border: `1px solid ${colors.border}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  flexShrink: 0, marginRight: 4,
                }}>
                  Edit
                </button>
                <button onClick={() => {
                  if (!confirm(`Uninstall skill "${s.name}"?`)) return
                  fetch('/api/skills/uninstall', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: s.name }),
                  })
                    .then(r => r.json())
                    .then((res: any) => {
                      if (res.success) {
                        setSkills(prev => prev.filter(sk => sk.name !== s.name))
                      } else {
                        alert(res.error || 'Failed to uninstall')
                      }
                    })
                    .catch(() => alert('Failed to uninstall'))
                }} style={{
                  padding: '2px 8px', background: colors.bgDanger, color: colors.error,
                  border: `1px solid ${colors.borderDanger}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  flexShrink: 0,
                }}>
                  Uninstall
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12, color: colors.textPrimary }}>Creating a Skill</h3>
        <div style={{ fontSize: 13, fontFamily: 'monospace', background: colors.bgPrimary, padding: 12, borderRadius: 4, lineHeight: 1.8 }}>
          <div style={{ color: colors.textSecondary }}># Create a skill directory</div>
          <div style={{ color: colors.textPrimary }}>mkdir -p ~/.automate/skills/my-skill</div>
          <div style={{ color: colors.textPrimary, marginTop: 4 }}>cat {'>'} ~/.automate/skills/my-skill/SKILL.md {'<<'} 'EOF'</div>
          <div style={{ color: colors.syntaxString }}># My Custom Skill</div>
          <div style={{ color: colors.syntaxString }}>When the user asks about X, do Y.</div>
          <div style={{ color: colors.textPrimary }}>EOF</div>
        </div>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12, color: colors.textPrimary }}>Create Skill</h3>
        <div style={{ marginBottom: 8 }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Skill name (e.g. my-assistant)"
            style={{
              width: '100%', padding: '8px 12px', background: colors.bgHover, border: `1px solid ${colors.borderLight}`,
              borderRadius: 4, color: colors.textPrimary, fontSize: 13, outline: 'none', fontFamily: 'monospace',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            rows={6}
            style={{
              width: '100%', padding: '8px 12px', background: colors.bgHover, border: `1px solid ${colors.borderLight}`,
              borderRadius: 4, color: colors.textPrimary, fontSize: 12, outline: 'none', fontFamily: 'monospace',
              boxSizing: 'border-box', resize: 'vertical',
            }}
          />
        </div>
        <button
          disabled={!newName.trim() || creating}
          onClick={() => {
            setCreating(true)
            fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: `Use the skill tool to create a new skill named "${newName}" with this content:\n\n${newContent}` }),
            })
              .then(() => {
                setNewName('')
                setNewContent('# My Skill\n\nDescribe what this skill does...')
                // Reload skills
                fetch('/api/skills').then(r => r.json()).then((d: any) => setSkills(d.skills || [])).catch(() => {})
              })
              .catch(() => {})
              .finally(() => setCreating(false))
          }}
          style={{
            padding: '8px 20px', background: newName.trim() && !creating ? colors.accent : colors.borderLight,
            color: newName.trim() && !creating ? colors.accentContrast : colors.inputPlaceholder,
            border: 'none', borderRadius: 4, cursor: newName.trim() && !creating ? 'pointer' : 'default',
            fontWeight: 600, fontSize: 13,
          }}
        >
          {creating ? 'Creating...' : 'Create Skill'}
        </button>
      </div>

      <div style={card}>
        <h3 style={{ fontSize: 16, marginBottom: 12, color: colors.textPrimary }}>ClawHub Registry</h3>
        <div style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 12 }}>
          Browse and install community skills from the ClawHub registry. Preview skills with security scanning before installing.
        </div>
        <div style={{ fontSize: 13, color: colors.textPrimary }}>
          Visit the <strong style={{ color: colors.accent }}>ClawHub</strong> tab in the sidebar to browse, search, install, and manage community skills.
        </div>
      </div>

      {/* Edit Skill Modal */}
      {editingSkill && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 8,
            padding: 20, width: '90%', maxWidth: 700, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          }}>
            <h3 style={{ fontSize: 16, marginBottom: 12, color: colors.textPrimary }}>
              Edit Skill: {editingSkill}
            </h3>
            <textarea
              value={editingContent}
              onChange={e => setEditingContent(e.target.value)}
              style={{
                flex: 1, minHeight: 300, padding: '8px 12px', background: colors.bgHover,
                border: `1px solid ${colors.borderLight}`, borderRadius: 4, color: colors.textPrimary,
                fontSize: 12, outline: 'none', fontFamily: 'monospace', resize: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => { setEditingSkill(null); setEditingContent('') }} style={{
                padding: '8px 16px', background: colors.bgSecondary, color: colors.textPrimary,
                border: `1px solid ${colors.border}`, borderRadius: 4, cursor: 'pointer', fontSize: 13,
              }}>
                Cancel
              </button>
              <button onClick={handleSaveEdit} disabled={saving} style={{
                padding: '8px 16px', background: saving ? colors.borderLight : colors.accent,
                color: saving ? colors.inputPlaceholder : colors.accentContrast,
                border: 'none', borderRadius: 4, cursor: saving ? 'default' : 'pointer', fontSize: 13, fontWeight: 600,
              }}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
