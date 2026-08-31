import React, { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { ScheduledEvent } from '@shared/types'
import ConfirmDialog from './ConfirmDialog'
import { IconBroadcast, IconCalendar, IconNotes, IconPlus } from '../lib/icons'

interface Props {
  /** open this event's dashboard directly (deep link) */
  initialEventId?: string
  onStartEvent: (eventId: string) => void
  onOpenSession: (sessionId: string) => void
}

const ALL_VOICE_LANGS = [
  'Shona',
  'Ndebele',
  'Swahili',
  'French',
  'Portuguese',
  'Spanish',
  'German',
  'Arabic',
  'Chinese',
  'Hindi'
]

function toLocalInput(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function relativeWhen(startsAt?: number): string | null {
  if (!startsAt) return null
  const diff = startsAt - Date.now()
  if (diff < -6 * 3600000) return 'past'
  if (diff < 0) return 'happening now'
  const days = Math.floor(diff / 86400000)
  if (days === 0) {
    const hours = Math.round(diff / 3600000)
    return hours <= 1 ? 'starting soon' : `in ${hours} hours`
  }
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

export default function EventsView({
  initialEventId,
  onStartEvent,
  onOpenSession
}: Props): React.JSX.Element {
  const [events, setEvents] = useState<ScheduledEvent[]>([])
  const [armedEventId, setArmedEventId] = useState<string | undefined>()
  const [armedUrl, setArmedUrl] = useState<string | undefined>()
  const [selectedId, setSelectedId] = useState<string | null>(initialEventId ?? null)
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState('')
  const [agendaText, setAgendaText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<{ url: string; data: string | null } | null>(null)
  const [inlineQr, setInlineQr] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteName, setPasteName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ScheduledEvent | null>(null)
  const [agendaDraft, setAgendaDraft] = useState('')
  const [waitingCount, setWaitingCount] = useState(0)
  const [linkCopied, setLinkCopied] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const r = await window.sitka.listEvents()
    setEvents(r.events)
    setArmedEventId(r.status.running && r.status.waiting ? r.status.eventId : undefined)
    setArmedUrl(r.status.running && r.status.waiting ? r.status.url : undefined)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (initialEventId) setSelectedId(initialEventId)
  }, [initialEventId])

  const selected = selectedId ? events.find((e) => e.id === selectedId) ?? null : null
  const armed = selected !== null && armedEventId === selected.id

  useEffect(() => {
    if (selected) setAgendaDraft((selected.agenda ?? []).join('\n'))
  }, [selectedId, selected?.agenda?.length])

  // Inline QR image whenever this event's code is armed.
  useEffect(() => {
    if (!armed || !armedUrl) {
      setInlineQr(null)
      return
    }
    void QRCode.toDataURL(armedUrl, {
      width: 400,
      margin: 1,
      color: { dark: '#1a1a1c', light: '#ffffff' }
    })
      .then(setInlineQr)
      .catch(() => setInlineQr(null))
  }, [armed, armedUrl])

  // Live count of early scanners while this event's QR is armed.
  useEffect(() => {
    if (!selected || !armed) {
      setWaitingCount(0)
      return undefined
    }
    const poll = (): void => {
      void window.sitka.conferenceStatus().then((s) => {
        if (s.running && s.waiting && s.eventId === selected.id) {
          setWaitingCount(s.attendees ?? 0)
        }
      })
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [selectedId, armed, selected])

  const copyLink = (url: string): void => {
    void navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    })
  }

  const arm = async (event: ScheduledEvent): Promise<void> => {
    setError(null)
    const res = await window.sitka.armEvent(event.id)
    if (res.error || !res.url) {
      setError(res.error ?? 'Could not start the event server.')
      return
    }
    await refresh()
  }

  const createEvent = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const startsAt = when ? new Date(when).getTime() : null
    const agenda = agendaText.split('\n').map((l) => l.trim()).filter(Boolean)
    const res = await window.sitka.createEvent(title || 'Live event', startsAt, agenda)
    setBusy(false)
    if (res.error || !res.event) {
      setError(res.error ?? 'Could not create the event.')
      return
    }
    setCreateOpen(false)
    setTitle('')
    setWhen('')
    setAgendaText('')
    await refresh()
    setSelectedId(res.event.id)
  }

  const upcoming = events.filter((e) => !e.sessionId)
  const past = events.filter((e) => e.sessionId)

  const whenLabel = (e: ScheduledEvent): string =>
    e.startsAt
      ? new Date(e.startsAt).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
      : 'No date set'

  // ============ detail (event command center) ============
  if (selected) {
    const materials = selected.materials ?? []
    const topics = selected.agenda ?? []
    const preChatOn = selected.preEventChat !== false
    const voice = selected.liveVoice ?? { enabled: true, languages: ALL_VOICE_LANGS }
    const ready = [
      { done: Boolean(selected.startsAt), label: 'Date & time set' },
      { done: materials.length > 0, label: 'AI briefed with materials' },
      { done: topics.length > 0, label: 'Topics planned' },
      { done: armed, label: 'Join code live & shareable' }
    ]
    const readyCount = ready.filter((r) => r.done).length
    const rel = relativeWhen(selected.startsAt)

    return (
      <div className="content">
        <div className="content-inner" style={{ maxWidth: 920 }}>
          <button className="btn btn-ghost btn-sm page-back" onClick={() => setSelectedId(null)}>
            ‹ All events
          </button>

          <div className="evd-header">
            <div style={{ flex: 1, minWidth: 260 }}>
              <h1 className="page-title" style={{ marginBottom: 4 }}>
                {selected.title}
              </h1>
              <div className="evd-meta">
                <IconCalendar size={13} />
                <input
                  type="datetime-local"
                  className="evd-date-input"
                  value={toLocalInput(selected.startsAt)}
                  onChange={(e) => {
                    const value = e.target.value ? new Date(e.target.value).getTime() : null
                    void window.sitka
                      .updateEvent(selected.id, { startsAt: value })
                      .then(() => refresh())
                  }}
                />
                {rel && <span className="evd-rel">{rel}</span>}
              </div>
            </div>
            <button className="btn btn-primary btn-lg" onClick={() => onStartEvent(selected.id)}>
              <IconBroadcast size={16} />
              Go live now
            </button>
          </div>

          {error && (
            <div className="notice notice-error" style={{ marginTop: 14 }}>
              <span>{error}</span>
            </div>
          )}

          <div className="evd-grid">
            {/* ---------- left column ---------- */}
            <div className="evd-main">
              <div className="evd-card">
                <div className="evd-card-head">
                  <span>Event readiness</span>
                  <span className="evd-progress-label">
                    {readyCount} of {ready.length}
                  </span>
                </div>
                <div className="ready-bar">
                  <span style={{ width: `${(readyCount / ready.length) * 100}%` }} />
                </div>
                {ready.map((r, i) => (
                  <div key={i} className={`ready-item${r.done ? ' done' : ''}`}>
                    <span className="agenda-tick">{r.done ? '✓' : ''}</span>
                    {r.label}
                  </div>
                ))}
              </div>

              <div className="evd-card">
                <div className="evd-card-head">
                  <span>Brief the AI — materials</span>
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
                        void window.sitka.addMaterialFile(selected.id).then((r) => {
                          if (r.error) setError(r.error)
                          else void refresh()
                        })
                      }
                    >
                      <IconPlus size={12} strokeWidth={2.4} /> Add file
                    </button>
                  </div>
                </div>
                <p className="field-hint" style={{ marginBottom: materials.length > 0 ? 10 : 0 }}>
                  Slides, agendas, bios, briefs (PDF, TXT, MD) — everything here makes
                  every attendee's companion an expert on this event before it starts.
                </p>
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
                      onClick={() =>
                        void window.sitka.removeMaterial(selected.id, i).then(() => refresh())
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <div className="evd-card">
                <div className="evd-card-head">
                  <span>Planned topics</span>
                  <span className="evd-progress-label">ticked off live · graded in the report</span>
                </div>
                <textarea
                  className="textarea"
                  rows={Math.max(3, topics.length + 1)}
                  placeholder="One topic per line…"
                  value={agendaDraft}
                  onChange={(e) => setAgendaDraft(e.target.value)}
                  onBlur={() =>
                    void window.sitka
                      .updateEvent(selected.id, {
                        agenda: agendaDraft.split('\n').map((l) => l.trim()).filter(Boolean)
                      })
                      .then(() => refresh())
                  }
                  spellCheck={false}
                />
              </div>

              <button
                className="btn btn-ghost btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setPendingDelete(selected)}
              >
                Delete event
              </button>
            </div>

            {/* ---------- right column ---------- */}
            <div className="evd-side">
              <div className="evd-card evd-qr-card">
                <div className="evd-card-head">
                  <span>Join code</span>
                  {armed && <span className="ev-armed">Live</span>}
                </div>
                {armed && inlineQr ? (
                  <>
                    <img
                      src={inlineQr}
                      alt="Join QR"
                      className="evd-qr-img"
                      title="Click to enlarge"
                      onClick={() => armedUrl && setQr({ url: armedUrl, data: inlineQr })}
                    />
                    <div className="evd-qr-url">{armedUrl}</div>
                    <div className="evd-waiting">
                      <span className="rec-dot" style={{ background: 'var(--text)' }} />
                      {waitingCount === 0
                        ? 'No one waiting yet — share the code'
                        : `${waitingCount} already waiting`}
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => armedUrl && copyLink(armedUrl)}
                      >
                        {linkCopied ? 'Copied ✓' : 'Copy link'}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          inlineQr && void window.sitka.saveQr(inlineQr, selected.title)
                        }
                      >
                        Save image…
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="evd-qr-placeholder">
                      <div className="art-qr" style={{ position: 'static', transform: 'none', opacity: 0.45 }}>
                        {Array.from({ length: 9 }).map((_, i) => (
                          <span key={i} className={i % 2 === 0 ? 'on' : ''} />
                        ))}
                      </div>
                    </div>
                    <p className="field-hint" style={{ textAlign: 'center', marginBottom: 12 }}>
                      Arm the code to let people scan in early — they can already ask
                      the AI about your event.
                    </p>
                    <button className="btn btn-primary" onClick={() => void arm(selected)}>
                      Arm join code
                    </button>
                  </>
                )}
              </div>

              <div className="evd-card">
                <div className="evd-card-head" style={{ marginBottom: 4 }}>
                  <span>Pre-event Q&amp;A</span>
                  <button
                    className={`switch${preChatOn ? ' on' : ''}`}
                    aria-label="Toggle pre-event Q&A"
                    onClick={() =>
                      void window.sitka
                        .updateEvent(selected.id, { preEventChat: !preChatOn })
                        .then(() => refresh())
                    }
                  />
                </div>
                <p className="field-hint" style={{ margin: 0 }}>
                  {preChatOn
                    ? materials.length > 0
                      ? 'Early scanners can already ask the AI about your event — it answers from your materials.'
                      : 'On — add materials above so the AI has something to answer from.'
                    : 'Off — early scanners see the waiting page only, until you go live.'}
                </p>
              </div>

              <div className="evd-card">
                <div className="evd-card-head" style={{ marginBottom: 4 }}>
                  <span>Live Voice</span>
                  <button
                    className={`switch${voice.enabled ? ' on' : ''}`}
                    aria-label="Toggle Live Voice"
                    onClick={() =>
                      void window.sitka
                        .updateEvent(selected.id, {
                          liveVoice: { enabled: !voice.enabled, languages: voice.languages }
                        })
                        .then(() => refresh())
                    }
                  />
                </div>
                <p className="field-hint" style={{ marginBottom: voice.enabled ? 10 : 0 }}>
                  {voice.enabled
                    ? 'Attendees follow your event as live captions in their language — and can have their phone speak them aloud. Offered languages:'
                    : 'Off — everyone sees the original captions only.'}
                </p>
                {voice.enabled && (
                  <div className="kind-row">
                    {ALL_VOICE_LANGS.map((lang) => {
                      const on = voice.languages.includes(lang)
                      return (
                        <button
                          key={lang}
                          className={`kind-chip${on ? ' sel' : ''}`}
                          style={{ padding: '4px 11px', fontSize: 12 }}
                          onClick={() =>
                            void window.sitka
                              .updateEvent(selected.id, {
                                liveVoice: {
                                  enabled: true,
                                  languages: on
                                    ? voice.languages.filter((l) => l !== lang)
                                    : [...voice.languages, lang]
                                }
                              })
                              .then(() => refresh())
                          }
                        >
                          {lang}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="evd-card" style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 650, marginBottom: 4 }}>Showtime?</div>
                <p className="field-hint" style={{ marginBottom: 12 }}>
                  Launching opens your Co-Pilot console — every waiting phone connects
                  instantly.
                </p>
                <button className="btn" onClick={() => onStartEvent(selected.id)}>
                  <IconBroadcast size={14} />
                  Launch event
                </button>
              </div>
            </div>
          </div>
        </div>

        {qr && (
          <div className="dialog-overlay" onMouseDown={() => setQr(null)}>
            <div
              className="dialog"
              style={{ width: 380, textAlign: 'center' }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="dialog-title" style={{ fontSize: 17 }}>
                {selected.title}
              </div>
              {qr.data && (
                <img
                  src={qr.data}
                  alt="Join QR"
                  style={{
                    width: 280,
                    height: 280,
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
                <button className="btn btn-primary" onClick={() => setQr(null)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {pasteOpen && (
          <div className="dialog-overlay" onMouseDown={() => setPasteOpen(false)}>
            <div className="dialog" style={{ width: 440 }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="dialog-title">Paste event material</div>
              <div className="field">
                <label className="field-label">Name</label>
                <input
                  className="input"
                  value={pasteName}
                  placeholder="e.g. Keynote outline"
                  onChange={(e) => setPasteName(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">Content</label>
                <textarea
                  className="textarea"
                  rows={8}
                  value={pasteText}
                  placeholder="Paste slides text, agenda, brief…"
                  onChange={(e) => setPasteText(e.target.value)}
                />
              </div>
              <div className="dialog-actions">
                <button className="btn" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!pasteText.trim()}
                  onClick={() =>
                    void window.sitka
                      .addMaterialText(selected.id, pasteName, pasteText)
                      .then((r) => {
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
            title="Delete event?"
            message={`“${pendingDelete.title}” and its materials will be permanently deleted. This cannot be undone.`}
            onConfirm={() => {
              const id = pendingDelete.id
              setPendingDelete(null)
              setSelectedId(null)
              void window.sitka.deleteEvent(id).then(() => refresh())
            }}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </div>
    )
  }

  // ============ list view ============
  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 860 }}>
        <div className="ev-hero">
          <div className="ev-hero-text">
            <h1 className="ev-hero-title">
              Events people
              <br />
              never forget.
            </h1>
            <p className="ev-hero-sub">
              Brief the AI with your documents, share the QR days ahead, and give
              every person in the room their own companion — in their language, at
              their level.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary btn-lg"
                onClick={() => {
                  setError(null)
                  setCreateOpen(true)
                }}
              >
                <IconPlus size={16} strokeWidth={2.2} />
                Create an event
              </button>
            </div>
          </div>
          <div className="ev-hero-art">
            <div className="ev-art-qr">
              {Array.from({ length: 16 }).map((_, i) => (
                <span key={i} className={[0, 1, 2, 4, 5, 7, 8, 10, 13, 15].includes(i) ? 'on' : ''} />
              ))}
            </div>
            <div className="ev-art-pulse" />
            <div className="ev-art-phone p1">
              <span className="ev-art-line" />
              <span className="ev-art-line short" />
              <span className="ev-art-bubble">Explain this simply</span>
            </div>
            <div className="ev-art-phone p2">
              <span className="ev-art-line" />
              <span className="ev-art-line short" />
              <span className="ev-art-bubble">¿Qué significa esto?</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="notice notice-error" style={{ marginTop: 18 }}>
            <span>{error}</span>
          </div>
        )}

        {upcoming.length > 0 && (
          <>
            <div className="section-title" style={{ marginTop: 28 }}>
              Upcoming
            </div>
            {upcoming.map((e) => (
              <div key={e.id} className="ev-row" onClick={() => setSelectedId(e.id)}>
                <div className="ev-date">
                  <IconCalendar size={15} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ev-title">{e.title}</div>
                  <div className="ev-sub">
                    {whenLabel(e)}
                    {(e.materials?.length ?? 0) > 0 && ` · ${e.materials!.length} materials`}
                    {(e.agenda?.length ?? 0) > 0 && ` · ${e.agenda!.length} topics`}
                  </div>
                </div>
                {armedEventId === e.id && <span className="ev-armed">QR live</span>}
                <button
                  className="btn btn-sm"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onStartEvent(e.id)
                  }}
                >
                  Go live
                </button>
              </div>
            ))}
          </>
        )}

        {past.length > 0 && (
          <>
            <div className="section-title" style={{ marginTop: 28 }}>
              Past events
            </div>
            {past.map((e) => (
              <div
                key={e.id}
                className="ev-row"
                onClick={() => e.sessionId && onOpenSession(e.sessionId)}
              >
                <div className="ev-date" style={{ opacity: 0.5 }}>
                  <IconCalendar size={15} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ev-title">{e.title}</div>
                  <div className="ev-sub">{whenLabel(e)} · view session & report</div>
                </div>
                <span className="link" style={{ fontSize: 13 }}>
                  Report →
                </span>
              </div>
            ))}
          </>
        )}

        <div className="section-title" style={{ marginTop: 34 }}>
          {events.length === 0 ? 'What is Events?' : 'How Events works'}
        </div>
        <p className="feat-intro">
          Events turns any presentation, lecture, or conference you host into an
          AI-powered experience for your whole audience. You create the event here,
          upload your documents so the AI is briefed, and share one QR code. Everyone
          who scans it — on their own phone, no app, no account — gets a personal AI
          companion for your event: a live transcript, private questions answered at
          their level and in their language, a smart way to ask you questions, and a
          personalized take-home pack when it ends. You, meanwhile, present with a
          Co-Pilot console showing who's connected, what they're asking, and what you
          haven't covered yet.
        </p>

        <div className="ev-steps">
          <div className="ev-step">
            <span className="ev-step-num">1</span>
            <span className="ev-step-title">Create &amp; brief</span>
            <span className="ev-step-desc">
              Add your slides, agenda, and briefs — the AI becomes an expert on your
              event.
            </span>
          </div>
          <span className="ev-step-arrow">→</span>
          <div className="ev-step">
            <span className="ev-step-num">2</span>
            <span className="ev-step-title">Share the QR early</span>
            <span className="ev-step-desc">
              Attendees scan days ahead and can already ask the AI what to expect.
            </span>
          </div>
          <span className="ev-step-arrow">→</span>
          <div className="ev-step">
            <span className="ev-step-num">3</span>
            <span className="ev-step-title">Go live</span>
            <span className="ev-step-desc">
              Every phone comes alive — private AI, smart questions, and your Co-Pilot
              dashboard.
            </span>
          </div>
        </div>

        <div className="ev-chips">
          <span>Pre-event Q&amp;A</span>
          <span>11 languages</span>
          <span>Already-answered detection</span>
          <span>Audience pulse</span>
          <span>Take-home packs</span>
          <span>Event report</span>
        </div>

        {createOpen && (
          <div className="dialog-overlay" onMouseDown={() => setCreateOpen(false)}>
            <div className="dialog" style={{ width: 420 }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="dialog-title">New event</div>
              <div className="dialog-message">
                Your event dashboard — with the shareable join code — is created
                immediately.
              </div>
              <div className="field">
                <label className="field-label">Event name</label>
                <input
                  className="input"
                  value={title}
                  autoFocus
                  placeholder="e.g. Q3 All-Hands · Marketing 101"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">Starts (optional)</label>
                <input
                  type="datetime-local"
                  className="input"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">Planned topics (optional, one per line)</label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={agendaText}
                  onChange={(e) => setAgendaText(e.target.value)}
                />
              </div>
              <div className="dialog-actions">
                <button className="btn" onClick={() => setCreateOpen(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={() => void createEvent()}>
                  {busy ? 'Creating…' : 'Create event'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
