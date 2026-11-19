import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LogOut, Mic, MessageSquare, Plus, Search, Trash2 } from 'lucide-react'
import './ChatWorkspace.css'

const API = import.meta.env.VITE_TOKEN_SERVER_URL || `${window.location.protocol}//${window.location.hostname}:3000`

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || `Request failed (${response.status}).`)
  }
  if (response.status === 204) return null
  return response.json()
}

export function SignIn({ onSignedIn }) {
  const [username, setUsername] = useState('ali')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
      onSignedIn(result.user)
    } catch (loginError) { setError(loginError.message) } finally { setBusy(false) }
  }
  return <main className="onex-chat signin-screen"><form className="signin-card" onSubmit={submit}><div className="chat-brand"><span>O</span> ONEXAI <small>INTELLIGENCE</small></div><h1>Welcome back</h1><p>Sign in to your private workspace.</p><label>Account<select value={username} onChange={(event) => setUsername(event.target.value)}><option value="ali">Ali</option><option value="hamza">Hamza</option></select></label><label>Password<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <div className="chat-error">{error}</div>}<button className="chat-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button><small className="setup-hint">First setup? In the project folder run <code>uv run python src/setup_users.py</code>.</small></form></main>
}

export default function ChatWorkspace({ user, onLogout, onVoice }) {
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const bottomRef = useRef(null)
  const controllerRef = useRef(null)

  async function loadList(nextOffset = 0, term = search) {
    const result = await api(`/api/conversations?limit=10&offset=${nextOffset}&q=${encodeURIComponent(term)}`)
    setConversations((current) => nextOffset ? [...current, ...result.conversations] : result.conversations)
    setHasMore(result.conversations.length === 10)
    setOffset(nextOffset)
  }
  async function openConversation(id) {
    setError('')
    try {
      const result = await api(`/api/conversations/${id}`)
      setActiveId(id); setMessages(result.messages)
    } catch (loadError) { setError(loadError.message) }
  }
  async function createConversation() {
    setError('')
    try {
      const result = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ type: 'chat' }) })
      setActiveId(result.conversation.id); setMessages([]); await loadList()
    } catch (createError) { setError(createError.message) }
  }
  useEffect(() => {
    const timer = setTimeout(() => loadList().catch((loadError) => setError(loadError.message)), 0)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => () => controllerRef.current?.abort(), [])

  async function sendMessage(event) {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || busy) return
    let conversationId = activeId
    setBusy(true); setError(''); setDraft('')
    try {
      if (!conversationId) {
        const result = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ type: 'chat' }) })
        conversationId = result.conversation.id; setActiveId(conversationId)
      }
      setMessages((current) => [...current, { id: `pending-${Date.now()}`, role: 'user', content }, { id: 'streaming', role: 'assistant', content: '' }])
      const controller = new AbortController(); controllerRef.current = controller
      const response = await fetch(`${API}/api/chat/stream`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: conversationId, content }), signal: controller.signal })
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `Chat failed (${response.status}).`) }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n'); buffer = events.pop() || ''
        for (const raw of events) {
          const dataLine = raw.split('\n').find((line) => line.startsWith('data: '))
          if (!dataLine) continue
          const payload = JSON.parse(dataLine.slice(6))
          if (raw.startsWith('event: error')) throw new Error(payload.detail || 'Gemini request failed.')
          if (payload.text) setMessages((current) => current.map((item) => item.id === 'streaming' ? { ...item, content: item.content + payload.text } : item))
        }
      }
      setMessages((current) => current.filter((item) => item.id !== 'streaming' || item.content).map((item) => item.id === 'streaming' ? { ...item, id: `assistant-${Date.now()}` } : item))
      await loadList()
    } catch (sendError) {
      if (sendError.name !== 'AbortError') setError(sendError.message)
      setMessages((current) => current.filter((item) => item.id !== 'streaming' || item.content))
    } finally { controllerRef.current = null; setBusy(false) }
  }
  async function deleteConversation(id, event) {
    event.stopPropagation()
    try { await api(`/api/conversations/${id}`, { method: 'DELETE' }); if (activeId === id) { setActiveId(null); setMessages([]) }; await loadList() }
    catch (deleteError) { setError(deleteError.message) }
  }
  async function searchConversations(value) {
    setSearch(value)
    try { await loadList(0, value) } catch (searchError) { setError(searchError.message) }
  }

  return <main className={`onex-chat ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
    <aside className="chat-sidebar"><div className="chat-brand"><span>O</span> ONEXAI <small>INTELLIGENCE</small></div><button className="sidebar-action" onClick={createConversation}><Plus size={16} /> New chat</button><button className="sidebar-action" onClick={() => onVoice(null)}><Mic size={16} /> Start voice session</button><label className="history-search"><Search size={15} /><input value={search} onChange={(event) => searchConversations(event.target.value)} placeholder="Search conversations" /></label><div className="history-caption">RECENT CONVERSATIONS</div><nav className="history-list">{conversations.map((item) => <button className={`history-item ${item.id === activeId ? 'selected' : ''}`} key={item.id} onClick={() => openConversation(item.id)}><span className="history-icon">{item.type === 'voice' ? <Mic size={14} /> : <MessageSquare size={14} />}</span><span className="history-title">{item.title}</span><span className="history-delete" role="button" tabIndex={0} aria-label="Delete conversation" onClick={(event) => deleteConversation(item.id, event)}><Trash2 size={13} /></span></button>)}</nav>{hasMore && <button className="history-more" onClick={() => loadList(offset + 10)}>Load older</button>}<div className="profile-row"><span>{user.display_name[0]}</span><b>{user.display_name}</b><button onClick={onLogout} aria-label="Sign out"><LogOut size={15} /></button></div></aside>
    <section className="chat-main"><header className="chat-topbar"><button className="mobile-menu" onClick={() => setSidebarOpen((open) => !open)}>☰</button><div><b>ONEXAI</b><span>Personal intelligence</span></div><button className="top-voice" onClick={() => onVoice(activeId)}><Mic size={15} /> Voice</button></header>{activeId ? <div className="message-scroll">{messages.length === 0 && <div className="chat-welcome"><h1>What would you like to work through?</h1><p>Your conversations are private to your account.</p></div>}{messages.map((item) => <article className={`message message-${item.role}`} key={item.id}><span className="message-avatar">{item.role === 'user' ? user.display_name[0] : 'O'}</span><div className="message-body"><b>{item.role === 'user' ? user.display_name : 'ONEXAI'}</b><p>{item.content}{item.id === 'streaming' && !item.content && <i className="typing-dots">Thinking…</i>}</p></div></article>)}<div ref={bottomRef} /></div> : <div className="chat-welcome"><h1>Good to see you, {user.display_name}.</h1><p>Start a chat or continue a recent conversation.</p><button className="chat-primary" onClick={createConversation}>Start a new chat</button></div>}{error && <div className="chat-error chat-workspace-error">{error}</div>}<form className="composer" onSubmit={sendMessage}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) sendMessage(event) }} placeholder="Message ONEXAI" rows={1} /><button className="composer-voice" type="button" onClick={() => onVoice(activeId)} aria-label="Continue in voice"><Mic size={17} /></button><button className="composer-send" disabled={busy || !draft.trim()} aria-label="Send message">{busy ? '…' : <ArrowUp size={18} />}</button><small>ONEXAI can make mistakes. Verify important information.</small></form></section>
  </main>
}
