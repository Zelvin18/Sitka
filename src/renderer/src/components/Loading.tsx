import React, { useEffect, useState } from 'react'
import { Mark } from '../lib/icons'

/**
 * The one loading state: the Sitka mark with its point orbiting, the same
 * motion the AI shows while it thinks, and a line of words beneath that
 * moves on as the wait grows. The words end on "Almost there" and stay.
 */

export const LOADING_WORDS = {
  generic: ['Getting things ready', 'Almost there'],
  session: ['Opening this session', 'Gathering what was said', 'Almost there'],
  recording: ['Fetching the recording', 'Almost there'],
  library: ['Opening your library', 'Almost there'],
  events: ['Opening your events', 'Almost there'],
  coach: ['Opening this practice', 'Almost there'],
  space: ['Opening this space', 'Almost there'],
  overview: ['Reading across your sessions', 'Almost there']
} as const

interface Props {
  words?: readonly string[]
  /** a small row instead of a centred block (inside cards, video areas) */
  compact?: boolean
  /** light text for dark surfaces such as the video area */
  onDark?: boolean
  /** ms before anything is shown, so a quick load never flashes */
  delay?: number
  /** ms between one line of words and the next */
  step?: number
}

export default function Loading({
  words = LOADING_WORDS.generic,
  compact,
  onDark,
  delay = 160,
  step = 2400
}: Props): React.JSX.Element | null {
  const [shown, setShown] = useState(delay === 0)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (delay === 0) return undefined
    const t = setTimeout(() => setShown(true), delay)
    return () => clearTimeout(t)
  }, [delay])

  useEffect(() => {
    if (!shown || index >= words.length - 1) return undefined
    const t = setTimeout(() => setIndex((i) => Math.min(i + 1, words.length - 1)), step)
    return () => clearTimeout(t)
  }, [shown, index, words.length, step])

  if (!shown) return null
  const text = words[Math.min(index, words.length - 1)] ?? ''
  return (
    <div
      className={`loading${compact ? ' compact' : ''}${onDark ? ' on-dark' : ''}`}
      role="status"
      aria-live="polite"
    >
      <Mark size={compact ? 18 : 34} live />
      <span className="loading-words">
        <span key={index} className="loading-word">
          {text}
        </span>
      </span>
    </div>
  )
}
