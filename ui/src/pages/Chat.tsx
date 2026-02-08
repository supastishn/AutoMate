import React, { useEffect, useRef, useState } from 'react'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: { name: string; result: string }[]
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [connected, setConnected] = useState(false)
  const [typing, setTyping] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    connect()
    return () => { wsRef.current?.close() }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws`)

    ws.onopen = () => setConnected(true)
    ws.onclose = () => { setConnected(false); setTimeout(connect, 3000) }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)

      if (msg.type === 'connected') {
        setMessages(prev => [...prev, { role: 'system', content: `Connected. Session: ${msg.session_id}` }])
      }
      if (msg.type === 'typing') {
        setTyping(msg.active)
      }
      if (msg.type === 'stream') {
        setStreaming(prev => prev + msg.content)
        setTyping(false)
      }
      if (msg.type === 'response') {
        setTyping(false)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: msg.content || streaming,
          toolCalls: msg.tool_calls,
        }])
        setStreaming('')
      }
      if (msg.type === 'error') {
        setMessages(prev => [...prev, { role: 'system', content: `Error: ${msg.message}` }])
      }
    }

    wsRef.current = ws
  }

  const send = () => {
    if (!input.trim() || !wsRef.current) return
    setMessages(prev => [...prev, { role: 'user', content: input }])
    wsRef.current.send(JSON.stringify({ type: 'message', content: input }))
    setInput('')
    setStreaming('')
    inputRef.current?.focus()
  }

  const msgStyle = (role: string) => ({
    padding: '10px 14px',
    marginBottom: 8,
    borderRadius: 8,
    maxWidth: '85%',
    alignSelf: role === 'user' ? 'flex-end' as const : 'flex-start' as const,
    background: role === 'user' ? '#1a3a5c' : role === 'system' ? '#1a1a1a' : '#1a2a1a',
    border: `1px solid ${role === 'user' ? '#2a5a8c' : role === 'system' ? '#333' : '#2a4a2a'}`,
    fontSize: 14,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    fontFamily: 'monospace',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#4caf50' : '#f44' }} />
        <span style={{ fontSize: 14, color: '#888' }}>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {messages.map((m, i) => (
          <div key={i} style={msgStyle(m.role)}>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>
              {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'AutoMate' : 'System'}
            </div>
            {m.content}
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #333', fontSize: 11, color: '#888' }}>
                Tools used: {m.toolCalls.map(t => t.name).join(', ')}
              </div>
            )}
          </div>
        ))}
        {streaming && (
          <div style={msgStyle('assistant')}>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>AutoMate</div>
            {streaming}<span style={{ animation: 'blink 1s infinite' }}>|</span>
          </div>
        )}
        {typing && !streaming && (
          <div style={{ ...msgStyle('assistant'), color: '#666' }}>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4 }}>AutoMate</div>
            Thinking...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ padding: '12px 20px', borderTop: '1px solid #222', display: 'flex', gap: 8 }}>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Type a message... (/new to reset, /status for info)"
          style={{
            flex: 1, padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333',
            borderRadius: 6, color: '#e0e0e0', fontSize: 14, outline: 'none', fontFamily: 'monospace',
          }}
        />
        <button
          onClick={send}
          style={{
            padding: '10px 20px', background: '#4fc3f7', color: '#000', border: 'none',
            borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 14,
          }}
        >
          Send
        </button>
      </div>

      <style>{`@keyframes blink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } }`}</style>
    </div>
  )
}
