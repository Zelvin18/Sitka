import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  CoachProject,
  CoachRehearsal,
  ScheduledEvent,
  SimDifficulty,
  TranscriptSegment
} from '@shared/types'
import ChatPane, { type ChatPaneHandle } from './ChatPane'
import ConfirmDialog from './ConfirmDialog'
import {
  IconBroadcast,
  IconCalendar,
  IconCamera,
  IconHelp,
  IconMic,
  IconScreen,
  IconNotes,
  IconPlus,
  IconSparkle,
  IconStop
} from '../lib/icons'
import { formatTime } from '../lib/format'

interface Props {
  hasChatKey: boolean
  hasSttKey: boolean
  onOpenSettings: () => void
}

type Mode =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'rehearse'; id: string }
  | { kind: 'scoring'; id: string }
  | { kind: 'result'; id: string; rehearsal: CoachRehearsal }
  | { kind: 'simulate'; id: string; persona: string; difficulty: SimDifficulty }

const PERSONAS = ['Investor', 'Client', 'Professor', 'Executive', 'Conference audience', 'Technical audience']
const DIFFICULTIES: { key: SimDifficulty; label: string }[] = [
  { key: 'friendly', label: 'Friendly' },
  { key: 'professional', label: 'Professional' },
  { key: 'challenging', label: 'Challenging' },
  { key: 'grilling', label: 'Grilling' }
]

function ScoreRing({ value, size = 120, label }: { value: number; size?: number; label?: string }): React.JSX.Element {
  const stroke = size >= 100 ? 9 : 6
  const r = size / 2 - stroke
  const c = 2 * Math.PI * r
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-bg" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="ring-fg"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-text">
        <div className="ring-value" style={{ fontSize: size >= 100 ? 28 : 15 }}>
          {value}
        </div>
        {label && <div className="ring-label">{label}</div>}
      </div>
    </div>
  )
}

export default function CoachView({ hasChatKey, hasSttKey, onOpenSettings }: Props): React.JSX.Element {
  const [projects, setProjects] = useState<CoachProject[]>([])
  const [events, setEvents] = useState<ScheduledEvent[]>([])
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [createOpen, setCreateOpen] = useState(false)
  const [goal, setGoal] = useState('')
  const [audience, setAudience] = useState('')
  const [when, setWhen] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [briefBusy, setBriefBusy] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteName, setPasteName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CoachProject | null>(null)
  const [simChat, setSimChat] = useState<ChatMessage[] | null>(null)
  const [roomChoice, setRoomChoice] = useState<'studio' | 'qa'>('studio')
  const [simPersona, setSimPersona] = useState(PERSONAS[0])
  const [simDifficulty, setSimDifficulty] = useState<SimDifficulty>('professional')

  // rehearsal (live studio) state
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [camOn, setCamOn] = useState(true)
  const [hasCam, setHasCam] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [sharePickerOpen, setSharePickerOpen] = useState(false)
  const [shareSources, setShareSources] = useState<
    { id: string; name: string; thumbnail: string }[]
  >([])
  const [hint, setHint] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const camStreamRef = useRef<MediaStream | null>(null)
  const shareStreamRef = useRef<MediaStream | null>(null)
  const camVideoRef = useRef<HTMLVideoElement>(null)
  const shareVideoRef = useRef<HTMLVideoElement>(null)
  const segLiveRef = useRef<TranscriptSegment[]>([])
  const hintBusyRef = useRef(false)
  const hintDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const startRef = useRef(0)
  const chunkStartRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([])
  const stoppingRef = useRef(false)
  const chatRef = useRef<ChatPaneHandle>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setProjects(await window.sitka.listCoachProjects())
    const ev = await window.sitka.listEvents()
    setEvents(ev.events.filter((e) => !e.sessionId))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const project =
    mode.kind === 'list' ? null : projects.find((p) => p.id === mode.id) ?? null

  // ---------- rehearsal recording ----------

  const cleanupRecording = useCallback((): void => {
    timersRef.current.forEach(clearInterval)
    timersRef.current = []
    if (hintDismissRef.current) clearTimeout(hintDismissRef.current)
    try {
      if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
    } catch {
      /* noop */
    }
    for (const ref of [streamRef, camStreamRef, shareStreamRef]) {
      ref.current?.getTracks().forEach((t) => t.stop())
      ref.current = null
    }
    recRef.current = null
    setSharing(false)
    setHint(null)
  }, [])

  useEffect(() => cleanupRecording, [cleanupRecording])

  const sttBlob = useCallback(async (blob: Blob, offsetSec: number): Promise<void> => {
    if (blob.size < 3000) return
    const buf = await blob.arrayBuffer()
    const res = await window.sitka.coachStt(buf, offsetSec)
    if (res.segments && res.segments.length > 0) {
      setSegments((prev) => {
        const next = [...prev, ...res.segments!].sort((a, b) => a.start - b.start)
        segLiveRef.current = next
        return next
      })
    }
  }, [])

  const startChunk = useCallback((): void => {
    const stream = streamRef.current
    if (!stream) return
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    const chunkStart = Date.now()
    chunkStartRef.current = chunkStart
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) void sttBlob(e.data, (chunkStart - startRef.current) / 1000)
    }
    rec.start()
    recRef.current = rec
  }, [sttBlob])

  const startRehearsal = useCallback(
    async (id: string): Promise<void> => {
      setError(null)
      try {
        // Live studio: camera + mic like a real online presentation. Falls back
        // to audio-only when there is no camera.
        let cam: MediaStream | null = null
        try {
          cam = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720 },
            audio: { echoCancellation: true, noiseSuppression: true }
          })
          setHasCam(true)
        } catch {
          cam = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true }
          })
          setHasCam(false)
        }
        camStreamRef.current = cam
        streamRef.current = new MediaStream(cam.getAudioTracks())
        setCamOn(true)
        startRef.current = Date.now()
        stoppingRef.current = false
        segLiveRef.current = []
        setSegments([])
        setElapsed(0)
        setHint(null)
        startChunk()
        timersRef.current.push(
          setInterval(() => {
            const rec = recRef.current
            if (rec && rec.state !== 'inactive') {
              rec.onstop = () => {
                if (!stoppingRef.current) startChunk()
              }
              rec.stop()
            }
          }, 15000),
          setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000),
          setInterval(() => {
            if (hintBusyRef.current || segLiveRef.current.length < 4) return
            hintBusyRef.current = true
            void window.sitka
              .coachHint(id, segLiveRef.current.slice(-60))
              .then((res) => {
                if (res.hint) {
                  setHint(res.hint)
                  if (hintDismissRef.current) clearTimeout(hintDismissRef.current)
                  hintDismissRef.current = setTimeout(() => setHint(null), 14000)
                }
              })
              .finally(() => {
                hintBusyRef.current = false
              })
          }, 75000)
        )
        setMode({ kind: 'rehearse', id })
      } catch {
        setError('Microphone access failed — allow the mic and try again.')
      }
    },
    [startChunk]
  )

  // Attach studio streams to their video tiles.
  useEffect(() => {
    if (mode.kind !== 'rehearse') return
    if (camVideoRef.current && camStreamRef.current) {
      camVideoRef.current.srcObject = camStreamRef.current
      void camVideoRef.current.play().catch(() => undefined)
    }
  }, [mode, hasCam, sharing])

  useEffect(() => {
    if (mode.kind !== 'rehearse') return
    if (shareVideoRef.current && shareStreamRef.current) {
      shareVideoRef.current.srcObject = shareStreamRef.current
      void shareVideoRef.current.play().catch(() => undefined)
    }
  }, [mode, sharing])

  const toggleCam = useCallback((): void => {
    const track = camStreamRef.current?.getVideoTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setCamOn(track.enabled)
  }, [])

  const openSharePicker = useCallback(async (): Promise<void> => {
    const sources = await window.sitka.listSources()
    setShareSources(sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail })))
    setSharePickerOpen(true)
  }, [])

  const startShare = useCallback(async (sourceId: string): Promise<void> => {
    setSharePickerOpen(false)
    try {
      const md = navigator.mediaDevices as unknown as {
        getUserMedia: (c: unknown) => Promise<MediaStream>
      }
      const stream = await md.getUserMedia({
        audio: false,
        video: {
          mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 10 }
        }
      })
      shareStreamRef.current?.getTracks().forEach((t) => t.stop())
      shareStreamRef.current = stream
      setSharing(true)
    } catch {
      setError('Could not share that screen.')
    }
  }, [])

  const stopShare = useCallback((): void => {
    shareStreamRef.current?.getTracks().forEach((t) => t.stop())
    shareStreamRef.current = null
    setSharing(false)
  }, [])

  const finishRehearsal = useCallback(
    async (id: string): Promise<void> => {
      stoppingRef.current = true
      const durationSec = (Date.now() - startRef.current) / 1000
      const rec = recRef.current
      if (rec && rec.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          rec.onstop = () => resolve()
          rec.stop()
        })
      }
      cleanupRecording()
      setMode({ kind: 'scoring', id })
      // Give the last STT chunk a moment to land.
      await new Promise((r) => setTimeout(r, 2500))
      const finalSegments = await new Promise<TranscriptSegment[]>((resolve) => {
        setSegments((prev) => {
          resolve(prev)
          return prev
        })
      })
      const res = await window.sitka.coachScore(id, finalSegments, durationSec)
      if (res.error || !res.rehearsal) {
        setError(res.error === 'missing-key' ? 'Add an AI key in Settings first.' : res.error ?? 'Scoring failed.')
        setMode({ kind: 'detail', id })
      } else {
        await refresh()
        setMode({ kind: 'result', id, rehearsal: res.rehearsal })
      }
    },
    [cleanupRecording, refresh]
  )

  // ---------- simulation ----------

  const enterSimulation = async (
    id: string,
    persona: string,
    difficulty: SimDifficulty
  ): Promise<void> => {
    const saved = await window.sitka.coachGetSim(id)
    setSimChat(saved)
    setMode({ kind: 'simulate', id, persona, difficulty })
    if (saved.length === 0) {
      setTimeout(() => chatRef.current?.ask("I'm ready — ask your first question."), 400)
    }
  }

  // ============ list ============
  if (mode.kind === 'list') {
    return (
      <div className="content">
        <div className="content-inner" style={{ maxWidth: 860 }}>
          <div className="ev-hero">
            <div>
              <h1 className="ev-hero-title">
                Walk in
                <br />
                already ready.
              </h1>
              <p className="ev-hero-sub">
                Upload your materials, get briefed, rehearse against the clock, and
                face the hard questions before the real audience ever asks them.
              </p>
              <button
                className="btn btn-primary btn-lg"
                onClick={() => {
                  setGoal('')
                  setAudience('')
                  setWhen('')
                  setCreateOpen(true)
                }}
              >
                <IconPlus size={16} strokeWidth={2.2} />
                New practice
              </button>
            </div>
            <div className="coach-art">
              <div className="coach-art-ring">
                <div className="coach-ready-ring">✓</div>
                <div className="ring-label" style={{ textAlign: 'center', marginTop: 8 }}>
                  ready
                </div>
              </div>
              <div className="ev-art-phone p1" style={{ right: '4%', top: '2%' }}>
                <span className="ev-art-line" />
                <span className="ev-art-line short" />
                <span className="ev-art-bubble">Why that valuation?</span>
              </div>
              <div className="coach-art-mic">
                <IconMic size={20} strokeWidth={1.7} />
              </div>
            </div>
          </div>

          {error && (
            <div className="notice notice-error" style={{ marginTop: 16 }}>
              <span>{error}</span>
            </div>
          )}

          {projects.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 26 }}>
                Your practices
              </div>
              {projects.map((p) => {
                const last = p.rehearsals[p.rehearsals.length - 1]
                return (
                  <div key={p.id} className="ev-row" onClick={() => setMode({ kind: 'detail', id: p.id })}>
                    <div className="ev-date">
                      <IconMic size={15} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="ev-title">{p.title}</div>
                      <div className="ev-sub">
                        {p.audience}
                        {p.when &&
                          ` · ${new Date(p.when).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`}
                        {` · ${p.rehearsals.length} rehearsal${p.rehearsals.length === 1 ? '' : 's'}`}
                      </div>
                    </div>
                    {last && <ScoreRing value={last.scores.overall} size={46} />}
                  </div>
                )
              })}
            </>
          )}

          <>
              <div className="section-title" style={{ marginTop: 34 }}>
                {projects.length === 0 ? 'What is Coach?' : 'How Coach works'}
              </div>
              <p className="feat-intro">
                Coach is your private preparation room for anything you have to present
                — an investor pitch, a keynote, a class, a job interview, a sales demo.
                You tell it what you're presenting and to whom, hand it your documents,
                and it becomes a personal presentation coach built around{' '}
                <strong>your</strong> material: it briefs you, listens to you rehearse,
                scores you honestly, and plays the toughest audience you'll ever face —
                so the real one feels easy.
              </p>

              <div className="feat-grid">
                <div className="feat-card">
                  <span className="feat-icon">
                    <IconSparkle size={17} strokeWidth={1.7} />
                  </span>
                  <span className="feat-title">Get briefed</span>
                  <span className="feat-desc">
                    Coach reads your slides, plans, and notes, then tells you the
                    structure to follow, the one message that must land, your weak
                    spots, and the exact questions to expect.
                  </span>
                </div>
                <div className="feat-card">
                  <span className="feat-icon">
                    <IconMic size={17} strokeWidth={1.7} />
                  </span>
                  <span className="feat-title">Rehearse & get scored</span>
                  <span className="feat-desc">
                    Present out loud to your microphone. Coach listens and scores you
                    0–100 on content, clarity, structure, confidence, and timing — with
                    specific notes like "you rushed the financials."
                  </span>
                </div>
                <div className="feat-card">
                  <span className="feat-icon">
                    <IconHelp size={17} strokeWidth={1.7} />
                  </span>
                  <span className="feat-title">Face a tough audience</span>
                  <span className="feat-desc">
                    Coach role-plays an investor, client, professor, or executive — from
                    friendly to full grilling — asking hard questions from your own
                    materials and judging every answer as strong, shaky, or not holding.
                  </span>
                </div>
                <div className="feat-card">
                  <span className="feat-icon">
                    <IconBroadcast size={17} strokeWidth={1.7} />
                  </span>
                  <span className="feat-title">Remembered on the day</span>
                  <span className="feat-desc">
                    Link a practice to one of your Events: while you present live, your
                    Co-Pilot remembers what you practiced and quietly surfaces your
                    rehearsed answers when the real questions come in.
                  </span>
                </div>
              </div>

              <div className="section-title" style={{ marginTop: 28 }}>
                How it works
              </div>
              <div className="ev-steps">
                <div className="ev-step">
                  <span className="ev-step-num">1</span>
                  <span className="ev-step-title">Create a practice</span>
                  <span className="ev-step-desc">
                    Say what you're presenting, to whom, and when — then add your
                    slides, notes, or plan.
                  </span>
                </div>
                <span className="ev-step-arrow">→</span>
                <div className="ev-step">
                  <span className="ev-step-num">2</span>
                  <span className="ev-step-title">Build your brief</span>
                  <span className="ev-step-desc">
                    One click — Coach studies everything and hands you your preparation
                    plan.
                  </span>
                </div>
                <span className="ev-step-arrow">→</span>
                <div className="ev-step">
                  <span className="ev-step-num">3</span>
                  <span className="ev-step-title">Rehearse, then repeat</span>
                  <span className="ev-step-desc">
                    Practice out loud, read your scores, fix the weak spots, and watch
                    your progress climb run after run.
                  </span>
                </div>
                <span className="ev-step-arrow">→</span>
                <div className="ev-step">
                  <span className="ev-step-num">4</span>
                  <span className="ev-step-title">Pressure-test</span>
                  <span className="ev-step-desc">
                    Enter the practice room and take the hardest questions before the
                    real audience asks them.
                  </span>
                </div>
              </div>
            </>

          {createOpen && (
            <div className="dialog-overlay" onMouseDown={() => setCreateOpen(false)}>
              <div className="dialog" style={{ width: 430 }} onMouseDown={(e) => e.stopPropagation()}>
                <div className="dialog-title">New practice</div>
                <div className="field">
                  <label className="field-label">What are you presenting?</label>
                  <input
                    className="input"
                    value={goal}
                    autoFocus
                    placeholder="e.g. Investor pitch for my company"
                    onChange={(e) => setGoal(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">Who is the audience?</label>
                  <input
                    className="input"
                    value={audience}
                    placeholder="e.g. Potential investors"
                    onChange={(e) => setAudience(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">When is it? (optional)</label>
                  <input
                    type="datetime-local"
                    className="input"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                </div>
                <div className="dialog-actions">
                  <button className="btn" onClick={() => setCreateOpen(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!goal.trim()}
                    onClick={() => {
                      void window.sitka
                        .createCoachProject(goal.slice(0, 60), goal, audience, when ? new Date(when).getTime() : null)
                        .then((p) => {
                          setCreateOpen(false)
                          void refresh().then(() => setMode({ kind: 'detail', id: p.id }))
                        })
                    }}
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="content">
        <div className="empty">Loading…</div>
      </div>
    )
  }

  // ============ live studio ============
  if (mode.kind === 'rehearse') {
    const lastLine = segments[segments.length - 1]?.text
    return (
      <div className="studio">
        <div className="studio-top">
          <span className="live-badge">● LIVE PRACTICE</span>
          <span className="studio-title">{project.title}</span>
          <span className="timer" style={{ marginLeft: 'auto', color: '#d5d5da' }}>
            {formatTime(elapsed)}
          </span>
        </div>

        <div className="studio-stage">
          <div className="studio-frame">
          <div className="studio-main">
            {sharing ? (
              <video ref={shareVideoRef} autoPlay muted playsInline className="studio-share" />
            ) : hasCam ? (
              <video ref={camVideoRef} autoPlay muted playsInline className="studio-cam-main" />
            ) : (
              <div className="studio-novideo">
                <div className="rehearse-mic" style={{ width: 72, height: 72 }}>
                  <IconMic size={24} strokeWidth={1.6} />
                </div>
              </div>
            )}
            {sharing && hasCam && (
              <video ref={camVideoRef} autoPlay muted playsInline className="studio-selfview" />
            )}
            {hint && (
              <div className="studio-hint fade-in">
                <span className="nudge-label" style={{ color: '#9a9aa2' }}>
                  Coach
                </span>
                {hint}
              </div>
            )}
            {lastLine && <div className="studio-caption">{lastLine}</div>}
          </div>

          <div className="studio-audience">
            {[project.audience || 'Audience', 'Guest 2', 'Guest 3'].map((name, i) => (
              <div key={i} className="studio-tile">
                <span className="studio-avatar" />
                <span className="studio-tile-name">{name}</span>
                <span className="studio-tile-muted">muted</span>
              </div>
            ))}
          </div>
          </div>
        </div>

        <div className="studio-controls">
          <div className="studio-dock">
            {hasCam && (
              <button className={`studio-btn${camOn ? '' : ' off'}`} onClick={toggleCam} title="Toggle camera">
                <IconCamera size={15} strokeWidth={1.9} />
                {camOn ? 'Camera' : 'Camera off'}
              </button>
            )}
            {sharing ? (
              <button className="studio-btn off" onClick={stopShare}>
                <IconScreen size={15} strokeWidth={1.9} />
                Stop sharing
              </button>
            ) : (
              <button className="studio-btn" onClick={() => void openSharePicker()}>
                <IconScreen size={15} strokeWidth={1.9} />
                Present slides
              </button>
            )}
            <span className="studio-dock-sep" />
            <button className="btn btn-danger" style={{ borderRadius: 20 }} onClick={() => void finishRehearsal(project.id)}>
              <IconStop size={14} strokeWidth={2.4} />
              End & get scored
            </button>
          </div>
        </div>

        {sharePickerOpen && (
          <div className="dialog-overlay" onMouseDown={() => setSharePickerOpen(false)}>
            <div className="dialog" style={{ width: 560 }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="dialog-title">Present a screen or window</div>
              <div className="source-grid" style={{ maxHeight: 320, overflowY: 'auto' }}>
                {shareSources.map((s) => (
                  <button key={s.id} className="source-tile" onClick={() => void startShare(s.id)}>
                    <img className="source-thumb" src={s.thumbnail} alt="" />
                    <div className="source-name">{s.name}</div>
                  </button>
                ))}
              </div>
              <div className="dialog-actions" style={{ marginTop: 14 }}>
                <button className="btn" onClick={() => setSharePickerOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ============ scoring ============
  if (mode.kind === 'scoring') {
    return (
      <div className="content">
        <div className="content-inner" style={{ maxWidth: 640, textAlign: 'center', paddingTop: 120 }}>
          <span className="dots" style={{ transform: 'scale(1.6)' }}>
            <span />
            <span />
            <span />
          </span>
          <h1 className="page-title" style={{ marginTop: 22 }}>
            Your coach is reviewing…
          </h1>
          <p className="page-subtitle">Scoring content, clarity, structure, confidence, and timing.</p>
        </div>
      </div>
    )
  }

  // ============ result ============
  if (mode.kind === 'result') {
    const r = mode.rehearsal
    const bars: { label: string; value: number }[] = [
      { label: 'Content', value: r.scores.content },
      { label: 'Clarity', value: r.scores.clarity },
      { label: 'Structure', value: r.scores.structure },
      { label: 'Confidence', value: r.scores.confidence },
      { label: 'Timing', value: r.scores.timing }
    ]
    return (
      <div className="content">
        <div className="content-inner" style={{ maxWidth: 680 }}>
          <div style={{ textAlign: 'center', marginBottom: 26 }}>
            <ScoreRing value={r.scores.overall} size={150} label="overall" />
            <div className="field-hint" style={{ marginTop: 10 }}>
              {formatTime(r.durationSec)} rehearsal · {new Date(r.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </div>
          </div>
          <div className="score-bars">
            {bars.map((b) => (
              <div key={b.label} className="score-bar-row">
                <span className="score-bar-label">{b.label}</span>
                <div className="score-bar-track">
                  <span style={{ width: `${b.value}%` }} />
                </div>
                <span className="score-bar-value">{b.value}</span>
              </div>
            ))}
          </div>
          {r.summary && (
            <p className="summary-block" style={{ marginTop: 20, fontSize: 15 }}>
              {r.summary}
            </p>
          )}
          <div className="section-title">Coach's notes</div>
          <ul style={{ margin: '0 0 8px 20px', color: 'var(--text-2)' }}>
            {r.feedback.map((f, i) => (
              <li key={i} style={{ marginBottom: 7 }}>
                {f}
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <button className="btn btn-primary" onClick={() => void startRehearsal(project.id)}>
              <IconMic size={14} />
              Practice again
            </button>
            <button className="btn btn-ghost" onClick={() => setMode({ kind: 'detail', id: project.id })}>
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ============ simulate ============
  if (mode.kind === 'simulate') {
    return (
      <div className="brain-view">
        <div className="brain-hero" style={{ paddingBottom: 10 }}>
          <button
            className="btn btn-ghost btn-sm page-back"
            onClick={() => setMode({ kind: 'detail', id: project.id })}
          >
            ‹ {project.title}
          </button>
          <h1 className="page-title" style={{ fontSize: 21 }}>
            {mode.persona} · {mode.difficulty}
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Answer out of character any time: say "how did I do?" for a debrief.
          </p>
        </div>
        {simChat !== null && (
          <div className="brain-chat">
            <ChatPane
              ref={chatRef}
              sessionId={`__sim_${project.id}`}
              live={false}
              brain={false}
              initialChat={simChat}
              hasChatKey={hasChatKey}
              hasTranscript
              headerTitle="Practice room"
              headerExtra={
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    void window.sitka.coachSaveSim(project.id, []).then(() => {
                      setSimChat([])
                      setMode({ ...mode })
                      setTimeout(() => chatRef.current?.ask("I'm ready — ask your first question."), 400)
                    })
                  }}
                >
                  Restart
                </button>
              }
              onSeek={() => undefined}
              onOpenSettings={onOpenSettings}
              onPersist={(messages) => void window.sitka.coachSaveSim(project.id, messages)}
              askOverride={(requestId, question, history) =>
                void window.sitka.coachSimAsk({
                  projectId: project.id,
                  requestId,
                  persona: mode.persona,
                  difficulty: mode.difficulty,
                  question,
                  history
                })
              }
            />
          </div>
        )}
      </div>
    )
  }

  // ============ detail ============
  const materials = project.materials ?? []
  const last = project.rehearsals[project.rehearsals.length - 1]
  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 920 }}>
        <button className="btn btn-ghost btn-sm page-back" onClick={() => setMode({ kind: 'list' })}>
          ‹ All practices
        </button>
        <div className="evd-header">
          <div style={{ flex: 1, minWidth: 260 }}>
            <h1 className="page-title" style={{ marginBottom: 4 }}>
              {project.title}
            </h1>
            <div className="evd-meta" style={{ gap: 10, flexWrap: 'wrap' }}>
              <span>{project.audience}</span>
              {project.when && (
                <span className="evd-rel">
                  <IconCalendar size={11} />{' '}
                  {new Date(project.when).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
              )}
            </div>
          </div>
        </div>

        {!hasSttKey && (
          <div className="notice" style={{ marginTop: 12 }}>
            <span>
              Rehearsals need transcription — add a key in{' '}
              <span className="link" onClick={onOpenSettings}>
                Settings
              </span>
              .
            </span>
          </div>
        )}
        {error && (
          <div className="notice notice-error" style={{ marginTop: 12 }}>
            <span>{error}</span>
          </div>
        )}

        <div className="evd-grid">
          <div className="evd-main">
            <div className="evd-card">
              <div className="evd-card-head">
                <span>
                  <span className="step-num">1</span> Add your materials
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setPasteName('')
                      setPasteText('')
                      setPasteOpen(true)
                    }}
                  >
                    Paste
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      void window.sitka.coachAddMaterialFile(project.id).then((r) => {
                        if (r.error) setError(r.error)
                        else void refresh()
                      })
                    }
                  >
                    <IconPlus size={12} strokeWidth={2.4} /> Add file
                  </button>
                </div>
              </div>
              {materials.length === 0 && (
                <p className="field-hint" style={{ margin: 0 }}>
                  Slides, business plan, speaker notes, research — everything starts
                  here. The more your coach reads, the sharper the brief, the scoring,
                  and the simulated questions.
                </p>
              )}
              {materials.map((m, i) => (
                <div key={i} className="mat-row">
                  <span className="mat-icon">
                    <IconNotes size={14} />
                  </span>
                  <span className="convo-line-title">{m.name}</span>
                  <span className="convo-date" style={{ marginTop: 0 }}>
                    {(m.chars / 1000).toFixed(1)}k chars
                  </span>
                  <button
                    className="convo-line-delete"
                    title="Remove"
                    onClick={() => void window.sitka.coachRemoveMaterial(project.id, i).then(() => refresh())}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="evd-card">
              <div className="evd-card-head">
                <span>
                  <span className="step-num">2</span> Get briefed
                </span>
                <button
                  className={`btn btn-sm${project.brief ? ' btn-ghost' : ' btn-primary'}`}
                  disabled={briefBusy || !hasChatKey}
                  onClick={() => {
                    setBriefBusy(true)
                    void window.sitka.coachBrief(project.id).then((res) => {
                      setBriefBusy(false)
                      if (res.error) setError(res.error === 'missing-key' ? 'Add an AI key in Settings first.' : res.error)
                      else void refresh()
                    })
                  }}
                >
                  {briefBusy ? 'Studying…' : project.brief ? 'Rebuild' : 'Build my brief'}
                </button>
              </div>
              {project.brief ? (
                <>
                  <div className="brief-key">
                    <IconSparkle size={14} /> {project.brief.keyMessage}
                  </div>
                  {project.brief.structure.length > 0 && (
                    <>
                      <div className="brief-sub">Structure</div>
                      <ol className="brief-list">
                        {project.brief.structure.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                    </>
                  )}
                  {project.brief.weakAreas.length > 0 && (
                    <>
                      <div className="brief-sub">Weak areas</div>
                      <ul className="brief-list">
                        {project.brief.weakAreas.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {project.brief.expectedQuestions.length > 0 && (
                    <>
                      <div className="brief-sub">Expect these questions</div>
                      <ul className="brief-list">
                        {project.brief.expectedQuestions.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <p className="field-hint" style={{ margin: 0 }}>
                  Once your materials are in, your coach reads everything and tells
                  you: the structure to follow, the one message that must land, your
                  weak spots, and the questions to expect.
                </p>
              )}
            </div>

            {events.length > 0 && (
              <div className="evd-card">
                <div className="evd-card-head" style={{ marginBottom: 6 }}>
                  <span>Presenting at an event?</span>
                </div>
                <p className="field-hint" style={{ marginBottom: 10 }}>
                  Link it — on the day, your live Co-Pilot remembers everything you
                  practiced and surfaces your rehearsed answers when questions come in.
                </p>
                <select
                  className="input"
                  value={project.eventId ?? ''}
                  onChange={(e) =>
                    void window.sitka
                      .updateCoachProject(project.id, { eventId: e.target.value || null })
                      .then(() => refresh())
                  }
                >
                  <option value="">Not linked</option>
                  {events.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPendingDelete(project)}>
              Delete practice
            </button>
          </div>

          <div className="evd-side">
            <div className="evd-card">
              <div className="evd-card-head">
                <span>
                  <span className="step-num">3</span> Practice
                </span>
              </div>
              <div className="room-grid">
                <button
                  className={`room-card${roomChoice === 'studio' ? ' sel' : ''}`}
                  onClick={() => setRoomChoice('studio')}
                >
                  <span className="room-title">
                    <IconMic size={14} /> Live Studio
                  </span>
                  <span className="room-desc">
                    Camera on, slides shared — a full dress rehearsal with live
                    coaching, scored at the end.
                  </span>
                </button>
                <button
                  className={`room-card${roomChoice === 'qa' ? ' sel' : ''}`}
                  onClick={() => setRoomChoice('qa')}
                >
                  <span className="room-title">
                    <IconHelp size={14} /> Q&amp;A room
                  </span>
                  <span className="room-desc">
                    Sitka plays your audience and grills you with questions from your
                    materials.
                  </span>
                </button>
              </div>

              {roomChoice === 'qa' && (
                <div className="fade-in">
                  <div className="brief-sub">Who is asking</div>
                  <div className="kind-row" style={{ marginBottom: 8 }}>
                    {PERSONAS.slice(0, 4).map((p) => (
                      <button
                        key={p}
                        className={`kind-chip${simPersona === p ? ' sel' : ''}`}
                        style={{ padding: '5px 11px', fontSize: 12.5 }}
                        onClick={() => setSimPersona(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <div className="brief-sub" style={{ marginTop: 4 }}>
                    How hard they push
                  </div>
                  <div className="kind-row">
                    {DIFFICULTIES.map((d) => (
                      <button
                        key={d.key}
                        className={`kind-chip${simDifficulty === d.key ? ' sel' : ''}`}
                        style={{ padding: '5px 11px', fontSize: 12.5 }}
                        onClick={() => setSimDifficulty(d.key)}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <button
                className="btn btn-primary"
                style={{ width: '100%', marginTop: 14 }}
                disabled={roomChoice === 'studio' ? !hasSttKey : !hasChatKey}
                onClick={() => {
                  if (roomChoice === 'studio') void startRehearsal(project.id)
                  else void enterSimulation(project.id, simPersona, simDifficulty)
                }}
              >
                {roomChoice === 'studio' ? 'Enter Live Studio' : `Start Q&A — ${simDifficulty}`}
              </button>
            </div>

            <div className="evd-card" style={{ textAlign: 'center' }}>
              <div className="evd-card-head" style={{ justifyContent: 'center' }}>
                <span>Progress</span>
              </div>
              {last ? (
                <>
                  <ScoreRing value={last.scores.overall} size={110} label="last run" />
                  <div className="rehearsal-history">
                    {project.rehearsals.slice(-6).map((r) => (
                      <div
                        key={r.id}
                        className="rehearsal-bar"
                        title={`${r.scores.overall} · ${new Date(r.at).toLocaleString()}`}
                        onClick={() => setMode({ kind: 'result', id: project.id, rehearsal: r })}
                      >
                        <span style={{ height: `${Math.max(8, r.scores.overall)}%` }} />
                      </div>
                    ))}
                  </div>
                  <div className="field-hint">
                    {project.rehearsals.length} rehearsal{project.rehearsals.length === 1 ? '' : 's'} — click a bar to revisit
                  </div>
                </>
              ) : (
                <p className="field-hint" style={{ margin: 0 }}>
                  No rehearsals yet. <strong>Enter the live studio</strong> — camera on,
                  slides shared, exactly like the real thing — and get scored on
                  content, clarity, structure, confidence, and timing.
                </p>
              )}
            </div>

          </div>
        </div>

        {pasteOpen && (
          <div className="dialog-overlay" onMouseDown={() => setPasteOpen(false)}>
            <div className="dialog" style={{ width: 440 }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="dialog-title">Paste material</div>
              <div className="field">
                <label className="field-label">Name</label>
                <input className="input" value={pasteName} placeholder="e.g. Pitch deck notes" onChange={(e) => setPasteName(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Content</label>
                <textarea className="textarea" rows={8} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
              </div>
              <div className="dialog-actions">
                <button className="btn" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!pasteText.trim()}
                  onClick={() =>
                    void window.sitka.coachAddMaterialText(project.id, pasteName, pasteText).then((r) => {
                      if (r.error) setError(r.error)
                      setPasteOpen(false)
                      void refresh()
                    })
                  }
                >
                  Add material
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingDelete && (
          <ConfirmDialog
            title="Delete practice?"
            message={`“${pendingDelete.title}” — the brief, materials, rehearsal history, and practice chats will be permanently deleted.`}
            onConfirm={() => {
              const id = pendingDelete.id
              setPendingDelete(null)
              setMode({ kind: 'list' })
              void window.sitka.deleteCoachProject(id).then(() => refresh())
            }}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </div>
    </div>
  )
}
