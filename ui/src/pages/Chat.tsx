import React, { useEffect, useRef, useState, useCallback } from 'react'
import { emitDataUpdate } from '../hooks/useDataUpdates'

const SLASH_COMMANDS = [
  { cmd: '/new', desc: 'Start a new session' },
  { cmd: '/reset', desc: 'Reset current session' },
  { cmd: '/factory-reset', desc: 'Wipe everything' },
  { cmd: '/status', desc: 'Session info' },
  { cmd: '/compact', desc: 'Compact context' },
  { cmd: '/elevated on|off', desc: 'Toggle elevated permissions' },
  { cmd: '/model', desc: 'List or switch models' },
  { cmd: '/context', desc: 'Context diagnostics' },
  { cmd: '/index on|off|rebuild', desc: 'Manage search index' },
  { cmd: '/heartbeat on|off|now', desc: 'Manage heartbeat' },
] as const

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: { name: string; result: string }[]
  images?: { url?: string; base64?: string; mimeType: string; alt?: string; filename?: string }[]
  reactions?: string[]
  timestamp: number
}

// Simple markdown renderer (no external dep runtime - we parse ourselves)
function renderMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      const code = codeLines.join('\n')
      nodes.push(
        <div key={key++} style={{ margin: '8px 0' }}>
          {lang && <div style={{ fontSize: 10, color: '#888', padding: '2px 10px', background: '#1a1a2e', borderRadius: '4px 4px 0 0', borderBottom: '1px solid #333' }}>{lang}</div>}
          <pre style={{
            margin: 0, padding: 12, background: '#0d0d0d', borderRadius: lang ? '0 0 4px 4px' : 4,
            fontSize: 12, lineHeight: 1.6, overflow: 'auto', border: '1px solid #2a2a2a',
            fontFamily: '"Fira Code", "JetBrains Mono", monospace',
          }}>
            <code>{highlightCode(code, lang)}</code>
          </pre>
        </div>
      )
      continue
    }

    // Headers
    if (line.startsWith('### ')) {
      nodes.push(<h4 key={key++} style={{ fontSize: 14, fontWeight: 600, margin: '12px 0 4px', color: '#e0e0e0' }}>{formatInline(line.slice(4))}</h4>)
      i++; continue
    }
    if (line.startsWith('## ')) {
      nodes.push(<h3 key={key++} style={{ fontSize: 16, fontWeight: 600, margin: '14px 0 6px', color: '#e0e0e0' }}>{formatInline(line.slice(3))}</h3>)
      i++; continue
    }
    if (line.startsWith('# ')) {
      nodes.push(<h2 key={key++} style={{ fontSize: 18, fontWeight: 700, margin: '16px 0 8px', color: '#fff' }}>{formatInline(line.slice(2))}</h2>)
      i++; continue
    }

    // Bullet list
    if (line.match(/^[-*] /)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        items.push(lines[i].replace(/^[-*] /, ''))
        i++
      }
      nodes.push(
        <ul key={key++} style={{ margin: '4px 0', paddingLeft: 20 }}>
          {items.map((item, j) => <li key={j} style={{ marginBottom: 2, lineHeight: 1.6 }}>{formatInline(item)}</li>)}
        </ul>
      )
      continue
    }

    // Numbered list
    if (line.match(/^\d+\. /)) {
      const items: string[] = []
      while (i < lines.length && lines[i].match(/^\d+\. /)) {
        items.push(lines[i].replace(/^\d+\. /, ''))
        i++
      }
      nodes.push(
        <ol key={key++} style={{ margin: '4px 0', paddingLeft: 20 }}>
          {items.map((item, j) => <li key={j} style={{ marginBottom: 2, lineHeight: 1.6 }}>{formatInline(item)}</li>)}
        </ol>
      )
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2))
        i++
      }
      nodes.push(
        <blockquote key={key++} style={{
          margin: '8px 0', padding: '8px 14px', borderLeft: '3px solid #4fc3f7',
          background: '#0d1520', color: '#aaa', fontStyle: 'italic',
        }}>
          {quoteLines.map((l, j) => <div key={j}>{formatInline(l)}</div>)}
        </blockquote>
      )
      continue
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      nodes.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid #333', margin: '12px 0' }} />)
      i++; continue
    }

    // Tool usage marker: [used tool: toolName]
    if (line.match(/^\[used tool: .+\]$/)) {
      const toolName = line.replace(/^\[used tool: /, '').replace(/\]$/, '')
      nodes.push(
        <div key={key++} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          margin: '6px 0', padding: '4px 10px', background: '#1a1a2e',
          border: '1px solid #2a2a4a', borderRadius: 16, fontSize: 11,
          color: '#8888cc', fontFamily: 'monospace',
        }}>
          <span style={{ color: '#6a6aaa' }}>&#9881;</span>
          <span>used tool: <span style={{ color: '#4fc3f7', fontWeight: 600 }}>{toolName}</span></span>
        </div>
      )
      i++; continue
    }

    // Empty line
    if (!line.trim()) {
      nodes.push(<div key={key++} style={{ height: 6 }} />)
      i++; continue
    }

    // Regular paragraph
    nodes.push(<p key={key++} style={{ margin: '2px 0', lineHeight: 1.6 }}>{formatInline(line)}</p>)
    i++
  }

  return nodes
}

// Inline formatting: bold, italic, inline code, links
function formatInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  while (remaining.length > 0) {
    // Inline code
    let match = remaining.match(/^`([^`]+)`/)
    if (match) {
      parts.push(<code key={key++} style={{ background: '#1a1a2e', padding: '1px 5px', borderRadius: 3, fontSize: '0.9em', color: '#e6db74', fontFamily: 'monospace' }}>{match[1]}</code>)
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Bold
    match = remaining.match(/^\*\*(.+?)\*\*/)
    if (match) {
      parts.push(<strong key={key++} style={{ fontWeight: 600, color: '#fff' }}>{match[1]}</strong>)
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Italic
    match = remaining.match(/^\*(.+?)\*/)
    if (match) {
      parts.push(<em key={key++}>{match[1]}</em>)
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Link
    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/)
    if (match) {
      parts.push(<a key={key++} href={match[2]} target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'underline' }}>{match[1]}</a>)
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Regular text - consume until next special char
    const nextSpecial = remaining.search(/[`*\[]/)
    if (nextSpecial === -1) {
      parts.push(remaining)
      break
    } else if (nextSpecial === 0) {
      // Special char that didn't match a pattern - consume it
      parts.push(remaining[0])
      remaining = remaining.slice(1)
    } else {
      parts.push(remaining.slice(0, nextSpecial))
      remaining = remaining.slice(nextSpecial)
    }
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>
}

// Simple syntax highlighting by token type
function highlightCode(code: string, lang: string): React.ReactNode {
  const keywords = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'import', 'export', 'from', 'class', 'extends', 'new', 'this', 'async', 'await',
    'try', 'catch', 'throw', 'switch', 'case', 'break', 'continue', 'default',
    'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'yield', 'interface',
    'type', 'enum', 'implements', 'abstract', 'public', 'private', 'protected',
    'static', 'readonly', 'override', 'def', 'self', 'True', 'False', 'None',
    'print', 'elif', 'pass', 'with', 'as', 'lambda', 'raise', 'except', 'finally',
    'fn', 'pub', 'mod', 'use', 'struct', 'impl', 'trait', 'match', 'mut', 'ref',
  ])

  const parts: React.ReactNode[] = []
  const tokens = code.split(/(\s+|[{}()\[\];,.:!<>=+\-*/&|^~?@#]|"[^"]*"|'[^']*'|`[^`]*`|\/\/.*$|\/\*[\s\S]*?\*\/|\b\d+\.?\d*\b)/gm)
  let key = 0

  for (const token of tokens) {
    if (!token) continue
    if (keywords.has(token)) {
      parts.push(<span key={key++} style={{ color: '#c678dd' }}>{token}</span>)
    } else if (token.match(/^("|'|`)/) ) {
      parts.push(<span key={key++} style={{ color: '#98c379' }}>{token}</span>)
    } else if (token.match(/^\/\//)) {
      parts.push(<span key={key++} style={{ color: '#5c6370', fontStyle: 'italic' }}>{token}</span>)
    } else if (token.match(/^\d/)) {
      parts.push(<span key={key++} style={{ color: '#d19a66' }}>{token}</span>)
    } else if (token.match(/^[{}()\[\];,.:!<>=+\-*/&|^~?@#]/)) {
      parts.push(<span key={key++} style={{ color: '#abb2bf' }}>{token}</span>)
    } else {
      parts.push(<span key={key++}>{token}</span>)
    }
  }

  return <>{parts}</>
}

interface HeartbeatActivity {
  sessionId: string
  round: number
  toolCalls: string[]
  content: string
  status: 'running' | 'finished' | 'error' | 'max_rounds'
  timestamp: number
}

export default function Chat({ loadSessionId, onSessionLoaded }: { loadSessionId?: string | null; onSessionLoaded?: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [connected, setConnected] = useState(false)
  const [typing, setTyping] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('automate_token') || '')
  const [needsAuth, setNeedsAuth] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [sessionsList, setSessionsList] = useState<{ id: string; channel: string; messageCount: number; updatedAt: string }[]>([])
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [contextInfo, setContextInfo] = useState<{ used: number; limit: number; percent: number } | null>(null)
  const [elevated, setElevated] = useState(false)
  const [currentModel, setCurrentModel] = useState('')
  const [models, setModels] = useState<{name: string; model: string; active: boolean}[]>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [heartbeat, setHeartbeat] = useState<HeartbeatActivity | null>(null)
  const [awaitingResponse, setAwaitingResponse] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const msgIdRef = useRef(0)
  const awaitingResponseRef = useRef(false)

  const makeId = () => `msg_${++msgIdRef.current}_${Date.now()}`

  useEffect(() => {
    connect()
    return () => { wsRef.current?.close() }
  }, [])

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then((d: any) => {
      setModels(d.providers || [])
      setCurrentModel(d.current?.model || '')
    }).catch(() => {})
  }, [])

  // Fetch sessions list for the picker
  const fetchSessionsList = useCallback(async () => {
    try {
      const r = await fetch('/api/sessions')
      const data = await r.json() as any
      setSessionsList((data.sessions || []).filter((s: any) => s.messageCount > 0))
    } catch {}
  }, [])

  // Load a session requested from another tab (e.g. Sessions "Open in Chat")
  // Retries until WS is connected since Chat may be freshly mounting
  useEffect(() => {
    if (!loadSessionId) return
    const trySend = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'load_session', session_id: loadSessionId }))
        onSessionLoaded?.()
        return true
      }
      return false
    }
    if (trySend()) return
    // WS not ready yet — retry until connected
    const interval = setInterval(() => {
      if (trySend()) clearInterval(interval)
    }, 200)
    return () => clearInterval(interval)
  }, [loadSessionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws`)

    ws.onopen = () => {
      setConnected(true)
      setNeedsAuth(false)
    }
    ws.onclose = () => { setConnected(false); setTimeout(connect, 3000) }
    ws.onerror = () => {
      // May need auth
      fetch('/api/health').then(r => {
        if (r.status === 401) setNeedsAuth(true)
      }).catch(() => {})
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)

      if (msg.type === 'connected') {
        setCurrentSessionId(msg.session_id)
        if (msg.context) setContextInfo(msg.context)
        setMessages(prev => [...prev, {
          id: makeId(),
          role: 'system',
          content: `Connected. Session: ${msg.session_id}`,
          timestamp: Date.now(),
        }])
      }
      if (msg.type === 'session_loaded') {
        setCurrentSessionId(msg.session_id)
        if (msg.context) setContextInfo(msg.context)
        // Replace messages with loaded session history
        // Skip assistant messages that are just tool call containers with no text content
        const loaded: ChatMessage[] = (msg.messages || [])
          .filter((m: any) => {
            // Skip system messages from loaded history
            if (m.role === 'system') return false
            // Skip blank assistant messages that only had tool_calls and no content
            if (m.role === 'assistant' && !m.content && (!m.tool_calls || m.tool_calls.length === 0)) return false
            return true
          })
          .map((m: any) => {
            // For assistant messages with tool_calls, show tool usage info
            let content = m.content || ''
            const toolCalls = m.tool_calls
              ? m.tool_calls.map((tc: any) => ({ name: tc.name, result: '' }))
              : undefined
            // If assistant message has no text but has tool calls, synthesize a description
            if (!content && toolCalls && toolCalls.length > 0) {
              content = toolCalls.map((tc: any) => `[used tool: ${tc.name}]`).join('\n')
            }
            return {
              id: makeId(),
              role: m.role as 'user' | 'assistant',
              content,
              toolCalls,
              timestamp: Date.now(),
            }
          })
        setMessages([
          { id: makeId(), role: 'system', content: `Loaded session: ${msg.session_id}`, timestamp: Date.now() },
          ...loaded,
        ])
        setStreaming('')
      }
      if (msg.type === 'typing') {
        // Only show typing if we're awaiting a response, to avoid stale typing indicators
        if (msg.active) {
          setTyping(awaitingResponseRef.current)
        } else {
          setTyping(false)
        }
      }
      if (msg.type === 'stream') {
        setStreaming(prev => prev + msg.content)
        setTyping(false)
      }
      if (msg.type === 'response') {
        setTyping(false)
        setAwaitingResponse(false)
        awaitingResponseRef.current = false
        if (msg.context) setContextInfo(msg.context)
        // Use accumulated streaming content if available — msg.content only has the
        // final LLM response (after tool calls), so it would wipe earlier streamed text.
        setStreaming(prev => {
          const finalContent = prev || msg.content || ''
          setMessages(msgs => [...msgs, {
            id: makeId(),
            role: 'assistant',
            content: finalContent,
            toolCalls: msg.tool_calls,
            timestamp: Date.now(),
          }])
          return ''
        })
      }
      if (msg.type === 'error') {
        setTyping(false)
        setAwaitingResponse(false)
        awaitingResponseRef.current = false
        setMessages(prev => [...prev, {
          id: makeId(),
          role: 'system',
          content: `Error: ${msg.message}`,
          timestamp: Date.now(),
        }])
      }
      // Forward data_update events to the shared event bus
      if (msg.type === 'data_update') {
        emitDataUpdate(msg.resource, msg.data)
      }
      // Handle heartbeat activity events (live heartbeat streaming)
      if (msg.type === 'heartbeat_activity') {
        if (msg.event === 'start') {
          setHeartbeat({
            sessionId: msg.sessionId || msg.session_id || '',
            round: 0,
            toolCalls: [],
            content: '',
            status: 'running',
            timestamp: msg.timestamp || Date.now(),
          })
        } else if (msg.event === 'round') {
          setHeartbeat(prev => ({
            sessionId: msg.sessionId || msg.session_id || prev?.sessionId || '',
            round: msg.round || (prev?.round || 0) + 1,
            toolCalls: msg.toolCalls || [],
            content: msg.content || '',
            status: 'running',
            timestamp: msg.timestamp || Date.now(),
          }))
        } else if (msg.event === 'end') {
          setHeartbeat(prev => prev ? {
            ...prev,
            status: msg.status || 'finished',
            round: msg.round || prev.round,
            timestamp: msg.timestamp || Date.now(),
          } : null)
          // Auto-dismiss after 8 seconds
          setTimeout(() => setHeartbeat(null), 8000)
        }
      }
      // Handle image events
      if (msg.type === 'image') {
        const imgData = {
          url: msg.url,
          base64: msg.base64,
          mimeType: msg.mimeType,
          alt: msg.alt,
          filename: msg.filename,
        }
        setMessages(prev => {
          // Attach to last assistant message or create new
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), {
              ...last,
              images: [...(last.images || []), imgData],
            }]
          }
          return [...prev, {
            id: makeId(),
            role: 'assistant',
            content: '',
            images: [imgData],
            timestamp: Date.now(),
          }]
        })
      }
    }

    wsRef.current = ws
  }

  const send = () => {
    if (!input.trim() || !wsRef.current) return
    setMessages(prev => [...prev, { id: makeId(), role: 'user', content: input, timestamp: Date.now() }])
    wsRef.current.send(JSON.stringify({ type: 'message', content: input }))
    setInput('')
    setStreaming('')
    setAwaitingResponse(true)
    awaitingResponseRef.current = true
    inputRef.current?.focus()
  }

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)

    for (const file of Array.from(files)) {
      const formData = new FormData()
      formData.append('file', file)

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData })
        const data = await res.json() as any

        if (data.ok) {
          // If it's an image, show preview in chat
          if (file.type.startsWith('image/')) {
            const reader = new FileReader()
            reader.onload = () => {
              setMessages(prev => [...prev, {
                id: makeId(),
                role: 'user',
                content: `Uploaded: ${file.name}`,
                images: [{
                  base64: (reader.result as string).split(',')[1],
                  mimeType: file.type,
                  filename: file.name,
                }],
                timestamp: Date.now(),
              }])
            }
            reader.readAsDataURL(file)
          } else {
            setMessages(prev => [...prev, {
              id: makeId(),
              role: 'user',
              content: `Uploaded: ${file.name} (${formatBytes(data.size)})`,
              timestamp: Date.now(),
            }])
          }

          // Tell the agent about the uploaded file
          if (wsRef.current) {
            const msg = file.type.startsWith('image/')
              ? `[User uploaded an image: ${file.name} at ${data.path}. You can analyze it with analyze_image.]`
              : `[User uploaded a file: ${file.name} (${formatBytes(data.size)}) at ${data.path}]`
            wsRef.current.send(JSON.stringify({ type: 'message', content: msg }))
          }
        }
      } catch (err) {
        setMessages(prev => [...prev, {
          id: makeId(),
          role: 'system',
          content: `Upload failed: ${err}`,
          timestamp: Date.now(),
        }])
      }
    }
    setUploading(false)
  }

  const toggleReaction = (msgId: string, emoji: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m
      const reactions = m.reactions || []
      if (reactions.includes(emoji)) {
        return { ...m, reactions: reactions.filter(r => r !== emoji) }
      }
      return { ...m, reactions: [...reactions, emoji] }
    }))
  }

  const copyMessage = (content: string) => {
    navigator.clipboard.writeText(content)
  }

  // Auth login screen
  if (needsAuth) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#0a0a0a' }}>
        <div style={{ padding: 40, background: '#141414', borderRadius: 12, border: '1px solid #222', maxWidth: 400, width: '100%' }}>
          <h2 style={{ fontSize: 20, marginBottom: 8, color: '#4fc3f7' }}>AutoMate</h2>
          <p style={{ fontSize: 13, color: '#888', marginBottom: 20 }}>Enter your authentication token to connect.</p>
          <input
            value={authToken}
            onChange={e => setAuthToken(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                localStorage.setItem('automate_token', authToken)
                setNeedsAuth(false)
                connect()
              }
            }}
            placeholder="Bearer token..."
            type="password"
            style={{
              width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333',
              borderRadius: 6, color: '#e0e0e0', fontSize: 14, outline: 'none', fontFamily: 'monospace',
              boxSizing: 'border-box', marginBottom: 12,
            }}
          />
          <button
            onClick={() => {
              localStorage.setItem('automate_token', authToken)
              setNeedsAuth(false)
              connect()
            }}
            style={{
              width: '100%', padding: '10px 20px', background: '#4fc3f7', color: '#000', border: 'none',
              borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 14,
            }}
          >
            Connect
          </button>
        </div>
      </div>
    )
  }

  const msgStyle = (role: string): React.CSSProperties => ({
    padding: '12px 16px',
    marginBottom: 8,
    borderRadius: 10,
    maxWidth: '85%',
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
    background: role === 'user' ? '#1a3a5c' : role === 'system' ? '#1a1a1a' : '#111a11',
    border: `1px solid ${role === 'user' ? '#2a5a8c' : role === 'system' ? '#333' : '#1a3a1a'}`,
    fontSize: 14,
    lineHeight: 1.6,
    wordBreak: 'break-word',
    position: 'relative',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#4caf50' : '#f44' }} />
          <span style={{ fontSize: 14, color: '#888' }}>{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
        {contextInfo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={`${contextInfo.used.toLocaleString()} / ${contextInfo.limit.toLocaleString()} tokens`}>
            <div style={{
              width: 80, height: 6, background: '#1a1a2e', borderRadius: 3, overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.min(contextInfo.percent, 100)}%`, height: '100%', borderRadius: 3,
                background: contextInfo.percent > 80 ? '#f44' : contextInfo.percent > 50 ? '#ff9800' : '#4caf50',
                transition: 'width 0.3s, background 0.3s',
              }} />
            </div>
            <span style={{ fontSize: 10, color: contextInfo.percent > 80 ? '#f44' : '#666', fontFamily: 'monospace' }}>
              {contextInfo.percent}%
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Elevated toggle */}
          <button onClick={() => {
            const next = !elevated
            setElevated(next)
            fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `/elevated ${next ? 'on' : 'off'}`, sessionId: currentSessionId }) }).catch(() => {})
          }} title={elevated ? 'Elevated: ON' : 'Elevated: OFF'} style={{
            padding: '4px 10px', background: elevated ? '#1a2e1a' : '#1a1a2e',
            color: elevated ? '#4caf50' : '#888', border: `1px solid ${elevated ? '#4caf50' : '#333'}`,
            borderRadius: 4, cursor: 'pointer', fontSize: 13,
          }}>
            {elevated ? '\u{1F6E1}\uFE0F' : '\u{1F512}'}
          </button>
          {/* Model picker */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowModelPicker(!showModelPicker)} style={{
              padding: '4px 12px', background: '#1a1a2e', color: '#4fc3f7',
              border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11,
              maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {currentModel.split('/').pop() || 'Model'}
            </button>
            {showModelPicker && (
              <div style={{
                position: 'absolute', top: 30, right: 0, zIndex: 100,
                background: '#141414', border: '1px solid #333', borderRadius: 8,
                minWidth: 220, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              }}>
                {models.map((m, i) => (
                  <div key={i} onClick={() => {
                    fetch('/api/models/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: m.name }) })
                      .then(r => r.json()).then((d: any) => { if (d.success) setCurrentModel(d.model || m.model) }).catch(() => {})
                    setShowModelPicker(false)
                  }} style={{
                    padding: '8px 14px', cursor: 'pointer', borderBottom: '1px solid #1a1a1a',
                    background: m.active ? '#1a1a2e' : 'transparent',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
                  onMouseLeave={e => (e.currentTarget.style.background = m.active ? '#1a1a2e' : 'transparent')}
                  >
                    <div style={{ fontSize: 12, color: m.active ? '#4fc3f7' : '#ccc' }}>{m.name}</div>
                    <div style={{ fontSize: 10, color: '#666' }}>{m.model}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => {
            fetchSessionsList()
            setShowSessionPicker(!showSessionPicker)
          }} style={{
            padding: '4px 12px', background: '#1a1a2e', color: '#888',
            border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11,
          }}>
            Sessions
          </button>
          <button onClick={() => {
            if (wsRef.current) {
              wsRef.current.send(JSON.stringify({ type: 'message', content: '/new' }))
              setMessages([])
              setStreaming('')
              setCurrentSessionId(null)
            }
          }} style={{
            padding: '4px 12px', background: '#1a1a2e', color: '#888',
            border: '1px solid #333', borderRadius: 4, cursor: 'pointer', fontSize: 11,
          }}>
            New
          </button>
        </div>
      </div>

      {/* Session picker dropdown */}
      {showSessionPicker && (
        <div style={{
          position: 'absolute', top: 48, right: 20, zIndex: 100,
          background: '#141414', border: '1px solid #333', borderRadius: 8,
          maxHeight: 300, overflow: 'auto', width: 340, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #222', fontSize: 12, color: '#888' }}>
            Load a session
          </div>
          {sessionsList.length === 0 && (
            <div style={{ padding: 16, color: '#555', fontSize: 12, textAlign: 'center' }}>No sessions with messages</div>
          )}
          {sessionsList.map(s => (
            <div
              key={s.id}
              onClick={() => {
                if (wsRef.current) {
                  wsRef.current.send(JSON.stringify({ type: 'load_session', session_id: s.id }))
                  setShowSessionPicker(false)
                }
              }}
              style={{
                padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #1a1a1a',
                fontSize: 12, transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontFamily: 'monospace', color: '#4fc3f7', fontSize: 11, marginBottom: 2 }}>{s.id}</div>
              <div style={{ color: '#666', fontSize: 10 }}>
                {s.channel} &middot; {s.messageCount} msgs &middot; {new Date(s.updatedAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Heartbeat activity banner */}
      {heartbeat && (
        <div style={{
          padding: '8px 20px',
          background: heartbeat.status === 'running' ? '#1a1520' : heartbeat.status === 'finished' ? '#151a15' : '#1a1515',
          borderBottom: `1px solid ${heartbeat.status === 'running' ? '#3a2a4a' : heartbeat.status === 'finished' ? '#2a4a2a' : '#4a2a2a'}`,
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 12,
        }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: heartbeat.status === 'running' ? '#ce93d8' : heartbeat.status === 'finished' ? '#81c784' : '#f44',
            animation: heartbeat.status === 'running' ? 'pulse 1.5s infinite' : 'none',
          }} />
          <span style={{ color: '#ce93d8', fontWeight: 600, fontFamily: 'monospace' }}>Heartbeat</span>
          {heartbeat.status === 'running' && (
            <>
              <span style={{ color: '#888' }}>Round {heartbeat.round}</span>
              {heartbeat.toolCalls.length > 0 && (
                <span style={{ color: '#666' }}>
                  Tools: {heartbeat.toolCalls.map((t, i) => (
                    <span key={i} style={{ color: '#4fc3f7', background: '#1a1a2e', padding: '1px 5px', borderRadius: 3, marginLeft: 4, fontSize: 10 }}>{t}</span>
                  ))}
                </span>
              )}
              {heartbeat.content && (
                <span style={{ color: '#aaa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {heartbeat.content.slice(0, 120)}{heartbeat.content.length > 120 ? '...' : ''}
                </span>
              )}
            </>
          )}
          {heartbeat.status === 'finished' && (
            <span style={{ color: '#81c784' }}>Completed (round {heartbeat.round})</span>
          )}
          {heartbeat.status === 'error' && (
            <span style={{ color: '#f44' }}>Failed at round {heartbeat.round}</span>
          )}
          {heartbeat.status === 'max_rounds' && (
            <span style={{ color: '#ff9800' }}>Hit max rounds ({heartbeat.round})</span>
          )}
          <button onClick={() => setHeartbeat(null)} style={{
            background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 14, marginLeft: 'auto', padding: '0 4px',
          }}>x</button>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {messages.map((m) => (
          <div key={m.id} style={msgStyle(m.role)}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: '#666' }}>
                {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'AutoMate' : 'System'}
                <span style={{ marginLeft: 8, fontSize: 9, color: '#444' }}>
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
              </span>
              {m.role === 'assistant' && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => copyMessage(m.content)} title="Copy" style={{
                    background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 12, padding: '2px 4px',
                  }}>Copy</button>
                </div>
              )}
            </div>

            {/* Content */}
            <div style={{ fontFamily: m.role === 'user' ? 'inherit' : 'inherit' }}>
              {m.role === 'assistant' ? renderMarkdown(m.content) : m.content}
            </div>

            {/* Images */}
            {m.images && m.images.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {m.images.map((img, j) => (
                  <div key={j} style={{ position: 'relative' }}>
                    <img
                      src={img.base64 ? `data:${img.mimeType};base64,${img.base64}` : img.url}
                      alt={img.alt || img.filename || 'image'}
                      style={{
                        maxWidth: 400, maxHeight: 300, borderRadius: 6,
                        border: '1px solid #333', cursor: 'pointer',
                      }}
                      onClick={() => {
                        const src = img.base64 ? `data:${img.mimeType};base64,${img.base64}` : img.url
                        if (src) window.open(src, '_blank')
                      }}
                    />
                    {img.filename && (
                      <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{img.filename}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Tool calls */}
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #222', fontSize: 11, color: '#666' }}>
                Tools: {m.toolCalls.map(t => (
                  <span key={t.name} style={{ background: '#1a1a2e', padding: '1px 6px', borderRadius: 3, marginRight: 4, color: '#4fc3f7' }}>{t.name}</span>
                ))}
              </div>
            )}

            {/* Quick actions */}
            {m.role === 'assistant' && m.content && (
              <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {['Summarize', 'Explain', 'Translate'].map(action => (
                  <button key={action} onClick={() => {
                    if (wsRef.current) {
                      const prompt = `${action} the above response concisely.`
                      setMessages(prev => [...prev, { id: makeId(), role: 'user', content: prompt, timestamp: Date.now() }])
                      wsRef.current.send(JSON.stringify({ type: 'message', content: prompt }))
                      setStreaming('')
                    }
                  }} style={{
                    padding: '2px 8px', background: '#1a1a2e', color: '#888',
                    border: '1px solid #2a2a2a', borderRadius: 10, cursor: 'pointer',
                    fontSize: 10, transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#4fc3f7'; e.currentTarget.style.borderColor = '#4fc3f7' }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#888'; e.currentTarget.style.borderColor = '#2a2a2a' }}
                  >
                    {action}
                  </button>
                ))}
              </div>
            )}

            {/* Reactions */}
            {m.role === 'assistant' && (
              <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                {['\u{1F44D}', '\u{1F44E}', '\u2764\uFE0F', '\u{1F4A1}'].map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => toggleReaction(m.id, emoji)}
                    style={{
                      background: m.reactions?.includes(emoji) ? '#1a2a3a' : 'transparent',
                      border: m.reactions?.includes(emoji) ? '1px solid #4fc3f7' : '1px solid #333',
                      borderRadius: 12, padding: '2px 6px', cursor: 'pointer', fontSize: 12,
                      opacity: m.reactions?.includes(emoji) ? 1 : 0.4,
                      transition: 'all 0.15s',
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Streaming message */}
        {streaming && (
          <div style={msgStyle('assistant')}>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 6 }}>AutoMate</div>
            <div>{renderMarkdown(streaming)}</div>
            <span style={{ animation: 'blink 1s infinite', color: '#4fc3f7' }}>|</span>
          </div>
        )}

        {/* Typing indicator */}
        {typing && !streaming && (
          <div style={{ ...msgStyle('assistant'), color: '#666' }}>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>AutoMate</div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ animation: 'bounce 1.4s infinite', animationDelay: '0s' }}>.</span>
              <span style={{ animation: 'bounce 1.4s infinite', animationDelay: '0.2s' }}>.</span>
              <span style={{ animation: 'bounce 1.4s infinite', animationDelay: '0.4s' }}>.</span>
              <span style={{ marginLeft: 8, fontSize: 12 }}>Thinking</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Slash command autocomplete */}
      {showSlashMenu && (
        <div style={{
          position: 'absolute', bottom: 70, left: 20, right: 20, zIndex: 50,
          background: '#141414', border: '1px solid #333', borderRadius: 8,
          maxHeight: 240, overflow: 'auto', boxShadow: '0 -4px 20px rgba(0,0,0,0.5)',
        }}>
          {SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().includes(slashFilter)).map(c => (
            <div
              key={c.cmd}
              onClick={() => { setInput(c.cmd + ' '); setShowSlashMenu(false); inputRef.current?.focus() }}
              style={{
                padding: '8px 14px', cursor: 'pointer', borderBottom: '1px solid #1a1a1a',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1a1a2e')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ fontFamily: 'monospace', color: '#4fc3f7', fontSize: 13 }}>{c.cmd}</span>
              <span style={{ fontSize: 11, color: '#666' }}>{c.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* Input area */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid #222' }}>
        {/* File upload indicator */}
        {uploading && (
          <div style={{ fontSize: 11, color: '#4fc3f7', marginBottom: 6 }}>Uploading file...</div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* File upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Upload file"
            style={{
              padding: '10px 12px', background: '#1a1a2e', color: '#888',
              border: '1px solid #333', borderRadius: 6, cursor: 'pointer', fontSize: 16,
            }}
          >
            +
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => handleFileUpload(e.target.files)}
          />

          {/* Text input */}
          <input
            ref={inputRef}
            value={input}
            onChange={e => {
              const v = e.target.value
              setInput(v)
              if (v.startsWith('/')) {
                setShowSlashMenu(true)
                setSlashFilter(v.slice(1).toLowerCase())
              } else {
                setShowSlashMenu(false)
              }
            }}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            onPaste={e => {
              // Handle pasted images
              const items = e.clipboardData?.items
              if (items) {
                const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'))
                if (imageItems.length > 0) {
                  e.preventDefault()
                  const files = imageItems.map(i => i.getAsFile()).filter(Boolean) as File[]
                  const dt = new DataTransfer()
                  files.forEach(f => dt.items.add(f))
                  handleFileUpload(dt.files)
                }
              }
            }}
            placeholder="Type a message... (/new, /status, /model, /compact)"
            style={{
              flex: 1, padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333',
              borderRadius: 6, color: '#e0e0e0', fontSize: 14, outline: 'none', fontFamily: 'inherit',
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim()}
            style={{
              padding: '10px 20px', background: input.trim() ? '#4fc3f7' : '#333', color: input.trim() ? '#000' : '#666',
              border: 'none', borderRadius: 6, cursor: input.trim() ? 'pointer' : 'default',
              fontWeight: 600, fontSize: 14, transition: 'all 0.15s',
            }}
          >
            Send
          </button>
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } }
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0) }
          40% { transform: translateY(-6px) }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1 }
          50% { opacity: 0.3 }
        }
      `}</style>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
