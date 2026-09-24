import React from 'react'
import { IconMic, IconWand } from '../lib/icons'

interface Props {
  onPractise: () => void
  onMake: () => void
}

/**
 * Studio: what a person makes *from* their sessions. Practising a talk with
 * a coach, and turning a session into a document or a deck. Both used to be
 * top-level pages of their own; here they are two doors off one room, so the
 * sidebar stays about what people do every day.
 */
export default function StudioView({ onPractise, onMake }: Props): React.JSX.Element {
  return (
    <div className="content">
      <div className="content-inner" style={{ maxWidth: 880 }}>
        <div className="hub-head">
          <h1 className="page-title">Studio</h1>
          <p className="page-subtitle">Make something from what Sitca has heard, or rehearse what you will say next.</p>
        </div>
        <div className="home-actions hub-actions hub-two">
          <button className="home-action" onClick={onMake}>
            <span className="home-action-icon">
              <IconWand size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">Make from a session</span>
            <span className="home-action-desc">A document, a report, a set of slides &mdash; written from the session, in your words, ready to download.</span>
          </button>
          <button className="home-action" onClick={onPractise}>
            <span className="home-action-icon">
              <IconMic size={19} strokeWidth={1.7} />
            </span>
            <span className="home-action-title">Practise a talk</span>
            <span className="home-action-desc">Rehearse in front of an audience that listens, with a coach who whispers what to fix.</span>
          </button>
        </div>
      </div>
    </div>
  )
}
