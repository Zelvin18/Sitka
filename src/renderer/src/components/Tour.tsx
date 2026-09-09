import React, { useEffect, useRef } from 'react'
import { mountTour } from '@shared/tour'

interface Props {
  onClose: () => void
}

/** The guided "How Sitka works" walkthrough, in a modal over the app. */
export default function Tour({ onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // The player is mounted exactly once. The parent may re-render (and hand
  // over a new onClose) while it plays; that must never restart the tour.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    return mountTour(node, {
      onDone: () => onCloseRef.current(),
      doneLabel: 'Start using Sitka',
      showSkip: false
    })
  }, [])
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
          <span className="tour-modal-title">How Sitka works</span>
          <span className="tour-modal-time">about a minute and a half</span>
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
        <div ref={ref} />
      </div>
    </div>
  )
}
