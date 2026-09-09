import React, { useEffect, useRef, useState } from 'react'
import type { Space } from '@shared/types'
import { IconBriefcase, IconCap, IconChevron, Mark } from '../lib/icons'

interface Props {
  space: Space | undefined
  /** undefined = personal (the general workspace) */
  onPick: (space: Space | undefined) => void
}

const LABEL: Record<string, string> = { business: 'Business', education: 'Education' }

/**
 * "Sitka for ▾" — one button in the top bar that opens a small menu with the
 * three places Sitka can be used: personal, Education, Business.
 */
export default function SpaceMenu({ space, onPick }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent | TouchEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (s: Space | undefined): void => {
    setOpen(false)
    onPick(s)
  }

  return (
    <div className="space-wrap" ref={wrapRef}>
      <button
        className={`space-menu-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose where you are using Sitka"
      >
        <span className="space-menu-kicker">Sitka for</span>
        <span className="space-menu-current">{space ? LABEL[space] : 'you'}</span>
        <IconChevron size={15} strokeWidth={2.2} />
      </button>
      {open && (
        <div className="space-menu" role="menu">
          <button className={`space-item${!space ? ' on' : ''}`} role="menuitem" onClick={() => pick(undefined)}>
            <span className="space-item-icon">
              <Mark size={16} />
            </span>
            <span className="space-item-text">
              <b>Personal</b>
              <small>Your own sessions, notes and memory.</small>
            </span>
          </button>
          <button
            className={`space-item${space === 'education' ? ' on' : ''}`}
            role="menuitem"
            onClick={() => pick('education')}
          >
            <span className="space-item-icon">
              <IconCap size={17} strokeWidth={1.8} />
            </span>
            <span className="space-item-text">
              <b>Education</b>
              <small>Lectures, courses and exams.</small>
            </span>
          </button>
          <button
            className={`space-item${space === 'business' ? ' on' : ''}`}
            role="menuitem"
            onClick={() => pick('business')}
          >
            <span className="space-item-icon">
              <IconBriefcase size={17} strokeWidth={1.8} />
            </span>
            <span className="space-item-text">
              <b>Business</b>
              <small>Meetings, decisions and follow-through.</small>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
