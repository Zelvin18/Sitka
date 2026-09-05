import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CaptureSource,
  SessionKind,
  SessionMeta,
  SessionNotes,
  TranscriptSegment
} from '@shared/types'
import ChatPane, { type ChatPaneHandle } from './ChatPane'
import AiText from './AiText'
import TranscriptPane from './TranscriptPane'
import NotesPane from './NotesPane'
import Splitter from './Splitter'
import QRCode from 'qrcode'
import { IconBroadcast, IconMic, IconScreen, IconSparkle, IconStar, IconStop } from '../lib/icons'
import { formatTime } from '../lib/format'
import { clamp, usePersistedNumber } from '../lib/persist'

const NOTES_INTERVAL_MS = 75000

const VIDEO_CHUNK_MS = 3000
const STT_CHUNK_MS = 5000
const MIN_AUDIO_BYTES = 4000

interface Props {
  hasChatKey: boolean
  hasSttKey: boolean
  onFinished: (sessionId: string) => void
  onCancel: () => void
  onOpenSettings: () => void
  onSessionCreated: (meta: SessionMeta) => void
  sessions: SessionMeta[]
  onOpenSessionAt: (sessionId: string, seconds?: number) => void
  /** preselects hosting mode linked to this event (from the Events page) */
  initialEventId?: string
  onGoEvents: (eventId?: string) => void
}

const NUDGE_INTERVAL_MS = 100000

type Phase = 'intent' | 'picking' | 'starting' | 'recording' | 'stopping'

const KIND_OPTIONS: { key: SessionKind; label: string; hint: string }[] = [
  { key: 'lecture', label: 'Lecture', hint: 'study focus' },
  { key: 'meeting', label: 'Meeting', hint: 'decisions & actions' },
  { key: 'presentation', label: 'Presentation', hint: 'key messages' },
  { key: 'other', label: 'Something else', hint: '' }
]

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ]
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? ''
}

export default function LiveSession({
  hasChatKey,
  hasSttKey,
  onFinished,
  onCancel,
  onOpenSettings,
  onSessionCreated,
  sessions,
  onOpenSessionAt,
  initialEventId,
  onGoEvents
}: Props): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('intent')
  const [hosting, setHosting] = useState(false)
  const [kind, setKind] = useState<SessionKind>('other')
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [micOn, setMicOn] = useState(true)
  const [systemAudioOn, setSystemAudioOn] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<SessionMeta | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [sttError, setSttError] = useState<string | null>(null)
  const [notes, setNotes] = useState<SessionNotes | null>(null)
  const [notesUpdating, setNotesUpdating] = useState(false)
  const [leftTab, setLeftTab] = useState<'transcript' | 'notes' | 'audience'>('transcript')
  const [chatW, setChatW] = usePersistedNumber('sitka.chatW', 440)
  const [videoH, setVideoH] = usePersistedNumber('sitka.videoH', 320)
  const [markToast, setMarkToast] = useState<string | null>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const videoWrapRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<ChatPaneHandle>(null)
  const lastCatchupRef = useRef(0)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [confUrl, setConfUrl] = useState<string | null>(null)
  const [qr, setQr] = useState<{ url: string; save?: boolean } | null>(null)
  const [qrData, setQrData] = useState<string | null>(null)
  const [upcoming, setUpcoming] = useState<{
    event: import('@shared/types').ScheduledEvent
    url?: string
  } | null>(null)
  const [availableEvents, setAvailableEvents] = useState<
    import('@shared/types').ScheduledEvent[]
  >([])
  const [agendaText, setAgendaText] = useState('')
  const [agendaList, setAgendaList] = useState<string[]>([])
  const [coverage, setCoverage] = useState<boolean[]>([])
  const [pulses, setPulses] = useState<{ at: number; text: string }[]>([])
  const prevQuestionTotalRef = useRef(0)
  const prevAttendeesRef = useRef(0)
  const prevCoverageRef = useRef<boolean[]>([])

  const addPulse = useCallback((text: string): void => {
    setPulses((prev) => [{ at: Date.now(), text }, ...prev].slice(0, 12))
  }, [])
  const [audience, setAudience] = useState<{
    attendees: number
    questions: { topic: string; items: { text: string; at: number; votes?: number }[] }[]
    reactions?: { landed: number; lost: number; recentLost: number }
    poll?: {
      id: string
      question: string
      options: string[]
      counts: number[]
      total: number
      status: 'open' | 'closed'
    }
  }>({ attendees: 0, questions: [] })
  const [pollQ, setPollQ] = useState('')
  const [pollOpts, setPollOpts] = useState('')
  const [pollErr, setPollErr] = useState<string | null>(null)
  const lastLostPulseRef = useRef(0)
  const [mind, setMind] = useState<{ topic: string; count: number }[]>([])
  const [recap, setRecap] = useState<{ topic: string; text: string } | null>(null)
  const [recapBusy, setRecapBusy] = useState(false)
  const [notePushed, setNotePushed] = useState(false)
  const [nudge, setNudge] = useState<string | null>(null)
  const nudgesShownRef = useRef<string[]>([])
  const nudgeBusyRef = useRef(false)
  const lastNudgeCountRef = useRef(0)
  const userQuestionsRef = useRef<string[]>([])

  const previewRef = useRef<HTMLVideoElement>(null)
  const previewStreamRef = useRef<MediaStream | null>(null)
  const streamsRef = useRef<MediaStream[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const sttRecorderRef = useRef<MediaRecorder | null>(null)
  const sttStreamRef = useRef<MediaStream | null>(null)
  const sttChunkStartRef = useRef(0)
  const sttTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionStartRef = useRef(0)
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve())
  const sessionIdRef = useRef<string | null>(null)
  const stoppingRef = useRef(false)
  const lastNotesCountRef = useRef(0)
  const notesBusyRef = useRef(false)
  const segmentsRef = useRef<TranscriptSegment[]>([])
  segmentsRef.current = segments

  // ---- source list ----
  const refreshSources = useCallback(async (): Promise<void> => {
    try {
      const list = await window.sitka.listSources()
      setSources(list)
      setSelectedSource((prev) => prev ?? list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null)
    } catch {
      setError('Could not list screens and windows.')
    }
  }, [])

  useEffect(() => {
    if (phase === 'picking') {
      void refreshSources()
      const t = setInterval(() => void refreshSources(), 4000)
      return () => clearInterval(t)
    }
    return undefined
  }, [phase, refreshSources])

  // ---- live audience hosting ----
  const openQr = useCallback(async (url: string, save = false): Promise<void> => {
    try {
      const data = await QRCode.toDataURL(url, {
        width: 280,
        margin: 1,
        color: { dark: '#1a1a1c', light: '#ffffff' }
      })
      setQrData(data)
    } catch {
      setQrData(null)
    }
    setQr({ url, save })
  }, [])

  const goLive = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current
    if (!id) return
    const res = await window.sitka.startConference(id)
    if (res.error || !res.url) {
      setError(res.error ?? 'Could not start the event server.')
      return
    }
    setConfUrl(res.url)
    setUpcoming(null)
    await openQr(res.url)
  }, [openQr])

  const stopHosting = useCallback(async (): Promise<void> => {
    await window.sitka.stopConference()
    setConfUrl(null)
    setQr(null)
    setAudience({ attendees: 0, questions: [] })
    setLeftTab((t) => (t === 'audience' ? 'transcript' : t))
  }, [])

  const selectEvent = useCallback(
    (event: import('@shared/types').ScheduledEvent | null, armedUrl?: string): void => {
      setUpcoming(event ? { event, url: armedUrl } : null)
      if (event?.agenda && event.agenda.length > 0) {
        setAgendaText(event.agenda.join('\n'))
      }
    },
    []
  )

  const loadEvents = useCallback(async (): Promise<void> => {
    const r = await window.sitka.listEvents()
    const open = r.events.filter((e) => !e.sessionId)
    setAvailableEvents(open)
    const armedUrl = r.status.running && r.status.waiting ? r.status.url : undefined
    const armedId = r.status.running && r.status.waiting ? r.status.eventId : undefined
    if (initialEventId) {
      const target = open.find((e) => e.id === initialEventId)
      if (target) selectEvent(target, armedId === target.id ? armedUrl : undefined)
    }
  }, [initialEventId, selectEvent])

  useEffect(() => {
    if (phase === 'intent' || phase === 'picking') void loadEvents()
  }, [phase, loadEvents])

  const eventLocked = Boolean(initialEventId)

  useEffect(() => {
    if (initialEventId) {
      setHosting(true)
      setKind('presentation')
      setPhase((p) => (p === 'intent' ? 'picking' : p))
    }
  }, [initialEventId])

  useEffect(() => {
    if (!confUrl) return undefined
    const refresh = (): void => {
      void window.sitka.conferenceStatus().then((s) => {
        if (!s.running) return
        const questions = s.questions ?? []
        const attendees = s.attendees ?? 0
        setAudience({ attendees, questions, reactions: s.reactions, poll: s.poll })
        // comprehension pulse: several people tapped "lost me" recently
        const recentLost = s.reactions?.recentLost ?? 0
        if (recentLost >= 3 && Date.now() - lastLostPulseRef.current > 180000) {
          lastLostPulseRef.current = Date.now()
          addPulse(`${recentLost} people say they're lost right now — a quick recap could help.`)
        }
        // ---- audience pulses ----
        const total = questions.reduce((n, g) => n + g.items.length, 0)
        if (total > prevQuestionTotalRef.current) {
          const topTopic = questions[0]?.topic
          addPulse(
            total - prevQuestionTotalRef.current === 1
              ? `New question for you${topTopic ? ` — about ${topTopic}` : ''}.`
              : `${total - prevQuestionTotalRef.current} new questions waiting.`
          )
        }
        prevQuestionTotalRef.current = total
        for (const milestone of [5, 10, 25, 50, 100, 250]) {
          if (attendees >= milestone && prevAttendeesRef.current < milestone) {
            addPulse(`${milestone} people are now with you.`)
          }
        }
        prevAttendeesRef.current = Math.max(prevAttendeesRef.current, attendees)
      })
    }
    refresh()
    const t = setInterval(refresh, 5000)
    const off = window.sitka.onConferenceUpdate(refresh)
    return () => {
      clearInterval(t)
      off()
    }
  }, [confUrl, addPulse])

  // ---- agenda coverage tracking (hosted, every 2 minutes) ----
  useEffect(() => {
    if (phase !== 'recording' || !hosting || !hasChatKey || agendaList.length === 0) {
      return undefined
    }
    const check = (): void => {
      const id = sessionIdRef.current
      if (!id || segmentsRef.current.length < 4) return
      void window.sitka.hostCoverage(id).then(({ covered }) => {
        if (covered.length !== agendaList.length) return
        covered.forEach((c, i) => {
          if (c && !prevCoverageRef.current[i]) {
            addPulse(`Covered: ${agendaList[i]} ✓`)
          }
        })
        prevCoverageRef.current = covered
        setCoverage(covered)
      })
    }
    const t = setInterval(check, 120000)
    const first = setTimeout(check, 45000)
    return () => {
      clearInterval(t)
      clearTimeout(first)
    }
  }, [phase, hosting, hasChatKey, agendaList, addPulse])

  // ---- Room's Mind: cluster the audience's private questions (every 2 min) ----
  useEffect(() => {
    if (phase !== 'recording' || !hosting || !confUrl || !hasChatKey) return undefined
    const check = (): void => {
      const id = sessionIdRef.current
      if (!id) return
      void window.sitka.roomMind(id).then((r) => setMind(r.themes ?? []))
    }
    const t = setInterval(check, 120000)
    const first = setTimeout(check, 60000)
    return () => {
      clearInterval(t)
      clearTimeout(first)
    }
  }, [phase, hosting, confUrl, hasChatKey])

  // ---- marks (global hotkey + button) ----
  useEffect(() => {
    const off = window.sitka.onSessionMarked(({ sessionId, time }) => {
      if (sessionId !== sessionIdRef.current) return
      setMarkToast(`⭐ Marked at ${formatTime(time)}`)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      toastTimerRef.current = setTimeout(() => setMarkToast(null), 2500)
    })
    return () => {
      off()
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  const catchMeUp = useCallback((): void => {
    const since = lastCatchupRef.current
    const nowSec = Math.floor((Date.now() - sessionStartRef.current) / 1000)
    lastCatchupRef.current = nowSec
    const scope =
      since > 30 ? `since [${formatTime(since)}]` : 'so far in this session'
    chatRef.current?.ask(
      `Catch me up: in a few short bullets, what happened ${scope}? End with one line on what is being discussed right now.`
    )
  }, [])

  // ---- proactive nudges ----
  const onChatPersist = useCallback((messages: Parameters<typeof window.sitka.saveChat>[1]): void => {
    const id = sessionIdRef.current
    if (id) void window.sitka.saveChat(id, messages)
    userQuestionsRef.current = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .slice(-5)
  }, [])

  useEffect(() => {
    if (phase !== 'recording' || !hasChatKey || hosting) return undefined
    const t = setInterval(() => {
      const id = sessionIdRef.current
      if (!id || nudgeBusyRef.current) return
      const count = segmentsRef.current.length
      if (count < 6 || count === lastNudgeCountRef.current) return
      lastNudgeCountRef.current = count
      nudgeBusyRef.current = true
      void window.sitka
        .checkNudge(id, userQuestionsRef.current, nudgesShownRef.current.slice(-6))
        .then((res) => {
          if (res.nudge && !nudgesShownRef.current.includes(res.nudge)) {
            nudgesShownRef.current.push(res.nudge)
            setNudge(res.nudge)
          }
        })
        .finally(() => {
          nudgeBusyRef.current = false
        })
    }, NUDGE_INTERVAL_MS)
    return () => clearInterval(t)
  }, [phase, hasChatKey, hosting])

  // ---- live notes ----
  const refreshNotes = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current
    if (!id || notesBusyRef.current) return
    const count = segmentsRef.current.length
    if (count === 0 || count === lastNotesCountRef.current) return
    notesBusyRef.current = true
    setNotesUpdating(true)
    try {
      const res = await window.sitka.updateNotes(id)
      if (res.notes) {
        setNotes(res.notes)
        lastNotesCountRef.current = count
      }
    } finally {
      notesBusyRef.current = false
      setNotesUpdating(false)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'recording' || !hasChatKey) return undefined
    const t = setInterval(() => void refreshNotes(), NOTES_INTERVAL_MS)
    return () => clearInterval(t)
  }, [phase, hasChatKey, refreshNotes])

  // Kick off the first notes pass as soon as there is something to write about.
  useEffect(() => {
    if (
      phase === 'recording' &&
      hasChatKey &&
      segments.length >= 3 &&
      lastNotesCountRef.current === 0
    ) {
      void refreshNotes()
    }
  }, [phase, hasChatKey, segments.length, refreshNotes])

  // Capture the current screen frame as a JPEG data URL for vision questions.
  const getFrame = useCallback((): string | null => {
    const v = previewRef.current
    if (!v || v.videoWidth === 0) return null
    const maxW = 1280
    const scale = Math.min(1, maxW / v.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    try {
      return canvas.toDataURL('image/jpeg', 0.7)
    } catch {
      return null
    }
  }, [])

  // ---- live stage view: mirror the screen to attendee phones every 2s ----
  useEffect(() => {
    if (phase !== 'recording' || !hosting || !confUrl) return undefined
    const t = setInterval(() => {
      const frame = getFrame()
      if (frame) void window.sitka.pushStageFrame(frame)
    }, 2000)
    return () => clearInterval(t)
  }, [phase, hosting, confUrl, getFrame])

  // Attach the live preview stream once the recording view has mounted.
  useEffect(() => {
    if (phase === 'recording' && previewRef.current && previewStreamRef.current) {
      previewRef.current.srcObject = previewStreamRef.current
      void previewRef.current.play().catch(() => undefined)
    }
  }, [phase])

  // ---- teardown on unmount ----
  useEffect(() => {
    return () => {
      if (sttTimerRef.current) clearInterval(sttTimerRef.current)
      if (clockTimerRef.current) clearInterval(clockTimerRef.current)
      try {
        recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop()
      } catch {
        /* noop */
      }
      try {
        sttRecorderRef.current?.state !== 'inactive' && sttRecorderRef.current?.stop()
      } catch {
        /* noop */
      }
      streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      void audioCtxRef.current?.close().catch(() => undefined)
    }
  }, [])

  const enqueueAppend = useCallback((blob: Blob): void => {
    const id = sessionIdRef.current
    if (!id) return
    appendQueueRef.current = appendQueueRef.current.then(async () => {
      const buf = await blob.arrayBuffer()
      await window.sitka.appendChunk(id, buf)
    })
  }, [])

  const transcribeBlob = useCallback(async (blob: Blob, offsetSec: number): Promise<void> => {
    const id = sessionIdRef.current
    if (!id || blob.size < MIN_AUDIO_BYTES) return
    const buf = await blob.arrayBuffer()
    const result = await window.sitka.transcribeChunk(id, buf, offsetSec)
    if (result.error) {
      if (result.error !== 'missing-key') setSttError(result.error)
      return
    }
    if (result.segments && result.segments.length > 0) {
      setSttError(null)
      setSegments((prev) =>
        [...prev, ...result.segments!].sort((a, b) => a.start - b.start)
      )
    }
  }, [])

  const startSttRecorder = useCallback((): void => {
    const stream = sttStreamRef.current
    if (!stream || stream.getAudioTracks().length === 0) return
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    const chunkStart = Date.now()
    sttChunkStartRef.current = chunkStart
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        void transcribeBlob(e.data, (chunkStart - sessionStartRef.current) / 1000)
      }
    }
    rec.start()
    sttRecorderRef.current = rec
  }, [transcribeBlob])

  const rotateStt = useCallback((): void => {
    const rec = sttRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => {
        if (!stoppingRef.current) startSttRecorder()
      }
      rec.stop()
    }
  }, [startSttRecorder])

  // ---- start recording ----
  const start = useCallback(async (): Promise<void> => {
    if (!selectedSource) return
    setPhase('starting')
    setError(null)
    try {
      const agenda = agendaText
        .split('\n')
        .map((l) => l.trim().replace(/^[-•\d.)\s]+/, '').trim())
        .filter(Boolean)
        .slice(0, 12)
      setAgendaList(agenda)
      prevCoverageRef.current = agenda.map(() => false)
      const meta = await window.sitka.createSession(
        upcoming?.event.title && hosting
          ? upcoming.event.title
          : `Session — ${new Date().toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })}`,
        kind,
        hosting,
        hosting ? agenda : undefined,
        hosting ? upcoming?.event.id : undefined
      )
      setSession(meta)
      sessionIdRef.current = meta.id
      onSessionCreated(meta)

      // Screen (+ optional system audio). chromeMediaSource constraints are
      // Electron-specific; on the web build the browser shows its own picker.
      const isWeb = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true
      const md = navigator.mediaDevices as unknown as {
        getUserMedia: (c: unknown) => Promise<MediaStream>
      }
      let desktopStream: MediaStream
      if (isWeb) {
        desktopStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 15 },
          audio: systemAudioOn
        })
      } else {
        try {
          desktopStream = await md.getUserMedia({
            audio: systemAudioOn ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: selectedSource,
                maxFrameRate: 15
              }
            }
          })
        } catch {
          // System audio loopback can fail (e.g. window capture) — retry video-only.
          desktopStream = await md.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: selectedSource,
                maxFrameRate: 15
              }
            }
          })
        }
      }
      streamsRef.current.push(desktopStream)

      let micStream: MediaStream | null = null
      if (micOn) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true }
          })
          streamsRef.current.push(micStream)
        } catch {
          micStream = null
        }
      }

      // Mix desktop audio + mic into one track.
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const dest = audioCtx.createMediaStreamDestination()
      let audioInputs = 0
      for (const s of [desktopStream, micStream]) {
        if (s && s.getAudioTracks().length > 0) {
          audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest)
          audioInputs++
        }
      }

      const recordTracks: MediaStreamTrack[] = [...desktopStream.getVideoTracks()]
      if (audioInputs > 0) recordTracks.push(...dest.stream.getAudioTracks())
      const recordStream = new MediaStream(recordTracks)

      // The preview <video> only mounts once phase becomes 'recording'; stash
      // the stream so the effect below can attach it after mount.
      previewStreamRef.current = new MediaStream(desktopStream.getVideoTracks())

      sessionStartRef.current = Date.now()
      stoppingRef.current = false

      const recorder = new MediaRecorder(recordStream, { mimeType: pickMimeType() })
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) enqueueAppend(e.data)
      }
      recorder.start(VIDEO_CHUNK_MS)
      recorderRef.current = recorder

      if (audioInputs > 0 && hasSttKey) {
        sttStreamRef.current = dest.stream
        startSttRecorder()
        sttTimerRef.current = setInterval(rotateStt, STT_CHUNK_MS)
      }

      clockTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - sessionStartRef.current) / 1000))
      }, 1000)

      // Arms the global Ctrl+Shift+M "mark this" hotkey.
      void window.sitka.setRecordingState({
        id: meta.id,
        startedAt: sessionStartRef.current
      })

      setPhase('recording')

      // Hosted events broadcast immediately — the QR is the first thing shown.
      if (hosting) {
        void goLive().then(() => setLeftTab('audience'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('picking')
    }
  }, [selectedSource, systemAudioOn, micOn, hasSttKey, kind, hosting, agendaText, upcoming, goLive, enqueueAppend, startSttRecorder, rotateStt, onSessionCreated])

  // ---- stop recording ----
  const stop = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current
    if (!id || stoppingRef.current) return
    stoppingRef.current = true
    setPhase('stopping')
    void window.sitka.setRecordingState(null)

    if (sttTimerRef.current) clearInterval(sttTimerRef.current)
    if (clockTimerRef.current) clearInterval(clockTimerRef.current)

    // Flush final STT chunk.
    const sttRec = sttRecorderRef.current
    if (sttRec && sttRec.state !== 'inactive') {
      sttRec.onstop = null
      sttRec.stop()
    }

    // Stop the main recorder and wait for its final chunk.
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        recorder.stop()
      })
    }
    await appendQueueRef.current

    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    streamsRef.current = []
    await audioCtxRef.current?.close().catch(() => undefined)
    audioCtxRef.current = null

    const durationMs = Date.now() - sessionStartRef.current
    await window.sitka.finalizeSession(id, durationMs)
    onFinished(id)
  }, [onFinished])

  const seekTranscript = useCallback((seconds: number): void => {
    const rows = document.querySelectorAll<HTMLElement>('[data-seg-start]')
    for (const row of rows) {
      if (Number(row.dataset.segStart) >= seconds) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' })
        break
      }
    }
  }, [])

  const dialogs = (
    <>
      {qr && (
        <div className="dialog-overlay" onMouseDown={() => setQr(null)}>
          <div
            className="dialog"
            style={{ width: 380, textAlign: 'center' }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="dialog-title" style={{ fontSize: 17 }}>
              Scan to join with your phone
            </div>
            <div className="dialog-message" style={{ marginBottom: 12 }}>
              {qr.save
                ? 'Share or print this code ahead of time. Early scanners see a waiting page and connect automatically the moment you go live. Valid while this computer stays on the same Wi-Fi.'
                : 'Anyone on this Wi-Fi gets their own AI companion for this session — live transcript, private questions, and a take-home pack.'}
            </div>
            {qrData && (
              <img
                src={qrData}
                alt="Join QR code"
                style={{
                  width: 240,
                  height: 240,
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: '#fff',
                  padding: 8
                }}
              />
            )}
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 13,
                color: 'var(--text-2)',
                margin: '12px 0 16px',
                userSelect: 'text'
              }}
            >
              {qr.url}
            </div>
            <div className="dialog-actions" style={{ justifyContent: 'center' }}>
              {qr.save && qrData && (
                <button
                  className="btn"
                  onClick={() =>
                    void window.sitka.saveQr(qrData, upcoming?.event.title ?? 'event')
                  }
                >
                  Save QR image…
                </button>
              )}
              <button className="btn btn-primary" onClick={() => setQr(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  // ============ intent UI ============
  if (phase === 'intent') {
    return (
      <div className="content">
        <div className="content-inner" style={{ maxWidth: 780 }}>
          <button className="btn btn-ghost btn-sm page-back" onClick={onCancel}>
            ‹ Back
          </button>
          <h1 className="page-title">New live session</h1>
          <p className="page-subtitle">What are you doing today?</p>

          <div className="intent-grid">
            <button
              className="intent-card"
              onClick={() => {
                setHosting(false)
                setPhase('picking')
              }}
            >
              <span className="intent-art">
                <span className="art-line" style={{ width: '70%' }} />
                <span className="art-line" style={{ width: '52%' }} />
                <span className="art-line" style={{ width: '62%' }} />
                <span className="art-bubble">Ask Sitka anything…</span>
              </span>
              <span className="intent-title">
                <IconScreen size={17} /> Just for me
              </span>
              <span className="intent-desc">
                I'm attending a lecture, meeting, or event — capture it privately.
              </span>
              <span className="intent-feats">
                <span>Live transcript & notes</span>
                <span>My own AI, jump to any moment</span>
                <span>Study pack & highlight reel</span>
              </span>
              <span className="intent-go">Start →</span>
            </button>
            <button
              className="intent-card"
              onClick={() => {
                setHosting(true)
                setPhase('picking')
              }}
            >
              <span className="intent-art">
                <span className="art-qr">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <span key={i} className={i % 2 === 0 ? 'on' : ''} />
                  ))}
                </span>
                <span className="art-pulse" />
              </span>
              <span className="intent-title">
                <IconBroadcast size={17} /> Host for an audience
                {availableEvents.length > 0 && (
                  <span className="intent-badge">
                    {availableEvents.length} scheduled
                  </span>
                )}
              </span>
              <span className="intent-desc">
                I'm presenting or teaching — the room joins me by QR code.
              </span>
              <span className="intent-feats">
                <span>Personal AI for every attendee</span>
                <span>Smart questions & audience insight</span>
                <span>Take-home pack in their language</span>
              </span>
              <span className="intent-go">Set up →</span>
            </button>
          </div>
        </div>
        {dialogs}
      </div>
    )
  }

  // ============ picking UI ============
  if (phase === 'picking' || phase === 'starting') {
    return (
      <div className="content">
        <div className="content-inner">
          <button
            className="btn btn-ghost btn-sm page-back"
            onClick={() => (eventLocked ? onGoEvents(initialEventId) : setPhase('intent'))}
            disabled={phase === 'starting'}
          >
            {eventLocked ? '‹ Event dashboard' : '‹ Back'}
          </button>
          <h1 className="page-title">
            {eventLocked
              ? `Launch — ${upcoming?.event.title ?? 'your event'}`
              : hosting
                ? 'Host a live event'
                : 'New live session'}
          </h1>
          <p className="page-subtitle">
            {eventLocked
              ? 'Choose what your audience will follow. The QR you shared goes live the moment you start.'
              : hosting
                ? 'Choose what to capture and share with your audience. The join QR code appears as soon as you start.'
                : 'Choose what Sitka should watch. It will capture the screen and audio, and understand the session as it happens.'}
          </p>

          {error && (
            <div className="notice notice-error">
              <span>{error}</span>
            </div>
          )}
          {!hasSttKey && (
            <div className="notice">
              <span>
                <strong>Transcription is off.</strong> Add an OpenAI key — or a free
                Groq key — in{' '}
                <span className="link" onClick={onOpenSettings}>
                  Settings
                </span>{' '}
                so Sitka can understand what is being said. You can still record without
                it.
              </span>
            </div>
          )}

          {hosting && eventLocked && (
            <div className="card-soft" style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 4 }}>
              <span className="ev-date" style={{ width: 34, height: 34 }}>
                <IconBroadcast size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{upcoming?.event.title ?? 'Your event'}</div>
                <div className="field-hint">
                  {(upcoming?.event.materials?.length ?? 0) > 0
                    ? `AI briefed with ${upcoming!.event.materials!.length} material${upcoming!.event.materials!.length > 1 ? 's' : ''} · `
                    : ''}
                  the QR you shared stays valid — waiting phones connect automatically.
                </div>
              </div>
            </div>
          )}
          {hosting && !eventLocked && (
            <>
              <div className="section-title">Event</div>
              <div className="card-soft" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  className="input"
                  style={{ flex: 1, minWidth: 220 }}
                  value={upcoming?.event.id ?? ''}
                  onChange={(e) => {
                    const ev = availableEvents.find((x) => x.id === e.target.value) ?? null
                    selectEvent(ev)
                  }}
                >
                  <option value="">Quick event (no preparation)</option>
                  {availableEvents.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                      {e.startsAt
                        ? ` — ${new Date(e.startsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                        : ''}
                    </option>
                  ))}
                </select>
                <span className="field-hint" style={{ flexBasis: '100%' }}>
                  {upcoming
                    ? 'Going live activates the QR already shared for this event, with its materials briefing the AI.'
                    : (
                        <>
                          Prepared events carry documents, an early QR, and a briefed AI —{' '}
                          <span className="link" onClick={onGoEvents}>
                            manage events
                          </span>
                          .
                        </>
                      )}
                </span>
              </div>
            </>
          )}

          {hosting && (
            <>
              <div className="section-title">Planned topics (optional)</div>
              <textarea
                className="textarea"
                rows={4}
                placeholder={
                  'One topic per line — Sitka ticks them off live and flags what you haven’t covered.\ne.g.\nWhy limits matter\nThe formal definition\nWorked example'
                }
                value={agendaText}
                onChange={(e) => setAgendaText(e.target.value)}
                spellCheck={false}
              />
            </>
          )}

          {!eventLocked && (
            <>
              <div className="section-title">This is a…</div>
              <div className="kind-row">
                {KIND_OPTIONS.map((k) => (
                  <button
                    key={k.key}
                    className={`kind-chip${kind === k.key ? ' sel' : ''}`}
                    onClick={() => setKind(k.key)}
                  >
                    {k.label}
                    {k.hint && <span className="kind-hint">{k.hint}</span>}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="section-title">Capture</div>
          <div className="source-grid">
            {sources.map((s) => (
              <button
                key={s.id}
                className={`source-tile${selectedSource === s.id ? ' selected' : ''}`}
                onClick={() => setSelectedSource(s.id)}
              >
                <img className="source-thumb" src={s.thumbnail} alt="" />
                <div className="source-name">
                  {s.kind === 'screen' ? '🖥 ' : ''}
                  {s.name}
                </div>
              </button>
            ))}
          </div>

          <div className="section-title">Audio</div>
          <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <div className="toggle-row">
              <div>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <IconScreen size={14} /> System audio
                </div>
                <div className="field-hint">
                  What you hear — the speaker in a call, a video, the lecture audio.
                </div>
              </div>
              <button
                className={`switch${systemAudioOn ? ' on' : ''}`}
                onClick={() => setSystemAudioOn((v) => !v)}
                aria-label="Toggle system audio"
              />
            </div>
            <div className="toggle-row">
              <div>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <IconMic size={14} /> Microphone
                </div>
                <div className="field-hint">
                  Your own voice — useful for in-person lectures and meetings.
                </div>
              </div>
              <button
                className={`switch${micOn ? ' on' : ''}`}
                onClick={() => setMicOn((v) => !v)}
                aria-label="Toggle microphone"
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
            <button
              className="btn btn-primary btn-lg"
              disabled={!selectedSource || phase === 'starting'}
              onClick={() => void start()}
            >
              {phase === 'starting' ? (
                'Starting…'
              ) : eventLocked ? (
                <>
                  <IconBroadcast size={15} strokeWidth={2} /> Launch event
                </>
              ) : hosting ? (
                'Start & show QR'
              ) : (
                'Start session'
              )}
            </button>
          </div>
        </div>
        {dialogs}
      </div>
    )
  }

  // ============ recording UI ============
  return (
    <div className="session-layout" ref={layoutRef}>
      <div className="session-left">
        <div className="session-header">
          <div className="session-header-row">
            <h1>{session?.title ?? 'Live session'}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {hosting &&
                (confUrl ? (
                  <button
                    className="btn btn-sm"
                    title="Show the join QR code"
                    onClick={() => void openQr(confUrl)}
                  >
                    <IconBroadcast size={13} />
                    {audience.attendees} live
                  </button>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Start broadcasting to the room"
                    onClick={() => void goLive()}
                  >
                    <IconBroadcast size={13} />
                    Go live
                  </button>
                ))}
              <button
                className="btn btn-ghost btn-sm"
                title="Pin this moment (works anywhere: Ctrl+Shift+M)"
                onClick={() => void window.sitka.markNow()}
              >
                <IconStar size={13} />
                Mark
              </button>
              {hasChatKey && !hosting && (
                <button
                  className="btn btn-ghost btn-sm"
                  title="Summarize what you missed"
                  onClick={catchMeUp}
                >
                  <IconSparkle size={13} />
                  Catch me up
                </button>
              )}
              <span className="live-badge">● REC</span>
              <span className="timer">{formatTime(elapsed)}</span>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void stop()}
                disabled={phase === 'stopping'}
              >
                <IconStop size={13} strokeWidth={2.4} />
                {phase === 'stopping' ? 'Finishing…' : 'End session'}
              </button>
            </div>
          </div>
        </div>
        <div
          className="video-wrap"
          ref={videoWrapRef}
          style={{ height: hosting ? 130 : clamp(videoH, 140, 900) }}
        >
          <video ref={previewRef} autoPlay muted playsInline />
        </div>
        {!hosting && (
          <Splitter
            direction="horizontal"
            onMove={(_x, y) => {
              const top = videoWrapRef.current?.getBoundingClientRect().top
              if (top === undefined) return
              setVideoH(clamp(y - top, 140, Math.round(window.innerHeight * 0.75)))
            }}
            onReset={() => setVideoH(320)}
          />
        )}
        {sttError && (
          <div className="notice notice-error" style={{ margin: '12px 20px 0' }}>
            <span>Transcription issue: {sttError}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0' }}>
          <button
            className={`btn btn-sm ${leftTab === 'transcript' ? '' : 'btn-ghost'}`}
            onClick={() => setLeftTab('transcript')}
          >
            Transcript
          </button>
          <button
            className={`btn btn-sm ${leftTab === 'notes' ? '' : 'btn-ghost'}`}
            onClick={() => setLeftTab('notes')}
          >
            Notes
            {notes && notes.moments.length > 0 ? ` · ${notes.moments.length}` : ''}
          </button>
          {confUrl && (
            <button
              className={`btn btn-sm ${leftTab === 'audience' ? '' : 'btn-ghost'}`}
              onClick={() => setLeftTab('audience')}
            >
              Console
              {audience.questions.length > 0
                ? ` · ${audience.questions.reduce((n, g) => n + g.items.length, 0)}`
                : ''}
            </button>
          )}
        </div>
        {leftTab === 'audience' && confUrl ? (
          <div className="transcript">
            <div className="console-stats">
              <div className="console-stat">
                <div className="console-value">{audience.attendees}</div>
                <div className="console-label">with you now</div>
              </div>
              <div className="console-stat">
                <div className="console-value">
                  {audience.questions.reduce((n, g) => n + g.items.length, 0)}
                </div>
                <div className="console-label">questions waiting</div>
              </div>
              <div className="console-stat console-actions">
                <button className="btn btn-sm" onClick={() => void openQr(confUrl)}>
                  Show QR
                </button>
                {confUrl.includes('/e/') && (
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Open the big-screen view for the venue projector"
                    onClick={() => window.open(confUrl.replace('/e/', '/s/'), '_blank')}
                  >
                    Stage screen
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => void stopHosting()}>
                  Stop
                </button>
              </div>
            </div>

            {audience.reactions &&
              (audience.reactions.landed > 0 || audience.reactions.lost > 0) && (
                <div className="react-strip">
                  <span className="react-pill">Landed · {audience.reactions.landed}</span>
                  <span
                    className={`react-pill${(audience.reactions.recentLost ?? 0) >= 3 ? ' hot' : ''}`}
                  >
                    Lost me · {audience.reactions.lost}
                  </span>
                </div>
              )}

            {mind.length > 0 && (
              <>
                <div className="section-title">The room's mind</div>
                <div className="mind-card">
                  <div className="mind-hint">
                    What the audience is privately asking about right now:
                  </div>
                  {mind.map((t) => (
                    <div key={t.topic} className="mind-row">
                      <span className="mind-topic">{t.topic}</span>
                      <span className="duration-chip">{t.count}</span>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={recapBusy}
                        onClick={() => {
                          setRecapBusy(true)
                          setRecap(null)
                          setNotePushed(false)
                          void window.sitka
                            .roomRecap(sessionIdRef.current ?? '', t.topic)
                            .then((r) => {
                              setRecapBusy(false)
                              if (r.text) setRecap({ topic: t.topic, text: r.text })
                            })
                        }}
                      >
                        {recapBusy ? '…' : 'Recap'}
                      </button>
                    </div>
                  ))}
                  {recap && (
                    <div className="mind-recap">
                      <div className="mind-recap-text">{recap.text}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button
                          className="btn btn-sm"
                          disabled={notePushed}
                          onClick={() => {
                            void window.sitka.pushRoomNote(recap.text).then((r) => {
                              if (!r.error) setNotePushed(true)
                            })
                          }}
                        >
                          {notePushed ? 'Sent to every phone ✓' : 'Send to every phone'}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setRecap(null)}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="section-title">Live poll</div>
            {audience.poll && (
              <div className="poll-card">
                <div className="poll-q">{audience.poll.question}</div>
                {audience.poll.options.map((o, i) => {
                  const count = audience.poll!.counts[i] ?? 0
                  const pct =
                    audience.poll!.total > 0
                      ? Math.round((count / audience.poll!.total) * 100)
                      : 0
                  return (
                    <div key={i} className="poll-row">
                      <div className="poll-bar" style={{ width: `${Math.max(4, pct)}%` }} />
                      <span className="poll-opt">{o}</span>
                      <span className="poll-count">
                        {count} · {pct}%
                      </span>
                    </div>
                  )
                })}
                <div className="poll-foot">
                  <span>
                    {audience.poll.total} vote{audience.poll.total === 1 ? '' : 's'} ·{' '}
                    {audience.poll.status === 'open' ? 'live on every phone' : 'closed'}
                  </span>
                  {audience.poll.status === 'open' && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => void window.sitka.closePoll()}
                    >
                      Close poll
                    </button>
                  )}
                </div>
              </div>
            )}
            {(!audience.poll || audience.poll.status === 'closed') && (
              <div className="poll-compose">
                <input
                  className="input"
                  placeholder="Ask the room a question…"
                  value={pollQ}
                  onChange={(e) => setPollQ(e.target.value)}
                />
                <input
                  className="input"
                  placeholder="Options, separated by commas (e.g. Yes, No, Not sure)"
                  value={pollOpts}
                  onChange={(e) => setPollOpts(e.target.value)}
                />
                {pollErr && (
                  <div className="field-hint" style={{ color: 'var(--danger)' }}>
                    {pollErr}
                  </div>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void window.sitka.launchPoll(pollQ, pollOpts.split(',')).then((r) => {
                      if (r.error) setPollErr(r.error)
                      else {
                        setPollErr(null)
                        setPollQ('')
                        setPollOpts('')
                      }
                    })
                  }
                >
                  Launch poll
                </button>
              </div>
            )}

            {agendaList.length > 0 && (
              <>
                <div className="section-title">Your plan</div>
                <div className="agenda-list">
                  {agendaList.map((topic, i) => (
                    <div key={i} className={`agenda-item${coverage[i] ? ' done' : ''}`}>
                      <span className="agenda-tick">{coverage[i] ? '✓' : ''}</span>
                      {topic}
                    </div>
                  ))}
                </div>
              </>
            )}

            {pulses.length > 0 && (
              <>
                <div className="section-title">Pulse</div>
                {pulses.map((p, i) => (
                  <div key={`${p.at}-${i}`} className="pulse-row">
                    <span className="pulse-time">
                      {new Date(p.at).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </span>
                    {p.text}
                  </div>
                ))}
              </>
            )}

            <div className="section-title">Questions for you</div>
            {audience.questions.length === 0 && (
              <div className="transcript-waiting">Nothing yet — they'll appear here.</div>
            )}
            {audience.questions.map((g) => (
              <div key={g.topic} className="qgroup">
                <div className="qgroup-head">
                  {g.topic}
                  <span className="duration-chip">{g.items.length}</span>
                </div>
                {g.items.map((q, i) => (
                  <div key={i} className="qgroup-item">
                    {(q.votes ?? 0) > 0 && (
                      <span className="vote-chip" title="Attendee upvotes">
                        ▲ {q.votes}
                      </span>
                    )}
                    {q.text}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : leftTab === 'transcript' ? (
          <TranscriptPane
            segments={segments}
            followLive
            transcribing={hasSttKey}
            emptyText={
              hasSttKey
                ? 'Waiting for speech…'
                : 'Transcription is off — add an OpenAI or Groq key in Settings.'
            }
            onSeek={seekTranscript}
          />
        ) : (
          <NotesPane
            notes={notes}
            onSeek={seekTranscript}
            updating={notesUpdating}
            emptyText={
              hasChatKey
                ? 'Notes appear a minute or two into the session and keep updating.'
                : 'Add an AI key in Settings to enable live notes.'
            }
          />
        )}
      </div>
      <Splitter
        direction="vertical"
        onMove={(x) => {
          const rect = layoutRef.current?.getBoundingClientRect()
          if (!rect) return
          setChatW(clamp(rect.right - x, 300, Math.max(320, rect.width - 420)))
        }}
        onReset={() => setChatW(440)}
      />
      {markToast && <div className="toast fade-in">{markToast}</div>}
      {dialogs}
      <div className="session-right" style={{ width: clamp(chatW, 300, 900) }}>
        {nudge && (
          <div className="nudge-card fade-in">
            <IconSparkle size={14} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="nudge-label">Sitka noticed</div>
              <AiText text={nudge} onSeek={seekTranscript} />
            </div>
            <button className="convo-line-delete" title="Dismiss" onClick={() => setNudge(null)}>
              ×
            </button>
          </div>
        )}
        {session && (
          <ChatPane
            ref={chatRef}
            onPersist={onChatPersist}
            resolveLabel={(sid) => sessions.find((s) => s.id.startsWith(sid))?.title}
            sessionId={session.id}
            live
            initialChat={[]}
            hasChatKey={hasChatKey}
            hasTranscript={segments.length > 0}
            onSeek={(seconds, sid) => {
              if (sid) {
                const other = sessions.find((s) => s.id.startsWith(sid))
                if (other && other.id !== sessionIdRef.current) {
                  onOpenSessionAt(other.id, seconds)
                  return
                }
              }
              seekTranscript(seconds)
            }}
            onOpenSettings={onOpenSettings}
            getFrame={getFrame}
            host={hosting}
            headerTitle={hosting ? 'Co-Pilot' : undefined}
            suggestions={
              hosting
                ? [
                    'What does the audience want right now?',
                    'Draft a crisp answer to the top question',
                    'What haven’t I covered yet?',
                    'Summarize the questions for Q&A'
                  ]
                : [
                    'What is being explained right now?',
                    'What does this slide mean?',
                    'Summarize the session so far',
                    'Explain this like I’m a beginner'
                  ]
            }
          />
        )}
      </div>
    </div>
  )
}
