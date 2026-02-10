import React, { useEffect, useState } from 'react'

interface Skill {
  name: string
  description?: string
  file?: string
}

const card = {
  background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 20,
} as React.CSSProperties

export default function Skills() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('# My Skill\n\nDescribe what this skill does...')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetch('/api/skills')
      .then(r => r.json())
      .then((data: any) => {
        setSkills(data.skills || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div style={{ padding: 30, maxWidth: 900 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24, fontWeight: 600 }}>Skills</h1>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: '#888', marginBottom: 12 }}>
          Skills are plugin modules that extend AutoMate's capabilities. 
          Each skill is a directory with a SKILL.md file that gets injected into the agent's system prompt.
        </div>
        <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#4fc3f7' }}>
          ~/.automate/skills/
        </div>
      </div>

      {/* Loaded skills */}
      <div style={{ ...card, marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>
          Loaded Skills ({skills.length})
        </h3>
        {loading ? (
          <div style={{ color: '#666', fontSize: 13 }}>Loading...</div>
        ) : skills.length === 0 ? (
          <div style={{ color: '#666', fontSize: 13 }}>
            No skills loaded. Install skills via <code style={{ color: '#4fc3f7' }}>automate clawhub browse</code>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {skills.map(s => (
              <div key={s.name} style={{
                padding: 12, background: '#0d0d0d', borderRadius: 6, border: '1px solid #1a1a1a',
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#4fc3f7', marginBottom: 4 }}>
                    {s.name}
                  </div>
                  {s.description && (
                    <div style={{ fontSize: 12, color: '#888' }}>{s.description}</div>
                  )}
                </div>
                <button onClick={() => {
                  if (!confirm(`Uninstall skill "${s.name}"?`)) return
                  fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `/index off` }) }).catch(() => {})
                  // Use the skill builder tool via chat command to delete
                  fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Use the skill tool to delete the skill named "${s.name}"` }) })
                    .then(() => { setSkills(prev => prev.filter(sk => sk.name !== s.name)) }).catch(() => {})
                }} style={{
                  padding: '2px 8px', background: '#2e1a1a', color: '#f44336',
                  border: '1px solid #4a2a2a', borderRadius: 4, cursor: 'pointer', fontSize: 11,
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
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>Creating a Skill</h3>
        <div style={{ fontSize: 13, fontFamily: 'monospace', background: '#0a0a0a', padding: 12, borderRadius: 4, lineHeight: 1.8 }}>
          <div style={{ color: '#888' }}># Create a skill directory</div>
          <div style={{ color: '#e0e0e0' }}>mkdir -p ~/.automate/skills/my-skill</div>
          <div style={{ color: '#e0e0e0', marginTop: 4 }}>cat {'>'} ~/.automate/skills/my-skill/SKILL.md {'<<'} 'EOF'</div>
          <div style={{ color: '#81c784' }}># My Custom Skill</div>
          <div style={{ color: '#81c784' }}>When the user asks about X, do Y.</div>
          <div style={{ color: '#e0e0e0' }}>EOF</div>
        </div>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>Create Skill</h3>
        <div style={{ marginBottom: 8 }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Skill name (e.g. my-assistant)"
            style={{
              width: '100%', padding: '8px 12px', background: '#1a1a1a', border: '1px solid #333',
              borderRadius: 4, color: '#e0e0e0', fontSize: 13, outline: 'none', fontFamily: 'monospace',
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
              width: '100%', padding: '8px 12px', background: '#1a1a1a', border: '1px solid #333',
              borderRadius: 4, color: '#e0e0e0', fontSize: 12, outline: 'none', fontFamily: 'monospace',
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
            padding: '8px 20px', background: newName.trim() && !creating ? '#4fc3f7' : '#333',
            color: newName.trim() && !creating ? '#000' : '#666',
            border: 'none', borderRadius: 4, cursor: newName.trim() && !creating ? 'pointer' : 'default',
            fontWeight: 600, fontSize: 13,
          }}
        >
          {creating ? 'Creating...' : 'Create Skill'}
        </button>
      </div>

      <div style={card}>
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>ClawHub Registry</h3>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>
          Browse and install community skills from the ClawHub registry:
        </div>
        <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#e0e0e0', background: '#0a0a0a', padding: 8, borderRadius: 4, lineHeight: 1.8 }}>
          <div>automate clawhub browse</div>
          <div>automate clawhub search &lt;query&gt;</div>
          <div>automate clawhub install &lt;repo&gt;</div>
        </div>
      </div>
    </div>
  )
}
