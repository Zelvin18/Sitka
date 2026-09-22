import React, { useEffect, useRef } from 'react'

interface Props {
  onClose: () => void
}

/** "How Sitca works": the film, under a minute, in a modal over the app. */
export default function Tour({ onClose }: Props): React.JSX.Element {
  // The parent may re-render (and hand over a new onClose) while the film
  // plays; that must never restart it.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="dialog-overlay" onClick={() => onCloseRef.current()}>
      <div className="tour-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tour-modal-head">
          <span className="tour-modal-title">How Sitca works</span>
          <span className="tour-modal-time">under a minute</span>
          <button className="tour-modal-skip" onClick={() => onCloseRef.current()}>
            Skip
          </button>
          <button
            className="tour-modal-x"
            onClick={() => onCloseRef.current()}
            aria-label="Close"
            title="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <video
          className="tour-film"
          src="/sitca-hero.mp4"
          poster="/sitca-hero.jpg"
          controls
          autoPlay
          playsInline
          onEnded={() => onCloseRef.current()}
        />
      </div>
    </div>
  )
}
