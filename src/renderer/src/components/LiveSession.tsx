import Photo from './Photo'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Hosts the chat column either in place or inside a pop-out window (the
 * browser's document picture-in-picture), so Sitca can float above a lecture
 * that runs in another window while the whole screen is being captured.
 */
function PopHost({ win, children }: { win: Window | null; children: React.ReactNode }): React.JSX.Element {
  return win ? createPortal(children, win.document.body) : <>{children}</>
}
import type {
  Space,
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
import AudioLevel from './AudioLevel'
import MaterialsPanel from './MaterialsPanel'
import { ON_SCREEN_PREFIX, type RoomMessage, type SessionMaterial } from '@shared/types'
import { frameDifference } from '@shared/visionLogic'
import {
  IconBroadcast,
  IconCamera,
  IconChevron,
  IconMic,
  IconScreen,
  IconSparkle,
  IconStar,
  IconStop,
  Mark
} from '../lib/icons'
import { formatTime } from '../lib/format'
import { pickAudioMimeType } from '../lib/audio'
import FilePick from './FilePick'
import {
  clamp,
  readSession,
  usePersistedBool,
  usePersistedNumber,
  useRemembered,
  writeSession
} from '../lib/persist'

/** What the setup page remembers across a refresh. */
const SETUP_KEY = 'sitka.live.setup'
type SetupDraft = {
  picking: boolean
  recording?: boolean
  hosting?: boolean
  kind?: SessionKind
  captureMode?: 'screen' | 'audio' | 'camera'
  micOn?: boolean
  systemAudioOn?: boolean
  moreOpen?: boolean
  agendaText?: string
}

const NOTES_INTERVAL_MS = 75000

/** Running as the website (browser picker) rather than inside Electron. */
const IS_WEB = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true
/** Phones cannot share their screen (no getDisplayMedia); their camera is the eye instead. */
const CAN_SHARE_SCREEN = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
/** Inside the Chrome extension: taking the meeting tab, and asking for the microphone. */
interface ExtShell {
  captureTab?: (tabId?: number) => Promise<MediaStream>
  ensureMic?: () => Promise<boolean>
  /** true in the invisible page that records for the extension */
  engine?: boolean
}
/** what the engine reports out, for the card on the meeting page and the viewer */
interface EngineStatus {
  state: 'starting' | 'recording' | 'ending' | 'ended' | 'failed'
  tabId?: number
  sessionId?: string
  startedAt?: number
  title?: string
  hostUrl?: string
  qr?: string
  /** once ended: the recap link to share */
  recapUrl?: string
  lastLine?: string
  error?: string
}
const tellEngine = (s: EngineStatus): void => {
  if (!extShell()?.engine) return
  window.dispatchEvent(new CustomEvent('sitka:engine:status', { detail: s }))
}
const extShell = (): ExtShell | undefined => (window as unknown as { sitkaExt?: ExtShell }).sitkaExt
// eslint-disable-next-line import/first
import { shrinkImageFile } from '../lib/attach'
// eslint-disable-next-line import/first
import { fixWebmDuration } from '@shared/webmDuration'
// eslint-disable-next-line import/first
import { clearLiveBeat, isThisTab, readLive, useLive, writeLiveBeat } from '../lib/live'
// eslint-disable-next-line import/first
import {
  IconCap as KindCap,
  IconBriefcase as KindBrief,
  IconSlides as KindSlides,
  IconNotes as PillNotes
} from '../lib/icons'
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { max: 15 }
  },
  audio: false
}

const VIDEO_CHUNK_MS = 3000
const STT_CHUNK_MS = 4000
const MIN_AUDIO_BYTES = 4000
/** below this loudest moment a caption chunk is silence: not sent, never invented */
const SILENCE_RMS = 0.0035

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
  /** started from Sitca for Business / Education: the session belongs there */
  space?: Space
  /** ecosystem flows skip the intent step and arrive with a kind chosen */
  presetKind?: SessionKind
  /** start straight on the audio-only setup (no screen) */
  presetAudio?: boolean
  /** quick record: begin the audio session immediately, no setup screen */
  autoStart?: boolean
  /** inside the Chrome extension: the meeting tab to capture, with no picker; the session starts on arrival */
  meetTab?: { tabId: number; title: string; at: number; host?: boolean }
  /** file the session in an organisation space (course, team, project) */
  orgSpaceId?: string
  /** shown in the header when filing into a space */
  orgSpaceName?: string
  /** preferences from Settings */
  defaultCapture?: 'screen' | 'camera' | 'audio'
  notesOn?: boolean
  readScreen?: boolean
}

const SPACE_COPY: Record<
  Space,
  { kicker: string; title: string; subtitle: string }
> = {
  business: {
    kicker: 'Sitca for Business',
    title: 'Capture a meeting',
    subtitle:
      'Sitca will follow the conversation and remember the decisions, promises and people — each with the moment it was said.'
  },
  education: {
    kicker: 'Sitca for Education',
    title: 'Attend a lecture',
    subtitle:
      'Sitca listens with you: a live transcript, notes that write themselves, and every concept you were taught, pinned to the moment.'
  }
}

const NUDGE_INTERVAL_MS = 100000

type Phase = 'intent' | 'picking' | 'starting' | 'recording' | 'stopping'

const KIND_OPTIONS: { key: SessionKind; label: string; hint: string }[] = [
  { key: 'lecture', label: 'Lecture', hint: 'study focus' },
  { key: 'meeting', label: 'Meeting', hint: 'decisions & actions' },
  { key: 'presentation', label: 'Presentation', hint: 'key messages' },
  { key: 'other', label: 'Something else', hint: '' }
]

// MP4 (H.264/AAC) first wherever the browser can record it: it is the one
// format every phone plays natively and streams progressively. WebM stays
// for browsers that cannot record MP4.
function pickMimeType(): string {
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1.64001F,mp4a.40.2"',
    'video/mp4',
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
  onGoEvents,
  space,
  presetKind,
  presetAudio,
  autoStart,
  meetTab,
  orgSpaceId,
  orgSpaceName,
  defaultCapture,
  notesOn,
  readScreen
}: Props): React.JSX.Element {
  // The setup page remembers its choices across a refresh (kept with the tab,
  // cleared the moment a session starts) so nothing has to be picked twice.
  const draft = useRef(readSession<SetupDraft>(SETUP_KEY)).current
  const [phase, setPhase] = useState<Phase>(
    presetKind || presetAudio || meetTab || draft?.picking ? 'picking' : 'intent'
  )
  const [hosting, setHosting] = useState(draft?.hosting ?? Boolean(meetTab?.host))
  const [kind, setKind] = useState<SessionKind>(presetKind ?? draft?.kind ?? 'other')
  // ---- capture mode: the screen with its sound, the camera, or the microphone alone ----
  const [captureMode, setCaptureMode] = useState<'screen' | 'audio' | 'camera'>(() => {
    if (presetAudio) return 'audio'
    if (meetTab) return 'screen' // the meeting tab is the screen
    const wanted = draft?.captureMode ?? defaultCapture ?? 'screen'
    if (wanted === 'screen' && !CAN_SHARE_SCREEN) return 'camera'
    return wanted
  })
  // the setup page keeps documents behind one quiet link
  const [moreOpen, setMoreOpen] = useState(draft?.moreOpen ?? false)
  // A reload in the middle of a live session ends it; say so once.
  const [reloadNote, setReloadNote] = useState(draft?.recording === true)
  // The page may be left before start() finishes; nothing must linger.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Leaving the page on purpose forgets the draft; a refresh never gets here.
      writeSession(SETUP_KEY, null)
    }
  }, [])
  const [audioOnlyRec, setAudioOnlyRec] = useState(false)
  /** optional picture for an audio session, shown where the video would be */
  const [banner, setBanner] = useState<string | null>(null)
  const bannerRef = useRef<string | null>(null)
  bannerRef.current = banner
  // ---- materials: slides/notes shared before the session exists (pending) and after ----
  const [pendingMats, setPendingMats] = useState<(SessionMaterial & { text: string })[]>([])
  const [materials, setMaterials] = useState<SessionMaterial[]>([])
  const micStreamRef = useRef<MediaStream | null>(null)
  // ---- sound that never arrives is named, and never transcribed ----
  // A level meter listens to the mixed sound. A caption chunk with no sound in
  // it is not sent (Whisper invents words for silence), and after a few
  // silent chunks the person is told, with a one-tap way to add the microphone.
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const chunkPeakRef = useRef(0)
  const silentChunksRef = useRef(0)
  const levelTimerRef = useRef<number | null>(null)
  const [noSound, setNoSound] = useState<'' | 'silent' | 'none'>('')
  const enableMicNow = useCallback(async (): Promise<void> => {
    const ctx = audioCtxRef.current
    const dest = destRef.current
    if (!ctx || !dest || micStreamRef.current) return
    try {
      await extShell()?.ensureMic?.()
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      micStreamRef.current = mic
      streamsRef.current.push(mic)
      ctx.createMediaStreamSource(mic).connect(dest)
      setMicOn(true)
      setNoSound('')
      silentChunksRef.current = 0
    } catch {
      setError('The microphone could not be opened. Check the browser has permission to use it.')
    }
  }, [])
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  // Sound: a screen session listens to the screen's own sound by default —
  // the call, the video, the slides' audio — and the microphone only when the
  // person switches it on. Camera and audio sessions have nothing but the
  // microphone, so there it is always on.
  // a captured meeting carries the class's voices; the lecturer's own comes through the microphone
  const [micOn, setMicOn] = useState(draft?.micOn ?? (meetTab ? true : captureMode !== 'screen'))
  const [systemAudioOn, setSystemAudioOn] = useState(draft?.systemAudioOn ?? true)
  useEffect(() => {
    if (captureMode !== 'screen') setMicOn(true)
  }, [captureMode])
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<SessionMeta | null>(null)
  const sessionRef = useRef<SessionMeta | null>(null)
  sessionRef.current = session
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [sttError, setSttError] = useState<string | null>(null)
  const [notes, setNotes] = useState<SessionNotes | null>(null)
  const [notesUpdating, setNotesUpdating] = useState(false)
  const [leftTab, setLeftTab] = useRemembered<'transcript' | 'notes' | 'audience' | 'materials'>(
    'sitka.live.tab',
    'transcript'
  )
  // Phone: Ask Sitca is a tab beside Transcript, open by default.
  const [askOpen, setAskOpen] = useRemembered('sitka.live.ask', () => window.innerWidth < 860)
  const [chatW, setChatW] = usePersistedNumber('sitka.chatW', 440)
  const [videoH, setVideoH] = usePersistedNumber('sitka.videoH', 320)
  // the picture can be folded away to give the words and the chat the room
  const [videoHidden, setVideoHidden] = usePersistedBool('sitka.videoHidden', false)
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
  const [agendaText, setAgendaText] = useState(draft?.agendaText ?? '')
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
  // the room chat: what attendees say to each other, and the host's replies
  const [roomMsgs, setRoomMsgs] = useState<RoomMessage[]>([])
  const [roomText, setRoomText] = useState('')
  const [roomError, setRoomError] = useState<string | null>(null)
  const roomListRef = useRef<HTMLDivElement>(null)
  // hosting: the right column is the Co-Pilot by default, the Room on request
  const [rightTab, setRightTab] = useRemembered<'ask' | 'room'>('sitka.live.right', 'ask')
  const roomSeenRef = useRef(0)
  const nudgesShownRef = useRef<string[]>([])

  // ---- page memory ----
  // While the user is still setting up, every choice is kept with the tab so
  // a refresh lands on the same page with the same selections. Once the
  // session is recording, only the fact that it was recording is kept: a
  // reload cannot carry a live capture across, and the warning below guards it.
  useEffect(() => {
    if (phase === 'intent') {
      writeSession(SETUP_KEY, null)
      return
    }
    if (phase === 'picking' || phase === 'starting') {
      const d: SetupDraft = {
        picking: true,
        hosting,
        kind,
        captureMode,
        micOn,
        systemAudioOn,
        moreOpen,
        agendaText
      }
      writeSession(SETUP_KEY, d)
      return
    }
    writeSession(SETUP_KEY, phase === 'recording' ? { picking: true, recording: true, hosting, kind, captureMode } : null)
  }, [phase, hosting, kind, captureMode, micOn, systemAudioOn, moreOpen, agendaText])

  // A refresh or a closed tab in the middle of a live session would lose what
  // is still being captured: the browser asks first.
  useEffect(() => {
    if (!IS_WEB || (phase !== 'recording' && phase !== 'starting' && phase !== 'stopping')) {
      return undefined
    }
    const guard = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [phase])
  const nudgeBusyRef = useRef(false)
  const lastNudgeCountRef = useRef(0)
  const userQuestionsRef = useRef<string[]>([])

  const previewRef = useRef<HTMLVideoElement>(null)
  const previewStreamRef = useRef<MediaStream | null>(null)
  const streamsRef = useRef<MediaStream[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const sttRecorderRef = useRef<MediaRecorder | null>(null)
  /** transcriptions still in flight: the end of the session waits for them */
  const sttPendingRef = useRef<Promise<void>>(Promise.resolve())
  /** what happened to the captions this session, written up at the end for the ops view */
  const sttStatsRef = useRef({ pieces: 0, bytes: 0, segments: 0, errors: 0, dropped: 0, rotatedByTimer: 0, heard: 0, container: '' })
  const sttStreamRef = useRef<MediaStream | null>(null)
  const sttChunkStartRef = useRef(0)
  const sttTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionStartRef = useRef(0)
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve())
  const sessionIdRef = useRef<string | null>(null)
  /** start(), reachable from the pickers that run before it is defined: a pick starts the session */
  const startRef = useRef<(overrideSource?: string) => Promise<void>>(async () => undefined)
  const stoppingRef = useRef(false)
  const lastNotesCountRef = useRef(0)
  const notesBusyRef = useRef(false)
  const segmentsRef = useRef<TranscriptSegment[]>([])
  segmentsRef.current = segments
  /** when the meeting's own captions last arrived: while they flow, Sitca's captioning rests */
  const meetCaptionAtRef = useRef(0)

  // ---- web: pick the screen up front and preview it live (browser picker) ----
  const [webStream, setWebStream] = useState<MediaStream | null>(null)
  const webStreamRef = useRef<MediaStream | null>(null)
  const webPreviewRef = useRef<HTMLVideoElement>(null)
  const pickWebScreen = useCallback(async (): Promise<void> => {
    try {
      // inside the extension, the meeting tab is taken directly: no picker
      const ext = extShell()
      const stream = meetTab && ext?.captureTab
        ? await ext.captureTab(meetTab.tabId)
        : await navigator.mediaDevices.getDisplayMedia({
        // The picker opens on the browser's tabs, the way sharing in a call
        // does: the tab of a call carries its picture AND its sound. A single
        // window of a call often comes through with its presented picture black
        // and no sound at all; the whole screen also works.
        video: {
          width: { max: 1280 },
          height: { max: 720 },
          frameRate: { max: 12 },
          displaySurface: 'browser'
        } as MediaTrackConstraints,
        audio: systemAudioOn,
        ...({
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          monitorTypeSurfaces: 'include',
          systemAudio: 'include'
        } as Record<string, string>)
      })
      webStreamRef.current?.getTracks().forEach((t) => t.stop())
      webStreamRef.current = stream
      setWebStream(stream)
      // the pick is the start: nothing else to press, nothing to come back for
      queueMicrotask(() => void startRef.current())
      const track = stream.getVideoTracks()[0]
      if (track) {
        track.onended = () => {
          if (webStreamRef.current === stream) {
            webStreamRef.current = null
            setWebStream(null)
          }
        }
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      // a cancelled picker is not an error; everything else is said plainly
      if (name === 'NotAllowedError' && /denied by system|permission/i.test(String(err))) {
        setError('Screen sharing is blocked for this browser. On a Mac, allow Screen Recording for your browser in System Settings, then try again.')
      } else if (name === 'NotReadableError' || name === 'AbortError') {
        setError('The screen could not be captured. Close other apps that record the screen, then try again.')
      } else if (name === 'NotFoundError' || name === 'NotSupportedError') {
        setError('This browser cannot share a screen. Try Chrome or Edge on a laptop, or use the camera instead.')
      } else if (meetTab) {
        // the extension says in words why the meeting tab could not be taken
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [systemAudioOn, meetTab])

  // The extension opened this page for a meeting tab: captured on arrival,
  // one press on the Meet page and nothing more to choose.
  // A second press on the toolbar icon is a fresh request, not a repeat: the
  // first may have been refused before Chrome had been invited in.
  const meetStartedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!meetTab || phase !== 'picking') return
    const key = `${meetTab.tabId}:${meetTab.at}`
    if (meetStartedRef.current === key) return
    meetStartedRef.current = key
    setError(null)
    void pickWebScreen()
  }, [meetTab, phase, pickWebScreen])
  // The phone's back camera, pointed at the board or the projector.
  const pickCamera = useCallback(async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
      webStreamRef.current?.getTracks().forEach((t) => t.stop())
      webStreamRef.current = stream
      setWebStream(stream)
      // the pick is the start: nothing else to press, nothing to come back for
      queueMicrotask(() => void startRef.current())
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (webStreamRef.current === stream) {
          webStreamRef.current = null
          setWebStream(null)
        }
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      setError(
        name === 'NotFoundError'
          ? 'No camera was found on this device.'
          : name === 'NotReadableError'
            ? 'The camera is in use by another app. Close it, then try again.'
            : 'Camera access was not allowed. Check the camera permission for this site in your browser settings.'
      )
    }
  }, [])
  // A preview belongs to one mode: switching modes lets it go.
  useEffect(() => {
    return () => {
      webStreamRef.current?.getTracks().forEach((t) => t.stop())
      webStreamRef.current = null
      setWebStream(null)
    }
  }, [captureMode])
  useEffect(() => {
    if (webStream && webPreviewRef.current) {
      webPreviewRef.current.srcObject = webStream
      void webPreviewRef.current.play().catch(() => undefined)
    }
  }, [webStream])
  // ---- a blank picture is caught, never recorded in silence ----
  // Every two seconds the picture being captured is sampled. Three dark
  // samples in a row mean the browser is sending black where the presented
  // video should be, and the person is told what to switch to.
  const [blankPicture, setBlankPicture] = useState(false)
  const blankCanvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (captureMode !== 'screen') {
      setBlankPicture(false)
      return undefined
    }
    const active = phase === 'recording' || Boolean(webStream)
    if (!active) {
      setBlankPicture(false)
      return undefined
    }
    let dark = 0
    const t = window.setInterval(() => {
      const v = phase === 'recording' ? previewRef.current : webPreviewRef.current
      if (!v || v.videoWidth === 0) return
      const c = blankCanvasRef.current ?? (blankCanvasRef.current = document.createElement('canvas'))
      c.width = 48
      c.height = 27
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      try {
        ctx.drawImage(v, 0, 0, 48, 27)
        const d = ctx.getImageData(6, 4, 36, 19).data
        let sum = 0
        for (let i = 0; i < d.length; i += 4) sum += (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10
        const mean = sum / (d.length / 4)
        dark = mean < 10 ? dark + 1 : 0
        setBlankPicture(dark >= 3)
      } catch {
        /* a frame that cannot be read is not a blank one */
      }
    }, 2000)
    return () => clearInterval(t)
  }, [captureMode, phase, webStream])

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

  // Room chat: kept fresh while hosting (quickly while the Room is open,
  // gently otherwise, so the tab can show how much has been said).
  useEffect(() => {
    if (!confUrl) return undefined
    let cancelled = false
    const load = (): void => {
      void window.sitka.listRoomMessages().then((m) => {
        if (cancelled) return
        setRoomMsgs((prev) => {
          const same = prev.length === m.length && prev.every((p, i) => p.id === m[i]?.id)
          return same ? prev : m
        })
      })
    }
    load()
    const t = setInterval(load, rightTab === 'room' ? 2500 : 8000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [confUrl, rightTab])
  useEffect(() => {
    if (rightTab === 'room') roomSeenRef.current = roomMsgs.length
  }, [rightTab, roomMsgs.length])
  useEffect(() => {
    const n = roomListRef.current
    if (n) n.scrollTop = n.scrollHeight
  }, [roomMsgs.length])
  const sendRoom = useCallback(async (): Promise<void> => {
    const t = roomText.trim()
    if (!t) return
    setRoomText('')
    const r = await window.sitka.sendRoomMessage(t)
    if (r.error) setRoomError(r.error)
    else {
      setRoomError(null)
      const m = await window.sitka.listRoomMessages()
      setRoomMsgs(m)
    }
  }, [roomText])

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
  // The conversation so far, kept here so the chat panel can move (into the
  // pop-out window and back) and reopen exactly where it was.
  const chatLogRef = useRef<Parameters<typeof window.sitka.saveChat>[1]>([])
  const onChatPersist = useCallback((messages: Parameters<typeof window.sitka.saveChat>[1]): void => {
    const id = sessionIdRef.current
    chatLogRef.current = messages
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
      if (!id || nudgeBusyRef.current || notesOn === false) return
      const count = segmentsRef.current.length
      if (count < 6 || count === lastNudgeCountRef.current) return
      lastNudgeCountRef.current = count
      nudgeBusyRef.current = true
      void window.sitka
        .checkNudge(id, userQuestionsRef.current, nudgesShownRef.current.slice(-6))
        .then((res) => {
          if (res.nudge && !nudgesShownRef.current.includes(res.nudge)) {
            nudgesShownRef.current.push(res.nudge)
            chatRef.current?.note(res.nudge)
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

  // Capture the current screen frame as a JPEG data URL.
  const captureFrame = useCallback((maxW: number, quality: number): string | null => {
    const v = previewRef.current
    if (!v || v.videoWidth === 0) return null
    const scale = Math.min(1, maxW / v.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    try {
      return canvas.toDataURL('image/jpeg', quality)
    } catch {
      return null
    }
  }, [])
  // Full-size frame for vision questions ("what does this graph show?").
  const getFrame = useCallback((): string | null => captureFrame(1280, 0.72), [captureFrame])

  // ---- visual memory: keep a key frame whenever the screen settles on something new ----
  // A tiny grayscale thumbnail is compared every few seconds; when the screen
  // has changed since the last kept frame and has stopped changing, the frame
  // is read by the vision model and joins the transcript as an "On screen" line.
  const lastSampleRef = useRef<Uint8ClampedArray | null>(null)
  const lastKeptRef = useRef<Uint8ClampedArray | null>(null)
  const lastKeptAtRef = useRef(0)
  const slideBusyRef = useRef(false)
  const slideCountRef = useRef(0)
  useEffect(() => {
    if (phase !== 'recording' || captureMode === 'audio' || !hasChatKey || readScreen === false) return undefined
    // A handheld camera never sits perfectly still, so it gets looser
    // "settled" and "changed" thresholds and a longer gap between frames.
    const settled = captureMode === 'camera' ? 0.06 : 0.02
    const distinct = captureMode === 'camera' ? 0.15 : 0.1
    const minGap = captureMode === 'camera' ? 12000 : 6000
    const t = setInterval(() => {
      const v = previewRef.current
      if (!v || v.videoWidth === 0 || slideBusyRef.current || slideCountRef.current >= 150) return
      const c = document.createElement('canvas')
      c.width = 48
      c.height = 27
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(v, 0, 0, 48, 27)
      const px = ctx.getImageData(0, 0, 48, 27).data
      const prev = lastSampleRef.current
      lastSampleRef.current = px
      if (!prev) return
      if (frameDifference(prev, px) > settled) return // still changing — wait for it to settle
      const kept = lastKeptRef.current
      if (kept && frameDifference(kept, px) < distinct) return // same screen as the last key frame
      if (Date.now() - lastKeptAtRef.current < minGap) return
      const frame = captureFrame(1280, 0.72)
      const id = sessionIdRef.current
      if (!frame || !id) return
      lastKeptRef.current = px
      lastKeptAtRef.current = Date.now()
      slideBusyRef.current = true
      const time = Math.max(0, (Date.now() - sessionStartRef.current) / 1000)
      void window.sitka
        .addSlide(id, time, frame)
        .then((r) => {
          if (!r.text) return
          slideCountRef.current++
          setSegments((all) =>
            [...all, { start: time, end: time + 1, text: ON_SCREEN_PREFIX + r.text }].sort(
              (a, b) => a.start - b.start
            )
          )
        })
        .finally(() => {
          slideBusyRef.current = false
        })
    }, 3000)
    return () => clearInterval(t)
  }, [phase, captureMode, hasChatKey, captureFrame])

  // ---- live video: a direct connection to each phone that asks for one ----
  useEffect(() => {
    if (phase !== 'recording' || !hosting || !confUrl) return undefined
    const stream = previewStreamRef.current
    if (!stream) return undefined
    void window.sitka.startVideoBroadcast(stream)
    return () => {
      void window.sitka.stopVideoBroadcast()
    }
  }, [phase, hosting, confUrl])

  // ---- live stage: the host's screen on every attendee's phone ----
  // A frame goes out the moment the picture changes, up to once a second,
  // and at least every 4s so a still slide never looks like a dropped feed.
  const [stageNote, setStageNote] = useState<string | null>(null)
  const stageThumbRef = useRef<Uint8ClampedArray | null>(null)
  const stageAtRef = useRef(0)
  useEffect(() => {
    if (phase !== 'recording' || !hosting || !confUrl) return undefined
    let busy = false
    const t = setInterval(() => {
      if (busy) return
      const v = previewRef.current
      if (!v || v.videoWidth === 0) return
      const c = document.createElement('canvas')
      c.width = 32
      c.height = 18
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(v, 0, 0, 32, 18)
      const px = ctx.getImageData(0, 0, 32, 18).data
      const changed = !stageThumbRef.current || frameDifference(stageThumbRef.current, px) > 0.01
      const keepAlive = Date.now() - stageAtRef.current > 4000
      if (!changed && !keepAlive) return
      const frame = captureFrame(1120, 0.62)
      if (!frame) return
      stageThumbRef.current = px
      stageAtRef.current = Date.now()
      busy = true
      void window.sitka
        .pushStageFrame(frame)
        .then((r) => setStageNote(r && r.error ? r.error : null))
        .catch((err: unknown) => setStageNote(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          busy = false
        })
    }, 1000)
    return () => clearInterval(t)
  }, [phase, hosting, confUrl, captureFrame])

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

  // While recording, keep the phone's screen awake. A screen that switches
  // off slows the page down and can pause the microphone; the attendee page
  // does the same while an event is live.
  useEffect(() => {
    if (phase !== 'recording') return undefined
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> }
    }
    if (!nav.wakeLock) return undefined
    let lock: { release: () => Promise<void> } | null = null
    let gone = false
    const grab = async (): Promise<void> => {
      if (gone || document.visibilityState !== 'visible') return
      try {
        lock = await nav.wakeLock!.request('screen')
      } catch {
        /* not granted: nothing else to do */
      }
    }
    void grab()
    const onVis = (): void => void grab()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', onVis)
      void lock?.release().catch(() => undefined)
    }
  }, [phase])

  // One live session per account, across tabs: while recording, this tab
  // writes a heartbeat the whole app reads (see lib/live.ts).
  useEffect(() => {
    if (phase !== 'recording' || !session) return undefined
    const tick = (): void => writeLiveBeat(session.id, session.title, sessionStartRef.current)
    tick()
    const t = window.setInterval(tick, 4000)
    return () => {
      clearInterval(t)
      clearLiveBeat(session.id)
    }
  }, [phase, session])

  const enqueueAppend = useCallback((blob: Blob): void => {
    const id = sessionIdRef.current
    if (!id) return
    // the heartbeat rides on the recorder's own clock as well as the timer:
    // an invisible page's timers can be slowed, its media pipeline is not
    if (sessionRef.current) writeLiveBeat(id, sessionRef.current.title, sessionStartRef.current)
    // Each chunk stands alone in the queue: one that fails to store is
    // written down and skipped, and every chunk after it still lands. A
    // rejection left in the chain would silently drop the rest of the session.
    appendQueueRef.current = appendQueueRef.current
      .then(async () => {
        const buf = await blob.arrayBuffer()
        await window.sitka.appendChunk(id, buf)
      })
      .catch((err) => {
        const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
        report?.(location.pathname, 'chunk store failed: ' + (err instanceof Error ? err.message : String(err)))
      })
  }, [])

  const transcribeBlob = useCallback(async (blob: Blob, offsetSec: number): Promise<void> => {
    const id = sessionIdRef.current
    if (!id || blob.size < MIN_AUDIO_BYTES) return
    const stats = sttStatsRef.current
    stats.pieces++
    stats.bytes += blob.size
    stats.container = blob.type || 'audio/webm'
    // each piece joins the queue the end of the session waits on
    const work = (async () => {
      const buf = await blob.arrayBuffer()
      const result = await window.sitka.transcribeChunk(id, buf, offsetSec, blob.type || 'audio/webm')
      if (result.error) {
        stats.errors++
        if (result.error !== 'missing-key') setSttError(result.error)
        return
      }
      if (result.segments && result.segments.length > 0) {
        stats.segments += result.segments.length
        setSttError(null)
        setSegments((prev) =>
          [...prev, ...result.segments!].sort((a, b) => a.start - b.start)
        )
      }
    })()
    sttPendingRef.current = sttPendingRef.current.then(() => work.catch(() => undefined))
    await work
  }, [])

  const startSttRecorder = useCallback((): void => {
    const stream = sttStreamRef.current
    if (!stream || stream.getAudioTracks().length === 0) return
    // whichever container this browser can write: Opus in WebM on most, AAC
    // in MP4 on iPhones and iPads, which cannot write WebM at all
    const mime = pickAudioMimeType()
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    const container = (rec.mimeType || mime || 'audio/webm').split(';')[0]
    const chunkStart = Date.now()
    sttChunkStartRef.current = chunkStart
    // The recorder's own timeslice drives the rotation. A JavaScript timer is
    // slowed to once a minute when a phone's screen is off, which left the
    // recording running with nothing being transcribed; the media pipeline
    // keeps its own clock. Each piece is a complete file: the timeslice part
    // (with the header) plus the remainder delivered on stop.
    const parts: Blob[] = []
    let rotating = false
    let flushed = false
    const flush = (): void => {
      if (flushed || parts.length === 0) return
      flushed = true
      // No sound in this chunk: nothing to transcribe, and Whisper would only
      // invent something. Three silent chunks in a row and the person is told.
      const peak = chunkPeakRef.current
      chunkPeakRef.current = 0
      // a meter that has never heard anything at all (some phones give the
      // microphone to the recorder alone) is not trusted to call a piece silent
      const meterDeaf = sttStatsRef.current.heard < 0.0005
      // The line between silence and speech follows the microphone: a phone's
      // quiet microphone must not have its every piece called silent. A piece
      // is silent when it is far below the loudest this session has been.
      const floor = Math.min(SILENCE_RMS, Math.max(0.0012, sttStatsRef.current.heard * 0.15))
      if (peak < floor && !meterDeaf) {
        sttStatsRef.current.dropped++
        silentChunksRef.current++
        if (silentChunksRef.current >= 3) setNoSound((cur) => (cur === 'none' ? cur : 'silent'))
        return
      }
      silentChunksRef.current = 0
      setNoSound('')
      // the meeting's own captions are flowing: they say it better, with names
      if (Date.now() - meetCaptionAtRef.current < 20000) {
        sttStatsRef.current.dropped++
        return
      }
      void transcribeBlob(
        new Blob(parts, { type: container }),
        (chunkStart - sessionStartRef.current) / 1000
      )
    }
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data)
      if (rec.state === 'recording') {
        if (rotating) return
        rotating = true
        rec.onstop = () => {
          flush()
          if (!stoppingRef.current) startSttRecorder()
        }
        rec.stop()
      } else if (!rotating) {
        // stopped from outside (the end of the session): the last words count too
        flush()
      }
    }
    rec.start(STT_CHUNK_MS)
    sttRecorderRef.current = rec
    // A browser that ignores the timeslice (some phones hand over data only
    // on stop) would never rotate, and never caption: a timer stands in.
    window.setTimeout(() => {
      if (rec.state !== 'recording' || rotating || stoppingRef.current) return
      rotating = true
      sttStatsRef.current.rotatedByTimer++
      rec.onstop = () => {
        flush()
        if (!stoppingRef.current) startSttRecorder()
      }
      rec.stop()
    }, STT_CHUNK_MS + 2500)
  }, [transcribeBlob])

  // ---- start recording ----
  const start = useCallback(async (overrideSource?: string): Promise<void> => {
    // a screen just picked is ready before the state that records it settles
    if (captureMode === 'screen' && !selectedSource && !overrideSource && !webStreamRef.current) return
    // one session at a time, across every tab of the account
    const other = readLive()
    if (other && !isThisTab(other)) {
      setError(`You are already live in another tab ("${other.title}"). End it there before starting a new one.`)
      return
    }
    setPhase('starting')
    setError(null)
    let created: SessionMeta | null = null
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
        hosting ? upcoming?.event.id : undefined,
        space,
        captureMode === 'audio',
        orgSpaceId
      )
      created = meta
      if (!mountedRef.current) throw new Error('left')
      setSession(meta)
      sessionIdRef.current = meta.id

      // Materials added on the setup page now belong to the session.
      if (pendingMats.length > 0) {
        let list: SessionMaterial[] = []
        for (const m of pendingMats) {
          try {
            list = await window.sitka.addSessionMaterial(meta.id, m.name, m.text)
          } catch {
            /* keep going — the session matters more than one document */
          }
        }
        setMaterials(list)
        setPendingMats([])
      }

      // Screen (+ optional system audio). chromeMediaSource constraints are
      // Electron-specific; on the web build the browser shows its own picker.
      const isWeb = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true
      const md = navigator.mediaDevices as unknown as {
        getUserMedia: (c: unknown) => Promise<MediaStream>
      }
      let desktopStream: MediaStream | null = null
      if (captureMode === 'audio') {
        // audio-only: nothing on screen to capture — the microphone is the session
      } else if (captureMode === 'camera') {
        const pre = webStreamRef.current
        if (pre && pre.getVideoTracks().some((t) => t.readyState === 'live')) {
          desktopStream = pre
          webStreamRef.current = null
          setWebStream(null)
        } else {
          desktopStream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
        }
      } else if (isWeb) {
        // Prefer the screen chosen (and previewed) on the picking page.
        const pre = webStreamRef.current
        if (pre && pre.getVideoTracks().some((t) => t.readyState === 'live')) {
          desktopStream = pre
          webStreamRef.current = null
          setWebStream(null)
        } else {
          desktopStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 12 } },
            audio: systemAudioOn
          })
        }
      } else {
        try {
          desktopStream = await md.getUserMedia({
            audio: systemAudioOn ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: overrideSource ?? selectedSource,
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
                chromeMediaSourceId: overrideSource ?? selectedSource,
                maxFrameRate: 15
              }
            }
          })
        }
      }
      if (desktopStream) streamsRef.current.push(desktopStream)

      let micStream: MediaStream | null = null
      if (micOn || captureMode !== 'screen') {
        try {
          // Audio-only and camera sessions happen in a room: take the
          // microphone raw. Echo cancellation would strip any sound the device
          // itself is playing, and noise suppression thins out distant speakers.
          // In the Chrome side panel the microphone prompt never appears;
          // the extension asks on a page of its own first, once ever.
          await extShell()?.ensureMic?.()
          micStream = await navigator.mediaDevices.getUserMedia({
            audio:
              captureMode !== 'screen'
                ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true }
                : { echoCancellation: true, noiseSuppression: true }
          })
          streamsRef.current.push(micStream)
        } catch {
          micStream = null
          // sharing a screen still works without it, but the person asked for
          // their voice, so they are told it is not in the recording
          if (captureMode === 'screen') {
            setSttError('Your microphone could not be opened, so only the shared sound is being captured. Check the microphone permission for this site.')
          }
        }
      }
      if (captureMode !== 'screen' && !micStream) {
        throw new Error('Microphone access is needed for this session — the sound comes from the room.')
      }
      micStreamRef.current = micStream
      setAudioOnlyRec(captureMode === 'audio')

      // Mix desktop audio + mic into one track.
      //
      // A phone's browser starts an AudioContext silent when it was not made
      // inside a tap, and the microphone permission prompt sits between the tap
      // and this point. Sound routed through a silent context is silence: the
      // recording had nothing in it and nothing reached the captions. So when
      // there is a single source of sound (a microphone session, a camera
      // session) its track is used as it is, and the context only listens for
      // the level meter. Mixing happens only when a screen's sound and the
      // microphone both exist.
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const keepAwake = (): void => {
        if (audioCtx.state !== 'running' && audioCtx.state !== 'closed') void audioCtx.resume().catch(() => undefined)
      }
      keepAwake()
      audioCtx.onstatechange = keepAwake
      const dest = audioCtx.createMediaStreamDestination()
      destRef.current = dest
      const audioSources = [desktopStream, micStream].filter(
        (st): st is MediaStream => !!st && st.getAudioTracks().length > 0
      )
      let audioInputs = 0
      for (const st of audioSources) {
        audioCtx.createMediaStreamSource(new MediaStream(st.getAudioTracks())).connect(dest)
        audioInputs++
      }
      const soundStream: MediaStream | null =
        audioSources.length === 1 && captureMode !== 'screen'
          ? new MediaStream(audioSources[0].getAudioTracks())
          : audioInputs > 0
            ? dest.stream
            : null
      // The level meter: the loudest moment of each caption chunk is kept, so
      // a chunk with nothing in it is never sent to be transcribed.
      chunkPeakRef.current = 0
      silentChunksRef.current = 0
      setNoSound(audioInputs === 0 ? 'none' : '')
      if (soundStream) {
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 2048
        audioCtx.createMediaStreamSource(soundStream).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        if (levelTimerRef.current) clearInterval(levelTimerRef.current)
        levelTimerRef.current = window.setInterval(() => {
          // a context that is not running hears nothing: the gate stays open
          // rather than throwing away speech it could not measure
          if (audioCtx.state !== 'running') {
            chunkPeakRef.current = 1
            return
          }
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          const rms = Math.sqrt(sum / buf.length)
          if (rms > chunkPeakRef.current) chunkPeakRef.current = rms
          if (rms > sttStatsRef.current.heard) sttStatsRef.current.heard = rms
        }, 150)
      }

      const recordTracks: MediaStreamTrack[] = [...(desktopStream?.getVideoTracks() ?? [])]
      if (soundStream) recordTracks.push(...soundStream.getAudioTracks())
      const recordStream = new MediaStream(recordTracks)

      // The preview <video> only mounts once phase becomes 'recording'; stash
      // the stream so the effect below can attach it after mount.
      previewStreamRef.current = desktopStream
        ? new MediaStream(desktopStream.getVideoTracks())
        : null

      sessionStartRef.current = Date.now()
      stoppingRef.current = false
      sttPendingRef.current = Promise.resolve()
      sttStatsRef.current = { pieces: 0, bytes: 0, segments: 0, errors: 0, dropped: 0, rotatedByTimer: 0, heard: 0, container: '' }

      // On the website recordings live in cloud storage: record at a compact
      // bitrate (screens and slides compress very well) so space lasts.
      const recorder = new MediaRecorder(recordStream, {
        mimeType: captureMode === 'audio' ? pickAudioMimeType() : pickMimeType(),
        ...(captureMode === 'audio'
          ? { audioBitsPerSecond: 64_000 }
          : IS_WEB
            ? { videoBitsPerSecond: captureMode === 'camera' ? 900_000 : 450_000, audioBitsPerSecond: 64_000 }
            : {})
      })
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) enqueueAppend(e.data)
      }
      recorder.start(VIDEO_CHUNK_MS)
      recorderRef.current = recorder

      if (soundStream && hasSttKey) {
        sttStreamRef.current = soundStream
        startSttRecorder()
      }

      clockTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - sessionStartRef.current) / 1000))
      }, 1000)

      // Arms the global Ctrl+Shift+M "mark this" hotkey.
      void window.sitka.setRecordingState({
        id: meta.id,
        startedAt: sessionStartRef.current
      })

      if (!mountedRef.current) throw new Error('left')
      setPhase('recording')
      // Only now is there a recording: the app's timer and the sidebar dot start here.
      onSessionCreated(meta)
      if (captureMode === 'audio' && bannerRef.current) {
        void window.sitka.setSessionBanner(meta.id, bannerRef.current)
        // the room sees it too, where the video would be
        if (hosting) void window.sitka.setEventBanner(null, bannerRef.current).catch(() => undefined)
      }

      // Hosted events broadcast immediately — the QR is the first thing shown.
      if (hosting) {
        void goLive().then(() => setLeftTab('audience'))
      }
    } catch (err) {
      // Nothing was recorded: release the devices and remove the empty session
      // so it never shows up as a phantom recording.
      streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      streamsRef.current = []
      if (created) {
        void window.sitka.deleteSession(created.id).catch(() => undefined)
        setSession(null)
        sessionIdRef.current = null
      }
      if (!mountedRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      if (message !== 'left') setError(message)
      setPhase('picking')
    }
  }, [selectedSource, systemAudioOn, micOn, hasSttKey, kind, hosting, agendaText, upcoming, goLive, enqueueAppend, startSttRecorder, onSessionCreated, captureMode, space, pendingMats, orgSpaceId])
  startRef.current = start

  // Quick record: the floating button lands here already in audio mode and
  // starts on arrival — one tap, no setup.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return
    if (phase !== 'picking' || captureMode !== 'audio') return
    autoStartedRef.current = true
    void start()
  }, [autoStart, phase, captureMode, start])

  // ---- stop recording ----
  const stop = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current
    if (!id || stoppingRef.current) return
    stoppingRef.current = true
    setPhase('stopping')
    tellEngine({ state: 'ending', sessionId: id, tabId: meetTab?.tabId })
    void window.sitka.setRecordingState(null)
    // the room is told first: attendees' phones must not wait on the recording
    if (hosting) void window.sitka.endEventNow(id).catch(() => undefined)

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
        // a recorder that never says it stopped is not waited on forever
        const done = window.setTimeout(resolve, 8000)
        recorder.onstop = () => {
          window.clearTimeout(done)
          resolve()
        }
        try {
          recorder.stop()
        } catch {
          window.clearTimeout(done)
          resolve()
        }
      })
    }
    await appendQueueRef.current

    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    streamsRef.current = []
    await audioCtxRef.current?.close().catch(() => undefined)
    audioCtxRef.current = null
    destRef.current = null
    if (levelTimerRef.current) clearInterval(levelTimerRef.current)
    levelTimerRef.current = null
    setNoSound('')

    const durationMs = Date.now() - sessionStartRef.current
    // For the extension's card: the recap link is ready the moment the
    // devices are released, long before the last uploads finish, so the
    // person can copy it and go while the rest is tidied up here.
    let recapUrl: string | undefined
    if (meetTab && extShell()?.engine) {
      try {
        const r = await window.sitka.publishRecap(id, true)
        if (r.url) recapUrl = r.url
      } catch {
        /* no link: the card says saved, and the session has Share */
      }
      tellEngine({ state: 'ending', sessionId: id, tabId: meetTab.tabId, recapUrl })
    }
    // the last pieces of speech are still being written down: the session's
    // end waits for them (within reason), so its title and notes see every word
    await Promise.race([sttPendingRef.current, new Promise<void>((r) => setTimeout(r, 25000))])
    {
      // what became of the captions, for the ops view: every session, so a
      // phone that records but never captions is seen, not guessed at
      const s = sttStatsRef.current
      const track = (window as unknown as { sitkaTrack?: (n: string, p: Record<string, unknown>) => void }).sitkaTrack
      track?.('captions_summary', {
        audio: captureMode === 'audio',
        pieces: s.pieces,
        kb: Math.round(s.bytes / 1024),
        segments: s.segments,
        errors: s.errors,
        dropped: s.dropped,
        by_timer: s.rotatedByTimer,
        heard: Number(s.heard.toFixed(4)),
        container: s.container,
        minutes: Math.round(durationMs / 60000),
        phone: window.innerWidth < 860
      })
      if (s.pieces > 0 && s.segments === 0 && durationMs > 20000) {
        const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
        report?.('captions-empty', `${s.pieces} pieces (${Math.round(s.bytes / 1024)} KB, ${s.container}) sent, ${s.errors} errors, ${s.dropped} dropped as silent, meter peak ${s.heard.toFixed(4)}, ${s.rotatedByTimer} rotated by timer · ${navigator.userAgent.slice(0, 90)}`)
      }
    }
    try {
      await window.sitka.finalizeSession(id, durationMs)
    } catch (err) {
      // the recording is on this device and the cloud has its parts; the
      // session opens anyway and finishes its bookkeeping on the next visit
      const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
      report?.(location.pathname, 'finalize failed: ' + (err instanceof Error ? err.message : String(err)))
    }
    onFinished(id)
    tellEngine({ state: 'ended', sessionId: id, tabId: meetTab?.tabId, recapUrl })
  }, [onFinished, hosting, meetTab])

  // ---- the extension's engine: orders in, progress out ----
  // Stop can come from the card on the meeting page.
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    const onStop = (): void => void stopRef.current()
    window.addEventListener('sitka:stop', onStop)
    return () => window.removeEventListener('sitka:stop', onStop)
  }, [])
  // What the card and the viewer are told: the state, the link for the room
  // when hosting, and the latest line heard.
  useEffect(() => {
    if (!meetTab) return
    if (phase === 'recording' && session) {
      tellEngine({
        state: 'recording',
        tabId: meetTab.tabId,
        sessionId: session.id,
        startedAt: sessionStartRef.current,
        title: session.title,
        hostUrl: confUrl ?? undefined,
        qr: confUrl ? qrData ?? undefined : undefined
      })
    } else if (phase === 'picking' && error) {
      tellEngine({ state: 'failed', tabId: meetTab.tabId, error })
    } else if (phase === 'picking' || phase === 'intent') {
      tellEngine({ state: 'starting', tabId: meetTab.tabId })
    }
  }, [meetTab, phase, session, confUrl, qrData, error])
  const lastLine = segments.length > 0 ? segments[segments.length - 1].text : ''
  useEffect(() => {
    if (!meetTab || phase !== 'recording' || !session || !lastLine || lastLine.startsWith(ON_SCREEN_PREFIX)) return
    tellEngine({ state: 'recording', tabId: meetTab.tabId, sessionId: session.id, startedAt: sessionStartRef.current, lastLine })
  }, [meetTab, phase, session, lastLine])
  // Captions the meeting itself shows (Google Meet's own, with the speaker's
  // name) arrive from the card. They are kept as the transcript, named, and
  // while they flow the recording's own captioning rests: the meeting's are
  // better, and doing both would say everything twice.
  const captionQueueRef = useRef<{ start: number; end: number; text: string; who?: string }[]>([])
  const captionTimerRef = useRef<number | null>(null)
  useEffect(() => {
    const onCaption = (e: Event): void => {
      const c = (e as CustomEvent<{ who: string; text: string; at: number; end?: number }>).detail
      const id = sessionIdRef.current
      if (!c || !c.text || !id || phase !== 'recording') return
      meetCaptionAtRef.current = Date.now()
      const start = Math.max(0, (c.at - sessionStartRef.current) / 1000)
      const words = c.text.split(/\s+/).filter(Boolean).length
      const end = c.end ? Math.max(start + 0.5, (c.end - sessionStartRef.current) / 1000) : start + Math.max(1.5, words / 2.6)
      captionQueueRef.current.push({ start, end, text: c.text, who: c.who })
      // written in small batches, so a busy conversation does not write a row per line
      if (captionTimerRef.current === null) {
        captionTimerRef.current = window.setTimeout(() => {
          captionTimerRef.current = null
          const batch = captionQueueRef.current.splice(0)
          if (batch.length === 0) return
          void window.sitka.addCaptions(id, batch).then((r) => {
            if (r.segments) setSegments(r.segments)
          })
        }, 1500)
      }
    }
    window.addEventListener('sitka:caption', onCaption)
    return () => window.removeEventListener('sitka:caption', onCaption)
  }, [phase])

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

  // Every hook below runs on every render. Nothing hook-shaped may sit after
  // the early returns further down: the count would change between the setup
  // page and the recording page, and React would refuse to continue.

  // A session already live in another tab blocks a second one from starting.
  const liveBeat = useLive()
  const liveElsewhere = liveBeat && !isThisTab(liveBeat) && phase !== 'recording' ? liveBeat : null

  // ---- theatre: the picture fills the screen, Sitca floats beside it ----
  // The same chat panel is used, restyled as a glass card, so the conversation
  // is never lost when the view changes. Escape, or the browser leaving full
  // screen, brings the page back.
  const [theatre, setTheatre] = useState(false)
  const [theatreChat, setTheatreChat] = useState(false)
  useEffect(() => {
    if (!theatre) return undefined
    const root = document.documentElement
    if (root.requestFullscreen && !document.fullscreenElement) {
      root.requestFullscreen().catch(() => undefined)
    }
    const onChange = (): void => {
      if (!document.fullscreenElement) setTheatre(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTheatre(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('keydown', onKey)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
    }
  }, [theatre])

  // ---- watch back while it records ----
  // Pause, or drag the bar back, and the recording so far plays, built from
  // what is already saved. The live capture and the captions carry on
  // underneath the whole time; "Go live" (or reaching the end) returns.
  const [dvr, setDvr] = useState<{ url: string; length: number } | null>(null)
  const [dvrBusy, setDvrBusy] = useState(false)
  const [dvrTime, setDvrTime] = useState(0)
  const [dvrPaused, setDvrPaused] = useState(false)
  const dvrRef = useRef<HTMLVideoElement>(null)
  const pendingDvrSeekRef = useRef<number | null>(null)
  const goLiveAgain = useCallback((): void => {
    setDvr((old) => {
      if (old) URL.revokeObjectURL(old.url)
      return null
    })
    setDvrPaused(false)
  }, [])
  const openDvr = useCallback(
    async (at?: number): Promise<void> => {
      const id = sessionIdRef.current
      if (!id || dvrBusy) return
      setDvrBusy(true)
      try {
        const bytes = await window.sitka.readVideo(id, 'video')
        if (!bytes || bytes.byteLength < 5000) return
        const length = Date.now() - sessionStartRef.current
        const blob = await fixWebmDuration(
          new Blob([bytes.slice().buffer], { type: 'video/webm' }),
          length
        ).catch(() => new Blob([bytes.slice().buffer], { type: 'video/webm' }))
        // pausing lands a little before the present; a drag lands where it was let go
        pendingDvrSeekRef.current = at ?? Math.max(0, length / 1000 - 15)
        setDvr((old) => {
          if (old) URL.revokeObjectURL(old.url)
          return { url: URL.createObjectURL(blob), length }
        })
        setDvrPaused(at === undefined)
      } finally {
        setDvrBusy(false)
      }
    },
    [dvrBusy]
  )
  const mmss = (s: number): string => {
    const t = Math.max(0, Math.floor(s))
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const r = t % 60
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
  }

  // ---- pop out: Sitca floats above a lecture in another window ----
  // With the whole screen captured, coming back to Sitca would put Sitca in
  // the recording. The chat can instead live in a small always-on-top window
  // that sits over the lecture; the capture keeps the lecture, and the
  // conversation stays intact when it comes back.
  const [popped, setPopped] = useState<Window | null>(null)
  const canPop =
    typeof (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture !==
      'undefined' && window.innerWidth >= 860
  const popOut = useCallback(async (): Promise<void> => {
    const dpip = (
      window as unknown as {
        documentPictureInPicture?: {
          requestWindow: (o: { width: number; height: number }) => Promise<Window>
        }
      }
    ).documentPictureInPicture
    if (!dpip) return
    try {
      const pip = await dpip.requestWindow({ width: 390, height: 640 })
      // the app's styles travel with it
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          if (sheet.href) {
            const l = pip.document.createElement('link')
            l.rel = 'stylesheet'
            l.href = sheet.href
            pip.document.head.appendChild(l)
          } else {
            const s = pip.document.createElement('style')
            s.textContent = Array.from(sheet.cssRules)
              .map((r) => r.cssText)
              .join('\n')
            pip.document.head.appendChild(s)
          }
        } catch {
          /* a sheet from elsewhere: skipped */
        }
      }
      const theme = document.documentElement.getAttribute('data-theme')
      if (theme) pip.document.documentElement.setAttribute('data-theme', theme)
      const size = document.documentElement.getAttribute('data-textsize')
      if (size) pip.document.documentElement.setAttribute('data-textsize', size)
      pip.document.body.className = 'popped-body'
      pip.document.title = 'Sitca'
      pip.addEventListener('pagehide', () => setPopped(null))
      setPopped(pip)
    } catch {
      setError('The pop-out window could not be opened in this browser.')
    }
  }, [])
  useEffect(() => {
    return () => {
      if (popped && !popped.closed) popped.close()
    }
  }, [popped])

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

          {liveElsewhere && (
            <div className="live-block">
              <span className="live-block-dot" />
              <div className="live-block-text">
                <b>You are already live in another tab.</b>
                <span>
                  "{liveElsewhere.title}" is recording there. Sitca keeps to one session at a time,
                  so end it in that tab before starting a new one.
                </span>
              </div>
            </div>
          )}

          <div className={`intent-grid${liveElsewhere ? ' blocked' : ''}`}>
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
                <span className="art-bubble">Ask Sitca anything…</span>
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
                <IconBroadcast size={17} /> Go live
                {availableEvents.length > 0 && (
                  <span className="intent-badge">
                    {availableEvents.length} planned
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
    const ready = captureMode !== 'screen' || Boolean(selectedSource)
    const kindLabel = KIND_OPTIONS.find((k) => k.key === kind)?.label ?? 'Session'
    return (
      <div className="content">
        <div className="content-inner setup">
          {eventLocked && (
            <button className="link-btn setup-back" onClick={() => onGoEvents(initialEventId)} disabled={phase === 'starting'}>
              ‹ Event dashboard
            </button>
          )}
          {/* The stage: a dark band with the one question, and the answer chips inside it. */}
          <div className="setup2-hero">
            {/* The photograph (web/public/setup-hero.jpeg) fills the band; a dark veil on
                the left carries the words in white, the way the mock-up has it. If the
                file is missing the veil alone stands, still readable. */}
            <Photo name="setup-hero" ext="jpeg" className="setup2-photo" />
            <div className="setup2-veil" aria-hidden="true" />
            <div className="setup2-words">
              <div className="setup2-kicker">
                {eventLocked
                  ? 'Launch event'
                  : orgSpaceName
                    ? `Filed in ${orgSpaceName}`
                    : space
                      ? SPACE_COPY[space].kicker
                      : hosting
                        ? 'Go live'
                        : 'New session'}
              </div>
              <h1 className="setup2-title">
                {eventLocked ? (
                  upcoming?.event.title ?? 'Your event'
                ) : hosting ? (
                  <>
                    What will the room see<span className="setup2-accent">?</span>
                  </>
                ) : space ? (
                  SPACE_COPY[space].title
                ) : (
                  <>
                    What are we capturing<span className="setup2-accent">?</span>
                  </>
                )}
              </h1>
              <p className="setup2-sub">
                {eventLocked
                  ? 'Tap what your audience will follow. The QR you shared goes live at once.'
                  : hosting
                    ? 'Tap what to capture. The join QR appears the moment it starts.'
                    : 'Tap what Sitca should watch. It starts the moment you choose.'}
              </p>
              {!eventLocked && (
                <div className="setup2-kinds">
                  {KIND_OPTIONS.map((k) => (
                    <button
                      key={k.key}
                      type="button"
                      className={`setup2-kind${kind === k.key ? ' on' : ''}`}
                      onClick={() => setKind(k.key)}
                    >
                      {k.key === 'lecture' ? (
                        <KindCap size={13} strokeWidth={1.9} />
                      ) : k.key === 'meeting' ? (
                        <KindBrief size={13} strokeWidth={1.9} />
                      ) : k.key === 'presentation' ? (
                        <KindSlides size={13} strokeWidth={1.9} />
                      ) : (
                        <IconSparkle size={13} strokeWidth={1.9} />
                      )}
                      {k.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* what Sitca does with it, as three quiet glass cards on the right */}
            <div className="setup2-pills" aria-hidden="true">
              <div className="setup2-pill">
                <span className="setup2-pill-icon">
                  <IconCamera size={16} strokeWidth={1.8} />
                </span>
                <span>
                  Record
                  <br />
                  &amp; capture
                </span>
              </div>
              <div className="setup2-pill">
                <span className="setup2-pill-icon">
                  <PillNotes size={16} strokeWidth={1.8} />
                </span>
                <span>
                  AI
                  <br />
                  smart notes
                </span>
              </div>
              <div className="setup2-pill">
                <span className="setup2-pill-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h9M8.5 3v2M6 9c1.5 4 4 6.5 7 8M11 9c-1.5 4-4 6.5-7 8" /><path d="M13 20l4-9 4 9M14.5 17h5" /></svg>
                </span>
                <span>
                  Live
                  <br />
                  translation
                </span>
              </div>
            </div>
          </div>

          {error && (
            <div className="notice notice-error">
              <span>{error}</span>
            </div>
          )}
          {reloadNote && (
            <div className="notice">
              <span>
                <strong>The page was reloaded during your live session,</strong> so it ended
                there. The transcript captured up to that moment is in your library.
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setReloadNote(false)}>
                Dismiss
              </button>
            </div>
          )}
          {!hasSttKey && (
            <div className="notice">
              <span>
                <strong>Transcription is off.</strong> Add an OpenAI key — or a free Groq key — in{' '}
                <span className="link" onClick={onOpenSettings}>
                  Settings
                </span>{' '}
                so Sitca can understand what is being said. You can still record without it.
              </span>
            </div>
          )}

          <div className="setup-steps">
            {hosting && (
              <section className="setup-block">
                <div className="setup-step-body">
                  <div className="setup-step-title">The event</div>
                  {eventLocked ? (
                    <div className="setup-card setup-card-row">
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
                  ) : (
                    <div className="setup-card">
                      <select
                        className="input"
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
                      <span className="field-hint">
                        {upcoming ? (
                          'Going live activates the QR already shared for this event, with its materials briefing the AI.'
                        ) : (
                          <>
                            Prepared events carry documents, an early QR, and a briefed AI —{' '}
                            <span className="link" onClick={() => onGoEvents()}>
                              manage events
                            </span>
                            .
                          </>
                        )}
                      </span>
                    </div>
                  )}
                  <textarea
                    className="textarea"
                    style={{ marginTop: 10 }}
                    rows={3}
                    placeholder={'Planned topics, one per line (optional). Sitca ticks them off live and flags what you have not covered.'}
                    value={agendaText}
                    onChange={(e) => setAgendaText(e.target.value)}
                    spellCheck={false}
                  />
                </div>
              </section>
            )}

            <section className="setup-block">
              <div className="setup-step-body">
                {/* Sound is decided before the tap, because the tap is the start. */}
                {CAN_SHARE_SCREEN && (
                  <div className="setup2-sound">
                    <span className="setup2-sound-label">For a screen, sound from</span>
                    <button
                      type="button"
                      className={`chip-toggle${systemAudioOn ? ' on' : ''}`}
                      onClick={() => setSystemAudioOn((v) => !v)}
                      title="What you hear — the speaker in a call, a video, the lecture audio"
                    >
                      <IconScreen size={13} strokeWidth={1.9} />
                      The screen
                    </button>
                    <button
                      type="button"
                      className={`chip-toggle${micOn ? ' on' : ''}`}
                      onClick={() => setMicOn((v) => !v)}
                      title="Your own voice — for in-person lectures and meetings"
                    >
                      <IconMic size={13} strokeWidth={1.9} />
                      My microphone
                    </button>
                  </div>
                )}

                {/* One tap each. The pick is the start. */}
                <div className="act-tiles">
                  {CAN_SHARE_SCREEN && (
                    <button
                      type="button"
                      className="act-tile"
                      disabled={phase === 'starting'}
                      onClick={() => {
                        setCaptureMode('screen')
                        if (IS_WEB) void pickWebScreen()
                      }}
                    >
                      <span className="act-icon">
                        <IconScreen size={22} strokeWidth={1.6} />
                      </span>
                      <span className="act-text">
                        <b>Share my screen</b>
                        <span>Slides, a call, a video — with its sound. Pick the call's tab for both.</span>
                      </span>
                      <span className="act-go">
                        <IconChevron size={16} strokeWidth={2.2} />
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="act-tile"
                    disabled={phase === 'starting'}
                    onClick={() => {
                      setCaptureMode('camera')
                      void pickCamera()
                    }}
                  >
                    <span className="act-icon">
                      <IconCamera size={22} strokeWidth={1.6} />
                    </span>
                    <span className="act-text">
                      <b>Use my camera</b>
                      <span>Point it at the board, the projector or the room.</span>
                    </span>
                    <span className="act-go">
                      <IconChevron size={16} strokeWidth={2.2} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="act-tile"
                    disabled={phase === 'starting'}
                    onClick={() => {
                      setCaptureMode('audio')
                      queueMicrotask(() => void startRef.current())
                    }}
                  >
                    <span className="act-icon">
                      <IconMic size={22} strokeWidth={1.6} />
                    </span>
                    <span className="act-text">
                      <b>Record audio</b>
                      <span>In person, through the microphone. On a call, put it on speaker.</span>
                    </span>
                    <span className="act-go">
                      <IconChevron size={16} strokeWidth={2.2} />
                    </span>
                  </button>
                </div>

                {/* The desktop app chooses among its screens and windows here; a tap starts. */}
                {!IS_WEB && CAN_SHARE_SCREEN && captureMode === 'screen' && sources.length > 0 && (
                  <div className="source-grid" style={{ marginTop: 14 }}>
                    {sources.map((s) => (
                      <button
                        key={s.id}
                        className={`source-tile${selectedSource === s.id ? ' selected' : ''}`}
                        disabled={phase === 'starting'}
                        onClick={() => {
                          setSelectedSource(s.id)
                          void startRef.current(s.id)
                        }}
                      >
                        <img className="source-thumb" src={s.thumbnail} alt="" />
                        <div className="source-name">{s.name}</div>
                      </button>
                    ))}
                  </div>
                )}
                {/* A picture for a listen-only session, chosen before the tap that starts it. */}
                <div className="banner-row">
                  <div className="banner-pick">
                    {banner ? (
                      <>
                        <img src={banner} alt="" className="banner-pick-img" />
                        <div className="banner-pick-text">
                          <div className="banner-pick-title">Banner</div>
                          <div className="banner-pick-sub">Shown where the video would be when you record audio.</div>
                        </div>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBanner(null)}>
                          Remove
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="banner-pick-text">
                          <div className="banner-pick-title">
                            Banner <span className="setup-optional">optional</span>
                          </div>
                          <div className="banner-pick-sub">A poster, a logo, the speaker — shown where the video would be when you record audio.</div>
                        </div>
                        <FilePick
                          documents={false}
                          multiple={false}
                          onFiles={(files) => {
                            const f = files[0]
                            if (f) void shrinkImageFile(f, 1280, 0.8).then(setBanner).catch(() => undefined)
                          }}
                        >
                          {(open) => (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={open}>
                              Add picture
                            </button>
                          )}
                        </FilePick>
                      </>
                    )}
                  </div>
                </div>
                {blankPicture && webStream && (
                  <div className="web-pick-warn">
                    <span>
                      The shared picture is blank: the browser is not passing on the presented video
                      from this window. Choose the tab where the call is running instead, or the whole
                      screen.
                    </span>
                    <button type="button" className="btn btn-sm" onClick={() => void pickWebScreen()}>
                      Choose again
                    </button>
                  </div>
                )}
                {!CAN_SHARE_SCREEN && (
                  <div className="mic-card-tip" style={{ borderTop: 0, paddingTop: 0 }}>
                    On a call or in a meeting on this phone? Put it on speaker so Sitca hears both
                    sides, and keep Sitca on screen or in split screen so the phone keeps recording.
                  </div>
                )}
              </div>
            </section>

            <section className="setup-block setup-more-block">
              <button type="button" className="setup-more" onClick={() => setMoreOpen((v) => !v)}>
                {moreOpen ? 'Hide' : pendingMats.length > 0 ? `Slides and notes · ${pendingMats.length}` : 'Add slides or notes'}
                <span className="setup-optional">optional</span>
              </button>
              {moreOpen && (
                <div className="setup-step-body" style={{ marginTop: 10 }}>
                  <div className="setup-step-hint">
                    Sitca reads them before it listens, so it knows where the session is heading.
                  </div>
                  <MaterialsPanel
                    compact
                    materials={pendingMats}
                    onAdd={async (name, text) =>
                      setPendingMats((prev) => [
                        ...prev,
                        { id: `${Date.now()}-${prev.length}`, name, text, chars: text.length, addedAt: Date.now() }
                      ])
                    }
                    onRemove={async (id) => setPendingMats((prev) => prev.filter((m) => m.id !== id))}
                  />
                </div>
              )}
            </section>
          </div>

          <div className="setup2-status">
            {phase === 'starting' ? (
              <>
                <Mark size={15} live /> Starting your {kindLabel.toLowerCase()}
                {hosting ? ' and opening the room' : ''}…
              </>
            ) : (
              <>
                <Mark size={15} />
                {ready && captureMode === 'screen' && !IS_WEB
                  ? 'Tap a screen or window above to start'
                  : 'Tap what to capture above — the session starts at once'}
                {pendingMats.length > 0
                  ? ` · ${pendingMats.length} ${pendingMats.length === 1 ? 'document' : 'documents'} read first`
                  : ''}
              </>
            )}
          </div>
        </div>
        {dialogs}
      </div>
    )
  }

  // ============ recording UI ============
  return (
    <div className={`session-layout${askOpen ? ' ask-open' : ''}`} ref={layoutRef}>
      <div className="session-left">
        <div className="session-header">
          <div className="session-header-row">
            <h1>{session?.title ?? 'Live session'}</h1>
            <div className="live-actions">
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
                {phase === 'stopping' ? (
                  'Finishing…'
                ) : (
                  <>
                    <span className="wide">End session</span>
                    <span className="narrow">End</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
        <div
          className={`video-wrap${videoHidden ? ' collapsed' : ''}${theatre ? ' theatre' : ''}`}
          ref={videoWrapRef}
          style={
            theatre
              ? undefined
              : { height: videoHidden ? 40 : hosting ? 130 : audioOnlyRec ? 116 : clamp(videoH, 140, 900) }
          }
        >
          {!theatre && (
            <button
              className="video-toggle"
              onClick={() => setVideoHidden(!videoHidden)}
              title={videoHidden ? 'Show the picture' : 'Hide the picture — the recording and the sound continue'}
            >
              <IconChevron size={13} strokeWidth={2.4} />
              {videoHidden ? 'Show video' : 'Hide'}
            </button>
          )}
          {!audioOnlyRec && !videoHidden && (
            <button
              className="video-expand"
              onClick={() => {
                setTheatre(!theatre)
                setTheatreChat(false)
              }}
              title={theatre ? 'Back to the page (Esc)' : 'Fill the screen'}
              aria-label={theatre ? 'Back to the page' : 'Fill the screen'}
            >
              {theatre ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>
              )}
            </button>
          )}
          {audioOnlyRec ? (
            <div className={`audio-stage${banner ? ' with-banner' : ''}`}>
              {banner && <img className="audio-banner" src={banner} alt="" />}
              <AudioLevel stream={micStreamRef.current} bars={44} tall />
              <div className="audio-stage-label">
                <Mark size={14} live /> Audio session · listening
              </div>
            </div>
          ) : (
            <>
              <video ref={previewRef} autoPlay muted playsInline className={dvr ? 'is-hidden' : ''} />
              {dvr && (
                <video
                  ref={dvrRef}
                  className="dvr-video"
                  src={dvr.url}
                  playsInline
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget
                    const at = pendingDvrSeekRef.current
                    if (at !== null) {
                      v.currentTime = at
                      pendingDvrSeekRef.current = null
                    }
                    if (dvrPaused) v.pause()
                    else void v.play().catch(() => undefined)
                  }}
                  onTimeUpdate={(e) => setDvrTime(e.currentTarget.currentTime)}
                  onPlay={() => setDvrPaused(false)}
                  onPause={() => setDvrPaused(true)}
                  onEnded={goLiveAgain}
                />
              )}
              {phase === 'recording' && (
                <div className={`live-controls${dvr ? ' dvr' : ''}`}>
                  {dvr ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const v = dvrRef.current
                          if (!v) return
                          if (v.paused) void v.play().catch(() => undefined)
                          else v.pause()
                        }}
                        title={dvrPaused ? 'Play' : 'Pause'}
                        aria-label={dvrPaused ? 'Play' : 'Pause'}
                      >
                        {dvrPaused ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                        )}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(1, dvr.length / 1000)}
                        step={0.5}
                        value={dvrTime}
                        onChange={(e) => {
                          const t = Number(e.target.value)
                          setDvrTime(t)
                          const v = dvrRef.current
                          if (v) v.currentTime = t
                        }}
                        aria-label="Position in the recording so far"
                      />
                      <span className="lc-time">
                        {mmss(dvrTime)} / {mmss(dvr.length / 1000)}
                      </span>
                      <button type="button" className="lc-live" onClick={goLiveAgain}>
                        Go live
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void openDvr()}
                        disabled={dvrBusy}
                        title="Pause and watch back — the recording and the captions carry on"
                        aria-label="Pause"
                      >
                        {dvrBusy ? (
                          <Mark size={14} live />
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                        )}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(1, elapsed)}
                        step={1}
                        value={elapsed}
                        onChange={(e) => void openDvr(Number(e.target.value))}
                        aria-label="Drag back to watch what was already recorded"
                      />
                      <span className="lc-time">{mmss(elapsed)}</span>
                      <span className="lc-livepill">
                        <i />
                        LIVE
                      </span>
                    </>
                  )}
                </div>
              )}
              {blankPicture && (
                <div className="blank-note">
                  <b>The shared picture is blank.</b> The browser is not passing on the presented
                  video from this window. In the browser's sharing bar, switch to the tab where the
                  call is running, or to the whole screen. If the call runs in a different Chrome
                  window or profile, the whole screen is the one that works.
                </div>
              )}
            </>
          )}
          {theatre && !theatreChat && (
            <button
              type="button"
              className="theatre-fab"
              onClick={() => setTheatreChat(true)}
              title="Open the conversation with Sitca"
              aria-label="Ask Sitca"
            >
              <Mark size={20} live />
              <span className="theatre-fab-text">
                <b>Ask Sitca</b>
                <small>about what is happening</small>
              </span>
            </button>
          )}
        </div>
        {!hosting && !audioOnlyRec && (
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
        {noSound && (
          <div className="soft-note" style={{ margin: '12px 20px 0' }}>
            <span className="soft-note-icon">
              <IconMic size={16} strokeWidth={1.8} />
            </span>
            <div className="soft-note-text">
              <b>Nothing to hear yet</b>
              <span>
                {noSound === 'none'
                  ? 'This share carries no sound. Share the call\'s tab or the whole screen, or listen through your microphone.'
                  : 'No sound has reached Sitca for a moment. If the call is in another window, share its tab or the whole screen, or listen through your microphone.'}
              </span>
            </div>
            {!micStreamRef.current && (
              <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => void enableMicNow()}>
                Use my microphone
              </button>
            )}
          </div>
        )}
        <div
          className="tab-row"
          style={{ display: 'flex', gap: 4, padding: '12px 24px 0' }}
          onClickCapture={(e) => {
            const b = (e.target as HTMLElement).closest('button')
            if (b && !b.classList.contains('tab-ask')) setAskOpen(false)
          }}
        >
          <button
            className={`btn btn-sm tab-ask ${askOpen ? '' : 'btn-ghost'}`}
            onClick={() => setAskOpen(true)}
          >
            <IconSparkle size={13} />
            Ask
          </button>
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
          <button
            className={`btn btn-sm ${leftTab === 'materials' ? '' : 'btn-ghost'}`}
            onClick={() => setLeftTab('materials')}
          >
            Materials{materials.length > 0 ? ` · ${materials.length}` : ''}
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
            {/* One slim strip: the two figures, the screen status, the controls. */}
            <div className="console-bar">
              <div className="console-figures">
                <span className="console-figure" title="People on the event page right now">
                  <b>{audience.attendees}</b>
                  with you now
                </span>
                <span className="console-figure" title="Questions sent to you, not yet answered">
                  <b>{audience.questions.reduce((n, g) => n + g.items.length, 0)}</b>
                  questions waiting
                </span>
              </div>
              <div
                className={`stage-status${stageNote ? ' bad' : audioOnlyRec ? ' quiet' : ' ok'}`}
              >
                {audioOnlyRec
                  ? 'Audio only — no screen to show the room'
                  : stageNote
                    ? `Screen not reaching phones: ${stageNote}`
                    : 'Screen live on every phone'}
              </div>
              <div className="console-btns">
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
                <button
                  className="btn btn-ghost btn-sm"
                  title="Stop sharing with the room; the recording continues"
                  onClick={() => void stopHosting()}
                >
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
        ) : leftTab === 'materials' ? (
          <div className="transcript">
            <MaterialsPanel
              materials={materials}
              onAdd={async (name, text) => {
                const id = sessionIdRef.current
                if (!id) return
                setMaterials(await window.sitka.addSessionMaterial(id, name, text))
              }}
              onRemove={async (mid) => {
                const id = sessionIdRef.current
                if (!id) return
                setMaterials(await window.sitka.removeSessionMaterial(id, mid))
              }}
            />
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
      <PopHost win={popped}>
      <div
        className={`session-right${theatre ? (theatreChat ? ' theatre-open' : ' theatre-hidden') : ''}${popped ? ' popped' : ''}`}
        style={{ width: clamp(chatW, 300, 900) }}
      >
        {theatre && theatreChat && (
          <button
            type="button"
            className="theatre-close"
            onClick={() => setTheatreChat(false)}
            title="Fold Sitca away — the conversation stays"
          >
            Close
          </button>
        )}
        {canPop && session && !theatre && (
          <button
            type="button"
            className="popout-btn"
            onClick={() => (popped ? popped.close() : void popOut())}
            title={
              popped
                ? 'Bring Sitca back into the page'
                : 'Float Sitca in a small window above the lecture, so the recording keeps the lecture'
            }
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              {popped ? (
                <path d="M4 14v6h6M20 10V4h-6M20 4l-7 7M4 20l7-7" />
              ) : (
                <path d="M14 4h6v6M20 4l-8 8M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
              )}
            </svg>
            {popped ? 'Back to the page' : 'Pop out'}
          </button>
        )}
        {hosting && session && (
          <div className="right-tabs">
            <button className={rightTab === 'ask' ? 'on' : ''} onClick={() => setRightTab('ask')}>
              <IconSparkle size={13} />
              Co-Pilot
            </button>
            <button className={rightTab === 'room' ? 'on' : ''} onClick={() => setRightTab('room')}>
              Room
              {roomMsgs.length > roomSeenRef.current && rightTab !== 'room' && (
                <i className="right-tab-dot" />
              )}
            </button>
            <span className="live-badge right-live">● LIVE</span>
          </div>
        )}
        {hosting && session && rightTab === 'room' && (
          <div className="room-panel">
            <div className="room-list room-list-tall" ref={roomListRef}>
              {roomMsgs.length === 0 ? (
                <div className="room-empty">
                  Quiet so far. Attendees can talk to each other here, and everything they say is visible to you.
                  Say hello.
                </div>
              ) : (
                roomMsgs.map((m) => (
                  <div key={m.id} className={`room-msg${m.host ? ' host' : ''}`}>
                    <b>{m.host ? 'You' : m.name}</b>
                    <span>{m.text}</span>
                  </div>
                ))
              )}
            </div>
            {roomError && <div className="notice notice-error" style={{ margin: '8px 0 0' }}>{roomError}</div>}
            <div className="room-input">
              <input
                className="input"
                placeholder="Say something to the room…"
                value={roomText}
                onChange={(e) => setRoomText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void sendRoom()
                }}
              />
              <button className="btn btn-sm" disabled={!roomText.trim()} onClick={() => void sendRoom()}>
                Send
              </button>
            </div>
          </div>
        )}
        {session && !(hosting && rightTab === 'room') && (
          <ChatPane
            ref={chatRef}
            onPersist={onChatPersist}
            resolveLabel={(sid) =>
              sessionIdRef.current?.startsWith(sid)
                ? undefined
                : sessions.find((s) => s.id.startsWith(sid))?.title
            }
            sessionId={session.id}
            live
            initialChat={chatLogRef.current}
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
      </PopHost>
    </div>
  )
}
