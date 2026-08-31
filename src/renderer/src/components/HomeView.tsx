import React, { useEffect, useRef, useState } from 'react'
import type { ScheduledEvent, SessionMeta } from '@shared/types'
import {
  IconBroadcast,
  IconCalendar,
  IconPlay,
  IconScreen,
  IconSparkle
} from '../lib/icons'
import { formatDate, formatDuration } from '../lib/format'

interface Props {
  sessions: SessionMeta[]
  onNewSession: () => void
  onGoEvents: () => void
  onGoOverview: () => void
  onGoLibrary: () => void
  onOpenSession: (id: string) => void
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
  onNewSession,
  onGoEvents,
  onGoOverview,
  onGoLibrary,
  onOpenSession
}: Props): React.JSX.Element {
  const [events, setEvents] = useState<ScheduledEvent[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [retryTick, setRetryTick] = useState(0)
  const requestedRef = useRef<Set<string>>(new Set())
  const recent = sessions.filter((s) => s.status === 'complete').slice(0, 3)
  const upcomingEvents = events.filter((e) => !e.sessionId).slice(0, 2)

  useEffect(() => {
    void window.sitka.listEvents().then((r) => setEvents(r.events))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const s of recent) {
        if (requestedRef.current.has(s.id)) continue
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
    const missing = recent.some((s) => !thumbs[s.id])
    if (!missing) return undefined
    const t = setTimeout(() => setRetryTick((n) => n + 1), 7000)
    return () => clearTimeout(t)
  }, [sessions, thumbs, retryTick])

  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 880 }}>
        <div className="home-hero">
          <div className="wordmark-dot home-dot" />
          <h1 className="home-greeting">{greeting()}.</h1>
          <p className="home-sub">
            Sitka attends with you — lectures, meetings, and events, understood live.
          </p>
        </div>

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
            <span className="home-action-title">Host an event</span>
            <span className="home-action-desc">
              Plan it, brief the AI with your documents, and give every attendee a
              companion.
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
                    {thumbs[s.id] ? (
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
