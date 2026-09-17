import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ScheduledEvent, SessionMeta } from '@shared/types'
import {
  IconBroadcast,
  IconCalendar,
  IconMic,
  IconPlay,
  IconQr,
  IconScreen,
  IconSparkle,
  Mark
} from '../lib/icons'
import { formatDate, formatDuration } from '../lib/format'
import Tour from './Tour'

const TOUR_SEEN = 'sitka.tourSeen'
function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN) === '1'
  } catch {
    return true
  }
}
function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN, '1')
  } catch {
    /* private mode */
  }
}

interface Props {
  /** sessions of the general space (the home page's own) */
  sessions: SessionMeta[]
  /** every session, whichever space it is in: the latest three are picked up here */
  allSessions: SessionMeta[]
  onNewSession: () => void
  onGoEvents: () => void
  onGoOverview: () => void
  onGoLibrary: () => void
  onOpenSession: (id: string) => void
  onNewAudioSession: () => void
  onJoin?: () => void
  /** true while the app may still be about to show the welcome card */
  holdTour?: boolean
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Working late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function HomeView({
  sessions,
  allSessions,
  onNewSession,
  onGoEvents,
  onGoOverview,
  onGoLibrary,
  onOpenSession,
  onNewAudioSession,
  onJoin,
  holdTour = false
}: Props): React.JSX.Element {
  const [events, setEvents] = useState<ScheduledEvent[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [retryTick, setRetryTick] = useState(0)
  const requestedRef = useRef<Set<string>>(new Set())
  // the three most recent, wherever they were filed: newest first, never mixed
  const recent = [...allSessions]
    .filter((s) => s.status === 'complete')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3)
  const upcomingEvents = events.filter((e) => !e.sessionId).slice(0, 2)
  const firstRun = !sessions.some((s) => !s.sample)
  // The walkthrough opens by itself the first time someone arrives, once —
  // but only after the app has settled whether the welcome card is due, since
  // that card offers the walkthrough itself. After that it lives in Settings,
  // where it can be watched again.
  const [showTour, setShowTour] = useState(false)
  useEffect(() => {
    if (!holdTour && firstRun && !tourSeen()) setShowTour(true)
  }, [holdTour, firstRun])
  const closeTour = useCallback((): void => {
    markTourSeen()
    setShowTour(false)
  }, [])

  useEffect(() => {
    void window.sitka.listEvents().then((r) => setEvents(r.events))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const s of recent) {
        // sound alone has no picture to thumbnail; its card is the voice card
        if (s.audioOnly || requestedRef.current.has(s.id)) continue
        requestedRef.current.add(s.id)
        const t = await window.sitka.getThumb(s.id)
        if (cancelled) return
        if (t) setThumbs((prev) => ({ ...prev, [s.id]: t }))
        else setTimeout(() => requestedRef.current.delete(s.id), 4000)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessions, retryTick])

  // Retry gently while a recent session still lacks its thumbnail.
  useEffect(() => {
    const missing = recent.some((s) => !s.audioOnly && !thumbs[s.id])
    if (!missing) return undefined
    const t = setTimeout(() => setRetryTick((n) => n + 1), 7000)
    return () => clearTimeout(t)
  }, [sessions, thumbs, retryTick])

  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 880 }}>
        <div className="home-hero">
          <Mark size={26} live />
          <div className="home-greeting-row">
            <h1 className="home-greeting">{greeting()}.</h1>
            {onJoin && (
              <button className="home-join" onClick={onJoin} title="Join a session by scanning the host's QR code" aria-label="Join a session">
                <IconQr size={20} strokeWidth={1.7} />
              </button>
            )}
          </div>
          <p className="home-sub">
            Sitca attends with you — lectures, meetings, and events, understood live.
          </p>
        </div>
        {showTour && <Tour onClose={closeTour} />}

        <div className="home-actions">
          <button className="home-action" onClick={onNewSession}>
            <span className="home-action-icon">
              <IconScreen size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">Start a live session</span>
            <span className="home-action-desc">
              Capture what you're attending — transcript, AI, and notes in real time.
            </span>
          </button>
          <button className="home-action" onClick={onGoEvents}>
            <span className="home-action-icon">
              <IconBroadcast size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">Plan an event</span>
            <span className="home-action-desc">
              For a date ahead: set the agenda, add your documents, and share the link or
              QR before the day. To go live this minute, start a session instead.
            </span>
          </button>
          <button className="home-action" onClick={onGoOverview}>
            <span className="home-action-icon">
              <IconSparkle size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">Ask your library</span>
            <span className="home-action-desc">
              One question across everything you've ever captured.
            </span>
          </button>
        </div>

        <button className="home-audio" onClick={onNewAudioSession}>
          <span className="home-audio-icon">
            <IconMic size={15} strokeWidth={1.8} />
          </span>
          <span>
            <span className="home-audio-title">Nothing to share on screen?</span>
            <span className="home-audio-desc">
              Record audio only — in-person meetings and lectures, one tap.
            </span>
          </span>
          <span className="home-door-arrow">→</span>
        </button>

        {upcomingEvents.length > 0 && (
          <>
            <div className="section-title" style={{ marginTop: 34 }}>
              Upcoming events
            </div>
            {upcomingEvents.map((e) => (
              <div key={e.id} className="home-event" onClick={onGoEvents}>
                <IconCalendar size={16} />
                <span style={{ fontWeight: 650 }}>{e.title}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 13 }}>
                  {e.startsAt
                    ? new Date(e.startsAt).toLocaleString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit'
                      })
                    : 'No date set'}
                </span>
                <span className="link" style={{ marginLeft: 'auto', fontSize: 13 }}>
                  Prepare →
                </span>
              </div>
            ))}
          </>
        )}

        {recent.length > 0 && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginTop: 30
              }}
            >
              <div className="section-title" style={{ margin: 0 }}>
                Pick up where you left off
              </div>
              <button className="link-btn" onClick={onGoLibrary}>
                View all →
              </button>
            </div>
            <div className="home-recent">
              {recent.map((s) => (
                <div key={s.id} className="lib-card" onClick={() => onOpenSession(s.id)}>
                  <div className="lib-thumb-wrap">
                    {s.banner ? (
                      <img className="lib-thumb" src={s.banner} alt="" />
                    ) : s.audioOnly ? (
                      <div className="lib-thumb-voice">
                        <span className="voice-bars" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="lib-thumb-voice-text">
                          <IconMic size={12} strokeWidth={2} /> Voice
                        </span>
                      </div>
                    ) : thumbs[s.id] ? (
                      <img className="lib-thumb" src={thumbs[s.id]} alt="" />
                    ) : (
                      <div className="lib-thumb-empty">
                        <IconPlay size={22} strokeWidth={1.5} />
                      </div>
                    )}
                    <span className="lib-duration">{formatDuration(s.durationMs)}</span>
                  </div>
                  <div className="lib-body">
                    <div className="lib-title">{s.title}</div>
                    <div className="lib-date">{formatDate(s.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
