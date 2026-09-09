import React, { useEffect, useRef } from 'react'
import { mountTour } from '@shared/tour'

interface Props {
  onClose: () => void
}

/** The one-minute "How Sitka works" walkthrough, in a modal over the app. */
export default function Tour({ onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const dispose = mountTour(node, { onDone: onClose, doneLabel: 'Start using Sitka' })
    return dispose
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
          <span>How Sitka works</span>
          <span className="tour-modal-time">1 minute</span>
        </div>
        <div ref={ref} />
      </div>
    </div>
  )
}
