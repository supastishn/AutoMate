import React from 'react'

const card = {
  background: '#141414', border: '1px solid #222', borderRadius: 8, padding: 20,
} as React.CSSProperties

export default function Skills() {
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

      <div style={card}>
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>Bundled Skills</h3>
        <div style={{ fontSize: 13, color: '#888' }}>
          Skills in the project's skills/ directory are loaded automatically.
          User skills in ~/.automate/skills/ take priority.
        </div>
      </div>
    </div>
  )
}
