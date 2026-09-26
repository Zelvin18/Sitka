import React, { useEffect, useState } from 'react'
import { IconBroadcast, IconQr, IconSparkle } from '../lib/icons'
import EventsView from './EventsView'

interface Props {
  /** open this event's dashboard directly (deep link) */
  initialEventId?: string
  /** the person is on a paid plan: Send Sitca is theirs to use */
  paid: boolean
  onJoin: () => void
  onStartEvent: (eventId: string) => void
  onOpenSession: (sessionId: string) => void
}

const ASKED_KEY = 'sitka.sendSitca.asked'

/**
 * Live: every way into a room, in one place. Join something someone else is
 * hosting, host one yourself, or send Sitca to attend for you. Below, the
 * events this person hosts. Everything that used to be three sidebar
 * entries (Join, Events, and the way to a bot) is here, so "live" means one
 * thing wherever someone is coming from.
 */
export default function LiveHub({ initialEventId, paid, onJoin, onStartEvent, onOpenSession }: Props): React.JSX.Element {
  const [live, setLive] = useState<{ id: string; title: string; url: string }[]>([])
  // "Host an event" opens the new-event form; an event being edited has the page to itself
  const [createNonce, setCreateNonce] = useState(0)
  const [editing, setEditing] = useState<string | null>(initialEventId ?? null)
  const [sendOpen, setSendOpen] = useState(false)
  const [asked, setAsked] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ASKED_KEY) === '1'
    } catch {
      return false
    }
  })

  // the events this person is in right now: a way back in, while they are on
  useEffect(() => {
    let gone = false
    const look = (): void => {
      void window.sitka
        .listMyLive()
        .then((l) => {
          if (!gone) setLive(l)
        })
        .catch(() => undefined)
    }
    look()
    const t = window.setInterval(look, 30000)
    return () => {
      gone = true
      window.clearInterval(t)
    }
  }, [])

  const noteAsked = (): void => {
    try {
      localStorage.setItem(ASKED_KEY, '1')
    } catch {
      /* remembered for this visit only */
    }
    setAsked(true)
  }

  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 880 }}>
        {!editing && (
        <>
        <div className="hub-head">
          <h1 className="page-title">Live</h1>
          <p className="page-subtitle">Join a session, host one, or send Sitca in your place.</p>
        </div>

        {live.map((e) => (
          <a key={e.id} className="home-live" href={e.url} target="_blank" rel="noreferrer">
            <span className="live-badge">● LIVE</span>
            <span className="home-live-text">
              <b>{e.title}</b>
              <span>You are in this event. It stays in your library when it ends.</span>
            </span>
            <span className="btn btn-primary btn-sm">Rejoin</span>
          </a>
        ))}

        <div className="home-actions hub-actions">
          <button className="home-action" onClick={onJoin}>
            <span className="home-action-icon">
              <IconQr size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">Join a session</span>
            <span className="home-action-desc">Scan the host&rsquo;s QR code or paste their link. Captions in your language, and Sitca to ask privately.</span>
          </button>
          <button className="home-action" onClick={() => setCreateNonce((n) => n + 1)}>
            <span className="home-action-icon">
              <IconBroadcast size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">Host an event</span>
            <span className="home-action-desc">A link and a QR for the room. Everyone follows along in their own language and asks Sitca, not you.</span>
          </button>
          <button className="home-action" onClick={() => setSendOpen(true)}>
            <span className="home-action-icon">
              <IconSparkle size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">
              Send Sitca <span className="hub-badge">{paid ? 'Soon' : 'Plus'}</span>
            </span>
            <span className="home-action-desc">Can&rsquo;t make the meeting? Sitca attends for you and leaves the recap in your library.</span>
          </button>
        </div>

        </>
        )}
        <EventsView
          compact
          initialEventId={initialEventId}
          onStartEvent={onStartEvent}
          onOpenSession={onOpenSession}
          createNonce={createNonce}
          onSelect={setEditing}
        />
      </div>

      {sendOpen && (
        <>
          <div className="menu-overlay" onMouseDown={() => setSendOpen(false)} />
          <div className="dialog hub-sheet" role="dialog" aria-labelledby="send-sitca-title">
            <div className="dialog-title" id="send-sitca-title">Send Sitca to a meeting</div>
            <p className="hub-sheet-p">
              Give Sitca a Google Meet link and a time. It joins as a named guest &mdash; &ldquo;Sitca (notes for you)&rdquo; &mdash;
              listens, reads the screen, and leaves the recording, notes and recap in your library when the meeting ends.
              You can be there too and leave whenever you need to; nothing changes in the room when you go.
            </p>
            <p className="hub-sheet-p">
              {paid
                ? 'It is being finished for your plan now. You will see it here the moment it is on.'
                : 'It comes with Plus and above. You will see it here the moment it is on.'}
            </p>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => setSendOpen(false)}>
                Close
              </button>
              <button
                className="btn btn-primary"
                disabled={asked}
                onClick={() => {
                  noteAsked()
                  setSendOpen(false)
                }}
              >
                {asked ? 'You will be told' : 'Tell me when it is ready'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
