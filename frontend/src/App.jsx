import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Phone, ShieldCheck, Sparkles, Volume2, X } from 'lucide-react'
import './App.css'

const TOKEN_URL = import.meta.env.VITE_TOKEN_SERVER_URL || 'http://127.0.0.1:3000'
const PEOPLE = ['Ali Hassan', 'Hamza']

function Conversation({ onLeave, participantName }) {
  const roomRef = useRef(null)
  const agentTimeoutRef = useRef(null)
  const [state, setState] = useState('connecting')
  const [micEnabled, setMicEnabled] = useState(true)
  const [transcripts, setTranscripts] = useState([])
  const [error, setError] = useState('')
  const [assistantSpeaking, setAssistantSpeaking] = useState(false)
  const [agentTarget, setAgentTarget] = useState('my-agent')

  useEffect(() => {
    let mounted = true
    let currentRoom
    const abortController = new AbortController()

    async function connect() {
      try {
        const { Room, RoomEvent, Track } = await import('livekit-client')
        const response = await fetch(`${TOKEN_URL}/getToken`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participant_name: participantName }),
          signal: abortController.signal,
        })
        const credentials = await response.json()
        if (!response.ok) throw new Error(credentials.detail || 'Could not connect to ONEXA.')
        if (!mounted) return
        if (!credentials.room_name) throw new Error('The token service did not return a room name.')
        setAgentTarget(`${credentials.agent_name || 'my-agent'} · ${credentials.agent_deployment || 'unknown deployment'}`)

        currentRoom = new Room({ adaptiveStream: true, dynacast: true })
        roomRef.current = currentRoom

        currentRoom.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            document.getElementById('remote-audio')?.appendChild(track.attach())
          }
        })
        currentRoom.on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
        currentRoom.on(RoomEvent.ParticipantConnected, () => {
          clearTimeout(agentTimeoutRef.current)
          if (mounted) setState('connected')
        })
        currentRoom.on(RoomEvent.ParticipantDisconnected, () => {
          if (mounted && currentRoom.remoteParticipants.size === 0) {
            setState('agent-missing')
            setAssistantSpeaking(false)
          }
        })
        currentRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          setAssistantSpeaking(speakers.some((speaker) => speaker.identity !== currentRoom.localParticipant.identity))
        })
        currentRoom.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
          const speaker = participant?.identity === currentRoom.localParticipant.identity ? 'you' : 'onexa'
          for (const segment of segments) {
            if (!segment.text?.trim()) continue
            setTranscripts((current) => {
              const existing = current.findIndex((item) => item.id === segment.id)
              const next = [...current]
              const entry = { id: segment.id, speaker, text: segment.text, final: segment.final }
              if (existing >= 0) next[existing] = entry
              else next.push(entry)
              return next.slice(-8)
            })
          }
        })
        currentRoom.on(RoomEvent.Disconnected, () => {
          if (mounted) {
            setState('ended')
            setAssistantSpeaking(false)
          }
        })

        await currentRoom.connect(credentials.server_url, credentials.participant_token)
        if (currentRoom.name !== credentials.room_name) {
          throw new Error('LiveKit connected to a different room than the token service created.')
        }
        await currentRoom.localParticipant.setMicrophoneEnabled(true)
        if (mounted) {
          if (currentRoom.remoteParticipants.size > 0) {
            setState('connected')
          } else {
            setState('waiting-agent')
            agentTimeoutRef.current = setTimeout(() => {
              if (mounted && currentRoom.remoteParticipants.size === 0) {
                setState('agent-missing')
              }
            }, 15000)
          }
        }
      } catch (connectError) {
        if (mounted && connectError.name !== 'AbortError') {
          await currentRoom?.disconnect()
          setError(connectError.message || 'Connection failed. Check that the ONEXA services are running.')
          setState('error')
        }
      }
    }

    connect()
    return () => {
      mounted = false
      abortController.abort()
      clearTimeout(agentTimeoutRef.current)
      currentRoom?.disconnect()
      roomRef.current = null
    }
  }, [participantName])

  async function toggleMicrophone() {
    const next = !micEnabled
    try {
      await roomRef.current?.localParticipant.setMicrophoneEnabled(next)
      setMicEnabled(next)
    } catch {
      setError('Could not change microphone access. Check your browser permissions.')
    }
  }

  async function leave() {
    await roomRef.current?.disconnect()
    setState('ended')
    onLeave()
  }

  const isLive = state === 'connected'
  const isWaiting = state === 'waiting-agent'
  const agentMissing = state === 'agent-missing'
  const lastTranscript = transcripts.at(-1)

  return (
    <main className="workspace">
      <header className="topbar">
        <a className="wordmark" href="#home" aria-label="ONEXA home"><span className="brand-mark">O</span> ONEXA</a>
        <div className="topbar-right"><span className="privacy-label"><ShieldCheck size={15} /> Private session</span><span className="avatar">{participantName[0]}</span></div>
      </header>

      <div className="workspace-grid">
        <aside className="sidebar">
          <div className="sidebar-label">WORKSPACE</div>
          <div className="side-current"><span className="side-dot" /> Voice assistant <span className="chevron">⌄</span></div>
          <div className="sidebar-rule" />
          <div className="sidebar-label">YOUR ONEXA</div>
          <div className="memory-card"><span className="memory-icon"><Sparkles size={16} /></span><div><b>Business memory</b><small>Coming in a future phase</small></div></div>
          <p className="sidebar-note">This session is not saved after you leave. ONEXA will be able to remember your work when its memory system is connected.</p>
          <div className="sidebar-bottom"><span className="online-dot" /> Preview UI <span className="version">LOCAL</span></div>
        </aside>

        <section className="main-panel" aria-live="polite">
          <div className="session-meta"><span className={`session-dot ${isLive ? 'active' : ''}`} />{state === 'connecting' ? 'Connecting securely' : isWaiting ? 'ROOM CONNECTED · WAITING FOR AGENT' : isLive ? 'VOICE SESSION' : agentMissing ? 'AGENT NOT CONNECTED' : state === 'error' ? 'CONNECTION ISSUE' : 'SESSION ENDED'}</div>
          <div className={`orb-wrap ${assistantSpeaking ? 'speaking' : ''}`}>
            <div className="orb-halo" /><div className="orb"><span className="orb-core" /><span className="orb-wave wave-one" /><span className="orb-wave wave-two" /><span className="orb-wave wave-three" /></div>
          </div>
          <h1>{state === 'connecting' ? 'Joining your space…' : isWaiting ? 'Connecting to ONEXA…' : isLive ? assistantSpeaking ? 'ONEXA is speaking' : 'I’m here, ' + participantName.split(' ')[0] : agentMissing ? 'ONEXA hasn’t joined yet' : state === 'error' ? 'Let’s get you connected' : 'Until next time'}</h1>
          <p className="subtitle">{state === 'connecting' ? 'Opening a private voice session' : isWaiting ? `Room connected. Waiting for ${agentTarget}.` : isLive ? assistantSpeaking ? 'Listening to your response is paused while I speak.' : 'Speak naturally. I’m listening.' : agentMissing ? `The browser joined the room, but ${agentTarget} did not. Check the worker deployment and dispatch target.` : state === 'error' ? error : 'Your conversation has ended.'}</p>

          <div className="live-caption" aria-live="polite">
            {lastTranscript ? <><span className="caption-speaker">{lastTranscript.speaker === 'you' ? 'YOU' : 'ONEXA'}</span><span>{lastTranscript.text}</span></> : <><Volume2 size={16} /><span>{isLive ? 'Your conversation will appear here' : 'Voice activity and transcription appear here'}</span></>}
          </div>

          {state === 'error' ? <div className="error-box"><b>Connection didn’t start</b><span>{error}</span><small>Start the Python agent and token service, then refresh this page.</small></div> : null}
          {agentMissing ? <div className="error-box"><b>Voice agent not connected</b><span>The room is open, but {agentTarget} did not join it.</span><small>Start the existing agent with <code>lk agent dev --deployment onexa-dev</code> and confirm it registers in the same LiveKit project.</small></div> : null}

          <div className="call-controls">
            <div className="control-spacer" />
            <button className={`mic-button ${!micEnabled ? 'muted' : ''}`} onClick={toggleMicrophone} disabled={!isLive} aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'} title={micEnabled ? 'Mute microphone' : 'Unmute microphone'}>{micEnabled ? <Mic size={22} /> : <MicOff size={22} />}</button>
            {isLive ? <button className="end-button" onClick={leave}><Phone size={17} /> End session</button> : <button className="end-button secondary" onClick={onLeave}><X size={17} /> Back</button>}
            <div className="control-spacer" />
          </div>
          <div className="control-hint">{isLive ? micEnabled ? 'Microphone on' : 'Microphone muted' : 'Browser microphone required'}</div>
          <div id="remote-audio" className="audio-output" />
        </section>

        <aside className="right-rail">
          <div className="rail-heading"><span>SESSION NOTES</span><span className="rail-count">01</span></div>
          <div className="note-card"><div className="note-icon"><Sparkles size={16} /></div><div><b>Business context</b><p>Share an idea, plan a project, or think through a decision with ONEXA.</p></div></div>
          <div className="note-card subtle"><div className="note-icon muted-icon"><ShieldCheck size={16} /></div><div><b>Session privacy</b><p>This call uses your existing LiveKit voice agent. Long-term recall is not active yet.</p></div></div>
          <div className="rail-footer">ONEXA · VOICE PREVIEW</div>
        </aside>
      </div>
    </main>
  )
}

function App() {
  const [participantName, setParticipantName] = useState(PEOPLE[0])
  const [inSession, setInSession] = useState(false)

  if (inSession) return <Conversation participantName={participantName} onLeave={() => setInSession(false)} />

  return (
    <main className="landing">
      <header className="landing-top"><a className="wordmark" href="#home"><span className="brand-mark">O</span> ONEXA</a><span className="preview-chip"><span /> PERSONAL AI · VOICE PREVIEW</span></header>
      <div className="landing-content">
        <div className="landing-copy">
          <div className="eyebrow"><span /> YOUR PERSONAL AI MANAGER</div>
          <h1>Make room for<br /><em>what matters.</em></h1>
          <p className="landing-description">A clear head for your biggest ideas. Talk through work, projects and plans with ONEXA, your voice-first AI assistant.</p>
          <div className="start-card">
            <label htmlFor="participant">START A PRIVATE SESSION</label>
            <div className="start-row"><div className="select-wrap"><span className="select-avatar">{participantName[0]}</span><select id="participant" value={participantName} onChange={(event) => setParticipantName(event.target.value)}>{PEOPLE.map((person) => <option key={person}>{person}</option>)}</select></div><button className="start-button" onClick={() => setInSession(true)}>Start talking <span>↗</span></button></div>
            <div className="secure-note"><ShieldCheck size={14} /> Your voice connects directly to your private LiveKit session.</div>
          </div>
          <div className="feature-row"><div><span className="feature-symbol">◉</span><b>Natural voice</b><small>Talk like you think</small></div><div><span className="feature-symbol">✳</span><b>Business-minded</b><small>Ideas to action</small></div><div><span className="feature-symbol">⌘</span><b>Built for two</b><small>Ali &amp; Hamza</small></div></div>
        </div>
        <div className="landing-visual" aria-hidden="true"><div className="visual-orbit orbit-a" /><div className="visual-orbit orbit-b" /><div className="visual-orbit orbit-c" /><div className="visual-orb"><div className="visual-glow" /><span className="visual-ripple ripple-a" /><span className="visual-ripple ripple-b" /><span className="visual-ripple ripple-c" /></div><div className="visual-label label-left"><span className="visual-point" /> READY WHEN YOU ARE</div><div className="visual-label label-right">THOUGHTFUL BY DESIGN <span className="visual-point" /></div><div className="visual-caption">A more considered way to work.<br /><span>One conversation at a time.</span></div></div>
      </div>
      <footer className="landing-footer"><span>DESIGNED FOR CLEARER THINKING</span><span>MADE FOR ALI &amp; HAMZA <i>·</i> 2026</span></footer>
    </main>
  )
}

export default App
