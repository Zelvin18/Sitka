import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMeta, Settings } from '@shared/types'
import ConfirmDialog from './ConfirmDialog'
import { IconPlus, IconScreen, IconStar, IconTrash } from '../lib/icons'
import { formatDuration } from '../lib/format'

interface Props {
  sessions: SessionMeta[]
  settings: Settings | null
  onNewSession: () => void
  onOpenSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onSettings: () => void
}

export default function Home({
  sessions,
  settings,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onSettings
}: Props): React.JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [retryTick, setRetryTick] = useState(0)
  const requestedRef = useRef<Set<string>>(new Set())

  // Fetch (and lazily generate) a thumbnail per completed session. A failed
  // attempt (e.g. the recording was still finalizing) retries on the next
  // refresh instead of being cached forever.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const s of sessions) {
        if (s.status !== 'complete' || requestedRef.current.has(s.id)) continue
        requestedRef.current.add(s.id)
        const thumb = await window.sitka.getThumb(s.id)
        if (cancelled) return
        if (thumb) {
          setThumbs((prev) => ({ ...prev, [s.id]: thumb }))
        } else {
          setTimeout(() => requestedRef.current.delete(s.id), 5000)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessions, retryTick])

  // Keep retrying gently while any completed session still lacks a thumbnail.
  useEffect(() => {
    const missing = sessions.some((s) => s.status === 'complete' && !thumbs[s.id])
    if (!missing) return undefined
    const t = setTimeout(() => setRetryTick((n) => n + 1), 8000)
    return () => clearTimeout(t)
  }, [sessions, thumbs, retryTick])

  const missingKeys =
    settings !== null &&
    !settings.groqApiKey &&
    (!settings.anthropicApiKey || !settings.openaiApiKey)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.summary ?? '').toLowerCase().includes(q)
    )
  }, [sessions, query])

  // Group by calendar day (sessions arrive newest-first).
  const groups = useMemo(() => {
    const labelFor = (ms: number): string => {
      const d = new Date(ms)
      const now = new Date()
      const yesterday = new Date(now)
      yesterday.setDate(now.getDate() - 1)
      if (d.toDateString() === now.toDateString()) return 'Today'
      if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
      return d.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
      })
    }
    const out: { label: string; items: SessionMeta[] }[] = []
    for (const s of filtered) {
      const label = labelFor(s.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(s)
      else out.push({ label, items: [s] })
    }
    return out
  }, [filtered])

  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 960 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap'
          }}
        >
          <div>
            <h1 className="page-title">Library</h1>
            <p className="page-subtitle" style={{ marginBottom: 0 }}>
              Every session Sitka has attended with you — searchable, replayable,
              understood.
            </p>
          </div>
          {sessions.length > 0 && (
            <input
              className="input brain-search"
              style={{ maxWidth: 260, padding: '9px 16px' }}
              placeholder="Filter sessions…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        {missingKeys && (
          <div className="notice" style={{ marginTop: 24 }}>
            <span>
              <strong>Finish setup.</strong> Add API keys in{' '}
              <span className="link" onClick={onSettings}>
                Settings
              </span>{' '}
              to enable live transcription and Ask Sitka — a single free Groq key is
              enough for testing.
            </span>
          </div>
        )}

        {sessions.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconScreen size={36} strokeWidth={1.3} />
            </div>
            <div className="empty-title">No sessions yet</div>
            <div style={{ marginBottom: 20 }}>
              Start a live session before your next lecture, meeting, or presentation.
            </div>
            <button className="btn btn-primary btn-lg" onClick={onNewSession}>
              <IconPlus size={16} strokeWidth={2.2} />
              New live session
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 20 }}>
            {groups.map((g) => (
              <div key={g.label}>
                <div className="lib-group-label">{g.label}</div>
                <div className="lib-grid">
                  {g.items.map((s) => (
              <div key={s.id} className="lib-card" onClick={() => onOpenSession(s.id)}>
                <div className="lib-thumb-wrap">
                  {thumbs[s.id] ? (
                    <img className="lib-thumb" src={thumbs[s.id]} alt="" />
                  ) : (
                    <div className="lib-thumb-empty">
                      <IconScreen size={26} strokeWidth={1.4} />
                    </div>
                  )}
                  {s.status === 'recording' ? (
                    <span className="live-badge lib-overlay-left">● LIVE</span>
                  ) : (
                    <span className="lib-duration">{formatDuration(s.durationMs)}</span>
                  )}
                  {s.status === 'complete' &&
                    (s.hosted || (s.kind && s.kind !== 'other')) && (
                      <span className="lib-badge">
                        {s.hosted ? '● Hosted' : s.kind}
                      </span>
                    )}
                  {s.space && (
                    <span className="lib-badge lib-badge-space">
                      {s.space === 'business' ? 'Business' : 'Education'}
                    </span>
                  )}
                  <button
                    className="lib-delete"
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(s)
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
                <div className="lib-body">
                  <div className="lib-title">{s.title}</div>
                  <div className="lib-date">
                    {new Date(s.createdAt).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                    {(s.highlights?.length ?? 0) > 0 && (
                      <span className="lib-meta">
                        <IconStar size={11} /> {s.highlights!.length}
                      </span>
                    )}
                  </div>
                  {s.summary && <div className="lib-summary">{s.summary}</div>}
                </div>
              </div>
                  ))}
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="transcript-waiting">
                No session matches “{query.trim()}”.
              </div>
            )}
          </div>
        )}

        {pendingDelete && (
          <ConfirmDialog
            title="Delete session?"
            message={`“${pendingDelete.title}” — the recording, transcript, notes, and chat will be permanently deleted. This cannot be undone.`}
            onConfirm={() => {
              const id = pendingDelete.id
              setPendingDelete(null)
              onDeleteSession(id)
            }}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </div>
    </div>
  )
}
