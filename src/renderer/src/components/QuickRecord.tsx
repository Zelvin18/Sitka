import React, { useEffect, useState } from 'react'
import { IconMic } from '../lib/icons'
import { formatTime } from '../lib/format'

interface Props {
  /** a session is being recorded right now */
  recording: boolean
  /** when the current recording started (ms) */
  startedAt?: number
  /** the live page is on screen — the button steps aside */
  hidden: boolean
  onStart: () => void
  onOpen: () => void
}

/**
 * The floating record button. One tap starts an audio session on the spot,
 * no setup screen. While recording it becomes a red pill with the timer;
 * tapping that opens the live session, where End session lives.
 */
export default function QuickRecord({
  recording,
  startedAt,
  hidden,
  onStart,
  onOpen
}: Props): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!recording) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [recording])

  if (hidden) return null

  if (recording) {
    const elapsed = startedAt ? (now - startedAt) / 1000 : 0
    return (
      <button className="quick-rec live" onClick={onOpen} title="Open the live session">
        <span className="quick-rec-dot" />
        <span className="quick-rec-time">{formatTime(elapsed)}</span>
        <span className="quick-rec-label">Recording</span>
      </button>
    )
  }

  return (
    <button
      className="quick-rec"
      onClick={onStart}
      title="Record audio now (Ctrl+Shift+R)"
      aria-label="Record audio now"
    >
      <IconMic size={22} strokeWidth={1.9} />
    </button>
  )
}
