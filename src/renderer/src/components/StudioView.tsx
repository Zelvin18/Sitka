import React from 'react'
import Photo from './Photo'
import { IconMic, IconWand } from '../lib/icons'

interface Props {
  onPractise: () => void
  onMake: () => void
}

/**
 * Studio: what a person makes *from* their sessions. Turning a session into
 * a document or a deck, and rehearsing a talk with a coach. Both used to be
 * top-level pages of their own; here they are two doors off one room, each
 * with a picture of what happens behind it, so the sidebar stays about what
 * people do every day.
 */
export default function StudioView({ onPractise, onMake }: Props): React.JSX.Element {
  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 940 }}>
        <div className="hub-head">
          <h1 className="page-title">Studio</h1>
          <p className="page-subtitle">Make something from what Sitca has heard, or rehearse what you will say next.</p>
        </div>
        <div className="studio-cards">
          <button className="studio-card" onClick={onMake}>
            <span className="studio-card-photo">
              <Photo name="business-hero" position="62% center" />
            </span>
            <span className="studio-card-body">
              <span className="studio-card-kicker">
                <IconWand size={13} strokeWidth={2} />
                From a session
              </span>
              <span className="studio-card-title">Make a document or a deck</span>
              <span className="studio-card-desc">
                A report, a memo, a proposal, a set of slides &mdash; written from what was said, in your words, ready to download and share.
              </span>
              <span className="studio-card-cta">Open Make &rarr;</span>
            </span>
          </button>
          <button className="studio-card" onClick={onPractise}>
            <span className="studio-card-photo">
              <Photo name="coach-hero" position="60% center" />
            </span>
            <span className="studio-card-body">
              <span className="studio-card-kicker">
                <IconMic size={13} strokeWidth={2} />
                Before you speak
              </span>
              <span className="studio-card-title">Practise a talk</span>
              <span className="studio-card-desc">
                Rehearse in front of an audience that listens, with a coach who whispers what to fix &mdash; pace, clarity, the moments that lose people.
              </span>
              <span className="studio-card-cta">Open Practise &rarr;</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
