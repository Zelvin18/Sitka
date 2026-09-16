import { IconMic } from '../lib/icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RoomMessage, SessionData, SessionMaterial, SessionMeta, Slide } from '@shared/types'
import MaterialsPanel from './MaterialsPanel'
import FilePick from './FilePick'
import ChatPane from './ChatPane'
import TranscriptPane from './TranscriptPane'
import NotesPane from './NotesPane'
import StudyPane from './StudyPane'
import ReportPane from './ReportPane'
import Splitter from './Splitter'
import { clamp, usePersistedBool, usePersistedNumber, useRemembered } from '../lib/persist'
import Loading, { LOADING_WORDS } from './Loading'
import { shrinkImageFile } from '../lib/attach'
import { IconPlay } from '../lib/icons'
import { mediaType, playProgressively, sourceFromParts, streamMedia } from '@shared/progressive'

/** MediaSource, or Safari's managed one on iPhone */
const hasStreamingEngine = (): boolean => typeof MediaSource !== 'undefined' || 'ManagedMediaSource' in window
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
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [videoError, setVideoError] = useState(false)
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
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [slides, setSlides] = useState<Slide[]>([])
  const [showMaterials, setShowMaterials] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [materials, setMaterials] = useState<SessionMaterial[]>([])
  // Phone: the chat is a tab beside Transcript, open by default, so the screen
  // shows one thing at a time. On a desktop the chat is always the right column.
  const [askOpen, setAskOpen] = useRemembered('sitka.session.ask', () => window.innerWidth < 860)
  // Hosted events keep their room: the host can read the whole conversation
  // again beside Ask Sitka, long after the event ended.
  const [rightTab, setRightTab] = useRemembered<'ask' | 'room'>('sitka.session.right', 'ask')
  const [roomMsgs, setRoomMsgs] = useState<RoomMessage[]>([])

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
  useEffect(() => {
    if (!roomEventId) return undefined
    let cancelled = false
    void window.sitka.listRoomMessages(roomEventId).then((m) => {
      if (!cancelled) setRoomMsgs(m)
    })
    return () => {
      cancelled = true
    }
  }, [roomEventId])

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
      // The title and summary are written automatically. If that has not
      // happened yet (the tab was closed, the AI was busy), it happens now.
      if (
        d &&
        d.meta.status === 'complete' &&
        !d.meta.analyzed &&
        d.segments.length > 2 &&
        autoAnalyzedRef.current !== d.meta.id
      ) {
        autoAnalyzedRef.current = d.meta.id
        setReanalyzing(true)
        void window.sitka.reanalyzeSession(d.meta.id).then((m) => {
          setReanalyzing(false)
          if (m) setData((cur) => (cur ? { ...cur, meta: m } : cur))
        })
      }
      // Meetings lead with decisions & actions; lectures/others with transcript.
      if (!tabInitializedRef.current && d) {
        tabInitializedRef.current = true
        if (d.meta.hosted && d.report) setTab('report')
        else if (d.meta.kind === 'meeting' && d.meta.summary) setTab('overview')
      }
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshToken])

  // MediaRecorder webm files have no seek index, so seeking a streamed source
  // snaps back to 0. Loading the whole file as a blob (read via the main
  // process) makes every byte available locally, so Chromium can seek anywhere.
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    durationFixedRef.current = false
    setVideoSrc(null)
    setVideoError(false)
    setVideoLive(false)
    if (!videoWanted) return undefined
    void (async () => {
      try {
        // Remux on first open if needed — gives the file a real duration and
        // seek index. Playback always uses a locally loaded blob: every byte
        // is in hand, so seeking can never fail.
        await window.sitka.prepareSession(sessionId)
        if (cancelled) return
        // On the website the recording plays from one whole file when there is
        // one: native, progressive, the fastest start on any device. Failing
        // that it is streamed part by part; the whole file is read into memory
        // only when neither is possible.
        const url = await window.sitka.videoUrl(sessionId)
        if (cancelled) return
        if (url) {
          setVideoSrc(url)
          return
        }
        const sized = await window.sitka.listVideoPartsSized(sessionId).catch(() => [])
        const parts = sized.length > 0 ? sized.map((p) => p.url) : await window.sitka.listVideoParts(sessionId)
        if (cancelled) return
        if (parts.length > 0 && hasStreamingEngine()) {
          streamPartsRef.current = parts
          streamSizesRef.current = sized.length > 0 ? sized.map((p) => p.size) : null
          setVideoSrc('progressive')
          return
        }
        const bytes = await window.sitka.readVideo(sessionId)
        if (cancelled) return
        if (!bytes || bytes.byteLength === 0) {
          setVideoError(true)
          return
        }
        const blob = new Blob([bytes.slice().buffer], { type: mediaType(bytes.subarray(0, 12)) })
        objectUrl = URL.createObjectURL(blob)
        setVideoSrc(objectUrl)
      } catch {
        if (!cancelled) setVideoError(true)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [sessionId, videoWanted])

  // A different session: the recording loads straight away, and the mark
  // stays over the player until it has something to show.
  useEffect(() => {
    setVideoWanted(true)
    setVideoLive(false)
    pendingSeekRef.current = null
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
      ? streamMedia(v, sourceFromParts(parts.map((url, i) => ({ url, size: sizes[i] }))), { durationSec })
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
    // twenty seconds without a first frame is a stream that will not come
    const watchdog = window.setTimeout(() => {
      if (cancelled || !videoRef.current || videoRef.current.readyState >= 1) return
      cancelled = true
      streamPartsRef.current = []
      void window.sitka.readVideo(sessionId).then((bytes) => {
        if (!bytes || bytes.byteLength === 0) {
          setVideoError(true)
          return
        }
        setVideoSrc(URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType(bytes.subarray(0, 12)) })))
      })
    }, 20000)
    void run.then((ok) => {
      if (cancelled) return
      if (!ok) {
        // this file cannot be streamed: read it whole instead
        streamPartsRef.current = []
        void window.sitka.readVideo(sessionId).then((bytes) => {
          if (cancelled || !bytes || bytes.byteLength === 0) {
            setVideoError(true)
            return
          }
          setVideoSrc(URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType(bytes.subarray(0, 12)) })))
        })
      }
    })
    return () => {
      cancelled = true
      clearTimeout(watchdog)
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
                  title="Slides, notes and readings Sitka uses for this session"
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
                    ? 'summary not ready yet — Sitka will try again next time you open this session'
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
                ? 'Uploading the rest of this recording…'
                : 'Part of this recording is still on this device. It uploads on its own when the connection allows.'}
            </span>
            {!uploading && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  setUploading(true)
                  void window.sitka.retryUploads(meta.id).then((r) => {
                    setUploading(false)
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
              <a className="btn btn-ghost btn-sm" href={videoSrc} download={`${meta.title.replace(/[^\w-]+/g, '-')}.webm`}>
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
        {meta.status === 'recording' && (
          <div className="live-block" style={{ margin: '12px 24px 0' }}>
            <span className="live-block-dot" />
            <div className="live-block-text">
              <b>This session is recording right now.</b>
              <span>
                It is live in another tab or window. Follow it there; the recording and the words
                arrive here once it ends.
              </span>
            </div>
          </div>
        )}
        <div
          className={`video-wrap${meta.audioOnly ? ' audio-only' : ''}${videoHidden ? ' collapsed' : ''}`}
          ref={videoWrapRef}
          style={{
            height: videoHidden ? 40 : meta.audioOnly ? Math.min(clamp(videoH, 140, 900), 220) : clamp(videoH, 140, 900)
          }}
        >
          <button
            className="video-toggle"
            onClick={() => setVideoHidden(!videoHidden)}
            title={videoHidden ? 'Show the picture' : 'Hide the picture — the sound keeps playing'}
          >
            <IconChevron size={13} strokeWidth={2.4} />
            {videoHidden ? 'Show video' : 'Hide'}
          </button>
          {videoSrc ? (
            <>
              <video
                ref={videoRef}
                src={videoSrc === 'progressive' ? undefined : videoSrc}
                poster={poster ?? undefined}
                controls
                playsInline
                onLoadedMetadata={onLoadedMetadata}
                onLoadedData={() => setVideoLive(true)}
                onPlaying={() => setVideoLive(true)}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onError={() => {
                  // The link did not open: expired, gone, or refused. Never a
                  // spinner for good: fall back to the parts, then to the file.
                  if (videoSrc?.startsWith('blob:')) {
                    setVideoError(true)
                    return
                  }
                  if (videoSrc === 'progressive') {
                    // the stream broke: the whole file, read into memory, plays anything
                    streamPartsRef.current = []
                    void window.sitka.readVideo(sessionId).then((bytes) => {
                      if (!bytes || bytes.byteLength === 0) {
                        setVideoError(true)
                        return
                      }
                      setVideoSrc(URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType(bytes.subarray(0, 12)) })))
                    })
                    return
                  }
                  void (async () => {
                    const sized = await window.sitka.listVideoPartsSized(sessionId).catch(() => [])
                    const parts = sized.length > 0 ? sized.map((p) => p.url) : await window.sitka.listVideoParts(sessionId).catch(() => [])
                    if (parts.length > 0 && hasStreamingEngine()) {
                      streamPartsRef.current = parts
                      streamSizesRef.current = sized.length > 0 ? sized.map((p) => p.size) : null
                      setVideoSrc('progressive')
                      return
                    }
                    const bytes = await window.sitka.readVideo(sessionId).catch(() => null)
                    if (!bytes || bytes.byteLength === 0) {
                      setVideoError(true)
                      return
                    }
                    setVideoSrc(URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType(bytes.subarray(0, 12)) })))
                  })()
                }}
              />
              {!videoLive && !meta.audioOnly && (
                <div className="video-waiting">
                  <Loading compact onDark words={LOADING_WORDS.recording} delay={0} />
                  {meta.recordingPending && (
                    <div className="video-waiting-note">
                      The last parts are still uploading from this device. Keep this tab open
                      until the recording appears.
                    </div>
                  )}
                </div>
              )}
              {meta.audioOnly && (
                <div className={`audio-overlay${meta.banner ? ' with-banner' : ''}`}>
                  {meta.banner ? (
                    <img className="audio-banner" src={meta.banner} alt="" />
                  ) : (
                    <>
                      <span className="audio-overlay-icon">
                        <IconMic size={20} strokeWidth={1.6} />
                      </span>
                      <span>Audio session</span>
                    </>
                  )}
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
              {meta.readOnly ? (
                'The recording stays with the person who captured it. The transcript, notes and answers are all here.'
              ) : videoError ? (
                'Could not load this recording.'
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
            className={`btn btn-sm ${tab === 'transcript' ? '' : 'btn-ghost'}`}
            onClick={() => setTab('transcript')}
          >
            Transcript
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
          {meta.hosted ? (
            <button
              className={`btn btn-sm ${tab === 'report' ? '' : 'btn-ghost'}`}
              onClick={() => setTab('report')}
            >
              Event report
            </button>
          ) : (
            <button
              className={`btn btn-sm ${tab === 'study' ? '' : 'btn-ghost'}`}
              onClick={() => setTab('study')}
            >
              Study
            </button>
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
            title="Export this tab as a Markdown file"
            onClick={() => {
              void window.sitka.exportSession(meta.id, tab === 'report' ? 'overview' : tab).then((res) => {
                if (res.ok) {
                  setExported(true)
                  setTimeout(() => setExported(false), 2000)
                }
              })
            }}
          >
            <IconDownload size={13} />
            {exported ? 'Exported ✓' : 'Export'}
          </button>
        </div>

        {tab === 'transcript' && (
          <TranscriptPane
            segments={segments}
            currentTime={currentTime}
            onSeek={seek}
            emptyText="No transcript was captured for this session."
          />
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
                  Sitka can write organized notes for this session — key points,
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
                  ? 'No transcript — Sitka could not analyze this session.'
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
      <div className="session-right" style={{ width: clamp(chatW, 300, 900) }}>
        {roomEventId && (
          <div className="right-tabs">
            <button className={rightTab === 'ask' ? 'on' : ''} onClick={() => setRightTab('ask')}>
              <IconSparkle size={13} />
              Ask Sitka
            </button>
            <button className={rightTab === 'room' ? 'on' : ''} onClick={() => setRightTab('room')}>
              Room{roomMsgs.length > 0 ? ` · ${roomMsgs.length}` : ''}
            </button>
          </div>
        )}
        {roomEventId && rightTab === 'room' && (
          <div className="room-panel">
            <div className="room-note">The room, as it happened. Attendees talked here during the event.</div>
            <div className="room-list room-list-tall">
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
        {!(roomEventId && rightTab === 'room') && (
        <ChatPane
          sessionId={meta.id}
          live={false}
          initialChat={chat}
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
          suggestions={[
            'Summarize this session',
            'What were the most important points?',
            'When was the main topic explained?'
          ]}
        />
        )}
      </div>
    </div>
  )
}
