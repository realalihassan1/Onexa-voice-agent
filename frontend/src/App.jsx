import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, LockKeyhole, Mic, MicOff, Phone, Radio, Sparkles, Volume2 } from 'lucide-react'
import IntelligenceSphere from './IntelligenceSphere.jsx'
import './App.css'

const TOKEN_URL = import.meta.env.VITE_TOKEN_SERVER_URL || 'http://127.0.0.1:3000'
const PEOPLE = ['Ali Hassan', 'Hamza']
const MODE_LABELS = {
  idle: 'STANDBY',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'SPEAKING',
}

function reportPerformance(stage, durationMs) {
  if (import.meta.env.DEV && Number.isFinite(durationMs)) {
    console.debug(`[ONEXA latency] ${stage}: ${Math.round(durationMs)} ms`)
  }
}

function ONEXAStudioMark() {
  return <span className="studio-mark" aria-hidden="true"><span>O</span><i /></span>
}

function App() {
  const [participantName, setParticipantName] = useState(PEOPLE[0])
  const [inSession, setInSession] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const [connection, setConnection] = useState('idle')
  const [mode, setMode] = useState('idle')
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [transcripts, setTranscripts] = useState([])
  const [error, setError] = useState('')
  const [agentTarget, setAgentTarget] = useState('my-agent')
  const audioOutputRef = useRef(null)
  const roomRef = useRef(null)
  const audioLevelRef = useRef(0)
  const userSpokeRef = useRef(false)
  const sessionStartedAtRef = useRef(0)
  const speechStartedAtRef = useRef(0)
  const speechEndedAtRef = useRef(0)
  const firstUserTranscriptRef = useRef(false)
  const firstAgentTextRef = useRef(false)
  const firstAgentAudioRef = useRef(false)
  const firstPlayerPlaybackRef = useRef(false)
  const bootMeasuredRef = useRef(false)

  useEffect(() => {
    if (bootMeasuredRef.current) return
    bootMeasuredRef.current = true
    const navigation = performance.getEntriesByType('navigation')[0]
    const loadMs = navigation?.loadEventEnd ? navigation.loadEventEnd - navigation.startTime : performance.now()
    reportPerformance('page navigation to app ready', loadMs)
  }, [])

  useEffect(() => {
    if (!inSession) {
      return undefined
    }

    let mounted = true
    let currentRoom
    let agentTimeout
    let transcriptFlushTimer
    const pendingTranscripts = new Map()
    const abortController = new AbortController()

    function enqueueTranscript(entry) {
      pendingTranscripts.set(entry.id, entry)
      if (transcriptFlushTimer) return
      transcriptFlushTimer = setTimeout(() => {
        transcriptFlushTimer = 0
        if (!mounted || pendingTranscripts.size === 0) return
        const updates = [...pendingTranscripts.values()]
        pendingTranscripts.clear()
        setTranscripts((current) => {
          const next = [...current]
          for (const update of updates) {
            const index = next.findIndex((item) => item.id === update.id)
            if (index >= 0) next[index] = update
            else next.push(update)
          }
          return next.slice(-6)
        })
      }, 50)
    }

    async function connect() {
      const connectStartedAt = performance.now()
      setConnection('connecting')
      setMode('idle')
      setError('')
      setTranscripts([])
      userSpokeRef.current = false
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
        reportPerformance('token request', performance.now() - connectStartedAt)
        if (!mounted) return
        if (!credentials.room_name) throw new Error('The token service did not return a room name.')
        setAgentTarget(`${credentials.agent_name || 'my-agent'} · ${credentials.agent_deployment || 'unknown deployment'}`)

        currentRoom = new Room({ adaptiveStream: true, dynacast: true })
        roomRef.current = currentRoom
        const localRoom = currentRoom
        currentRoom.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio && audioOutputRef.current) {
            const audioElement = track.attach()
            audioElement.addEventListener('playing', () => {
              if (!firstPlayerPlaybackRef.current) {
                firstPlayerPlaybackRef.current = true
                reportPerformance('session start to audio playback started', performance.now() - sessionStartedAtRef.current)
              }
            })
            audioOutputRef.current.appendChild(audioElement)
          }
        })
        currentRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((element) => element.remove())
        })
        currentRoom.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
          if (mounted) setAudioBlocked(!playing)
        })
        currentRoom.on(RoomEvent.ParticipantConnected, (participant) => {
          if (participant.identity !== localRoom.localParticipant.identity) {
            clearTimeout(agentTimeout)
            if (mounted) {
              reportPerformance('session start to agent joined', performance.now() - sessionStartedAtRef.current)
              setConnection('connected')
              setMode('listening')
            }
          }
        })
        currentRoom.on(RoomEvent.ParticipantDisconnected, () => {
          if (mounted && localRoom.remoteParticipants.size === 0) {
            clearTimeout(agentTimeout)
            setConnection('agent-missing')
            setMode('idle')
            audioLevelRef.current = 0
          }
        })
        currentRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (!mounted) return
          const localIdentity = localRoom.localParticipant.identity
          const localSpeaker = speakers.find((speaker) => speaker.identity === localIdentity)
          const remoteSpeaker = speakers.find((speaker) => speaker.identity !== localIdentity)
          const level = Math.max(0, ...speakers.map((speaker) => speaker.audioLevel || 0))
          audioLevelRef.current = level

          if (remoteSpeaker && remoteSpeaker.audioLevel > 0.015) {
            if (!firstAgentAudioRef.current && speechEndedAtRef.current) {
              firstAgentAudioRef.current = true
              reportPerformance('user speech end to first remote audio activity', performance.now() - speechEndedAtRef.current)
            }
            userSpokeRef.current = false
            setConnection('connected')
            setMode('speaking')
          } else if (localSpeaker && localSpeaker.audioLevel > 0.012) {
            if (!userSpokeRef.current) {
              speechStartedAtRef.current = performance.now()
              speechEndedAtRef.current = 0
              firstUserTranscriptRef.current = false
              firstAgentTextRef.current = false
              firstAgentAudioRef.current = false
            }
            userSpokeRef.current = true
            setConnection('connected')
            setMode('listening')
          } else {
            audioLevelRef.current = 0
            if (userSpokeRef.current) {
              userSpokeRef.current = false
              speechEndedAtRef.current = performance.now()
              setMode('thinking')
            } else {
              setMode((currentMode) => currentMode === 'speaking' || currentMode === 'idle' ? 'listening' : currentMode)
            }
          }
        })
        currentRoom.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
          const attributes = reader.info?.attributes || {}
          const isTranscription = Boolean(attributes['lk.transcribed_track_id'])
          if (!isTranscription) return

          const speaker = participantInfo.identity === localRoom.localParticipant.identity ? 'you' : 'onexa'
          const id = attributes['lk.segment_id'] || `${speaker}-${performance.now()}`
          const final = attributes['lk.transcription_final'] === 'true'
          let text = ''
          try {
            for await (const chunk of reader) {
              text += chunk
              if (!mounted) break
              if (!text.trim()) continue
              const entry = { id, speaker, text: text.trim(), final }
              if (speaker === 'you' && !speechStartedAtRef.current) speechStartedAtRef.current = performance.now()
              if (speaker === 'you' && !firstUserTranscriptRef.current) {
                firstUserTranscriptRef.current = true
                reportPerformance('user speech start to live transcript', performance.now() - speechStartedAtRef.current)
              } else if (speaker === 'onexa' && !firstAgentTextRef.current && speechEndedAtRef.current) {
                firstAgentTextRef.current = true
                reportPerformance('user speech end to first response text', performance.now() - speechEndedAtRef.current)
              }
              enqueueTranscript(entry)
            }
          } catch (streamError) {
            if (import.meta.env.DEV) console.debug('[ONEXA] Transcription stream ended early.', streamError)
          }
        })
        currentRoom.on(RoomEvent.Disconnected, () => {
          if (mounted) {
            setConnection('ended')
            setMode('idle')
            audioLevelRef.current = 0
          }
        })

        await currentRoom.connect(credentials.server_url, credentials.participant_token)
        reportPerformance('token received to LiveKit connected', performance.now() - connectStartedAt)
        if (currentRoom.name !== credentials.room_name) {
          throw new Error('LiveKit connected to a different room than the token service created.')
        }
        await currentRoom.localParticipant.setMicrophoneEnabled(true)
        reportPerformance('session start to microphone ready', performance.now() - sessionStartedAtRef.current)
        if (!mounted) return
        if (currentRoom.remoteParticipants.size > 0) {
          setConnection('connected')
          setMode('listening')
        } else {
          setConnection('waiting-agent')
          setMode('listening')
          agentTimeout = setTimeout(() => {
            if (mounted && currentRoom.remoteParticipants.size === 0) setConnection('agent-missing')
          }, 15000)
        }
      } catch (connectError) {
        if (mounted && connectError.name !== 'AbortError') {
          await currentRoom?.disconnect()
          setError(connectError.message || 'Connection failed. Check that the ONEXA services are running.')
          setConnection('error')
          setMode('idle')
        }
      }
    }

    connect()
    return () => {
      mounted = false
      abortController.abort()
      clearTimeout(agentTimeout)
      clearTimeout(transcriptFlushTimer)
      pendingTranscripts.clear()
      currentRoom?.disconnect()
      roomRef.current = null
    }
  }, [inSession, participantName, retryVersion])

  async function toggleMicrophone() {
    const room = roomRef.current
    const next = !micEnabled
    try {
      await room?.localParticipant.setMicrophoneEnabled(next)
      setMicEnabled(next)
    } catch {
      setError('Could not change microphone access. Check your browser permissions.')
    }
  }

  async function enableAudio() {
    try {
      await roomRef.current?.startAudio()
      setAudioBlocked(false)
    } catch {
      setError('Browser audio is still blocked. Check this site’s sound permission and try again.')
    }
  }

  function beginSession() {
    sessionStartedAtRef.current = performance.now()
    speechStartedAtRef.current = 0
    speechEndedAtRef.current = 0
    firstUserTranscriptRef.current = false
    firstAgentTextRef.current = false
    firstAgentAudioRef.current = false
    firstPlayerPlaybackRef.current = false
    setMicEnabled(true)
    setConnection('connecting')
    setMode('idle')
    audioLevelRef.current = 0
    setError('')
    setAudioBlocked(false)
    if (inSession) setRetryVersion((version) => version + 1)
    else setInSession(true)
  }

  function endSession() {
    setInSession(false)
    setConnection('ended')
    setMode('idle')
    audioLevelRef.current = 0
  }

  const active = inSession && ['connecting', 'waiting-agent', 'connected'].includes(connection)
  const recoverable = inSession && ['agent-missing', 'error', 'ended'].includes(connection)
  const subtitle = connection === 'connecting'
    ? 'Opening a private intelligence channel'
    : audioBlocked
      ? 'Audio playback is paused. Enable speaker output to hear ONEXA.'
      : connection === 'waiting-agent'
      ? `Waiting for ${agentTarget} to join this room`
      : connection === 'agent-missing'
        ? `${agentTarget} did not join the room`
        : connection === 'error'
          ? error
          : mode === 'speaking'
            ? 'ONEXA is responding through your voice channel'
            : mode === 'thinking'
              ? 'Connecting your words with the right insight'
              : mode === 'listening'
                ? 'Speak naturally. ONEXA is listening.'
                : 'Your personal intelligence, ready when you are.'

  return (
    <main className="onexa-app">
      <div className="ambient ambient--left" />
      <div className="ambient ambient--right" />
      <header className="topbar">
        <a className="brand" href="#home" aria-label="ONEXA home"><ONEXAStudioMark /><span>ONEXA</span></a>
        <div className="brand-descriptor">PERSONALIZED INTELLIGENCE <span>·</span> OPI</div>
        <div className="topbar-right">
          <span className={`connection-pill ${connection === 'connected' ? 'is-connected' : ''}`}><i />{connection === 'connected' ? 'LIVE SESSION' : connection === 'waiting-agent' ? 'CONNECTING' : 'PRIVATE SESSION'}</span>
        </div>
      </header>

      <section className="experience" aria-live="polite">
        <div className="intro-copy">
          <div className="eyebrow"><span /> INTELLIGENCE WITH PURPOSE</div>
          <h1>Beyond<br /><em>what exists.</em></h1>
          <p>A more personal kind of intelligence. Talk through the ideas, decisions, and work that move you forward.</p>
          <div className="intro-index"><span>01</span><i /> OPI / VOICE SYSTEM</div>
        </div>

        <div className="sphere-stage">
          <div className="stage-ring stage-ring--outer" />
          <div className="stage-ring stage-ring--inner" />
          <div className="sphere-kicker"><Sparkles size={13} /> ONEXA INTELLIGENCE</div>
          <IntelligenceSphere mode={inSession ? mode : 'idle'} audioLevelRef={audioLevelRef} />
          <div className="sphere-caption"><span className="caption-line" /> OPI <span className="caption-dot">·</span> ONEXA PERSONALIZED INTELLIGENCE <span className="caption-line" /></div>
        </div>

        <aside className="session-aside">
          <div className="aside-label">SYSTEM STATE <span>01 / 01</span></div>
          <div className="state-readout"><span className={`state-beacon state-beacon--${mode}`} /><div><small>{inSession ? 'VOICE AGENT' : 'OPI SYSTEM'}</small><b>{inSession ? MODE_LABELS[mode] : 'STANDBY'}</b></div><Radio size={15} /></div>
          <p className="state-description">{subtitle}</p>
          <div className="aside-rule" />
          <div className="aside-label transcript-label">LIVE TRANSCRIPT <Volume2 size={13} /></div>
          {transcripts.length ? (
            <div className="transcript-list">
              {transcripts.slice(-3).map((item) => <div className={`transcript-entry transcript-entry--${item.speaker}`} key={item.id}><span>{item.speaker === 'you' ? 'YOU' : 'ONEXA'}</span><p>{item.text}</p></div>)}
            </div>
          ) : (
            <div className="transcript-empty"><span>—</span><p>{inSession ? 'Your conversation will appear here.' : 'Ideas become clearer when you say them out loud.'}</p></div>
          )}
          {connection === 'agent-missing' || connection === 'error' ? <div className="inline-error">{error || `Start the worker with the same deployment as ${agentTarget}.`}</div> : null}
        </aside>
      </section>

      <footer className="control-dock">
        <div className="dock-context"><LockKeyhole size={13} /><span>PRIVATE LIVEKIT ROOM</span></div>
        <div className="dock-actions">
          {active ? <>
            {audioBlocked ? <button className="session-button" onClick={enableAudio}><Volume2 size={16} /><span>ENABLE AUDIO</span></button> : null}
            <button className={`mic-control ${!micEnabled ? 'is-muted' : ''}`} onClick={toggleMicrophone} disabled={connection !== 'connected'} aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'} title={micEnabled ? 'Mute microphone' : 'Unmute microphone'}>{micEnabled ? <Mic size={18} /> : <MicOff size={18} />}</button>
            <button className="session-button session-button--end" onClick={endSession}><Phone size={16} /> END SESSION</button>
          </> : recoverable ? <>
            <button className="session-button session-button--end" onClick={endSession}>CLOSE</button>
            <button className="session-button" onClick={beginSession}><span className="button-orb" /><span>RETRY SESSION</span><ArrowUpRight size={16} /></button>
          </> : <>
            <label className="participant-select" htmlFor="participant-name"><span>SESSION FOR</span><select id="participant-name" value={participantName} onChange={(event) => setParticipantName(event.target.value)}>{PEOPLE.map((person) => <option key={person}>{person}</option>)}</select></label>
            <button className="session-button" onClick={beginSession}><span className="button-orb" /><span>START A SESSION</span><ArrowUpRight size={16} /></button>
          </>}
        </div>
        <div className="dock-note"><span className={`dock-indicator ${active ? 'is-active' : ''}`} /> {active ? connection === 'connected' ? 'AGENT CONNECTED' : connection === 'waiting-agent' ? 'JOINING ONEXA' : 'OPENING CHANNEL' : 'READY WHEN YOU ARE'}</div>
      </footer>
      <div className="session-error" aria-live="polite">{connection === 'agent-missing' ? `The room connected, but ${agentTarget} did not join. Confirm the worker is running with --deployment onexa-dev.` : ''}</div>
      <div ref={audioOutputRef} className="audio-output" />
    </main>
  )
}

export default App
