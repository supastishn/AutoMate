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
  toolCalls?: { name: string; result: string; arguments?: string }[]
  images?: { url?: string; base64?: string; mimeType: string; alt?: string; filename?: string }[]
  reactions?: string[]
  timestamp: number
  serverIndex?: number  // Index in server-side messages array
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
      const isHtml = lang.toLowerCase() === 'html'
      const codeKey = key++
      nodes.push(
        <div key={codeKey} style={{ margin: '8px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: '#888', padding: '2px 10px', background: '#1a1a2e', borderRadius: '4px 4px 0 0', borderBottom: '1px solid #333' }}>
            <span>{lang || 'code'}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {isHtml && (
                <button
                  data-html-preview={code}
                  style={{
                    background: '#2a1a3e', color: '#ce93d8', border: '1px solid #4a2a6a',
                    borderRadius: 3, padding: '1px 8px', cursor: 'pointer', fontSize: 10,
                    fontWeight: 600, transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#3a2a5e'; e.currentTarget.style.color = '#e0b0ff' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#2a1a3e'; e.currentTarget.style.color = '#ce93d8' }}
                >
                  ▶ Preview HTML
                </button>
              )}
              <button
                onClick={() => navigator.clipboard.writeText(code)}
                style={{
                  background: 'none', color: '#666', border: '1px solid #333',
                  borderRadius: 3, padding: '1px 6px', cursor: 'pointer', fontSize: 10,
                }}
              >
                Copy
              </button>
            </div>
          </div>
          <pre style={{
            margin: 0, padding: 12, background: '#0d0d0d', borderRadius: '0 0 4px 4px',
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

    // Tool usage marker: [used tool: toolName] — render a placeholder that gets
    // replaced with the accordion by renderContentWithTools()
    if (line.match(/^\[used tool: .+\]$/)) {
      const toolName = line.replace(/^\[used tool: /, '').replace(/\]$/, '')
      nodes.push(<div key={key++} data-tool-placeholder={toolName} />)
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

/** Render a single tool call accordion button + expandable details */
function ToolAccordion({ t, toolKey, isExpanded, onToggle }: {
  t: { name: string; arguments?: string; result: string }
  toolKey: string
  isExpanded: boolean
  onToggle: () => void
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={onToggle}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          padding: '3px 8px', background: '#1a1a2e', borderRadius: 4,
          border: '1px solid #2a2a4a', userSelect: 'none',
        }}
      >
        <span style={{
          display: 'inline-block', fontSize: 9, color: '#888',
          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
        }}>▶</span>
        <span style={{ color: '#6a6aaa' }}>⚙</span>
        <span style={{ color: '#4fc3f7', fontWeight: 600, fontFamily: 'monospace' }}>{t.name}</span>
      </div>
      {isExpanded && (
        <div style={{
          marginTop: 4, marginLeft: 12, padding: '6px 10px',
          background: '#0d0d0d', borderRadius: 4, border: '1px solid #1a1a2e',
          fontFamily: '"Fira Code", "JetBrains Mono", monospace', fontSize: 11,
          maxHeight: 200, overflow: 'auto',
        }}>
          {t.arguments && (
            <div style={{ marginBottom: t.result ? 6 : 0 }}>
              <div style={{ color: '#888', marginBottom: 2, fontSize: 10 }}>Arguments:</div>
              <pre style={{ margin: 0, color: '#d19a66', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {(() => { try { return JSON.stringify(JSON.parse(t.arguments!), null, 2) } catch { return t.arguments } })()}
              </pre>
            </div>
          )}
          {t.result && (
            <div>
              <div style={{ color: '#888', marginBottom: 2, fontSize: 10 }}>Result:</div>
              <pre style={{ margin: 0, color: '#98c379', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {t.result.length > 2000 ? t.result.slice(0, 2000) + '…' : t.result}
              </pre>
            </div>
          )}
          {!t.arguments && !t.result && (
            <div style={{ color: '#555', fontStyle: 'italic' }}>No details available</div>
          )}
        </div>
      )}
    </div>
  )
}

interface HeartbeatActivity {
  sessionId: string
  content: string
  status: 'running' | 'ok-empty' | 'ok-token' | 'sent' | 'skipped' | 'failed'
  timestamp: number
  serverIndex?: number  // Index in server-side messages array
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
  const [hideHeartbeats, setHideHeartbeats] = useState(() => localStorage.getItem('automate_hide_heartbeats') === 'true')
  const [awaitingResponse, setAwaitingResponse] = useState(false)
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const msgIdRef = useRef(0)
  const awaitingResponseRef = useRef(false)
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})
  const pendingToolCallsRef = useRef<{ name: string; arguments?: string; result: string }[]>([])
  const [streamingToolCalls, setStreamingToolCalls] = useState<{ name: string; arguments?: string; result: string }[]>([])
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const makeId = () => `msg_${++msgIdRef.current}_${Date.now()}`

  /** Render markdown content with tool accordions inline where [used tool: X] markers appear */
  const renderContentWithTools = (
    text: string,
    toolCalls: { name: string; arguments?: string; result: string }[] | undefined,
    keyPrefix: string,
  ) => {
    const nodes = renderMarkdown(text)
    if (!toolCalls || toolCalls.length === 0) return nodes
    // Map tool names to their data (use first match, consume in order)
    const toolQueue = [...toolCalls]
    return nodes.map((node, i) => {
      // Check if this node is a tool placeholder <div data-tool-placeholder="toolName" />
      if (React.isValidElement(node) && (node.props as any)?.['data-tool-placeholder']) {
        const name = (node.props as any)['data-tool-placeholder'] as string
        const idx = toolQueue.findIndex(t => t.name === name)
        const tc = idx >= 0 ? toolQueue.splice(idx, 1)[0] : null
        if (tc) {
          const toolKey = `${keyPrefix}:${i}`
          return (
            <ToolAccordion
              key={toolKey}
              t={tc}
              toolKey={toolKey}
              isExpanded={expandedTools[toolKey] || false}
              onToggle={() => setExpandedTools(prev => ({ ...prev, [toolKey]: !prev[toolKey] }))}
            />
          )
        }
        // No matching tool data — show placeholder text
        return <div key={i} style={{ color: '#888', fontSize: 11, fontFamily: 'monospace', margin: '4px 0' }}>⚙ {name}</div>
      }
      return node
    })
  }

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
        // If the server is still processing this session (e.g. page refresh mid-stream),
        // show the thinking indicator immediately
        if (msg.processing) {
          setAwaitingResponse(true)
          awaitingResponseRef.current = true
          setTyping(true)
        }
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
        // Merge consecutive assistant messages into one: tool-call-only messages
        // get folded into the previous assistant message (tools belong to that turn).
        const rawMsgs = (msg.messages || []).filter((m: any) => m.role !== 'system')
        const merged: ChatMessage[] = []

        for (const m of rawMsgs) {
          if (m.role === 'assistant') {
            const toolCalls = m.tool_calls
              ? m.tool_calls.map((tc: any) => ({ name: tc.name, result: tc.result || '', arguments: tc.arguments || '' }))
              : []
            // Inject [used tool: X] markers if toolCalls exist but markers don't
            // (markers are streamed to UI but not stored in session)
            let content = (m.content || '').trim()
            if (toolCalls.length > 0) {
              const markers = toolCalls
                .filter(tc => !content.includes(`[used tool: ${tc.name}]`))
                .map(tc => `[used tool: ${tc.name}]`)
                .join('\n')
              if (markers) {
                content = markers + (content ? '\n\n' + content : '')
              }
            }

            // If the last merged message is also assistant, merge into it
            const last = merged[merged.length - 1]
            if (last && last.role === 'assistant') {
              if (toolCalls.length > 0) {
                last.toolCalls = [...(last.toolCalls || []), ...toolCalls]
              }
              if (content) {
                last.content = last.content ? last.content + '\n\n' + content : content
              }
              // Keep the first serverIndex when merging
            } else {
              // New assistant message
              merged.push({
                id: makeId(),
                role: 'assistant',
                content,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                timestamp: Date.now(),
                serverIndex: m.serverIndex,
              })
            }
          } else {
            merged.push({
              id: makeId(),
              role: m.role as 'user',
              content: m.content || '',
              timestamp: Date.now(),
              serverIndex: m.serverIndex,
            })
          }
        }

        setMessages([
          { id: makeId(), role: 'system', content: `Loaded session: ${msg.session_id}`, timestamp: Date.now() },
          ...merged,
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
      // Tool call completed during streaming — accumulate for the final message
      // Also update state so tool calls render live in the streaming bubble
      if (msg.type === 'tool_call') {
        const tc = { name: msg.name, arguments: msg.arguments, result: msg.result || '' }
        pendingToolCallsRef.current.push(tc)
        setStreamingToolCalls(prev => [...prev, tc])
      }
      if (msg.type === 'response') {
        setTyping(false)
        setAwaitingResponse(false)
        awaitingResponseRef.current = false
        if (msg.context) setContextInfo(msg.context)
        // Merge tool calls: prefer real-time events (have results) over final summary
        const toolCalls = pendingToolCallsRef.current.length > 0
          ? pendingToolCallsRef.current
          : msg.tool_calls
        pendingToolCallsRef.current = []
        setStreamingToolCalls([])
        // Use accumulated streaming content if available — msg.content only has the
        // final LLM response (after tool calls), so it would wipe earlier streamed text.
        setStreaming(prev => {
          // Keep [used tool: X] markers — renderContentWithTools replaces them with accordions
          const finalContent = (prev || msg.content || '').trim()
          setMessages(msgs => [...msgs, {
            id: makeId(),
            role: 'assistant',
            content: finalContent,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
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
      if (msg.type === 'interrupted') {
        setTyping(false)
        setAwaitingResponse(false)
        awaitingResponseRef.current = false
        // Flush any accumulated streaming content as a partial message
        setStreaming(prev => {
          if (prev) {
            setMessages(msgs => [...msgs, {
              id: makeId(),
              role: 'assistant',
              content: prev + '\n\n*(interrupted)*',
              timestamp: Date.now(),
            }])
          }
          return ''
        })
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
            content: '',
            status: 'running',
            timestamp: msg.timestamp || Date.now(),
          })
        } else if (msg.event === 'skipped') {
          setHeartbeat({
            sessionId: '',
            content: 'Skipped (empty checklist)',
            status: 'skipped',
            timestamp: msg.timestamp || Date.now(),
          })
          setTimeout(() => setHeartbeat(null), 5000)
        } else if (msg.event === 'end') {
          setHeartbeat({
            sessionId: msg.sessionId || msg.session_id || '',
            content: msg.content || '',
            status: msg.status || 'ok-empty',
            timestamp: msg.timestamp || Date.now(),
          })
          setTimeout(() => setHeartbeat(null), 8000)
        }
      }
      // Handle heartbeat streaming chunks
      if (msg.type === 'heartbeat_stream') {
        setHeartbeat(prev => prev ? {
          ...prev,
          content: (prev.content || '') + (msg.chunk || ''),
        } : {
          sessionId: msg.sessionId || '',
          content: msg.chunk || '',
          status: 'running',
          timestamp: msg.timestamp || Date.now(),
        })
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
      // Handle messages_updated (after delete/edit)
      if (msg.type === 'messages_updated') {
        setCurrentSessionId(msg.session_id)
        if (msg.context) setContextInfo(msg.context)
        const loaded: ChatMessage[] = (msg.messages || [])
          .filter((m: any) => m.role !== 'system')
          .map((m: any) => ({
            id: makeId(),
            role: m.role as 'user' | 'assistant',
            content: m.content || '',
            toolCalls: m.tool_calls?.map((tc: any) => ({ name: tc.name, arguments: tc.arguments, result: tc.result || '' })),
            timestamp: Date.now(),
            serverIndex: m.serverIndex,
          }))
        setMessages(loaded)
        setEditingMessageId(null)
        setEditingContent('')
      }
      // Handle retry_complete (after retry)
      if (msg.type === 'retry_complete') {
        setTyping(false)
        setAwaitingResponse(false)
        awaitingResponseRef.current = false
        if (msg.context) setContextInfo(msg.context)
        // Reload all messages from server
        const loaded: ChatMessage[] = (msg.messages || [])
          .filter((m: any) => m.role !== 'system')
          .map((m: any) => ({
            id: makeId(),
            role: m.role as 'user' | 'assistant',
            content: m.content || '',
            toolCalls: m.tool_calls?.map((tc: any) => ({ name: tc.name, arguments: tc.arguments, result: tc.result || '' })),
            timestamp: Date.now(),
            serverIndex: m.serverIndex,
          }))
        setMessages(loaded)
        setStreaming('')
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
    pendingToolCallsRef.current = []
    setStreamingToolCalls([])
    setAwaitingResponse(true)
    awaitingResponseRef.current = true
    inputRef.current?.focus()
  }

  // Find the server-side index for a message by its local id
  const findServerIndex = (msgId: string): number => {
    // Find the message and return its serverIndex property
    const msg = messages.find(m => m.id === msgId)
    if (!msg || msg.serverIndex === undefined) return -1
    return msg.serverIndex
  }

  const deleteMessage = (msgId: string) => {
    const idx = findServerIndex(msgId)
    if (idx < 0 || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ type: 'delete_message', index: idx }))
  }

  const startEditMessage = (msgId: string, content: string) => {
    setEditingMessageId(msgId)
    setEditingContent(content)
  }

  const saveEditMessage = () => {
    if (!editingMessageId || !wsRef.current) return
    const idx = findServerIndex(editingMessageId)
    if (idx < 0) return
    wsRef.current.send(JSON.stringify({ type: 'edit_message', index: idx, content: editingContent }))
  }

  const cancelEdit = () => {
    setEditingMessageId(null)
    setEditingContent('')
  }

  const retryMessage = (msgId: string) => {
    const idx = findServerIndex(msgId)
    if (idx < 0 || !wsRef.current) return
    setStreaming('')
    pendingToolCallsRef.current = []
    setStreamingToolCalls([])
    setAwaitingResponse(true)
    awaitingResponseRef.current = true
    wsRef.current.send(JSON.stringify({ type: 'retry_message', index: idx }))
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
          {/* Heartbeat visibility toggle */}
          <button onClick={() => {
            const next = !hideHeartbeats
            setHideHeartbeats(next)
            localStorage.setItem('automate_hide_heartbeats', String(next))
          }} title={hideHeartbeats ? 'Heartbeats: Hidden' : 'Heartbeats: Visible'} style={{
            padding: '4px 10px', background: hideHeartbeats ? '#2e1a1a' : '#1a1a2e',
            color: hideHeartbeats ? '#f48' : '#ce93d8', border: `1px solid ${hideHeartbeats ? '#4a2a2a' : '#333'}`,
            borderRadius: 4, cursor: 'pointer', fontSize: 13,
          }}>
            {hideHeartbeats ? '💔' : '💜'}
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
          background: heartbeat.status === 'running' ? '#1a1520' : heartbeat.status === 'sent' ? '#1a1a2e' : heartbeat.status === 'failed' ? '#1a1515' : '#151a15',
          borderBottom: `1px solid ${heartbeat.status === 'running' ? '#3a2a4a' : heartbeat.status === 'sent' ? '#2a2a4a' : heartbeat.status === 'failed' ? '#4a2a2a' : '#2a4a2a'}`,
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 12,
        }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: heartbeat.status === 'running' ? '#ce93d8' : heartbeat.status === 'sent' ? '#4fc3f7' : heartbeat.status === 'failed' ? '#f44' : '#81c784',
            animation: heartbeat.status === 'running' ? 'pulse 1.5s infinite' : 'none',
          }} />
          <span style={{ color: '#ce93d8', fontWeight: 600, fontFamily: 'monospace' }}>Heartbeat</span>
          {heartbeat.status === 'running' && !heartbeat.content && (
            <span style={{ color: '#888' }}>Checking...</span>
          )}
          {heartbeat.status === 'running' && heartbeat.content && (
            <span style={{ color: '#ce93d8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {heartbeat.content.slice(0, 200)}{heartbeat.content.length > 200 ? '...' : ''}
              <span style={{ animation: 'blink 1s infinite', color: '#ce93d8' }}>|</span>
            </span>
          )}
          {heartbeat.status === 'ok-empty' && (
            <span style={{ color: '#81c784' }}>All clear (empty response)</span>
          )}
          {heartbeat.status === 'ok-token' && (
            <span style={{ color: '#81c784' }}>All clear</span>
          )}
          {heartbeat.status === 'skipped' && (
            <span style={{ color: '#888' }}>Skipped (empty checklist)</span>
          )}
          {heartbeat.status === 'sent' && (
            <span style={{ color: '#4fc3f7', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Alert: {heartbeat.content.slice(0, 120)}{heartbeat.content.length > 120 ? '...' : ''}
            </span>
          )}
          {heartbeat.status === 'failed' && (
            <span style={{ color: '#f44' }}>Failed</span>
          )}
          <button onClick={() => setHeartbeat(null)} style={{
            background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 14, marginLeft: 'auto', padding: '0 4px',
          }}>x</button>
        </div>
      )}

      {/* HTML Preview Modal */}
      {htmlPreview && (
        <div
          onClick={() => setHtmlPreview(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', zIndex: 1000,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '90%', maxWidth: 1000, height: '80%',
              background: '#fff', borderRadius: 12, overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{
              padding: '8px 16px', background: '#1a1a2e',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: '1px solid #333',
            }}>
              <span style={{ fontSize: 13, color: '#4fc3f7', fontWeight: 600 }}>HTML Preview</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => {
                    const w = window.open('', '_blank')
                    if (w) { w.document.write(htmlPreview); w.document.close() }
                  }}
                  style={{
                    padding: '3px 10px', background: '#2a2a4a', color: '#4fc3f7',
                    border: '1px solid #4fc3f7', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  }}
                >
                  Open in tab
                </button>
                <button
                  onClick={() => setHtmlPreview(null)}
                  style={{
                    padding: '3px 10px', background: '#2a1a1a', color: '#f44',
                    border: '1px solid #f44', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  }}
                >
                  Close
                </button>
              </div>
            </div>
            <iframe
              srcDoc={htmlPreview}
              style={{ flex: 1, border: 'none', background: '#fff' }}
              sandbox="allow-scripts"
              title="HTML Preview"
            />
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        onClick={e => {
          const btn = (e.target as HTMLElement).closest('[data-html-preview]') as HTMLElement | null
          if (btn) {
            setHtmlPreview(btn.getAttribute('data-html-preview') || '')
          }
        }}
        style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {messages.filter((m) => {
          if (!hideHeartbeats) return true
          // Hide heartbeat-related messages: HEARTBEAT_OK responses or [HEARTBEAT CHECK] prompts
          const content = m.content.trim()
          if (content === 'HEARTBEAT_OK' || content.includes('HEARTBEAT_OK')) return false
          if (content.startsWith('[HEARTBEAT CHECK]') || content.endsWith('[HEARTBEAT CHECK]')) return false
          if (content.startsWith('[HEARTBEAT]') || content.endsWith('[HEARTBEAT]')) return false
          return true
        }).map((m) => (
          <div key={m.id} style={msgStyle(m.role)}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: '#666' }}>
                {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'AutoMate' : 'System'}
                <span style={{ marginLeft: 8, fontSize: 9, color: '#444' }}>
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
              </span>
              {/* Action buttons for user and assistant messages */}
              {(m.role === 'user' || m.role === 'assistant') && m.id !== editingMessageId && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {m.role === 'assistant' && (
                    <button onClick={() => copyMessage(m.content)} title="Copy" style={{
                      background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 11, padding: '2px 4px',
                    }}>Copy</button>
                  )}
                  <button onClick={() => startEditMessage(m.id, m.content)} title="Edit" style={{
                    background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 11, padding: '2px 4px',
                  }}>Edit</button>
                  <button onClick={() => retryMessage(m.id)} title="Retry" style={{
                    background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 11, padding: '2px 4px',
                  }}>Retry</button>
                  <button onClick={() => deleteMessage(m.id)} title="Delete" style={{
                    background: 'none', border: 'none', color: '#a55', cursor: 'pointer', fontSize: 11, padding: '2px 4px',
                  }}>Del</button>
                </div>
              )}
            </div>

            {/* Content - show edit textarea if editing this message */}
            {editingMessageId === m.id ? (
              <div>
                <textarea
                  value={editingContent}
                  onChange={e => setEditingContent(e.target.value)}
                  style={{
                    width: '100%', minHeight: 80, padding: 8,
                    background: '#1a1a1a', border: '1px solid #4fc3f7', borderRadius: 4,
                    color: '#e0e0e0', fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
                  }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={saveEditMessage} style={{
                    padding: '4px 12px', background: '#4fc3f7', color: '#000',
                    border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  }}>Save</button>
                  <button onClick={cancelEdit} style={{
                    padding: '4px 12px', background: '#333', color: '#888',
                    border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{ fontFamily: m.role === 'user' ? 'inherit' : 'inherit' }}>
                {m.role === 'assistant' ? renderContentWithTools(m.content, m.toolCalls, m.id) : m.content}
              </div>
            )}

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

        {/* Streaming message — tool accordions render inline where [used tool: X] markers appear */}
        {(streaming || streamingToolCalls.length > 0) && (
          <div style={msgStyle('assistant')}>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 6 }}>AutoMate</div>
            <div>{renderContentWithTools(streaming, streamingToolCalls, 'streaming')}</div>
            <span style={{ animation: 'blink 1s infinite', color: '#4fc3f7' }}>|</span>
          </div>
        )}

        {/* Typing indicator */}
        {typing && !streaming && streamingToolCalls.length === 0 && (
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
          {(awaitingResponse || streaming) ? (
            <button
              onClick={() => {
                if (wsRef.current) {
                  wsRef.current.send(JSON.stringify({ type: 'interrupt' }))
                }
              }}
              style={{
                padding: '10px 20px', background: '#f44336', color: '#fff',
                border: 'none', borderRadius: 6, cursor: 'pointer',
                fontWeight: 600, fontSize: 14, transition: 'all 0.15s',
              }}
            >
              Stop
            </button>
          ) : (
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
          )}
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