import { IconMic } from '../lib/icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RoomMessage, SessionData, SessionMaterial, SessionMeta, Slide } from '@shared/types'
import MaterialsPanel from './MaterialsPanel'
import FilePick from './FilePick'
import ChatPane from './ChatPane'
import TranscriptPane from './TranscriptPane'
import SpeakersBar from './SpeakersBar'
import NotesPane from './NotesPane'
import StudyPane from './StudyPane'
import ReportPane from './ReportPane'
import Splitter from './Splitter'
import { clamp, usePersistedBool, usePersistedNumber, useRemembered } from '../lib/persist'
import Loading, { LOADING_WORDS } from './Loading'
import { shrinkImageFile } from '../lib/attach'
import { IconPause, IconPlay, IconSpeaker } from '../lib/icons'
import { mediaType, playProgressively, sourceFromParts, streamMedia } from '@shared/progressive'
import { defragmentMp4, isFragmentedMp4 } from '@shared/mp4'
import { tapToPlay } from '../lib/tapToPlay'

/** MediaSource, or Safari's managed one on iPhone */
const hasStreamingEngine = (): boolean => typeof MediaSource !== 'undefined' || 'ManagedMediaSource' in window
/** an iPhone or iPad, whichever browser: every browser there is Safari's engine underneath */
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
import { formatDate, formatDuration, formatTime, parseTimestamp } from '../lib/format'
import { copyRich } from '../lib/clipboard'
import {
  IconCopy,
  IconDoc,
  IconDownload,
  IconEdit,
  IconNotes,
  IconChevron,
  IconShare,
  IconSparkle,
  IconStar,
  Mark
} from '../lib/icons'
import ShareCard from './ShareCard'

interface Props {
  sessionId: string
  hasChatKey: boolean
  onOpenSettings: () => void
  /** bumps when main pushes a session:updated for this session */
  refreshToken: number
  /** deep link: seek here once the video is ready (Brain citations, palette) */
  initialSeek?: number
  seekNonce?: number
  /** all sessions — used to resolve cross-session citations in answers */
  sessions: SessionMeta[]
  onOpenSessionAt: (sessionId: string, seconds?: number) => void
}

export default function SessionView({
  sessionId,
  hasChatKey,
  onOpenSettings,
  refreshToken,
  initialSeek,
  seekNonce,
  sessions,
  onOpenSessionAt
}: Props): React.JSX.Element {
  const [data, setData] = useState<SessionData | null>(null)
  // the voices: listening again in progress, and a voice the transcript asked to name
  const [speakersBusy, setSpeakersBusy] = useState(false)
  const [naming, setNaming] = useState<number | null>(null)
  const namingDone = useCallback(() => setNaming(null), [])
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [videoError, setVideoError] = useState(false)
  /** the recording handed to the browser's own player, when ours could not play it */
  const [nativeSrc, setNativeSrc] = useState<string | null>(null)
  /** how the recording was being played when it failed, for the message and the report */
  const diagRef = useRef('')
  // The first frame, and how long it took by which way, goes to the ops view
  // once per load: the measure of "YouTube fast", phone by phone.
  const firstFrame = (): void => {
    if (firstFrameSentRef.current || !loadStartRef.current) return
    firstFrameSentRef.current = true
    const track = (window as unknown as { sitkaTrack?: (n: string, p: Record<string, unknown>) => void }).sitkaTrack
    const ms = Date.now() - loadStartRef.current
    track?.('play_first_frame', {
      way: diagRef.current,
      ms,
      audio: Boolean(data?.meta.audioOnly),
      minutes: Math.round((data?.meta.durationMs || 0) / 60000),
      phone: window.innerWidth < 860
    })
    // a slow start is written up like a fault, with the ways that were passed over
    if (ms > 8000) {
      const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
      const passed = ladderRef.current.tried.length ? ` · passed over: ${ladderRef.current.tried.join('; ')}` : ''
      const stream = streamNoteRef.current ? ` · stream said: ${streamNoteRef.current}` : ''
      report?.('session-player-slow', `${Math.round(ms / 1000)} s to the first frame by ${diagRef.current}${passed}${stream} · ${navigator.userAgent.slice(0, 90)}`)
    }
  }
  // Browsers hold a hidden tab's media back: nothing is fetched, nothing
  // decoded, until the tab is looked at. A wait measured on a hidden page
  // would run out with nothing to show and blame the recording. So every
  // wait here counts only time the page is visible.
  const visibleTimeout = (ms: number, fn: () => void): (() => void) => {
    let left = ms
    let started = 0
    let timer: number | null = null
    let done = false
    const stop = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }
    const arm = (): void => {
      if (done || document.visibilityState !== 'visible') return
      started = Date.now()
      timer = window.setTimeout(() => {
        done = true
        document.removeEventListener('visibilitychange', onVis)
        fn()
      }, left)
    }
    const onVis = (): void => {
      if (document.visibilityState === 'visible') arm()
      else if (timer !== null) {
        left = Math.max(500, left - (Date.now() - started))
        stop()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    arm()
    return () => {
      done = true
      stop()
      document.removeEventListener('visibilitychange', onVis)
    }
  }
  const whenVisible = (): Promise<void> =>
    document.visibilityState === 'visible'
      ? Promise.resolve()
      : new Promise((resolve) => {
          const on = (): void => {
            if (document.visibilityState === 'visible') {
              document.removeEventListener('visibilitychange', on)
              resolve()
            }
          }
          document.addEventListener('visibilitychange', on)
        })
  const failWith = (why: string): void => {
    diagRef.current = why
    const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
    report?.('session-player', `${why} · ${navigator.userAgent.slice(0, 80)}`)
    setVideoSrc(null)
    setVideoError(true)
  }
  // The ways a recording can be played, tried in order: the whole file by
  // its link, the parts as a stream, the whole file read into memory. A way
  // that errors, or that gives no data in twenty seconds, hands over to the
  // next; only when the last is exhausted does the player say what it tried.
  type Way = 'hls' | 'url' | 'stream' | 'blob'
  const ladderRef = useRef<{ ways: Way[]; tried: string[] }>({ ways: [], tried: [] })
  const loadGenRef = useRef(0)
  /** counts the ways tried in this load, so a late watchdog from an earlier way cannot skip the next */
  const wayRef = useRef(0)
  /** the parts and their sizes, listed once per load and shared by the ways */
  const sizedRef = useRef<{ url: string; size: number }[]>([])
  /** the session's meta as soon as it is known, for decisions taken before the state settles */
  const metaRef = useRef<SessionMeta | null>(null)
  /** when this load began, and whether its first frame has been reported */
  const loadStartRef = useRef(0)
  const firstFrameSentRef = useRef(false)
  /** why the stream engine declined, if it did */
  const streamNoteRef = useRef('')
  const objectUrlRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [mediaDuration, setMediaDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const userPausedRef = useRef(false)
  // Loudness, 0 to 3: up to 1 is the element's own volume; past 1 the sound
  // is routed through a gain node, for a recording made too quietly.
  const [loud, setLoud] = usePersistedNumber('sitka.voiceLoud', 1)
  const gainRef = useRef<{ ctx: AudioContext; gain: GainNode; el: HTMLMediaElement } | null>(null)
  const applyLoud = useCallback((v: HTMLVideoElement, value: number): void => {
    v.volume = Math.min(1, Math.max(0, value))
    // an element can be given to a gain node once: a new element gets a new node
    if (gainRef.current && gainRef.current.el !== v) {
      void gainRef.current.ctx.close().catch(() => undefined)
      gainRef.current = null
    }
    if (value > 1 && !gainRef.current) {
      try {
        const ctx = new AudioContext()
        const gain = ctx.createGain()
        ctx.createMediaElementSource(v).connect(gain)
        gain.connect(ctx.destination)
        gainRef.current = { ctx, gain, el: v }
      } catch {
        /* no boost on this browser: the element's volume is the ceiling */
      }
    }
    const g = gainRef.current
    if (g) {
      if (g.ctx.state !== 'running') void g.ctx.resume().catch(() => undefined)
      g.gain.gain.value = value > 1 ? value : 1
    }
  }, [])
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    // The boost is for sound-only sessions, whose element is fetched with
    // CORS so a gain node may hear it. A video plays through its own
    // controls: routed through a gain node without CORS it would go silent.
    if (data?.meta.audioOnly) applyLoud(v, loud)
    else {
      v.volume = 1
      if (gainRef.current) {
        void gainRef.current.ctx.close().catch(() => undefined)
        gainRef.current = null
      }
    }
  }, [loud, videoSrc, applyLoud, data?.meta.audioOnly])
  useEffect(
    () => () => {
      void gainRef.current?.ctx.close().catch(() => undefined)
      gainRef.current = null
    },
    []
  )
  // On the website the recording is fetched from the cloud, which can be a
  // long download on a phone: it waits for a tap (or a jump to a moment).
  // On the desktop it is a local file and loads at once.
  const [videoWanted, setVideoWanted] = useState(true)
  // true once the player has a frame (or, for sound alone, data) on screen;
  // until then the orbiting mark stays over the player
  const [videoLive, setVideoLive] = useState(false)
  // the library's thumbnail stands in as the picture until the first frame arrives
  const [poster, setPoster] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setPoster(null)
    void window.sitka
      .getThumb(sessionId)
      .then((t) => {
        if (!cancelled) setPoster(t)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionId])
  // preparing an older WebM recording as MP4 for phones: progress from the web layer
  const [phonePrep, setPhonePrep] = useState<{ pct: number; error?: string } | null>(null)
  useEffect(() => {
    const onProgress = (e: Event): void => {
      const d = (e as CustomEvent<{ id: string; pct: number; done: boolean; error?: string }>).detail
      if (!d || d.id !== sessionId) return
      if (d.done) {
        setPhonePrep(d.error ? { pct: 0, error: d.error } : null)
        if (!d.error) setData((cur) => (cur ? { ...cur, meta: { ...cur.meta, mime: 'video/mp4', whole: true } } : cur))
      } else setPhonePrep({ pct: d.pct })
    }
    window.addEventListener('sitka:convert', onProgress)
    return () => window.removeEventListener('sitka:convert', onProgress)
  }, [sessionId])
  const [currentTime, setCurrentTime] = useState(0)
  // The chosen tabs come back after a refresh.
  const [tab, setTab] = useRemembered<'transcript' | 'overview' | 'notes' | 'study' | 'report'>(
    'sitka.session.tab',
    'transcript'
  )
  const [notesGenerating, setNotesGenerating] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [studyGenerating, setStudyGenerating] = useState(false)
  const [studyError, setStudyError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [reelSrc, setReelSrc] = useState<string | null>(null)
  const [reelBusy, setReelBusy] = useState(false)
  const [reelError, setReelError] = useState<string | null>(null)
  const [reelSaved, setReelSaved] = useState(false)
  const [exported, setExported] = useState(false)
  // the session into Google Drive: the recording and a Google Doc, with progress
  const [drive, setDrive] = useState<{ stage: string; sent: number; total: number; folderUrl?: string; error?: string } | null>(null)
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<{ sessionId: string; stage: string; sent: number; total: number }>).detail
      if (d.sessionId !== sessionId) return
      setDrive((cur) => ({ ...(cur ?? { stage: '', sent: 0, total: 0 }), stage: d.stage, sent: d.sent, total: d.total }))
    }
    window.addEventListener('sitka:drive', on)
    return () => window.removeEventListener('sitka:drive', on)
  }, [sessionId])
  const saveToDrive = useCallback((): void => {
    if (drive && ['asking', 'reading', 'sending', 'writing'].includes(drive.stage)) return
    const inExtension = Boolean((window as unknown as { sitkaExt?: unknown }).sitkaExt)
    if (inExtension) {
      // Google's window cannot open inside the extension: the website does it
      window.open(`https://sitcaai.vercel.app/app#open=${sessionId}&t=${Date.now()}`, '_blank', 'noopener')
      return
    }
    setDrive({ stage: 'asking', sent: 0, total: 0 })
    void window.sitka.saveToDrive(sessionId).then((r) => {
      if (r.error) {
        const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
        report?.('drive', `save to Drive failed for ${sessionId}: ${r.error}`)
        setDrive({ stage: 'failed', sent: 0, total: 0, error: r.error })
      } else setDrive({ stage: 'done', sent: 1, total: 1, folderUrl: r.folderUrl })
    })
  }, [drive, sessionId])
  // the recording itself, as a file: fetched whole, then saved with the session's name
  const [downloading, setDownloading] = useState<'' | 'busy' | 'done' | 'none'>('')
  const downloadRecording = useCallback((): void => {
    if (downloading === 'busy') return
    setDownloading('busy')
    void window.sitka
      .readVideo(sessionId)
      .then((bytes) => {
        if (!bytes || bytes.byteLength === 0) {
          setDownloading('none')
          return
        }
        const kind = mediaType(bytes.subarray(0, 12))
        const copy = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(copy).set(bytes)
        const name = (metaRef.current?.title || 'recording').replace(/[^\w\- ]+/g, '').trim() || 'recording'
        return window.sitka.saveBinaryFile(`${name}.${kind === 'video/mp4' ? (metaRef.current?.audioOnly ? 'm4a' : 'mp4') : 'webm'}`, copy).then(() => setDownloading('done'))
      })
      .catch(() => setDownloading('none'))
      .then(() => window.setTimeout(() => setDownloading(''), 3000))
  }, [downloading, sessionId])
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [slides, setSlides] = useState<Slide[]>([])
  const [showMaterials, setShowMaterials] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [uploading, setUploading] = useState(false)
  // whether this browser holds the part of the recording the cloud lacks:
  // asked once on opening, which also sends it up when it is here
  const [pendingHere, setPendingHere] = useState<boolean | null>(null)
  const [materials, setMaterials] = useState<SessionMaterial[]>([])
  // Phone: the chat is a tab beside Transcript, open by default, so the screen
  // shows one thing at a time. On a desktop the chat is always the right column.
  const [askOpen, setAskOpen] = useRemembered('sitka.session.ask', () => window.innerWidth < 860)
  // Hosted events keep their room: the host can read the whole conversation
  // again beside Ask Sitca, long after the event ended.
  const [rightTab, setRightTab] = useRemembered<'ask' | 'room'>('sitka.session.right', 'ask')
  const [roomMsgs, setRoomMsgs] = useState<RoomMessage[]>([])
  const [findText, setFindText] = useState('')
  const [briefBusy, setBriefBusy] = useState(false)
  const [roomQs, setRoomQs] = useState<{ topic: string; items: { text: string; at: number; votes: number }[] }[]>([])

  useEffect(() => {
    let cancelled = false
    void window.sitka.listSessionMaterials(sessionId).then((m) => {
      if (!cancelled) setMaterials(m)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const roomEventId = data?.meta.hosted ? data.meta.eventId : undefined
  const roomQCount = roomQs.reduce((n, g) => n + g.items.length, 0)
  const roomLive = data?.meta.status === 'recording'
  useEffect(() => {
    if (!roomEventId) return undefined
    let cancelled = false
    const load = (): void => {
      void window.sitka.listRoomMessages(roomEventId).then((m) => {
        if (!cancelled) setRoomMsgs(m)
      })
      void window.sitka.listSpeakerQuestions(roomEventId).then((q) => {
        if (!cancelled) setRoomQs(q)
      })
    }
    load()
    // while the event is on, the room is read again every few seconds, so
    // the host watching from here sees what the audience says as it comes
    const t = roomLive ? window.setInterval(load, 4000) : null
    return () => {
      cancelled = true
      if (t) clearInterval(t)
    }
  }, [roomEventId, roomLive])

  // Visual memory: the key frames of what was on screen, as a filmstrip.
  useEffect(() => {
    let cancelled = false
    void window.sitka.listSlides(sessionId).then((s) => {
      if (!cancelled) setSlides(s)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshToken])
  const videoRef = useRef<HTMLVideoElement>(null)
  const durationFixedRef = useRef(false)
  const pendingSeekRef = useRef<number | null>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const videoWrapRef = useRef<HTMLDivElement>(null)
  const [chatW, setChatW] = usePersistedNumber('sitka.chatW', 440)
  const [videoH, setVideoH] = usePersistedNumber('sitka.videoH', 320)
  const [videoHidden, setVideoHidden] = usePersistedBool('sitka.videoHidden', false)
  // ---- theatre: the recording fills the screen, Sitca floats beside it ----
  // The same chat panel, restyled as a glass card, so the conversation is
  // never lost when the view changes. Escape, or the browser leaving full
  // screen, brings the page back.
  const [theatre, setTheatre] = useState(false)
  const [theatreChat, setTheatreChat] = useState(false)
  // The player's own full-screen button is the way in. The browser would
  // put the bare video full screen, where nothing of ours can float; so the
  // moment that happens, the page as a whole takes its place — the video
  // fills it, and Sitca can sit beside it. Pressing the button again, or
  // Escape, or the browser leaving full screen, brings the page back.
  // The player's own full-screen control is switched off (it would put the
  // bare video full screen, where nothing of ours can float) and one of ours
  // stands in its place, at the bottom right where that one was. It asks for
  // the whole page full screen, so the picture fills it and Sitca can sit
  // beside it.
  useEffect(() => {
    if (!theatre) return undefined
    const root = document.documentElement
    if (root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen().catch(() => undefined)
    const onChange = (): void => {
      if (!document.fullscreenElement) setTheatre(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTheatre(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('keydown', onKey)
    // a phone turns to fill the screen with the picture, where it allows that
    const o = screen.orientation as ScreenOrientation & { lock?: (k: string) => Promise<void>; unlock?: () => void }
    if (window.innerWidth < 860 && typeof o?.lock === 'function') o.lock('landscape').catch(() => undefined)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('keydown', onKey)
      if (typeof o?.unlock === 'function') {
        try {
          o.unlock()
        } catch {
          /* not held */
        }
      }
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
    }
  }, [theatre])
  // another session, or the page left: back to the ordinary view
  useEffect(() => {
    setTheatre(false)
    setTheatreChat(false)
  }, [sessionId])

  const tabInitializedRef = useRef(false)
  const autoAnalyzedRef = useRef<string | null>(null)

  const [gone, setGone] = useState<'' | 'missing' | 'failed'>('')
  useEffect(() => {
    let cancelled = false
    setGone('')
    // A session that no longer exists (deleted in another tab, a stale link)
    // or one that cannot be fetched must not sit on "Opening" for good.
    const stall = window.setTimeout(() => {
      if (!cancelled) setGone((g) => g || 'failed')
    }, 25000)
    void window.sitka.getSession(sessionId).catch(() => null).then((d) => {
      if (cancelled) return
      window.clearTimeout(stall)
      if (!d) {
        setGone('missing')
        return
      }
      setData(d)
      metaRef.current = d.meta
      // The title and summary are written automatically. If that has not
      // happened yet (the tab was closed, the AI was busy), it happens now.
      if (
        d &&
        d.meta.status === 'complete' &&
        !d.meta.analyzed &&
        d.segments.length > 2 &&
        autoAnalyzedRef.current !== d.meta.id &&
        // just ended: the page that recorded it is writing the title now
        Date.now() - (d.meta.createdAt + (d.meta.durationMs || 0)) > 90000
      ) {
        autoAnalyzedRef.current = d.meta.id
        setReanalyzing(true)
        void window.sitka.reanalyzeSession(d.meta.id).then((m) => {
          setReanalyzing(false)
          if (m) setData((cur) => (cur ? { ...cur, meta: m } : cur))
        })
      }
      // Every session opens the same way: the recording and the overview.
      // Ask, the transcript and the rest are a tap away.
      if (!tabInitializedRef.current && d) {
        tabInitializedRef.current = true
        setTab('overview')
      }
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshToken])

  // MediaRecorder webm files have no seek index, so seeking a streamed source
  // snaps back to 0. Loading the whole file as a blob (read via the main
  // process) makes every byte available locally, so Chromium can seek anywhere.
  const advance = useCallback(
    async (gen: number, note?: string): Promise<void> => {
      if (gen !== loadGenRef.current) return
      const L = ladderRef.current
      if (note) L.tried.push(note)
      const way = L.ways.shift()
      // whatever the last element was doing stops now: no request of the old
      // way lingers under the new one
      const old = videoRef.current
      if (old) {
        try {
          old.pause()
          ;(old as HTMLVideoElement & { srcObject: unknown }).srcObject = null
          old.removeAttribute('src')
          old.load()
        } catch {
          /* already gone */
        }
      }
      wayRef.current++
      durationFixedRef.current = false
      setVideoLive(false)
      if (!way) {
        failWith(L.tried.length > 0 ? L.tried.join('; ') : 'no recording was found in the cloud or on this device')
        return
      }
      try {
        if (way === 'hls') {
          // a phone's own player, handed the recording as a playlist: the
          // pieces by byte range, starting within a second or two
          const url = await window.sitka.videoHls(sessionId).catch(() => null)
          if (gen !== loadGenRef.current) return
          if (!url) {
            void advance(gen)
            return
          }
          diagRef.current = 'the recording as a playlist'
          setVideoSrc(url)
          return
        }
        if (way === 'url') {
          // one whole file by its link: native, progressive, the fastest start
          const url = await window.sitka.videoUrl(sessionId)
          if (gen !== loadGenRef.current) return
          if (!url) {
            void advance(gen)
            return
          }
          diagRef.current = 'the whole file by its link'
          setVideoSrc(url)
          return
        }
        if (way === 'stream') {
          const sized = sizedRef.current.length > 0 ? sizedRef.current : await window.sitka.listVideoPartsSized(sessionId).catch(() => [])
          const parts = sized.length > 0 ? sized.map((p) => p.url) : await window.sitka.listVideoParts(sessionId).catch(() => [])
          if (gen !== loadGenRef.current) return
          if (parts.length === 0 || !hasStreamingEngine()) {
            void advance(gen, parts.length === 0 ? 'no parts in the cloud' : 'no streaming engine in this browser')
            return
          }
          streamPartsRef.current = parts
          streamSizesRef.current = sized.length > 0 ? sized.map((p) => p.size) : null
          diagRef.current = `a stream of ${parts.length} part${parts.length === 1 ? '' : 's'}`
          setVideoSrc('progressive')
          return
        }
        // The parts are already listed with their links: they are fetched
        // straight from the store, all at once, and joined here — no further
        // round trips through the server. Only when nothing was listed is the
        // fuller path taken (parts still on this device, older stores).
        let bytes: Uint8Array | null = null
        const listed = sizedRef.current
        if (listed.length > 0) {
          try {
            const bufs = await Promise.all(
              listed.map(async (p) => {
                const r = await fetch(p.url, { cache: 'no-store' })
                if (!r.ok) throw new Error(`part ${r.status}`)
                return new Uint8Array(await r.arrayBuffer())
              })
            )
            const joined = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0))
            let at = 0
            for (const b of bufs) {
              joined.set(b, at)
              at += b.byteLength
            }
            bytes = joined
          } catch {
            bytes = null
          }
        }
        if (gen !== loadGenRef.current) return
        if (!bytes) bytes = await window.sitka.readVideo(sessionId)
        if (gen !== loadGenRef.current) return
        if (!bytes || bytes.byteLength === 0) {
          void advance(gen, 'no file could be read from the cloud or this device')
          return
        }
        const kind = mediaType(bytes.subarray(0, 12))
        diagRef.current = `the whole file in memory (${kind}, ${(bytes.byteLength / 1048576).toFixed(1)} MB)`
        // A recording still in the recorder's fragments makes the player
        // read the whole of it before the first frame (a minute for a long
        // one). With its index written first, here and now, it starts at
        // once; if the rewrite is refused, the fragments play as they are.
        if (kind === 'video/mp4' && bytes.byteLength < 400 * 1024 * 1024 && isFragmentedMp4(bytes)) {
          try {
            const flat = defragmentMp4(bytes)
            if (flat) {
              bytes = flat
              diagRef.current += ', index first'
            }
          } catch {
            /* as recorded */
          }
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: kind }))
        setVideoSrc(objectUrlRef.current)
      } catch (err) {
        void advance(gen, `${diagRef.current || way}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId]
  )
  // still being recorded (by the extension's engine, or another tab): there
  // is no file to play yet; the words arrive as they are said instead
  const stillRecording = data?.meta.status === 'recording'
  // A recording the cloud is still missing: on opening, this browser is asked
  // whether it holds the rest. If it does, it goes up now, without a press;
  // if not, the page says where it is instead of offering a button that
  // has nothing to send.
  const pendingId = data?.meta.recordingPending ? data.meta.id : null
  useEffect(() => {
    if (!pendingId) return
    let gone = false
    setUploading(true)
    void window.sitka
      .retryUploads(pendingId)
      .then((r) => {
        if (gone) return
        if (r.here !== undefined) setPendingHere(r.here)
        if (r.pending === 0) {
          setData((d) => {
            if (!d || d.meta.id !== pendingId) return d
            const next = { ...d.meta }
            delete next.recordingPending
            return { ...d, meta: next }
          })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!gone) setUploading(false)
      })
    return () => {
      gone = true
    }
  }, [pendingId])
  // Just ended: the last pieces may still be on their way up. The player
  // holds for those few seconds only (or while an upload is known to be
  // pending), then plays the parts as a stream; the whole file is joined
  // in the background and announced when done — nobody waits for it.
  const endedAt = data ? data.meta.createdAt + (data.meta.durationMs || 0) : 0
  const wholeReady = Boolean(data?.meta.whole)
  const [preparingOver, setPreparingOver] = useState(false)
  const joining =
    Boolean(data) &&
    !stillRecording &&
    !wholeReady &&
    !data?.meta.readOnly &&
    !data?.meta.saved &&
    !data?.meta.sample &&
    !data?.meta.audioOnly &&
    Date.now() - endedAt < 180000
  const preparing = joining && !preparingOver && (Boolean(data?.meta.recordingPending) || Date.now() - endedAt < 15000)
  // While another page records this session (the extension's engine, or a
  // laptop watched from a phone), this one reads the row again every few
  // seconds: the words, the conversation from the card, and then the end,
  // the recording and the title as they are written. It keeps reading for a
  // short while after the end, until the title has been written.
  const settledAfterEnd = Boolean(data?.meta.analyzed) || (endedAt > 0 && Date.now() - endedAt > 240000)
  const following = Boolean(data) && !data?.meta.readOnly && !data?.meta.saved && !data?.meta.sample && (stillRecording || !settledAfterEnd)
  useEffect(() => {
    if (!following) return undefined
    let busy = false
    const look = window.setInterval(() => {
      if (busy || document.visibilityState === 'hidden') return
      busy = true
      void window.sitka
        .refreshSession(sessionId)
        .then(() => window.sitka.getSession(sessionId))
        .then((d) => {
          if (d) {
            metaRef.current = d.meta
            setData((cur) => (cur && cur.meta.id === d.meta.id ? d : cur))
          }
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false
        })
    }, 3000)
    return () => window.clearInterval(look)
  }, [following, sessionId])
  useEffect(() => {
    if (!joining) return undefined
    // the hold is short whatever happens: at most half a minute
    const t = window.setTimeout(() => setPreparingOver(true), 30000)
    const look = window.setInterval(() => {
      void window.sitka.refreshSession(sessionId).then((m) => {
        if (m && (m.whole || !m.recordingPending)) setData((d) => (d ? { ...d, meta: { ...d.meta, ...m } } : d))
      })
    }, 4000)
    return () => {
      window.clearTimeout(t)
      window.clearInterval(look)
    }
  }, [joining, sessionId])
  useEffect(() => {
    const gen = ++loadGenRef.current
    loadStartRef.current = Date.now()
    firstFrameSentRef.current = false
    streamNoteRef.current = ''
    durationFixedRef.current = false
    setVideoSrc(null)
    setVideoError(false)
    setVideoLive(false)
    setPlaying(false)
    setMediaDuration(0)
    diagRef.current = ''
    // On an iPhone or iPad the parts stream is the quick start: Safari's own
    // loader is slow to open a long file by its link. Elsewhere the whole
    // file by its link is the quickest, the stream next.
    ladderRef.current = { ways: IOS ? ['hls', 'stream', 'url', 'blob'] : ['url', 'stream', 'blob'], tried: [] }
    if (!videoWanted || stillRecording || preparing) return undefined
    void (async () => {
      // a tab opened in the background waits until it is looked at
      await whenVisible()
      if (gen !== loadGenRef.current) return
      // Remux on first open if needed (desktop): a real duration and seek index.
      await window.sitka.prepareSession(sessionId).catch(() => undefined)
      if (gen !== loadGenRef.current) return
      // The parts and their sizes decide the order of the ways. A small
      // recording (a voice note, a short talk) is fetched whole in one go —
      // quicker than any engine. Sound alone on an iPhone opens by its link
      // or whole: Safari's engine is unsure with a stream that is only sound.
      const sized = await window.sitka.listVideoPartsSized(sessionId).catch(() => [])
      if (gen !== loadGenRef.current) return
      sizedRef.current = sized
      const total = sized.reduce((n, p) => n + p.size, 0)
      // "small" is small on a slow connection too: a voice note, not a lecture.
      // Anything larger plays from its link, which shows a first frame after a
      // few hundred kilobytes rather than after the whole file has arrived.
      const small = sized.length > 0 && total < 3 * 1024 * 1024
      // a small recording needs no more deciding: it goes at once. Otherwise the
      // session's own record may still be on its way: a moment's patience, then decide
      if (!small) for (let i = 0; i < 30 && !metaRef.current; i++) await new Promise((r) => setTimeout(r, 100))
      if (gen !== loadGenRef.current) return
      const audio = Boolean(metaRef.current?.audioOnly)
      ladderRef.current.ways = small
        ? ['blob', 'url', 'stream']
        : audio && IOS
          ? ['url', 'blob', 'stream']
          : IOS
            ? ['stream', 'url', 'blob']
            : ['url', 'stream', 'blob']
      void advance(gen)
    })()
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [sessionId, videoWanted, advance, stillRecording, preparing])

  // A source that shows nothing is not waited on for good: twenty seconds
  // without so much as its length, and the next way is tried.
  useEffect(() => {
    if (!videoSrc || videoSrc === 'progressive') return undefined
    const gen = loadGenRef.current
    const stop = visibleTimeout(10000, () => {
      const v = videoRef.current
      if (gen !== loadGenRef.current || !v || v.readyState >= 1) return
      const src = videoSrc
      // a link that gave nothing is asked directly what it answers, so the
      // account says whether the store or the player was the slow one
      void (async () => {
        let probe = ''
        if (/^https?:/.test(src)) {
          try {
            const t0 = Date.now()
            const r = await fetch(src, { headers: { Range: 'bytes=0-63' } })
            const head = new Uint8Array(await r.arrayBuffer())
            const box = String.fromCharCode(...head.subarray(4, 8))
            // the box after the first (its size is small: the low byte is enough)
            const n = head[3]
            const next = head.length >= n + 8 ? String.fromCharCode(...head.subarray(n + 4, n + 8)) : ''
            probe = ` · probe ${r.status} ${r.headers.get('content-type') ?? '?'} ranges:${r.headers.get('accept-ranges') ?? '-'} ${r.headers.get('content-range') ?? ''} first:${box}${next ? '/' + next : ''} in ${Date.now() - t0} ms`
          } catch (e) {
            probe = ` · probe failed (${e instanceof Error ? e.message : String(e)})`
          }
        }
        if (gen !== loadGenRef.current) return
        void advance(gen, `${diagRef.current} gave nothing in 10 s (network state ${v.networkState}, ready ${v.readyState}, buffered ${v.buffered.length}${v.error ? `, error ${v.error.code}` : ''}${v.isConnected ? '' : ', element detached'}${document.visibilityState !== 'visible' ? ', page hidden' : ''}, src ${v.currentSrc ? v.currentSrc.slice(0, 30) : 'none'})${probe}`)
      })()
    })
    return stop
  }, [videoSrc, advance])

  // A different session: the recording loads straight away, and the mark
  // stays over the player until it has something to show.
  useEffect(() => {
    setVideoWanted(true)
    setVideoLive(false)
    pendingSeekRef.current = null
    // opened afresh: the picture shown, the overview first, the chat put
    // away on a phone until asked for, wherever the last visit ended
    tabInitializedRef.current = false
    setTab('overview')
    setVideoHidden(false)
    setAskOpen(false)
    setRightTab('ask')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Streaming: once the player is mounted, feed it the parts in order. The
  // first plays as soon as it lands; the rest follow while it plays.
  const streamPartsRef = useRef<string[]>([])
  const streamSizesRef = useRef<number[] | null>(null)
  useEffect(() => {
    if (videoSrc !== 'progressive') return undefined
    const v = videoRef.current
    const parts = streamPartsRef.current
    const sizes = streamSizesRef.current
    if (!v || parts.length === 0) return undefined
    let cancelled = false
    const durationSec = data?.meta.durationMs ? data.meta.durationMs / 1000 : undefined
    // with sizes the parts are one stream: a quick start, jumps served from
    // where they land, a buffer that lets go of what was watched
    const run = sizes
      ? streamMedia(v, sourceFromParts(parts.map((url, i) => ({ url, size: sizes[i] }))), {
          durationSec,
          note: (why) => {
            streamNoteRef.current = why
          }
        })
      : playProgressively(
          v,
          parts.length,
          async (i) => {
            const r = await fetch(parts[i], { cache: 'no-store' })
            if (!r.ok) throw new Error(`part ${i}: ${r.status}`)
            return r.arrayBuffer()
          },
          { durationSec, lookahead: 3 }
        )
    const gen = loadGenRef.current
    const way = wayRef.current
    // ten seconds without a first frame is a stream that will not come. The
    // hand-over happens once: whichever of the two notices first cancels the
    // other, so the way after this one is never skipped by a late watchdog.
    const handOver = (why: string): void => {
      if (cancelled || gen !== loadGenRef.current || way !== wayRef.current) return
      cancelled = true
      streamPartsRef.current = []
      void advance(gen, why)
    }
    const stopWatch = visibleTimeout(10000, () => {
      if (!videoRef.current || videoRef.current.readyState >= 1) return
      handOver(`${diagRef.current} gave nothing in 10 s`)
    })
    void run.then((ok) => {
      // this file cannot be streamed: the next way
      if (!ok) handOver(`${diagRef.current} could not be streamed${streamNoteRef.current ? ` — ${streamNoteRef.current}` : ''}`)
    })
    return () => {
      cancelled = true
      stopWatch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc, sessionId])

  // MediaRecorder webm files report Infinity duration; force Chrome to compute
  // the real duration by jumping far ahead once, then settling back.
  const onLoadedMetadata = useCallback((): void => {
    const v = videoRef.current
    if (!v || durationFixedRef.current) return
    if (!Number.isFinite(v.duration)) {
      const onSeeked = (): void => {
        v.removeEventListener('seeked', onSeeked)
        durationFixedRef.current = true
        v.currentTime = pendingSeekRef.current ?? 0
        if (pendingSeekRef.current !== null) {
          pendingSeekRef.current = null
          void v.play().catch(() => undefined)
        }
      }
      v.addEventListener('seeked', onSeeked)
      v.currentTime = Number.MAX_SAFE_INTEGER / 1e6
    } else {
      durationFixedRef.current = true
      if (pendingSeekRef.current !== null) {
        v.currentTime = pendingSeekRef.current
        pendingSeekRef.current = null
        void v.play().catch(() => undefined)
      }
    }
  }, [])

  const seek = useCallback((seconds: number): void => {
    const v = videoRef.current
    if (!v || !durationFixedRef.current) {
      // Video still loading or duration not repaired yet — apply once ready.
      // A jump to a moment also asks for the recording when it is still folded.
      pendingSeekRef.current = seconds
      setVideoWanted(true)
      return
    }
    v.currentTime = seconds
    void v.play().catch(() => undefined)
  }, [])

  // Deep-link seek (Brain citation / palette hit) — queued until video is ready.
  useEffect(() => {
    if (initialSeek !== undefined) seek(initialSeek)
  }, [initialSeek, seekNonce, seek])

  // Load the highlight reel (if one has been rendered) as a local blob.
  const reelStamp = data?.meta.reelGeneratedAt
  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setReelSrc(null)
    if (!reelStamp) return undefined
    void window.sitka.readVideo(sessionId, 'reel').then((bytes) => {
      if (cancelled || !bytes || bytes.byteLength === 0) return
      url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType(bytes.subarray(0, 12)) }))
      setReelSrc(url)
    })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [sessionId, reelStamp])

  const makeReel = (): void => {
    setReelBusy(true)
    setReelError(null)
    void window.sitka.generateReel(sessionId).then((res) => {
      setReelBusy(false)
      if (res.error) setReelError(res.error)
      else
        setData((d) =>
          d ? { ...d, meta: { ...d.meta, reelGeneratedAt: Date.now() } } : d
        )
    })
  }

  if (!data) {
    if (gone) {
      return (
        <div className="content">
          <div className="empty">
            <div className="empty-title">
              {gone === 'missing' ? 'This session is no longer here' : 'This session could not be opened'}
            </div>
            <div style={{ maxWidth: 420, margin: '0 auto 20px' }}>
              {gone === 'missing'
                ? 'It may have been deleted, or the link is out of date.'
                : 'Check your connection, then try again.'}
            </div>
            <button className="btn btn-primary" onClick={() => window.dispatchEvent(new Event('sitka:home'))}>
              Back to the library
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="content">
        <Loading words={LOADING_WORDS.session} />
      </div>
    )
  }

  const { meta, segments, chat } = data
  const highlights = meta.highlights ?? []
  const marks = data.marks ?? []

  const snippetAt = (t: number): string => {
    const seg =
      segments.find((s) => t >= s.start && t < s.end) ??
      segments.reduce<(typeof segments)[number] | null>(
        (best, s) =>
          !best || Math.abs(s.start - t) < Math.abs(best.start - t) ? s : best,
        null
      )
    return seg ? seg.text : 'Marked moment'
  }

  return (
    <div className={`session-layout${askOpen ? ' ask-open' : ''}`} ref={layoutRef}>
      <div className="session-left">
        <div className="session-header">
          <div className="session-header-row">
            {renaming ? (
              <input
                className="input"
                style={{ fontSize: 17, fontWeight: 650, maxWidth: 480 }}
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(false)
                  if (e.key === 'Enter') {
                    setRenaming(false)
                    const next = titleDraft.trim()
                    if (next && next !== meta.title) {
                      void window.sitka.renameSession(meta.id, next)
                      setData((d) =>
                        d ? { ...d, meta: { ...d.meta, title: next } } : d
                      )
                    }
                  }
                }}
                onBlur={() => setRenaming(false)}
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <h1>{meta.title}</h1>
                <button
                  className="btn btn-ghost btn-sm"
                  title="Rename session"
                  onClick={() => {
                    setTitleDraft(meta.title)
                    setRenaming(true)
                  }}
                >
                  <IconEdit size={13} />
                </button>
              </div>
            )}
            <span className="duration-chip">{formatDuration(meta.durationMs)}</span>
            {meta.readOnly && <span className="lib-badge" title="Shared with you through an organisation space">Shared</span>}
            {meta.status === 'complete' && !meta.readOnly && (
              <>
                <button
                  className={`btn btn-sm ${showMaterials ? '' : 'btn-ghost'}`}
                  style={{ marginLeft: 'auto' }}
                  title="Slides, notes and readings Sitca uses for this session"
                  onClick={() => {
                    setShowMaterials((v) => !v)
                    setSharing(false)
                  }}
                >
                  <IconDoc size={13} />
                  Materials{materials.length > 0 ? ` · ${materials.length}` : ''}
                </button>
                <button
                  className={`btn btn-sm ${meta.recapUrl ? '' : 'btn-ghost'}`}
                  title="Share this session as a recap page"
                  onClick={() => {
                    setSharing((v) => !v)
                    setShowMaterials(false)
                  }}
                >
                  <IconShare size={13} />
                  {meta.recapUrl ? 'Shared' : 'Share'}
                </button>
              </>
            )}
          </div>
          <div className="session-meta-row">
            <span>{formatDate(meta.createdAt)}</span>
            {!meta.analyzed && meta.status === 'complete' && segments.length > 0 && (
              <span title={meta.analysisError}>
                ·{' '}
                {reanalyzing
                  ? 'writing the title and summary…'
                  : meta.analysisError
                    ? 'summary not ready yet — Sitca will try again next time you open this session'
                    : 'summary pending'}
              </span>
            )}
          </div>
          {showMaterials && (
            <div className="share-card" style={{ display: 'block' }}>
              <MaterialsPanel
                materials={materials}
                onAdd={async (name, text) =>
                  setMaterials(await window.sitka.addSessionMaterial(meta.id, name, text))
                }
                onRemove={async (mid) =>
                  setMaterials(await window.sitka.removeSessionMaterial(meta.id, mid))
                }
              />
            </div>
          )}
          {sharing && (
            <ShareCard
              meta={meta}
              onChange={(url) =>
                setData((d) =>
                  d ? { ...d, meta: { ...d.meta, recapUrl: url ?? undefined } } : d
                )
              }
              onClose={() => setSharing(false)}
            />
          )}
        </div>

        {meta.recordingPending && (
          <div className="pending-bar">
            <Mark size={14} live={uploading} />
            <span>
              {uploading
                ? 'Sending the rest of this recording to the cloud…'
                : pendingHere === false
                  ? `The recording is on ${meta.recordedOn ?? 'the browser that recorded it'}, not this one. Open Sitca there — it sends it up by itself. The transcript, notes and answers work here already.`
                  : 'Part of this recording is still on this device. It goes up on its own as soon as the connection allows.'}
            </span>
            {!uploading && pendingHere !== false && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  setUploading(true)
                  void window.sitka.retryUploads(meta.id).then((r) => {
                    setUploading(false)
                    if (r.here !== undefined) setPendingHere(r.here)
                    if (r.pending === 0) {
                      setData((d) => {
                        if (!d) return d
                        const next = { ...d.meta }
                        delete next.recordingPending
                        return { ...d, meta: next }
                      })
                    }
                  })
                }}
              >
                Upload now
              </button>
            )}
            {videoSrc && videoSrc !== 'progressive' && (
              <a className="btn btn-ghost btn-sm" href={videoSrc} download={`${meta.title.replace(/[^\w-]+/g, '-')}.${meta.mime === 'video/mp4' ? 'mp4' : 'webm'}`}>
                Save a copy
              </a>
            )}
            {(window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true &&
              !meta.readOnly &&
              !meta.audioOnly &&
              meta.mime !== 'video/mp4' &&
              (phonePrep && !phonePrep.error ? (
                <span className="phone-prep">
                  <Mark size={13} live /> Preparing for phones · {phonePrep.pct}% · keep this tab open
                </span>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  title="Recorded before phones were supported: this makes a copy every phone can play. It takes as long as the recording and runs in this tab."
                  onClick={() => {
                    setPhonePrep({ pct: 0 })
                    void window.sitka.convertForPhones(meta.id).then((r) => {
                      if (!r.ok) setPhonePrep({ pct: 0, error: r.error || 'Could not prepare it.' })
                    })
                  }}
                >
                  Prepare for phones
                </button>
              ))}
            {phonePrep?.error && <span className="phone-prep bad">{phonePrep.error}</span>}
          </div>
        )}
        {preparing && (
          <div className="live-block" style={{ margin: '12px 24px 0' }}>
            <Mark size={14} live />
            <div className="live-block-text">
              <b>Finishing up…</b>
            </div>
          </div>
        )}
        {meta.status === 'recording' && (
          <div className="live-block" style={{ margin: '12px 24px 0' }}>
            <span className="live-block-dot" />
            <div className="live-block-text">
              <b>Live now.</b>
              <span>
                The words arrive here as they are said. Ask anything about what has been covered so far;
                the recording appears when the session ends.
              </span>
            </div>
          </div>
        )}
        <div
          className={`video-wrap${meta.audioOnly ? ' audio-only' : ''}${videoHidden ? ' collapsed' : ''}${theatre ? ' theatre' : ''}`}
          ref={videoWrapRef}
          style={
            theatre
              ? undefined
              : {
                  height: videoHidden ? 40 : meta.audioOnly ? Math.min(clamp(videoH, 140, 900), 220) : clamp(videoH, 140, 900),
                  display: meta.status === 'recording' || preparing ? 'none' : undefined
                }
          }
        >
          {!theatre && (
            <button
              className="video-toggle"
              onClick={() => setVideoHidden(!videoHidden)}
              title={videoHidden ? 'Show the picture' : 'Hide the picture — the sound keeps playing'}
            >
              <IconChevron size={13} strokeWidth={2.4} />
              {videoHidden ? 'Show video' : 'Hide'}
            </button>
          )}
          {!meta.audioOnly && !videoHidden && videoSrc && (
            <button
              type="button"
              className="video-fullscreen"
              onClick={() => {
                setTheatre(!theatre)
                setTheatreChat(false)
              }}
              title={theatre ? 'Exit full screen (Esc)' : 'Full screen'}
              aria-label={theatre ? 'Exit full screen' : 'Full screen'}
            >
              {theatre ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
              )}
            </button>
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
                <small>about what you are watching</small>
              </span>
            </button>
          )}
          {!meta.sample && !theatre && (!meta.readOnly || meta.saved) && (
            <button
              className="video-toggle video-download"
              onClick={downloadRecording}
              disabled={downloading === 'busy'}
              title="Save the recording as a file on this device"
            >
              <IconDownload size={13} strokeWidth={2.2} />
              {downloading === 'busy' ? 'Fetching…' : downloading === 'done' ? 'Saved ✓' : downloading === 'none' ? 'Nothing to save yet' : 'Download'}
            </button>
          )}
          {!meta.sample && !theatre && (!meta.readOnly || meta.saved) && (
            <button
              className={`video-toggle video-drive${drive?.stage === 'done' ? ' done' : ''}`}
              onClick={() => (drive?.stage === 'done' && drive.folderUrl ? window.open(drive.folderUrl, '_blank', 'noopener') : saveToDrive())}
              title="Save the recording and a Google Doc of the notes to your Google Drive, in a Sitca folder"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3h8l6 10-4 7H6l-4-7z" />
                <path d="M8 3l6 10M2 13h12" />
              </svg>
              {!drive || drive.stage === '' ? 'Save to Drive'
                : drive.stage === 'asking' ? 'Asking Google…'
                : drive.stage === 'reading' ? 'Reading…'
                : drive.stage === 'sending' ? `Sending ${drive.total ? Math.round((drive.sent / drive.total) * 100) : 0}%`
                : drive.stage === 'writing' ? 'Writing the notes…'
                : drive.stage === 'done' ? 'In Drive · open'
                : 'Could not save · retry'}
            </button>
          )}
          {videoSrc ? (
            <>
              <video
                // a new element for every way tried: a player that has wedged
                // on one source (its load never starting, its engine never
                // opening) is thrown away rather than asked again
                key={`${sessionId}:${wayRef.current}`}
                ref={videoRef}
                src={videoSrc === 'progressive' ? undefined : videoSrc}
                poster={poster ?? undefined}
                controls={!meta.audioOnly}
                crossOrigin={meta.audioOnly ? 'anonymous' : undefined}
                onClick={tapToPlay}
                playsInline
                controlsList="nofullscreen"
                preload={meta.audioOnly ? 'auto' : 'metadata'}
                onLoadedMetadata={(e) => {
                  const el = e.currentTarget
                  setMediaDuration(el.duration)
                  // a length of nothing is a file the browser could not read:
                  // it would "play" to its end at once. The next way is tried.
                  const expected = (meta.durationMs || 0) / 1000
                  if (el.duration === 0 || Number.isNaN(el.duration) || (expected > 5 && el.duration < 1)) {
                    streamPartsRef.current = []
                    void advance(loadGenRef.current, `${diagRef.current} read as ${Number.isNaN(el.duration) ? 'unreadable' : `${el.duration.toFixed(2)} s long`} for a session of ${Math.round(expected)} s`)
                    return
                  }
                  onLoadedMetadata()
                }}
                onDurationChange={(e) => setMediaDuration(e.currentTarget.duration)}
                onLoadedData={() => {
                  setVideoLive(true)
                  firstFrame()
                }}
                onCanPlay={() => setVideoLive(true)}
                onPlaying={() => {
                  setVideoLive(true)
                  setPlaying(true)
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onError={(e) => {
                  // The link did not open, the stream broke, or the file was
                  // refused: never a dead player, the next way is tried.
                  const el = e.currentTarget as HTMLVideoElement
                  const code = el.error?.code
                  const msg = el.error?.message ? ` ${el.error.message.slice(0, 80)}` : ''
                  streamPartsRef.current = []
                  void advance(loadGenRef.current, `${diagRef.current} would not play (code ${code ?? '?'}${msg})`)
                }}
              />
              {!videoLive && !meta.audioOnly && (
                <div className="video-waiting">
                  <Loading compact onDark words={LOADING_WORDS.recording} delay={0} />
                  {meta.recordingPending && (
                    <div className="video-waiting-note">
                      The last parts are still uploading from the device that recorded it. Keep
                      that page open until the recording appears.
                    </div>
                  )}
                </div>
              )}
              {meta.audioOnly && (
                <div className={`audio-overlay${meta.banner ? ' with-banner' : ''}${playing ? ' playing' : ''}`}>
                  {meta.banner ? (
                    <img className="audio-banner" src={meta.banner} alt="" />
                  ) : (
                    <div className="voice-mark">
                      <span className="voice-bars" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="voice-mark-text">
                        <IconMic size={14} strokeWidth={1.8} /> Voice recording
                      </span>
                    </div>
                  )}
                  <div className="voice-bar" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="voice-play"
                      title={playing ? 'Pause' : 'Play'}
                      onClick={() => {
                        // a phone may not fetch a sound until a tap asks for it:
                        // the tap itself starts the load, then the playing
                        const v = videoRef.current
                        if (!v) return
                        if (!v.paused) {
                          userPausedRef.current = true
                          v.pause()
                          return
                        }
                        userPausedRef.current = false
                        if (v.readyState === 0 && videoSrc !== 'progressive') v.load()
                        const gen = loadGenRef.current
                        const from = v.currentTime
                        const state = (): string => {
                          const played = v.played.length ? `${v.played.start(0).toFixed(1)}–${v.played.end(v.played.length - 1).toFixed(1)}` : 'none'
                          return `length ${v.duration}, at ${v.currentTime.toFixed(2)}, ready ${v.readyState}, network ${v.networkState}, ${v.paused ? 'paused' : 'playing'}${v.ended ? ', ended' : ''}${v.muted ? ', muted' : ''}, rate ${v.playbackRate}, played ${played}${v.error ? `, error ${v.error.code}` : ''}`
                        }
                        const stalled = (why: string): void => {
                          if (gen !== loadGenRef.current) return
                          const d = `${diagRef.current}: ${why} (${state()})`
                          streamPartsRef.current = []
                          pendingSeekRef.current = Math.max(0, from) // the next way starts playing on its own
                          void advance(gen, d)
                        }
                        v.play()
                          .then(() => {
                            // playing, but not moving: four seconds without the clock advancing
                            window.setTimeout(() => {
                              if (gen !== loadGenRef.current || userPausedRef.current) return
                              const expected = (meta.durationMs || 0) / 1000
                              if (v.paused && !v.ended) stalled('play stopped by itself')
                              else if (v.currentTime - from < 0.25) stalled('play did not move')
                              else if (v.ended && v.currentTime < 1 && expected > 5) stalled('it ended at once')
                            }, 4000)
                          })
                          .catch((err) => {
                            const name = err instanceof Error ? err.name : String(err)
                            // a load that replaced this one aborted its play: the new one plays on its own
                            if (name === 'AbortError') {
                              pendingSeekRef.current = Math.max(0, from)
                              return
                            }
                            stalled(`play was refused (${name})`)
                          })
                      }}
                    >
                      {playing ? <IconPause size={16} strokeWidth={2.6} /> : <IconPlay size={16} strokeWidth={2.2} />}
                    </button>
                    {(() => {
                      const total =
                        Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : (meta.durationMs || 0) / 1000
                      return (
                        <>
                          <span className="voice-time">{formatTime(Math.min(currentTime, total || currentTime))}</span>
                          <input
                            type="range"
                            className="voice-scrub"
                            min={0}
                            max={Math.max(1, Math.floor(total))}
                            step={1}
                            value={Math.min(Math.floor(currentTime), Math.max(1, Math.floor(total)))}
                            disabled={!videoLive}
                            onChange={(e) => {
                              const t = Number(e.currentTarget.value)
                              setCurrentTime(t)
                              seek(t)
                            }}
                            aria-label="Position"
                          />
                          <span className="voice-time voice-total">
                            {videoLive ? formatTime(total) : diagRef.current ? 'Loading…' : 'Opening…'}
                          </span>
                        </>
                      )
                    })()}
                    <label className="voice-loud" title={`Loudness ${Math.round(loud * 100)}%`}>
                      <IconSpeaker size={14} strokeWidth={1.9} />
                      <input
                        type="range"
                        min={0}
                        max={3}
                        step={0.1}
                        value={loud}
                        onChange={(e) => setLoud(Number(e.currentTarget.value))}
                        aria-label="Loudness"
                      />
                      {loud > 1 && <span className="voice-loud-x">{loud.toFixed(1)}×</span>}
                    </label>
                    <button
                      type="button"
                      className="voice-rate"
                      title="Speed"
                      onClick={() => {
                        const next = rate >= 2 ? 1 : rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : 2
                        setRate(next)
                        if (videoRef.current) videoRef.current.playbackRate = next
                      }}
                    >
                      {rate}×
                    </button>
                    <button
                      type="button"
                      className="voice-dl"
                      title="Download the recording"
                      onClick={() =>
                        void window.sitka.readVideo(sessionId).then((bytes) => {
                          if (!bytes || bytes.byteLength === 0) return
                          const kind = mediaType(bytes.subarray(0, 12))
                          const copy = new ArrayBuffer(bytes.byteLength)
                          new Uint8Array(copy).set(bytes)
                          void window.sitka.saveBinaryFile(`${meta.title.replace(/[^\w\- ]+/g, '').trim() || 'recording'}.${kind === 'video/mp4' ? 'm4a' : 'webm'}`, copy)
                        })
                      }
                    >
                      <IconDownload size={15} strokeWidth={1.9} />
                    </button>
                  </div>
                  {!meta.readOnly && (
                    <FilePick
                      documents={false}
                      multiple={false}
                      onFiles={(files) => {
                        const f = files[0]
                        if (!f) return
                        void shrinkImageFile(f, 1280, 0.8).then(async (url) => {
                          const m = await window.sitka.setSessionBanner(meta.id, url)
                          if (m) setData((d) => (d ? { ...d, meta: m } : d))
                        })
                      }}
                    >
                      {(open) => (
                        <button type="button" className="banner-set" title="A picture shown here instead of video" onClick={open}>
                          {meta.banner ? 'Change banner' : 'Add banner'}
                        </button>
                      )}
                    </FilePick>
                  )}
                  {!meta.readOnly && meta.banner && (
                    <button
                      type="button"
                      className="banner-set banner-clear"
                      onClick={() => {
                        void window.sitka.setSessionBanner(meta.id, null).then((m) => {
                          if (m) setData((d) => (d ? { ...d, meta: m } : d))
                        })
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.5)',
                fontSize: 13,
                width: '100%'
              }}
            >
              {meta.readOnly && !meta.saved && !meta.spaceId ? (
                'The recording stays with the person who captured it. The transcript, notes and answers are all here.'
              ) : videoError ? (
                <div className="video-failed">
                  <div>{meta.recordingPending ? 'This recording has not reached the cloud yet.' : 'The recording is taking longer than usual to open.'}</div>
                  {meta.recordingPending ? (
                    <div className="video-failed-why">
                      {pendingHere === false
                        ? `It is on ${meta.recordedOn ?? 'the browser that recorded it'}, not this one. Open Sitca there and it sends it up by itself.`
                        : 'It is on this device and is being sent up now.'}
                    </div>
                  ) : (
                    <div className="video-failed-why">Try again in a moment, or download the file to watch it on your device.</div>
                  )}
                  {!meta.recordingPending && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setVideoError(false)
                        ladderRef.current = { ways: [], tried: [] }
                        loadGenRef.current++
                        setVideoWanted(false)
                        window.setTimeout(() => setVideoWanted(true), 50)
                      }}
                    >
                      Try again
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void window.sitka.readVideo(sessionId).then((bytes) => {
                        if (!bytes || bytes.byteLength === 0) return
                        const kind = mediaType(bytes.subarray(0, 12))
                        const copy = new ArrayBuffer(bytes.byteLength)
                        new Uint8Array(copy).set(bytes)
                        void window.sitka.saveBinaryFile(`${meta.title.replace(/[^\w\- ]+/g, '').trim() || 'recording'}.${kind === 'video/mp4' ? 'mp4' : 'webm'}`, copy)
                      })
                    }
                  >
                    Download the file
                  </button>
                  {/* the browser's own player, as a last resort and as a test: if this plays, the file is sound */}
                  {nativeSrc ? (
                    <audio className="video-failed-native" controls src={nativeSrc} />
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        void window.sitka.readVideo(sessionId).then((bytes) => {
                          if (!bytes || bytes.byteLength === 0) return
                          setNativeSrc(URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType(bytes.subarray(0, 12)) })))
                        })
                      }
                    >
                      Try the browser’s own player
                    </button>
                  )}
                </div>
              ) : !videoWanted ? (
                <button
                  type="button"
                  className="video-gate"
                  onClick={() => setVideoWanted(true)}
                  title="Fetch the recording"
                >
                  <span className="video-gate-ring">
                    <IconPlay size={20} strokeWidth={2.2} />
                  </span>
                  <span className="video-gate-text">
                    Play the recording
                    {meta.durationMs ? ` · ${formatDuration(meta.durationMs)}` : ''}
                  </span>
                  <span className="video-gate-sub">Loads when you tap</span>
                </button>
              ) : (
                <Loading compact onDark words={LOADING_WORDS.recording} />
              )}
            </div>
          )}
        </div>
        <Splitter
          direction="horizontal"
          onMove={(_x, y) => {
            const top = videoWrapRef.current?.getBoundingClientRect().top
            if (top === undefined) return
            setVideoH(clamp(y - top, 140, Math.round(window.innerHeight * 0.75)))
          }}
          onReset={() => setVideoH(320)}
        />

        {slides.length > 0 && (
          <div className="filmstrip" title="What was on screen — tap a frame to jump there">
            {slides.map((s, i) => {
              const next = slides[i + 1]?.time ?? Number.POSITIVE_INFINITY
              const active = currentTime >= s.time && currentTime < next
              return (
                <button
                  key={`${s.time}-${i}`}
                  className={`film${active ? ' active' : ''}`}
                  title={s.text}
                  onClick={() => seek(s.time)}
                >
                  <img src={s.image} alt="" loading="lazy" />
                  <span className="film-time">{formatTime(s.time)}</span>
                </button>
              )
            })}
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
            className={`btn btn-sm ${tab === 'overview' ? '' : 'btn-ghost'}`}
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
          <button
            className={`btn btn-sm ${tab === 'notes' ? '' : 'btn-ghost'}`}
            onClick={() => setTab('notes')}
          >
            Notes
          </button>
          <button
            className={`btn btn-sm ${tab === 'transcript' ? '' : 'btn-ghost'}`}
            onClick={() => setTab('transcript')}
          >
            Transcript
          </button>
          {meta.hosted ? (
            <button
              className={`btn btn-sm ${tab === 'report' ? '' : 'btn-ghost'}`}
              onClick={() => setTab('report')}
            >
              Event report
            </button>
          ) : (
            // flashcards and a quiz are for something that was taught: a
            // lecture, or anything filed under education. A meeting's page
            // does not offer to quiz the person on it.
            (meta.kind === 'lecture' || meta.space === 'education' || tab === 'study') && (
              <button
                className={`btn btn-sm ${tab === 'study' ? '' : 'btn-ghost'}`}
                onClick={() => setTab('study')}
              >
                Study
              </button>
            )
          )}
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 'auto' }}
            title="Copy this tab's content"
            onClick={() => {
              // the event report has no export of its own: the overview stands in
              void window.sitka.getExportText(meta.id, tab === 'report' ? 'overview' : tab).then((text) => {
                if (!text) return
                void copyRich(text).then((ok) => {
                  if (ok) {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }
                })
              })
            }}
          >
            <IconCopy size={13} />
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title={tab === 'transcript' ? 'Export the transcript as a text file' : 'Export a clean brief of this session, written by Sitca, as a document to send on (opens in Word and Google Docs)'}
            disabled={briefBusy}
            onClick={() => {
              if (tab === 'transcript' || meta.sample || meta.status !== 'complete') {
                void window.sitka.exportSession(meta.id, tab === 'report' ? 'overview' : tab).then((res) => {
                  if (res.ok) {
                    setExported(true)
                    setTimeout(() => setExported(false), 2000)
                  }
                })
                return
              }
              setBriefBusy(true)
              void window.sitka.sessionBrief(meta.id).then((r) => {
                setBriefBusy(false)
                if (!r.html) {
                  const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
                  report?.('brief', `brief failed for ${meta.id}: ${r.error || 'no page'}`)
                  return
                }
                const name = (r.title || meta.title).replace(/[^\w\- ]+/g, '').trim() || 'brief'
                const bytes = new TextEncoder().encode(r.html)
                const copy = new ArrayBuffer(bytes.byteLength)
                new Uint8Array(copy).set(bytes)
                void window.sitka.saveBinaryFile(`${name} — brief.doc`, copy)
                setExported(true)
                setTimeout(() => setExported(false), 2000)
              })
            }}
          >
            <IconDownload size={13} />
            {briefBusy ? 'Writing…' : exported ? 'Exported ✓' : 'Export'}
          </button>
        </div>

        {tab === 'transcript' && (
          <>
            <SpeakersBar
              speakers={meta.speakers}
              at={meta.speakersAt}
              error={meta.speakersError}
              canIdentify={
                meta.status === 'complete' && !meta.readOnly && !meta.saved && !meta.sample && Boolean(meta.whole || segments.length > 0)
              }
              busy={speakersBusy}
              onIdentify={() => {
                setSpeakersBusy(true)
                void window.sitka.identifySpeakers(meta.id).then((res) => {
                  setSpeakersBusy(false)
                  setData((d) => {
                    if (!d) return d
                    if (res.error) return { ...d, meta: { ...d.meta, speakersError: res.error } }
                    const m = { ...d.meta, speakers: res.speakers, speakersAt: Date.now() }
                    delete m.speakersError
                    return { ...d, meta: m, segments: res.segments ?? d.segments }
                  })
                })
              }}
              onListen={seek}
              onName={async (id, name) => {
                const res = await window.sitka.nameSpeaker(meta.id, id, name)
                if (res.speakers) setData((d) => (d ? { ...d, meta: { ...d.meta, speakers: res.speakers } } : d))
              }}
              naming={naming}
              onNamingDone={namingDone}
            />
            {segments.length > 8 && (
              <div className="transcript-find">
                <input
                  className="input"
                  value={findText}
                  placeholder="Find a word in the session…"
                  onChange={(e) => setFindText(e.target.value)}
                  spellCheck={false}
                />
                {findText && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setFindText('')}>
                    Clear
                  </button>
                )}
              </div>
            )}
            <TranscriptPane
              segments={segments}
              query={findText}
              currentTime={currentTime}
              onSeek={seek}
              followLive={meta.status === 'recording' && !findText}
              emptyText={meta.status === 'recording' ? 'Listening — the words appear here as they are said.' : 'No transcript was captured for this session.'}
              speakers={meta.speakers}
              onSpeaker={meta.readOnly || meta.saved ? undefined : setNaming}
            />
          </>
        )}

        {tab === 'notes' &&
          (data.notes ? (
            <NotesPane notes={data.notes} onSeek={seek} emptyText="" />
          ) : (
            <div className="transcript">
              <div className="empty" style={{ padding: '48px 24px' }}>
                <div className="empty-icon">
                  <IconNotes size={28} strokeWidth={1.4} />
                </div>
                <div className="empty-title">No notes yet</div>
                <div style={{ marginBottom: 18, maxWidth: 380, marginInline: 'auto' }}>
                  Sitca can write organized notes for this session — key points,
                  definitions, and the questions that were asked.
                </div>
                {notesError && (
                  <div className="notice notice-error" style={{ textAlign: 'left' }}>
                    <span>{notesError}</span>
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  disabled={notesGenerating || segments.length === 0}
                  onClick={() => {
                    setNotesGenerating(true)
                    setNotesError(null)
                    void window.sitka.updateNotes(meta.id).then((res) => {
                      setNotesGenerating(false)
                      if (res.notes) {
                        setData((d) => (d ? { ...d, notes: res.notes! } : d))
                      } else {
                        setNotesError(
                          res.error === 'missing-key'
                            ? 'Add an AI key in Settings first.'
                            : res.error ?? 'Could not generate notes — please try again.'
                        )
                      }
                    })
                  }}
                >
                  {notesGenerating ? 'Writing notes…' : 'Generate notes'}
                </button>
                {segments.length === 0 && (
                  <div className="field-hint" style={{ marginTop: 10 }}>
                    This session has no transcript to take notes from.
                  </div>
                )}
              </div>
            </div>
          ))}

        {tab === 'report' && (
          <ReportPane
            sessionId={meta.id}
            report={data.report}
            hasChatKey={hasChatKey}
            initialUrl={meta.replayUrl ?? null}
            onUpdated={(r) => setData((d) => (d ? { ...d, report: r } : d))}
          />
        )}

        {tab === 'study' && (
          <StudyPane
            study={data.study}
            generating={studyGenerating}
            error={studyError}
            hasTranscript={segments.length > 0}
            onGenerate={() => {
              setStudyGenerating(true)
              setStudyError(null)
              void window.sitka.generateStudy(meta.id).then((res) => {
                setStudyGenerating(false)
                if (res.error) setStudyError(res.error)
                else if (res.study)
                  setData((d) => (d ? { ...d, study: res.study! } : d))
              })
            }}
          />
        )}

        {tab === 'overview' && (
          <div className="transcript">
            {marks.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: 4 }}>
                  Your marks
                </div>
                {marks.map((t, i) => (
                  <div key={`mk-${i}`} className="highlight-row" onClick={() => seek(t)}>
                    <IconStar size={13} />
                    <span className="ts" style={{ textAlign: 'left', minWidth: 48 }}>
                      {formatTime(t)}
                    </span>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {snippetAt(t)}
                    </span>
                  </div>
                ))}
              </>
            )}

            <div className="section-title" style={{ marginTop: marks.length > 0 ? 24 : 4 }}>
              Highlight reel
            </div>
            {reelSrc ? (
              <div style={{ marginBottom: 8 }}>
                <video
                  src={reelSrc}
                  controls
                  onClick={tapToPlay}
                  playsInline
                  style={{
                    width: '100%',
                    maxHeight: 260,
                    background: '#000',
                    borderRadius: 10
                  }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      void window.sitka.saveReel(meta.id).then((res) => {
                        if (res.ok) {
                          setReelSaved(true)
                          setTimeout(() => setReelSaved(false), 2000)
                        }
                      })
                    }}
                  >
                    {reelSaved ? 'Saved ✓' : 'Save video…'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={makeReel} disabled={reelBusy}>
                    {reelBusy ? 'Rendering…' : 'Regenerate'}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: 8 }}>
                <p className="summary-block" style={{ marginBottom: 10 }}>
                  Turn this session's key moments into one short shareable video.
                </p>
                {reelError && (
                  <div className="notice notice-error">
                    <span>{reelError}</span>
                  </div>
                )}
                <button className="btn btn-primary btn-sm" onClick={makeReel} disabled={reelBusy}>
                  {reelBusy ? 'Rendering… (this can take a minute)' : 'Create highlight reel'}
                </button>
              </div>
            )}

            {meta.summary ? (
              <>
                <div className="section-title" style={{ marginTop: 4 }}>
                  Summary
                </div>
                <p className="summary-block">{meta.summary}</p>
                {highlights.length > 0 && (
                  <>
                    <div className="section-title">Key moments</div>
                    {highlights.map((h, i) => {
                      const secs = parseTimestamp(h.time)
                      return (
                        <div
                          key={i}
                          className="highlight-row"
                          onClick={() => secs !== null && seek(secs)}
                        >
                          <IconStar size={13} />
                          <span className="ts" style={{ textAlign: 'left', minWidth: 48 }}>
                            {h.time}
                          </span>
                          <span>{h.label}</span>
                        </div>
                      )
                    })}
                  </>
                )}
              </>
            ) : (
              <div className="transcript-waiting">
                {segments.length === 0
                  ? 'No transcript — Sitca could not analyze this session.'
                  : 'Summary not ready yet.'}
              </div>
            )}
          </div>
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
      <div
        className={`session-right${theatre ? (theatreChat ? ' theatre-open' : ' theatre-hidden') : ''}`}
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
        {roomEventId && !theatre && (
          <div className="right-tabs">
            <button className={rightTab === 'ask' ? 'on' : ''} onClick={() => setRightTab('ask')}>
              <IconSparkle size={13} />
              Ask Sitca
            </button>
            <button className={rightTab === 'room' ? 'on' : ''} onClick={() => setRightTab('room')}>
              Room{roomMsgs.length + roomQCount > 0 ? ` · ${roomMsgs.length + roomQCount}` : ''}
            </button>
          </div>
        )}
        {roomEventId && rightTab === 'room' && !theatre && (
          <div className="room-panel">
            <div className="room-note">{roomLive ? 'The room, live. What attendees ask you, and what they say to each other.' : 'The room, as it happened. Attendees talked here during the event.'}</div>
            <div className="room-list room-list-tall">
              <div className="section-title" style={{ margin: '4px 0 10px' }}>
                {roomLive ? 'Questions for you' : 'Questions they asked'}
                {roomQCount > 0 && <span className="duration-chip" style={{ marginLeft: 8 }}>{roomQCount}</span>}
              </div>
              {roomQs.length === 0 && <div className="room-empty">{roomLive ? 'Nothing yet — questions sent to you appear here.' : 'No questions were sent to the speaker.'}</div>}
              {roomQs.map((g) => (
                <div key={g.topic} className="qgroup">
                  <div className="qgroup-head">
                    {g.topic}
                    <span className="duration-chip">{g.items.length}</span>
                  </div>
                  {g.items.map((q, i) => (
                    <div key={i} className="qgroup-item">
                      {q.votes > 0 && (
                        <span className="vote-chip" title="Attendee upvotes">
                          ▲ {q.votes}
                        </span>
                      )}
                      {q.text}
                    </div>
                  ))}
                </div>
              ))}
              <div className="section-title" style={{ margin: '18px 0 10px' }}>Said in the room</div>
              {roomMsgs.length === 0 ? (
                <div className="room-empty">Nobody wrote in the room during this event.</div>
              ) : (
                roomMsgs.map((m) => (
                  <div key={m.id} className={`room-msg${m.host ? ' host' : ''}`}>
                    <b>{m.host ? 'You' : m.name}</b>
                    <span>{m.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        {(!(roomEventId && rightTab === 'room') || theatre) && (
        <ChatPane
          sessionId={meta.id}
          live={false}
          initialChat={chat}
          // the page keeps the conversation too: on a phone the pane comes
          // and goes with the Ask tab, and must come back with every word
          onPersist={(messages) => {
            setData((cur) => (cur && cur.meta.id === meta.id ? { ...cur, chat: messages } : cur))
            void window.sitka.saveChat(meta.id, messages)
          }}
          hasChatKey={hasChatKey}
          hasTranscript={segments.length > 0}
          onSeek={(seconds, sid) => {
            if (sid) {
              const other = sessions.find((s) => s.id.startsWith(sid))
              if (other && other.id !== meta.id) {
                onOpenSessionAt(other.id, seconds)
                return
              }
            }
            seek(seconds)
          }}
          resolveLabel={(sid) =>
            // a moment in this very session needs only its time; other sessions get their name
            meta.id.startsWith(sid) ? undefined : sessions.find((s) => s.id.startsWith(sid))?.title
          }
          onOpenSettings={onOpenSettings}
          suggestions={
            meta.kind === 'meeting'
              ? ['What was decided, and who does what?', 'Summarize this meeting in five lines', 'What is still open or unresolved?', 'Draft a follow-up email from this meeting']
              : meta.kind === 'lecture'
                ? ['Explain the main idea like I am new to it', 'Give me exam questions from this lecture', 'What are the key terms, with definitions?', 'Where did the lecturer say the important parts are?']
                : ['Summarize this session', 'What were the most important points?', 'When was the main topic explained?', 'Turn this into study notes']
          }
        />
        )}
      </div>
    </div>
  )
}
