import React, { useEffect, useRef, useState, useCallback } from 'react'
import { emitDataUpdate } from '../hooks/useDataUpdates'
import { useColors } from '../ThemeContext'

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
  askUserQuestion?: {
    id: string
    options?: string[]
    allowCustomInput?: boolean
    multiSelect?: boolean
  }
  images?: { url?: string; base64?: string; mimeType: string; alt?: string; filename?: string; id?: string }[]
  reactions?: string[]
  timestamp: number
  serverIndex?: number  // Index in server-side messages array
  _meta?: {
    hidden?: boolean
    isPowerSteering?: boolean
  }
}

// Helper function to normalize content from backend format to UI string format
function normalizeContent(content: any): string {
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    // Handle ContentPart[] array
    return content
      .map((part: any) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        } else if (part.type === 'image_url' && part.image_url?.url) {
          return `[Image: ${part.image_url.url}]`;
        }
        return `[${part.type || 'content'}]`;
      })
      .join(' ');
  }
  
  // Fallback for other content types
  return String(content || '');
}

function extractAskUserQuestion(meta: any): ChatMessage['askUserQuestion'] | undefined {
  const raw = meta?.askUserQuestion;
  if (!raw || typeof raw !== 'object') return undefined;
  const id = typeof raw.id === 'string' && raw.id
    ? raw.id
    : `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const options = Array.isArray(raw.options)
    ? raw.options.map((opt: any) => String(opt)).filter(Boolean)
    : undefined;
  return {
    id,
    options,
    allowCustomInput: raw.allowCustomInput !== false,
    multiSelect: !!raw.multiSelect,
  };
}

// Simple markdown renderer (no external dep runtime - we parse ourselves)
function renderMarkdown(text: string, colors?: any): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let key = 0

  // Pre-process: extract and merge [think]...[/think] or [reasoning]...[/reasoning] blocks
  // Streaming sends many small chunks - merge consecutive ones into single block
  const reasoningBlocks: { id: string; content: string }[] = []
  let processedText = text
  // Match both [think] and [reasoning] markers, merge consecutive ones
  const thinkRegex = /\[(think|reasoning)\]([\s\S]*?)\[\/(think|reasoning)\]/g
  let match
  let lastReasoningContent = ''
  // Use text (not processedText) for extraction
  while ((match = thinkRegex.exec(text)) !== null) {
    lastReasoningContent += match[2]
  }
  // If we have reasoning content, create one merged block at the start
  if (lastReasoningContent.trim()) {
    const id = `__reasoning_0__`
    reasoningBlocks.push({ id, content: lastReasoningContent.trim() })
    // Remove all think/reasoning markers from text - create NEW regex to reset lastIndex
    processedText = processedText.replace(/\[(think|reasoning)\][\s\S]*?\[\/(think|reasoning)\]/g, '').trim()
    // Prepend placeholder at start
    processedText = id + '\n' + processedText
  }

  const lines = processedText.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Reasoning block placeholder
    const reasoningMatch = line.match(/^__reasoning_(\d+)__$/)
    if (reasoningMatch) {
      const idx = parseInt(reasoningMatch[1])
      const block = reasoningBlocks[idx]
      if (block) {
        const reasoningKey = `reasoning_${key++}`
        nodes.push(
          <details key={reasoningKey} style={{ margin: '8px 0' }}>
            <summary style={{ 
              cursor: 'pointer', 
              fontSize: 12, 
              color: colors?.textMuted || 'var(--textMuted)',
              padding: '4px 8px',
              background: colors?.bgTertiary || 'var(--bgTertiary)',
              borderRadius: 4,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <span>🧠</span>
              <span>Reasoning</span>
              <span style={{ fontSize: 10, opacity: 0.7 }}>({block.content.length} chars)</span>
            </summary>
            <div style={{
              marginTop: 4,
              padding: '8px 12px',
              background: colors?.bgSecondary || 'var(--bgSecondary)',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              color: colors?.textSecondary || 'var(--textSecondary)',
              maxHeight: 300,
              overflow: 'auto',
            }}>
              {block.content}
            </div>
          </details>
        )
      }
      i++; continue
    }

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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: 'var(--textSecondary)', padding: '2px 10px', background: 'var(--bgTertiary)', borderRadius: '4px 4px 0 0', borderBottom: '1px solid var(--borderLight)' }}>
            <span>{lang || 'code'}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {isHtml && (
                <button
                  data-html-preview={code}
                  style={{
                    background: 'var(--bgHover)', color: 'var(--heartbeat)', border: '1px solid var(--borderLight)',
                    borderRadius: 3, padding: '1px 8px', cursor: 'pointer', fontSize: 10,
                    fontWeight: 600, transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bgActive)'; e.currentTarget.style.color = 'var(--heartbeat)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bgHover)'; e.currentTarget.style.color = 'var(--heartbeat)' }}
                >
                  ▶ Preview HTML
                </button>
              )}
              <button
                onClick={() => navigator.clipboard.writeText(code)}
                style={{
                  background: 'none', color: 'var(--textMuted)', border: '1px solid var(--borderLight)',
                  borderRadius: 3, padding: '1px 6px', cursor: 'pointer', fontSize: 10,
                }}
              >
                Copy
              </button>
            </div>
          </div>
          <pre style={{
            margin: 0, padding: 12, background: 'var(--bgPrimary)', borderRadius: '0 0 4px 4px',
            fontSize: 12, lineHeight: 1.6, overflow: 'auto', border: '1px solid var(--border)',
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
      nodes.push(<h4 key={key++} style={{ fontSize: 14, fontWeight: 600, margin: '12px 0 4px', color: 'var(--textPrimary)' }}>{formatInline(line.slice(4))}</h4>)
      i++; continue
    }
    if (line.startsWith('## ')) {
      nodes.push(<h3 key={key++} style={{ fontSize: 16, fontWeight: 600, margin: '14px 0 6px', color: 'var(--textPrimary)' }}>{formatInline(line.slice(3))}</h3>)
      i++; continue
    }
    if (line.startsWith('# ')) {
      nodes.push(<h2 key={key++} style={{ fontSize: 18, fontWeight: 700, margin: '16px 0 8px', color: 'var(--textPrimary)' }}>{formatInline(line.slice(2))}</h2>)
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
          margin: '8px 0', padding: '8px 14px', borderLeft: '3px solid var(--accent)',
          background: 'var(--bgHover)', color: 'var(--textSecondary)', fontStyle: 'italic',
        }}>
          {quoteLines.map((l, j) => <div key={j}>{formatInline(l)}</div>)}
        </blockquote>
      )
      continue
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      nodes.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid var(--borderLight)', margin: '12px 0' }} />)
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
      parts.push(<code key={key++} style={{ background: 'var(--bgTertiary)', padding: '1px 5px', borderRadius: 3, fontSize: '0.9em', color: 'var(--syntaxInlineCode)', fontFamily: 'monospace' }}>{match[1]}</code>)
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Bold
    match = remaining.match(/^\*\*(.+?)\*\*/)
    if (match) {
      parts.push(<strong key={key++} style={{ fontWeight: 600, color: 'var(--textPrimary)' }}>{match[1]}</strong>)
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
      parts.push(<a key={key++} href={match[2]} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>{match[1]}</a>)
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

// Simple syntax highlighting by token type (uses CSS variables for theme support)
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
      parts.push(<span key={key++} style={{ color: 'var(--syntaxKeyword)' }}>{token}</span>)
    } else if (token.match(/^("|'|`)/) ) {
      parts.push(<span key={key++} style={{ color: 'var(--syntaxString)' }}>{token}</span>)
    } else if (token.match(/^\/\//)) {
      parts.push(<span key={key++} style={{ color: 'var(--syntaxComment)', fontStyle: 'italic' }}>{token}</span>)
    } else if (token.match(/^\d/)) {
      parts.push(<span key={key++} style={{ color: 'var(--syntaxNumber)' }}>{token}</span>)
    } else if (token.match(/^[{}()\[\];,.:!<>=+\-*/&|^~?@#]/)) {
      parts.push(<span key={key++} style={{ color: 'var(--syntaxPunctuation)' }}>{token}</span>)
    } else {
      parts.push(<span key={key++}>{token}</span>)
    }
  }

  return <>{parts}</>
}

/** Render a single tool call accordion button + expandable details */
function ToolAccordion({ t, toolKey, isExpanded, onToggle, colors }: {
  t: { name: string; arguments?: string; result: string }
  toolKey: string
  isExpanded: boolean
  onToggle: () => void
  colors: Record<string, string>
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={onToggle}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          padding: '3px 8px', background: colors.bgTertiary, borderRadius: 4,
          border: `1px solid ${colors.borderLight}`, userSelect: 'none',
        }}
      >
        <span style={{
          display: 'inline-block', fontSize: 9, color: colors.textSecondary,
          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
        }}>▶</span>
        <span style={{ color: colors.textMuted }}>⚙</span>
        <span style={{ color: colors.accent, fontWeight: 600, fontFamily: 'monospace' }}>{t.name}</span>
      </div>
      {isExpanded && (
        <div style={{
          marginTop: 4, marginLeft: 12, padding: '6px 10px',
          background: colors.bgPrimary, borderRadius: 4, border: `1px solid ${colors.bgTertiary}`,
          fontFamily: '"Fira Code", "JetBrains Mono", monospace', fontSize: 11,
          maxHeight: 200, overflow: 'auto',
        }}>
          {t.arguments && (
            <div style={{ marginBottom: t.result ? 6 : 0 }}>
              <div style={{ color: colors.textSecondary, marginBottom: 2, fontSize: 10 }}>Arguments:</div>
              <pre style={{ margin: 0, color: 'var(--syntaxNumber)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {(() => { try { return JSON.stringify(JSON.parse(t.arguments!), null, 2) } catch { return t.arguments } })()}
              </pre>
            </div>
          )}
          {t.result && (
            <div>
              <div style={{ color: colors.textSecondary, marginBottom: 2, fontSize: 10 }}>Result:</div>
              <pre style={{ margin: 0, color: 'var(--syntaxString)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {t.result.length > 2000 ? t.result.slice(0, 2000) + '…' : t.result}
              </pre>
            </div>
          )}
          {!t.arguments && !t.result && (
            <div style={{ color: colors.textMuted, fontStyle: 'italic' }}>No details available</div>
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
  const colors = useColors()
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
  const [contextBreakdown, setContextBreakdown] = useState<{
    systemPrompt: number; toolDefinitions: number; userMessages: number;
    assistantMessages: number; toolResults: number; total: number; limit: number;
    details?: {
      systemPrompt: { name: string; tokens: number }[];
      tools: { name: string; tokens: number }[];
    };
  } | null>(null)
  const [showContextBreakdown, setShowContextBreakdown] = useState(false)
  const [expandedBreakdown, setExpandedBreakdown] = useState<string | null>(null)
  const [elevated, setElevated] = useState(false)
  const [currentModel, setCurrentModel] = useState('')
  const [models, setModels] = useState<{name: string; model: string; active: boolean}[]>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [multiAgent, setMultiAgent] = useState(false)
  const [showHiddenMessages, setShowHiddenMessages] = useState(false) // Toggle for power steering visibility
  const [agentsList, setAgentsList] = useState<{ name: string; isDefault: boolean; model: string }[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
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
  const currentSessionIdRef = useRef<string | null>(null)
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})
  const [expandedHeartbeats, setExpandedHeartbeats] = useState<Record<string, boolean>>({})
  const pendingToolCallsRef = useRef<{ name: string; arguments?: string; result: string }[]>([])
  const processingPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const messagePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastMessageCountRef = useRef<number>(0)
  const lastMessageHashRef = useRef<string>('')
  const [streamingToolCalls, setStreamingToolCalls] = useState<{ name: string; arguments?: string; result: string }[]>([])
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [promptQueue, setPromptQueue] = useState<string[]>([])
  const promptQueueRef = useRef<string[]>([])
  const makeId = () => `msg_${++msgIdRef.current}_${Date.now()}`

  /** Stop the processing-recovery poll if running. */
  const stopProcessingPoll = () => {
    if (processingPollRef.current) {
      clearInterval(processingPollRef.current)
      processingPollRef.current = null
    }
  }

  /** Poll for new messages from automated sources (heartbeat, plugins, etc.) */
  const startMessagePoll = () => {
    if (messagePollRef.current) return // Already polling
    messagePollRef.current = setInterval(async () => {
      const sessionId = currentSessionIdRef.current
      if (!sessionId || awaitingResponseRef.current) return // Skip if no session or already waiting for response

      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
        const data = await r.json() as any
        if (!data.session) return

        const serverMsgs = data.session.messages || []
        const serverMsgCount = serverMsgs.length
        // Simple hash: last message role + content length + first 50 chars
        const lastMsg = serverMsgs[serverMsgs.length - 1]
        const serverHash = lastMsg ? `${lastMsg.role}:${(lastMsg.content || '').length}:${(lastMsg.content || '').slice(0, 50)}` : ''

        // Reload if count changed OR last message changed
        if (serverMsgCount !== lastMessageCountRef.current || serverHash !== lastMessageHashRef.current) {
          lastMessageCountRef.current = serverMsgCount
          lastMessageHashRef.current = serverHash
          // Reload session via WebSocket
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'load_session', session_id: sessionId }))
          }
        }
      } catch { /* ignore */ }
    }, 5000) // Poll every 5 seconds
  }

  const stopMessagePoll = () => {
    if (messagePollRef.current) {
      clearInterval(messagePollRef.current)
      messagePollRef.current = null
    }
  }

  // Keep ref in sync with state for use in WebSocket callback
  useEffect(() => {
    promptQueueRef.current = promptQueue
  }, [promptQueue])

  // Track injected messages waiting to appear in correct position
  const [injectedPrompts, setInjectedPrompts] = useState<string[]>([])

  /** Send the next queued prompt if any exist - injects into current conversation */
  const sendNextQueuedPrompt = useCallback(() => {
    const queue = promptQueueRef.current
    if (queue.length === 0 || !wsRef.current) return

    // Take the first prompt from the queue
    const prompt = queue[0]
    const remaining = queue.slice(1)

    // Update state and ref
    setPromptQueue(remaining)
    promptQueueRef.current = remaining

    // Track as injected (will show as indicator, not in messages list)
    // The server will include it in the correct position when response completes
    setInjectedPrompts(prev => [...prev, prompt])

    // Send as 'inject' type - this adds to session without triggering new response
    // The current processing loop will see it in its next iteration
    wsRef.current.send(JSON.stringify({ type: 'inject', content: prompt }))

    // DON'T clear streaming state - let the current response continue displaying
  }, [selectedAgent])

  /** Render markdown content with tool accordions inline where [used tool: X] markers appear */
  const renderContentWithTools = (
    text: string,
    toolCalls: { name: string; arguments?: string; result: string }[] | undefined,
    keyPrefix: string,
  ) => {
    const nodes = renderMarkdown(text, colors)
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
              colors={colors}
            />
          )
        }
        // No matching tool data — show placeholder text
        return <div key={i} style={{ color: colors.textSecondary, fontSize: 11, fontFamily: 'monospace', margin: '4px 0' }}>⚙ {name}</div>
      }
      return node
    })
  }

  useEffect(() => {
    connect()
    return () => { stopProcessingPoll(); stopMessagePoll(); wsRef.current?.close() }
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

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Try to rejoin previous session on reconnect (e.g., after page refresh)
    const savedSessionId = localStorage.getItem('automate_session_id')
    const wsUrl = savedSessionId
      ? `${proto}//${location.host}/ws?rejoin_session_id=${encodeURIComponent(savedSessionId)}`
      : `${proto}//${location.host}/ws`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      setConnected(true)
      setNeedsAuth(false)
    }
    ws.onclose = () => { stopProcessingPoll(); setConnected(false); setTimeout(connect, 3000) }
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
        currentSessionIdRef.current = msg.session_id
        // Save session ID to localStorage for reconnection
        localStorage.setItem('automate_session_id', msg.session_id)
        if (msg.context) setContextInfo(msg.context)
        // If the server is still processing this session (e.g. page refresh mid-stream),
        // show the thinking indicator and start polling for completion.
        // Stream chunks may arrive via WS (sendToSession), but if the response
        // event was lost during the reconnect gap, the poll recovers gracefully.
        if (msg.processing) {
          setAwaitingResponse(true)
          awaitingResponseRef.current = true
          setTyping(true)
          stopProcessingPoll()
          const pollSessionId = msg.session_id as string
          processingPollRef.current = setInterval(async () => {
            try {
              const r = await fetch(`/api/sessions/${encodeURIComponent(pollSessionId)}`)
              const data = await r.json()
              if (data.session && !data.processing) {
                // Agent finished — reload session to get complete state
                stopProcessingPoll()
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'load_session', session_id: pollSessionId }))
                }
                setAwaitingResponse(false)
                awaitingResponseRef.current = false
                setTyping(false)
              }
            } catch {}
          }, 2500)
        }
        // Multi-agent support: show agent picker on fresh sessions
        if (msg.multiAgent && msg.agents?.length > 1) {
          setMultiAgent(true)
          setAgentsList(msg.agents)
          // Show picker only for fresh sessions (no existing messages)
          if (!msg.processing) {
            setShowAgentPicker(true)
          }
        }
        setMessages(prev => [...prev, {
          id: makeId(),
          role: 'system',
          content: `Connected. Session: ${msg.session_id}`,
          timestamp: Date.now(),
        }])
        // Start polling for automated messages (heartbeat, plugins)
        lastMessageCountRef.current = 0
        lastMessageHashRef.current = ''
        startMessagePoll()
      }
      if (msg.type === 'session_loaded') {
      // Hide agent picker when loading an existing session
      setShowAgentPicker(false)
        setCurrentSessionId(msg.session_id)
        currentSessionIdRef.current = msg.session_id
        if (msg.context) setContextInfo(msg.context)
        // Merge consecutive assistant messages into one: tool-call-only messages
        // get folded into the previous assistant message (tools belong to that turn).
        // Filter: show only user and assistant messages (not system or tool results)
        const rawMsgs = (msg.messages || []).filter((m: any) => m.role !== 'system' && m.role !== 'tool')
        const merged: ChatMessage[] = []

        for (const m of rawMsgs) {
          // Handle power steering messages - they come as user messages with _meta
          if (m._meta?.isPowerSteering) {
            merged.push({
              id: makeId(),
              role: m.role as 'user' | 'system', // Use the actual role from server
              content: normalizeContent(m.content),
              timestamp: Date.now(),
              serverIndex: m.serverIndex,
              _meta: m._meta,
            })
            continue
          }

          if (m.role === 'assistant') {
            const toolCalls = m.tool_calls
              ? m.tool_calls.map((tc: any) => ({ name: tc.name, result: tc.result || '', arguments: tc.arguments || '' }))
              : []
            const askUserQuestion = extractAskUserQuestion(m._meta)
            // Inject [used tool: X] markers if toolCalls exist but markers don't
            // (markers are streamed to UI but not stored in session)
            // Put content FIRST, then tool markers at the end
            let content = normalizeContent(m.content).trim()
            if (toolCalls.length > 0) {
              const markers = toolCalls
                .filter(tc => !content.includes(`[used tool: ${tc.name}]`))
                .map(tc => `[used tool: ${tc.name}]`)
                .join('\n')
              if (markers) {
                content = content ? content + '\n\n' + markers : markers
              }
            }

            if (askUserQuestion) {
              merged.push({
                id: makeId(),
                role: 'assistant',
                content,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                askUserQuestion,
                timestamp: Date.now(),
                serverIndex: m.serverIndex,
                _meta: m._meta,
              })
              continue
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
                _meta: m._meta,
              })
            }
          } else {
            merged.push({
              id: makeId(),
              role: m.role as 'user',
              content: normalizeContent(m.content),
              timestamp: Date.now(),
              serverIndex: m.serverIndex,
            })
          }
        }

        setMessages([
          { id: makeId(), role: 'system', content: `Loaded session: ${msg.session_id}`, timestamp: Date.now() },
          ...merged,
        ])
        // Track message count and hash for automated message detection
        const loadedMsgs = msg.messages || []
        const lastLoadedMsg = loadedMsgs[loadedMsgs.length - 1]
        lastMessageCountRef.current = loadedMsgs.length
        lastMessageHashRef.current = lastLoadedMsg ? `${lastLoadedMsg.role}:${(lastLoadedMsg.content || '').length}:${(lastLoadedMsg.content || '').slice(0, 50)}` : ''
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
      // If there's a queued prompt, send it after a short delay to let the tool result settle
      if (msg.type === 'tool_call') {
        const tc = { name: msg.name, arguments: msg.arguments, result: msg.result || '' }
        pendingToolCallsRef.current.push(tc)
        setStreamingToolCalls(prev => [...prev, tc])

        // Check for queued prompt and send it after tool call
        if (promptQueueRef.current.length > 0) {
          // Small delay to let the current tool result settle
          setTimeout(() => {
            sendNextQueuedPrompt()
          }, 100)
        }
      }
      if (msg.type === 'ask_user_question') {
        const questionText = normalizeContent(msg.question || '')
        if (questionText) {
          const questionId = typeof msg.questionId === 'string' && msg.questionId
            ? msg.questionId
            : `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          const options = Array.isArray(msg.options)
            ? msg.options.map((o: any) => String(o)).filter(Boolean)
            : undefined
          setMessages(prev => {
            if (prev.some(m => m.askUserQuestion?.id === questionId)) return prev
            return [...prev, {
              id: makeId(),
              role: 'assistant',
              content: questionText,
              askUserQuestion: {
                id: questionId,
                options,
                allowCustomInput: msg.allowCustomInput !== false,
                multiSelect: !!msg.multiSelect,
              },
              timestamp: Date.now(),
            }]
          })
        }
      }
      if (msg.type === 'response') {
        stopProcessingPoll()
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
        // Clear injected prompts - they're now in the server's message list
        setInjectedPrompts([])
        // Server sends mapped messages with serverIndex — use them to backfill indices
        const serverMsgs: any[] = msg.messages || []
        // Update message count and hash for automated message polling
        const lastServerMsg = serverMsgs[serverMsgs.length - 1]
        lastMessageCountRef.current = serverMsgs.length
        lastMessageHashRef.current = lastServerMsg ? `${lastServerMsg.role}:${(normalizeContent(lastServerMsg.content) || '').length}:${(normalizeContent(lastServerMsg.content) || '').slice(0, 50)}` : ''
        // Use accumulated streaming content if available — msg.content only has the
        // final LLM response (after tool calls), so it would wipe earlier streamed text.
        setStreaming(prev => {
          // Keep [used tool: X] markers — renderContentWithTools replaces them with accordions
          const finalContent = (prev || normalizeContent(msg.content)).trim()

          // If server sent messages, rebuild from server list to get correct ordering
          // (important when messages were injected mid-conversation)
          if (serverMsgs.length > 0) {
            // Convert server messages to client format, adding the final assistant response
            // Filter: show only user and assistant messages
            const rebuilt: Message[] = serverMsgs
              .filter((sm: any) => sm.role !== 'system' && sm.role !== 'tool')
              .map((sm: any) => ({
                id: makeId(),
                role: sm.role as 'user' | 'assistant' | 'tool' | 'system',
                content: normalizeContent(sm.content),
                toolCalls: sm.tool_calls,
                askUserQuestion: extractAskUserQuestion(sm._meta),
                serverIndex: sm.serverIndex,
                timestamp: Date.now(),
                _meta: sm._meta,
              }))

            // Check if the last message is already the assistant response we're about to add
            const lastMsg = rebuilt[rebuilt.length - 1]
            if (lastMsg && lastMsg.role === 'assistant') {
              // Update the last assistant message with streaming content and tool calls
              rebuilt[rebuilt.length - 1] = {
                ...lastMsg,
                content: finalContent || lastMsg.content,
                toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : lastMsg.toolCalls,
              }
            }

            setMessages(rebuilt)
          } else {
            // Fallback: append to existing messages (no server list available)
            setMessages(msgs => {
              const updated = [...msgs, {
                id: makeId(),
                role: 'assistant' as const,
                content: finalContent,
                toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
                timestamp: Date.now(),
              }]
              return updated
            })
          }
          return ''
        })
      }
      if (msg.type === 'error') {
        stopProcessingPoll()
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
        stopProcessingPoll()
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
        // When sessions are updated externally (heartbeat, plugins, etc.),
        // reload our current session to show new messages
        if (msg.resource === 'sessions' && !awaitingResponseRef.current && currentSessionIdRef.current) {
          // Use a small debounce to avoid spamming reloads
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            const ws = wsRef.current
            const sessionId = currentSessionIdRef.current
            // Only reload if we're not in the middle of a conversation
            setTimeout(() => {
              if (!awaitingResponseRef.current && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'load_session', session_id: sessionId }))
              }
            }, 300)
          }
        }
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
          id: msg.id, // For replacing previous images
        }
        setMessages(prev => {
          // Attach to last assistant message or create new
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            // If image has an id, replace existing image with same id
            const existingImages = last.images || []
            let newImages: typeof existingImages
            if (msg.id) {
              const existingIdx = existingImages.findIndex(img => img.id === msg.id)
              if (existingIdx >= 0) {
                // Replace existing image with same id
                newImages = [...existingImages]
                newImages[existingIdx] = imgData
              } else {
                newImages = [...existingImages, imgData]
              }
            } else {
              newImages = [...existingImages, imgData]
            }
            return [...prev.slice(0, -1), {
              ...last,
              images: newImages,
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
      // Handle context breakdown response
      if (msg.type === 'context_breakdown') {
        setContextBreakdown(msg.breakdown)
        setShowContextBreakdown(true)
      }
      // Handle injected message confirmation (queued prompts)
      if (msg.type === 'injected') {
        // Message was injected into session - the current processing loop will see it
        // Visual update already happened in sendNextQueuedPrompt
        console.log('[chat] Injected queued prompt into session')
      }
      // Handle messages_updated (after delete/edit)
      if (msg.type === 'messages_updated') {
        setCurrentSessionId(msg.session_id)
        currentSessionIdRef.current = msg.session_id
        if (msg.context) setContextInfo(msg.context)
        const loaded: ChatMessage[] = (msg.messages || [])
          .filter((m: any) => m.role !== 'system' && m.role !== 'tool')
          .map((m: any) => ({
            id: makeId(),
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content || '',
            toolCalls: m.tool_calls?.map((tc: any) => ({ name: tc.name, arguments: tc.arguments, result: tc.result || '' })),
            askUserQuestion: extractAskUserQuestion(m._meta),
            _meta: m._meta,
            timestamp: Date.now(),
            serverIndex: m.serverIndex,
          }))
        setMessages(loaded)
        setEditingMessageId(null)
        setEditingContent('')
      }
      // Handle retry_complete (after retry)
      if (msg.type === 'retry_complete') {
        stopProcessingPoll()
        setTyping(false)
        setAwaitingResponse(false)
        awaitingResponseRef.current = false
        if (msg.context) setContextInfo(msg.context)
        // Reload all messages from server - filter out system and tool messages
        const loaded: ChatMessage[] = (msg.messages || [])
          .filter((m: any) => m.role !== 'system' && m.role !== 'tool')
          .map((m: any) => ({
            id: makeId(),
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content || '',
            toolCalls: m.tool_calls?.map((tc: any) => ({ name: tc.name, arguments: tc.arguments, result: tc.result || '' })),
            askUserQuestion: extractAskUserQuestion(m._meta),
            _meta: m._meta,
            timestamp: Date.now(),
            serverIndex: m.serverIndex,
          }))
        setMessages(loaded)
        setStreaming('')
      }
    }

    wsRef.current = ws
  }

  const sendUserMessage = (raw: string) => {
    if (!wsRef.current) return
    const trimmed = raw.trim()
    if (!trimmed) return

    // If user resets session, clear agent selection and re-show picker
    if ((trimmed === '/new' || trimmed === '/reset') && multiAgent) {
      setSelectedAgent(null)
      setTimeout(() => setShowAgentPicker(true), 300)
    }

    setMessages(prev => [...prev, { id: makeId(), role: 'user', content: trimmed, timestamp: Date.now() }])
    const payload: any = { type: 'message', content: trimmed }
    if (selectedAgent) payload.agent = selectedAgent
    wsRef.current.send(JSON.stringify(payload))
    setStreaming('')
    pendingToolCallsRef.current = []
    setStreamingToolCalls([])
    setAwaitingResponse(true)
    awaitingResponseRef.current = true
  }

  const send = () => {
    if (!input.trim()) return
    sendUserMessage(input)
    setInput('')
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: colors.bgPrimary }}>
        <div style={{ padding: 40, background: colors.bgCard, borderRadius: 12, border: `1px solid ${colors.border}`, maxWidth: 400, width: '100%' }}>
          <h2 style={{ fontSize: 20, marginBottom: 8, color: colors.accent }}>AutoMate</h2>
          <p style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 20 }}>Enter your authentication token to connect.</p>
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
              width: '100%', padding: '10px 14px', background: colors.bgHover, border: `1px solid ${colors.borderLight}`,
              borderRadius: 6, color: colors.textPrimary, fontSize: 14, outline: 'none', fontFamily: 'monospace',
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
              width: '100%', padding: '10px 20px', background: colors.accent, color: colors.accentContrast, border: 'none',
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
    background: role === 'user' ? colors.accentMuted : role === 'system' ? colors.bgHover : colors.bgCard,
    border: `1px solid ${role === 'user' ? colors.borderFocus : role === 'system' ? colors.borderLight : colors.border}`,
    fontSize: 14,
    lineHeight: 1.6,
    wordBreak: 'break-word',
    position: 'relative',
  })

  /** Detect heartbeat-related messages and pre-compaction memory flush messages */
  const isHeartbeatMsg = (m: ChatMessage): boolean => {
    const c = m.content.trim()
    if (c === 'HEARTBEAT_OK' || c.includes('HEARTBEAT_OK')) return true
    if (c.startsWith('[HEARTBEAT CHECK]') || c.endsWith('[HEARTBEAT CHECK]')) return true
    if (c.startsWith('[HEARTBEAT]') || c.endsWith('[HEARTBEAT]')) return true
    // Pre-compaction memory flush messages
    if (c.startsWith('[MEMORY FLUSH]') || c === 'MEMORY_FLUSH_OK' || c.includes('MEMORY_FLUSH_OK')) return true
    return false
  }

  /** Group messages: consecutive heartbeat msgs become groups, others stay solo */
  type RenderItem = { kind: 'message'; msg: ChatMessage } | { kind: 'heartbeat'; msgs: ChatMessage[]; ts: number }
  const buildRenderItems = (): RenderItem[] => {
    // Filter hidden messages unless explicitly shown
    const visibleMsgs = messages.filter(m => !m._meta?.hidden || showHiddenMessages)
    if (!hideHeartbeats) return visibleMsgs.map(msg => ({ kind: 'message' as const, msg }))
    const items: RenderItem[] = []
    let i = 0
    while (i < visibleMsgs.length) {
      if (isHeartbeatMsg(visibleMsgs[i])) {
        const group: ChatMessage[] = []
        const ts = visibleMsgs[i].timestamp
        while (i < visibleMsgs.length && isHeartbeatMsg(visibleMsgs[i])) {
          group.push(visibleMsgs[i])
          i++
        }
        items.push({ kind: 'heartbeat', msgs: group, ts })
      } else {
        items.push({ kind: 'message', msg: visibleMsgs[i] })
        i++
      }
    }
    return items
  }
  const renderItems = buildRenderItems()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '12px 20px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? colors.success : colors.error }} />
          <span style={{ fontSize: 14, color: colors.textSecondary }}>{connected ? 'Connected' : 'Disconnected'}</span>
          {multiAgent && (
            <button
              onClick={() => setShowAgentPicker(true)}
              style={{
                padding: '3px 10px', background: selectedAgent ? colors.accentMuted : colors.bgHover,
                border: selectedAgent ? `1px solid ${colors.borderFocus}` : `1px solid ${colors.borderLight}`,
                borderRadius: 12, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                color: selectedAgent ? colors.accent : colors.textSecondary, transition: 'all 0.15s',
              }}
            >
              {selectedAgent ? `⚡ ${selectedAgent}` : '🤖 Pick Agent'}
            </button>
          )}
        </div>
        {contextInfo && (
          <div
            onClick={() => {
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'get_context_breakdown' }))
              }
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
            title={`${contextInfo.used.toLocaleString()} / ${contextInfo.limit.toLocaleString()} tokens - Click for breakdown`}
          >
            <div style={{
              width: 80, height: 6, background: colors.bgTertiary, borderRadius: 3, overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.min(contextInfo.percent, 100)}%`, height: '100%', borderRadius: 3,
                background: contextInfo.percent > 80 ? colors.error : contextInfo.percent > 50 ? colors.warning : colors.success,
                transition: 'width 0.3s, background 0.3s',
              }} />
            </div>
            <span style={{ fontSize: 10, color: contextInfo.percent > 80 ? colors.error : colors.textMuted, fontFamily: 'monospace' }}>
              {contextInfo.percent}%
            </span>
            <span style={{ fontSize: 10, color: colors.textMuted }}>i</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Elevated toggle */}
          <button onClick={() => {
            const next = !elevated
            setElevated(next)
            fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `/elevated ${next ? 'on' : 'off'}`, sessionId: currentSessionId }) }).catch(() => {})
          }} title={elevated ? 'Elevated: ON' : 'Elevated: OFF'} style={{
            padding: '4px 10px', background: elevated ? colors.bgHover : colors.bgTertiary,
            color: elevated ? colors.success : colors.textSecondary, border: `1px solid ${elevated ? colors.success : colors.borderLight}`,
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
            padding: '4px 10px', background: hideHeartbeats ? colors.bgHover : colors.bgTertiary,
            color: hideHeartbeats ? colors.error : colors.heartbeat, border: `1px solid ${colors.borderLight}`,
            borderRadius: 4, cursor: 'pointer', fontSize: 13,
          }}>
            {hideHeartbeats ? '💔' : '💜'}
          </button>
          {/* Power steering visibility toggle */}
          <button onClick={() => {
            setShowHiddenMessages(!showHiddenMessages)
          }} title={showHiddenMessages ? 'Power Steering: Visible' : 'Power Steering: Hidden'} style={{
            padding: '4px 10px', background: showHiddenMessages ? colors.bgHover : colors.bgTertiary,
            color: showHiddenMessages ? colors.warning : colors.textSecondary, border: `1px solid ${colors.borderLight}`,
            borderRadius: 4, cursor: 'pointer', fontSize: 13,
          }}>
            {showHiddenMessages ? '⚡' : '🔒'}
          </button>
          {/* Model picker */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowModelPicker(!showModelPicker)} style={{
              padding: '4px 12px', background: colors.bgTertiary, color: colors.accent,
              border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
              maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {currentModel.split('/').pop() || 'Model'}
            </button>
            {showModelPicker && (
              <div style={{
                position: 'absolute', top: 30, right: 0, zIndex: 100,
                background: colors.bgCard, border: `1px solid ${colors.borderLight}`, borderRadius: 8,
                minWidth: 220, boxShadow: `0 8px 24px ${colors.shadow}`,
              }}>
                {models.map((m, i) => (
                  <div key={i} onClick={() => {
                    fetch('/api/models/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: m.name }) })
                      .then(r => r.json()).then((d: any) => { if (d.success) setCurrentModel(d.model || m.model) }).catch(() => {})
                    setShowModelPicker(false)
                  }} style={{
                    padding: '8px 14px', cursor: 'pointer', borderBottom: `1px solid ${colors.border}`,
                    background: m.active ? colors.bgTertiary : 'transparent',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = colors.bgTertiary)}
                  onMouseLeave={e => (e.currentTarget.style.background = m.active ? colors.bgTertiary : 'transparent')}
                  >
                    <div style={{ fontSize: 12, color: m.active ? colors.accent : colors.textPrimary }}>{m.name}</div>
                    <div style={{ fontSize: 10, color: colors.textMuted }}>{m.model}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => {
            fetchSessionsList()
            setShowSessionPicker(!showSessionPicker)
          }} style={{
            padding: '4px 12px', background: colors.bgTertiary, color: colors.textSecondary,
            border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
          }}>
            Sessions
          </button>
          <button onClick={() => {
            if (wsRef.current) {
              wsRef.current.send(JSON.stringify({ type: 'message', content: '/new' }))
              setMessages([])
              setStreaming('')
              setCurrentSessionId(null)
              currentSessionIdRef.current = null
            }
          }} style={{
            padding: '4px 12px', background: colors.bgTertiary, color: colors.textSecondary,
            border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
          }}>
            New
          </button>
        </div>
      </div>

      {/* Session picker dropdown */}
      {showSessionPicker && (
        <div style={{
          position: 'absolute', top: 48, right: 20, zIndex: 100,
          background: colors.bgCard, border: `1px solid ${colors.borderLight}`, borderRadius: 8,
          maxHeight: 300, overflow: 'auto', width: 340, boxShadow: `0 8px 24px ${colors.shadow}`,
        }}>
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, fontSize: 12, color: colors.textSecondary }}>
            Load a session
          </div>
          {sessionsList.length === 0 && (
            <div style={{ padding: 16, color: colors.textMuted, fontSize: 12, textAlign: 'center' }}>No sessions with messages</div>
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
                padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${colors.border}`,
                fontSize: 12, transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = colors.bgTertiary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontFamily: 'monospace', color: colors.accent, fontSize: 11, marginBottom: 2 }}>{s.id}</div>
              <div style={{ color: colors.textMuted, fontSize: 10 }}>
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
          background: colors.bgTertiary,
          borderBottom: `1px solid ${colors.borderLight}`,
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 12,
        }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: heartbeat.status === 'running' ? colors.heartbeat : heartbeat.status === 'sent' ? colors.accent : heartbeat.status === 'failed' ? colors.error : colors.success,
            animation: heartbeat.status === 'running' ? 'pulse 1.5s infinite' : 'none',
          }} />
          <span style={{ color: colors.heartbeat, fontWeight: 600, fontFamily: 'monospace' }}>Heartbeat</span>
          {heartbeat.status === 'running' && !heartbeat.content && (
            <span style={{ color: colors.textSecondary }}>Checking...</span>
          )}
          {heartbeat.status === 'running' && heartbeat.content && (
            <span style={{ color: colors.heartbeat, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {heartbeat.content.slice(0, 200)}{heartbeat.content.length > 200 ? '...' : ''}
              <span style={{ animation: 'blink 1s infinite', color: colors.heartbeat }}>|</span>
            </span>
          )}
          {heartbeat.status === 'ok-empty' && (
            <span style={{ color: colors.success }}>All clear (empty response)</span>
          )}
          {heartbeat.status === 'ok-token' && (
            <span style={{ color: colors.success }}>All clear</span>
          )}
          {heartbeat.status === 'skipped' && (
            <span style={{ color: colors.textSecondary }}>Skipped (empty checklist)</span>
          )}
          {heartbeat.status === 'sent' && (
            <span style={{ color: colors.accent, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Alert: {heartbeat.content.slice(0, 120)}{heartbeat.content.length > 120 ? '...' : ''}
            </span>
          )}
          {heartbeat.status === 'failed' && (
            <span style={{ color: colors.error }}>Failed</span>
          )}
          <button onClick={() => setHeartbeat(null)} style={{
            background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 14, marginLeft: 'auto', padding: '0 4px',
          }}>x</button>
        </div>
      )}

      {/* HTML Preview Modal */}
      {htmlPreview && (
        <div
          onClick={() => setHtmlPreview(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: colors.bgOverlay, zIndex: 1000,
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
              padding: '8px 16px', background: colors.bgTertiary,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: `1px solid ${colors.borderLight}`,
            }}>
              <span style={{ fontSize: 13, color: colors.accent, fontWeight: 600 }}>HTML Preview</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => {
                    const w = window.open('', '_blank')
                    if (w) { w.document.write(htmlPreview); w.document.close() }
                  }}
                  style={{
                    padding: '3px 10px', background: colors.bgTertiary, color: colors.accent,
                    border: `1px solid ${colors.accent}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
                  }}
                >
                  Open in tab
                </button>
                <button
                  onClick={() => setHtmlPreview(null)}
                  style={{
                    padding: '3px 10px', background: colors.bgDanger, color: colors.error,
                    border: `1px solid ${colors.borderDanger}`, borderRadius: 4, cursor: 'pointer', fontSize: 11,
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

      {/* Context Breakdown Modal */}
      {showContextBreakdown && contextBreakdown && (
        <div
          onClick={() => { setShowContextBreakdown(false); setExpandedBreakdown(null) }}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: colors.bgOverlay, zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '90%', maxWidth: 450, maxHeight: '80vh',
              background: colors.bgCard, borderRadius: 12, overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              padding: '12px 16px', background: colors.bgTertiary,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: `1px solid ${colors.borderLight}`,
            }}>
              <span style={{ fontSize: 14, color: colors.textPrimary, fontWeight: 600 }}>Context Breakdown</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={() => {
                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ type: 'get_context_breakdown' }))
                    }
                  }}
                  style={{
                    background: 'none', border: 'none', color: colors.accent,
                    cursor: 'pointer', fontSize: 12, padding: '2px 6px',
                  }}
                  title="Refresh"
                >
                  ↻
                </button>
                <button
                  onClick={() => { setShowContextBreakdown(false); setExpandedBreakdown(null) }}
                  style={{
                    background: 'none', border: 'none', color: colors.textMuted,
                    cursor: 'pointer', fontSize: 16, padding: '0 4px',
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
            <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
              {/* Total usage bar */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: colors.textSecondary }}>Total Usage</span>
                  <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: 'monospace' }}>
                    {contextBreakdown.total.toLocaleString()} / {contextBreakdown.limit.toLocaleString()}
                  </span>
                </div>
                <div style={{ height: 8, background: colors.bgTertiary, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min((contextBreakdown.total / contextBreakdown.limit) * 100, 100)}%`,
                    height: '100%', borderRadius: 4,
                    background: (contextBreakdown.total / contextBreakdown.limit) > 0.8 ? colors.error
                      : (contextBreakdown.total / contextBreakdown.limit) > 0.5 ? colors.warning : colors.success,
                  }} />
                </div>
              </div>

              {/* Category breakdown */}
              {[
                { key: 'systemPrompt', label: 'System Prompt', value: contextBreakdown.systemPrompt, color: colors.accent, expandable: true },
                { key: 'toolDefinitions', label: 'Tool Definitions', value: contextBreakdown.toolDefinitions, color: colors.warning, expandable: true },
                { key: 'userMessages', label: 'User Messages', value: contextBreakdown.userMessages, color: colors.success, expandable: false },
                { key: 'assistantMessages', label: 'Assistant Messages', value: contextBreakdown.assistantMessages, color: colors.heartbeat, expandable: false },
                { key: 'toolResults', label: 'Tool Results', value: contextBreakdown.toolResults, color: colors.error, expandable: false },
              ].map(item => {
                const percent = contextBreakdown.total > 0 ? (item.value / contextBreakdown.total) * 100 : 0
                const isExpanded = expandedBreakdown === item.key
                const details = item.key === 'systemPrompt' ? contextBreakdown.details?.systemPrompt
                  : item.key === 'toolDefinitions' ? contextBreakdown.details?.tools
                  : null
                return (
                  <div key={item.label} style={{ marginBottom: 10 }}>
                    <div
                      onClick={() => item.expandable && details && setExpandedBreakdown(isExpanded ? null : item.key)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', marginBottom: 2,
                        cursor: item.expandable && details ? 'pointer' : 'default',
                        padding: '2px 0',
                      }}
                    >
                      <span style={{ fontSize: 11, color: colors.textSecondary, display: 'flex', alignItems: 'center', gap: 4 }}>
                        {item.expandable && details && (
                          <span style={{ fontSize: 8, color: colors.textMuted }}>{isExpanded ? '▼' : '▶'}</span>
                        )}
                        {item.label}
                        {item.expandable && details && (
                          <span style={{ fontSize: 9, color: colors.textMuted }}>({details.length})</span>
                        )}
                      </span>
                      <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: 'monospace' }}>
                        {item.value.toLocaleString()} ({percent.toFixed(1)}%)
                      </span>
                    </div>
                    <div style={{ height: 6, background: colors.bgTertiary, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${percent}%`,
                        height: '100%', borderRadius: 3,
                        background: item.color,
                        transition: 'width 0.3s',
                      }} />
                    </div>
                    {/* Expanded details */}
                    {isExpanded && details && (
                      <div style={{
                        marginTop: 6, padding: 8, background: colors.bgTertiary, borderRadius: 6,
                        maxHeight: 200, overflowY: 'auto',
                      }}>
                        {details.sort((a, b) => b.tokens - a.tokens).map((d, i) => (
                          <div key={i} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '3px 0', borderBottom: i < details.length - 1 ? `1px solid ${colors.borderLight}` : 'none',
                          }}>
                            <span style={{
                              fontSize: 10, color: colors.textSecondary,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              maxWidth: '70%',
                            }}>
                              {d.name}
                            </span>
                            <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: 'monospace' }}>
                              {d.tokens.toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Tips */}
              <div style={{ marginTop: 16, padding: 10, background: colors.bgHover, borderRadius: 6, fontSize: 11, color: colors.textSecondary }}>
                <strong style={{ color: colors.textPrimary }}>Tips:</strong>
                <ul style={{ margin: '6px 0 0 0', paddingLeft: 16 }}>
                  <li>Click System Prompt or Tool Definitions to see file breakdown</li>
                  <li>Use <code style={{ background: colors.bgTertiary, padding: '1px 4px', borderRadius: 2 }}>/compact</code> to summarize and reduce context</li>
                  <li>Tool results often take the most space</li>
                </ul>
              </div>
            </div>
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
        {renderItems.map((item, itemIdx) => {
          // ---- Heartbeat accordion (collapsed group) ----
          if (item.kind === 'heartbeat') {
            const hbKey = `hb_${itemIdx}_${item.ts}`
            const isOpen = expandedHeartbeats[hbKey] || false
            const dt = new Date(item.ts)
            const label = `Heartbeat ${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`
            return (
              <div key={hbKey} style={{ width: '100%', marginBottom: 6, alignSelf: 'stretch' }}>
                <div
                  onClick={() => setExpandedHeartbeats(prev => ({ ...prev, [hbKey]: !prev[hbKey] }))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    padding: '6px 12px', background: colors.bgHover, borderRadius: 6,
                    border: `1px solid ${colors.borderLight}`, userSelect: 'none', width: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <span style={{
                    display: 'inline-block', fontSize: 9, color: colors.textSecondary,
                    transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s',
                  }}>▶</span>
                  <span style={{ fontSize: 12, color: colors.heartbeat }}>💜</span>
                  <span style={{ fontSize: 12, color: colors.heartbeat, fontFamily: 'monospace', fontWeight: 600 }}>{label}</span>
                  <span style={{ fontSize: 10, color: colors.textMuted, marginLeft: 'auto' }}>{item.msgs.length} msg{item.msgs.length > 1 ? 's' : ''}</span>
                </div>
                {isOpen && (
                  <div style={{
                    marginTop: 4, padding: '8px 12px',
                    background: colors.bgPrimary, borderRadius: '0 0 6px 6px',
                    border: `1px solid ${colors.borderLight}`, borderTop: 'none',
                  }}>
                    {item.msgs.map((m) => (
                      <div key={m.id} style={{
                        padding: '8px 12px', marginBottom: 6, borderRadius: 8,
                        background: m.role === 'user' ? colors.accentMuted : m.role === 'system' ? colors.bgHover : colors.bgCard,
                        border: `1px solid ${m.role === 'user' ? colors.borderFocus : m.role === 'system' ? colors.borderLight : colors.border}`,
                        fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word',
                      }}>
                        <div style={{ fontSize: 10, color: colors.textMuted, marginBottom: 4 }}>
                          {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'AutoMate' : 'System'}
                          <span style={{ marginLeft: 6, fontSize: 9, color: colors.textMuted }}>
                            {new Date(m.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div>{m.role === 'assistant' ? renderContentWithTools(m.content, m.toolCalls, `msg_${m.serverIndex ?? m.id}`) : m.content}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          }

          // ---- Power Steering accordion ----
          const m = item.msg
          if (m._meta?.isPowerSteering) {
            const psKey = `ps_${itemIdx}_${m.id}`
            const isOpen = expandedTools[psKey] || false
            return (
              <div key={m.id} style={{ width: '100%', marginBottom: 6, alignSelf: 'stretch' }}>
                <div
                  onClick={() => setExpandedTools(prev => ({ ...prev, [psKey]: !prev[psKey] }))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    padding: '6px 12px', background: colors.bgWarning, borderRadius: 6,
                    border: `1px solid ${colors.warning}33`, userSelect: 'none', width: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <span style={{
                    display: 'inline-block', fontSize: 9, color: colors.warning,
                    transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s',
                  }}>▶</span>
                  <span style={{ fontSize: 12 }}>⚡</span>
                  <span style={{ fontSize: 12, color: colors.warning, fontWeight: 600 }}>Power Steering</span>
                  <span style={{ fontSize: 10, color: colors.textMuted, marginLeft: 'auto' }}>System re-anchor</span>
                </div>
                {isOpen && (
                  <div style={{
                    marginTop: 4, padding: '12px 16px',
                    background: colors.bgCard, borderRadius: '0 0 6px 6px',
                    border: `1px solid ${colors.warning}33`, borderTop: 'none',
                    fontSize: 12, color: colors.textSecondary, fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
                    maxHeight: 300, overflow: 'auto',
                  }}>
                    {m.content}
                  </div>
                )}
              </div>
            )
          }

          // ---- Normal message ----
          return (
          <div key={m.id} style={msgStyle(m.role)}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: colors.textMuted }}>
                {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'AutoMate' : 'System'}
                <span style={{ marginLeft: 8, fontSize: 9, color: colors.textMuted }}>
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
              </span>
              {/* Action buttons for user and assistant messages */}
              {(m.role === 'user' || m.role === 'assistant') && m.id !== editingMessageId && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {m.role === 'assistant' && (
                    <button onClick={() => copyMessage(m.content)} title="Copy" style={{
                      background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 11, padding: '2px 4px',
                    }}>Copy</button>
                  )}
                  <button onClick={() => startEditMessage(m.id, m.content)} title="Edit" style={{
                    background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 11, padding: '2px 4px',
                  }}>Edit</button>
                  <button onClick={() => retryMessage(m.id)} title="Retry" style={{
                    background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 11, padding: '2px 4px',
                  }}>Retry</button>
                  <button onClick={() => deleteMessage(m.id)} title="Delete" style={{
                    background: 'none', border: 'none', color: colors.error, cursor: 'pointer', fontSize: 11, padding: '2px 4px',
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
                    background: colors.bgHover, border: `1px solid ${colors.accent}`, borderRadius: 4,
                    color: colors.textPrimary, fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
                  }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={saveEditMessage} style={{
                    padding: '4px 12px', background: colors.accent, color: colors.accentContrast,
                    border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  }}>Save</button>
                  <button onClick={cancelEdit} style={{
                    padding: '4px 12px', background: colors.borderLight, color: colors.textSecondary,
                    border: `1px solid ${colors.borderLight}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
                  }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{ fontFamily: m.role === 'user' ? 'inherit' : 'inherit' }}>
                {m.role === 'assistant' ? renderContentWithTools(m.content, m.toolCalls, `msg_${m.serverIndex ?? m.id}`) : m.content}
              </div>
            )}

            {/* Ask-user quick options */}
            {m.role === 'assistant' && m.askUserQuestion && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(m.askUserQuestion.options || []).map((opt, idx) => (
                  <button
                    key={`${m.askUserQuestion?.id}_opt_${idx}`}
                    onClick={() => sendUserMessage(opt)}
                    style={{
                      padding: '4px 10px',
                      background: colors.bgTertiary,
                      color: colors.textPrimary,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 14,
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    {opt}
                  </button>
                ))}
                {m.askUserQuestion.allowCustomInput !== false && (
                  <button
                    onClick={() => {
                      if (!input.trim()) return
                      sendUserMessage(input)
                      setInput('')
                      inputRef.current?.focus()
                    }}
                    style={{
                      padding: '4px 10px',
                      background: colors.bgHover,
                      color: colors.textSecondary,
                      border: `1px dashed ${colors.borderLight}`,
                      borderRadius: 14,
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                    title="Send current composer text as your custom answer"
                  >
                    Send custom answer
                  </button>
                )}
              </div>
            )}

            {/* Images */}
            {m.images && m.images.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {m.images.map((img, j) => (
                  <div key={img.id || `img_${m.serverIndex ?? m.id}_${j}`} style={{ position: 'relative' }}>
                    <img
                      src={img.base64 ? `data:${img.mimeType};base64,${img.base64}` : img.url}
                      alt={img.alt || img.filename || 'image'}
                      style={{
                        maxWidth: 400, maxHeight: 300, borderRadius: 6,
                        border: `1px solid ${colors.borderLight}`, cursor: 'pointer',
                      }}
                      onClick={() => {
                        const src = img.base64 ? `data:${img.mimeType};base64,${img.base64}` : img.url
                        if (src) window.open(src, '_blank')
                      }}
                    />
                    {img.filename && (
                      <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>{img.filename}</div>
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
                    padding: '2px 8px', background: colors.bgTertiary, color: colors.textSecondary,
                    border: `1px solid ${colors.border}`, borderRadius: 10, cursor: 'pointer',
                    fontSize: 10, transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = colors.accent; e.currentTarget.style.borderColor = colors.accent }}
                  onMouseLeave={e => { e.currentTarget.style.color = colors.textSecondary; e.currentTarget.style.borderColor = colors.border }}
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
                      background: m.reactions?.includes(emoji) ? colors.accentMuted : 'transparent',
                      border: m.reactions?.includes(emoji) ? `1px solid ${colors.accent}` : `1px solid ${colors.borderLight}`,
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
          )
        })}

        {/* Streaming message — tool accordions render inline where [used tool: X] markers appear */}
        {(streaming || streamingToolCalls.length > 0) && (
          <div style={msgStyle('assistant')}>
            <div style={{ fontSize: 10, color: colors.textMuted, marginBottom: 6 }}>AutoMate</div>
            <div>{renderContentWithTools(streaming, streamingToolCalls, 'streaming')}</div>
            <span style={{ animation: 'blink 1s infinite', color: colors.accent }}>|</span>
          </div>
        )}

        {/* Injected prompts indicator - shown after streaming, before they're synced */}
        {injectedPrompts.length > 0 && (
          <>
            {injectedPrompts.map((prompt, i) => (
              <div key={`injected-${i}`} style={msgStyle('user')}>
                <div style={{ fontSize: 10, color: colors.textMuted, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>You</span>
                  <span style={{ fontSize: 9, color: colors.accent, background: colors.bgHover, padding: '1px 6px', borderRadius: 4 }}>injected</span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{prompt}</div>
              </div>
            ))}
          </>
        )}

        {/* Typing indicator */}
        {typing && !streaming && streamingToolCalls.length === 0 && (
          <div style={{ ...msgStyle('assistant'), color: colors.textMuted }}>
            <div style={{ fontSize: 10, color: colors.textMuted, marginBottom: 4 }}>AutoMate</div>
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
          background: colors.bgCard, border: `1px solid ${colors.borderLight}`, borderRadius: 8,
          maxHeight: 240, overflow: 'auto', boxShadow: `0 -4px 20px ${colors.shadow}`,
        }}>
          {SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().includes(slashFilter)).map(c => (
            <div
              key={c.cmd}
              onClick={() => { setInput(c.cmd + ' '); setShowSlashMenu(false); inputRef.current?.focus() }}
              style={{
                padding: '8px 14px', cursor: 'pointer', borderBottom: `1px solid ${colors.border}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = colors.bgTertiary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ fontFamily: 'monospace', color: colors.accent, fontSize: 13 }}>{c.cmd}</span>
              <span style={{ fontSize: 11, color: colors.textMuted }}>{c.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* Input area */}
      <div style={{ padding: '12px 20px', borderTop: `1px solid ${colors.border}` }}>
        {/* Queued prompts indicator */}
        {promptQueue.length > 0 && (
          <div style={{
            marginBottom: 8, borderRadius: 6, overflow: 'hidden',
            border: `1px solid ${colors.warning}`,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 12px', background: colors.warning, color: '#000',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                ⏳ {promptQueue.length} prompt{promptQueue.length > 1 ? 's' : ''} queued
              </span>
              <button
                onClick={() => setPromptQueue([])}
                style={{
                  background: 'rgba(0,0,0,0.2)', border: 'none', color: '#000',
                  cursor: 'pointer', fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  fontWeight: 600,
                }}
                title="Clear all queued prompts"
              >
                Clear all
              </button>
            </div>
            <div style={{ background: colors.bgTertiary, maxHeight: 120, overflowY: 'auto' }}>
              {promptQueue.map((prompt, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 12px',
                    borderBottom: idx < promptQueue.length - 1 ? `1px solid ${colors.border}` : 'none',
                  }}
                >
                  <span style={{
                    fontSize: 10, color: colors.textMuted, fontWeight: 600,
                    minWidth: 18,
                  }}>
                    #{idx + 1}
                  </span>
                  <span style={{
                    flex: 1, fontSize: 12, color: colors.textSecondary,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt}
                  </span>
                  <button
                    onClick={() => setPromptQueue(prev => prev.filter((_, i) => i !== idx))}
                    style={{
                      background: 'none', border: 'none', color: colors.error,
                      cursor: 'pointer', fontSize: 12, padding: '0 4px',
                    }}
                    title="Remove this prompt"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* File upload indicator */}
        {uploading && (
          <div style={{ fontSize: 11, color: colors.accent, marginBottom: 6 }}>Uploading file...</div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* File upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Upload file"
            style={{
              padding: '10px 12px', background: colors.bgTertiary, color: colors.textSecondary,
              border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer', fontSize: 16,
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
              flex: 1, padding: '10px 14px', background: colors.bgHover, border: `1px solid ${colors.borderLight}`,
              borderRadius: 6, color: colors.textPrimary, fontSize: 14, outline: 'none', fontFamily: 'inherit',
            }}
          />
          {(awaitingResponse || streaming) ? (
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden' }}>
              {/* Interrupt button */}
              <button
                onClick={() => {
                  if (wsRef.current) {
                    wsRef.current.send(JSON.stringify({ type: 'interrupt' }))
                  }
                }}
                style={{
                  padding: '10px 14px', background: colors.error, color: '#fff',
                  border: 'none', cursor: 'pointer',
                  fontWeight: 600, fontSize: 14, transition: 'all 0.15s',
                  borderRight: `1px solid rgba(255,255,255,0.2)`,
                }}
                title="Stop the current response"
              >
                Stop
              </button>
              {/* Queue button */}
              <button
                onClick={() => {
                  if (input.trim()) {
                    setPromptQueue(prev => [...prev, input.trim()])
                    setInput('')
                    inputRef.current?.focus()
                  }
                }}
                disabled={!input.trim()}
                style={{
                  padding: '10px 14px',
                  background: input.trim() ? colors.warning : colors.bgTertiary,
                  color: input.trim() ? '#000' : colors.textMuted,
                  border: 'none', cursor: input.trim() ? 'pointer' : 'default',
                  fontWeight: 600, fontSize: 14, transition: 'all 0.15s',
                  opacity: input.trim() ? 1 : 0.5,
                  position: 'relative',
                }}
                title="Queue this prompt to send after the next tool call"
              >
                Queue
                {promptQueue.length > 0 && (
                  <span style={{
                    position: 'absolute', top: -6, right: -6,
                    background: colors.accent, color: colors.accentContrast,
                    borderRadius: '50%', width: 18, height: 18,
                    fontSize: 10, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {promptQueue.length}
                  </span>
                )}
              </button>
            </div>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              style={{
                padding: '10px 20px', background: input.trim() ? colors.accent : colors.borderLight, color: input.trim() ? colors.accentContrast : colors.textMuted,
                border: 'none', borderRadius: 6, cursor: input.trim() ? 'pointer' : 'default',
                fontWeight: 600, fontSize: 14, transition: 'all 0.15s',
              }}
            >
              Send
            </button>
          )}
        </div>
      </div>

{/* Agent Picker Vignette — shown on new session when multi-agent is active */}
{showAgentPicker && multiAgent && (
  <div
    onClick={() => {
      // Clicking backdrop dismisses — defaults to normal routing
      setShowAgentPicker(false)
    }}
    style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: colors.bgOverlay, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(4px)',
    }}
  >
    <div
      onClick={e => e.stopPropagation()}
      style={{
        background: colors.bgSecondary, border: `1px solid ${colors.borderLight}`, borderRadius: 16,
        padding: 0, width: '90%', maxWidth: 440, overflow: 'hidden',
        boxShadow: `0 20px 60px ${colors.shadow}`,
      }}
    >
      <div style={{
        padding: '20px 24px 12px', borderBottom: `1px solid ${colors.border}`,
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: colors.textPrimary, marginBottom: 4 }}>
          Choose an Agent
        </div>
        <div style={{ fontSize: 12, color: colors.textSecondary }}>
          Select which agent should handle this session, or dismiss to use default routing.
        </div>
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
        {agentsList.map(a => {
          const isSelected = selectedAgent === a.name
          return (
            <div
              key={a.name}
              onClick={() => {
                setSelectedAgent(a.name)
                setShowAgentPicker(false)
              }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                background: isSelected ? colors.accentMuted : colors.bgHover,
                border: isSelected ? `1px solid ${colors.borderFocus}` : `1px solid ${colors.border}`,
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = colors.bgHover }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = colors.bgHover }}
            >
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: isSelected ? colors.accent : colors.textPrimary }}>
                  {a.name}
                  {a.isDefault && (
                    <span style={{
                      marginLeft: 8, fontSize: 10, color: colors.success,
                      background: colors.bgHover, border: `1px solid ${colors.borderLight}`,
                      borderRadius: 10, padding: '2px 8px', verticalAlign: 'middle',
                    }}>default</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: 'monospace', marginTop: 3 }}>
                  {a.model}
                </div>
              </div>
              <div style={{
                width: 20, height: 20, borderRadius: 10,
                border: isSelected ? `2px solid ${colors.accent}` : `2px solid ${colors.borderLight}`,
                background: isSelected ? colors.accent : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s', flexShrink: 0,
              }}>
                {isSelected && <div style={{ width: 8, height: 8, borderRadius: 4, background: colors.accentContrast }} />}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{
        padding: '12px 16px', borderTop: `1px solid ${colors.border}`,
        display: 'flex', justifyContent: 'flex-end', gap: 8,
      }}>
        <button
          onClick={() => {
            setSelectedAgent(null)
            setShowAgentPicker(false)
          }}
          style={{
            padding: '8px 18px', background: 'transparent', color: colors.textSecondary,
            border: `1px solid ${colors.borderLight}`, borderRadius: 6, cursor: 'pointer',
            fontSize: 12, fontWeight: 600,
          }}
        >
          Use Default
        </button>
      </div>
    </div>
  </div>
)}

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
