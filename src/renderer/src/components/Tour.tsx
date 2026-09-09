import React, { useEffect, useRef } from 'react'
import { mountTour } from '@shared/tour'

interface Props {
  onClose: () => void
}

/** The guided "How Sitka works" walkthrough, in a modal over the app. */
export default function Tour({ onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    return mountTour(node, { onDone: onClose, doneLabel: 'Start using Sitka', showSkip: false })
  }, [onClose])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="tour-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tour-modal-head">
          <span className="tour-modal-title">How Sitka works</span>
          <span className="tour-modal-time">about a minute and a half</span>
          <button className="tour-modal-skip" onClick={onClose}>
            Skip
          </button>
          <button className="tour-modal-x" onClick={onClose} aria-label="Close" title="Close">
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
