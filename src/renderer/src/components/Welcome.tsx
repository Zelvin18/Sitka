import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { IconMic, IconScreen, IconSparkle, IconStar, Mark } from '../lib/icons'
import Tour from './Tour'

interface Props {
  /** the person's given name, for the greeting */
  name: string
  onClose: () => void
}

/**
 * The first thing a new account sees: a welcome by name, what Sitca does in
 * three lines, and a way in — the walkthrough, or straight to work. Shown
 * once per account, on whichever device they first sign in from.
 */
export default function Welcome({ name, onClose }: Props): React.JSX.Element {
  const [tour, setTour] = useState(false)
  const first = (name || '').trim().split(/\s+/)[0]
  const greeting = first && !first.includes('@') ? `Welcome, ${first}.` : 'Welcome.'

  if (tour) return <Tour onClose={onClose} />

  return createPortal(
    <div className="dialog-overlay welcome-overlay">
      <div className="welcome" role="dialog" aria-label="Welcome to Sitca">
        <div className="welcome-hero">
          <span className="welcome-glow" aria-hidden="true" />
          <span className="welcome-mark">
            <Mark size={38} />
          </span>
          <h1 className="welcome-title">{greeting}</h1>
          <p className="welcome-sub">
            Sitca sits in your lectures, meetings and talks. It listens, reads the screen, answers privately, and remembers
            every moment — so you attend once and keep it forever.
          </p>
        </div>
        <div className="welcome-body">
          <div className="welcome-rows">
            <div className="welcome-row">
              <span className="welcome-row-icon">
                <IconScreen size={17} strokeWidth={1.7} />
              </span>
              <span className="welcome-row-text">
                <b>Capture anything</b>
                <span>Share a screen, point a camera, or just listen — one tap and Sitca is with you.</span>
              </span>
            </div>
            <div className="welcome-row">
              <span className="welcome-row-icon">
                <IconSparkle size={17} strokeWidth={1.7} />
              </span>
              <span className="welcome-row-text">
                <b>Ask while it happens</b>
                <span>“What did she just say?” — a private answer, with the exact moment it was said.</span>
              </span>
            </div>
            <div className="welcome-row">
              <span className="welcome-row-icon">
                <IconStar size={17} strokeWidth={1.7} />
              </span>
              <span className="welcome-row-text">
                <b>Keep it forever</b>
                <span>Notes, a study pack and the recording, in a library you can question for years.</span>
              </span>
            </div>
          </div>
          <div className="welcome-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setTour(true)}>
              <IconMic size={13} strokeWidth={2.2} />
              See how it works · 1½ min
            </button>
            <button type="button" className="btn btn-primary welcome-go" onClick={onClose}>
              Start using Sitca
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
