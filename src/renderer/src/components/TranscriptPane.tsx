import React, { useEffect, useRef } from 'react'
import type { TranscriptSegment } from '@shared/types'
import { formatTime } from '../lib/format'

interface Props {
  segments: TranscriptSegment[]
  /** current playback (or live) position in seconds, used to highlight the active segment */
  currentTime?: number
  onSeek?: (seconds: number) => void
  /** keep scrolled to the bottom as new segments arrive (live mode) */
  followLive?: boolean
  emptyText: string
  transcribing?: boolean
}

export default function TranscriptPane({
  segments,
  currentTime,
  onSeek,
  followLive,
  emptyText,
  transcribing
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (followLive && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [segments.length, followLive])

  const activeIndex =
    currentTime === undefined
      ? -1
      : segments.findIndex((s) => currentTime >= s.start && currentTime < s.end)

  return (
    <div className="transcript" ref={scrollRef}>
      {segments.length === 0 && !transcribing && (
        <div className="transcript-waiting">{emptyText}</div>
      )}
      {segments.map((seg, i) => (
        <div
          key={`${seg.start}-${i}`}
          className={`transcript-seg${i === activeIndex ? ' active' : ''}`}
          data-seg-start={seg.start}
          onClick={() => onSeek?.(seg.start)}
        >
          <span className="ts">{formatTime(seg.start)}</span>
          <span className="transcript-text">{seg.text}</span>
        </div>
      ))}
      {transcribing && (
        <div className="transcript-waiting">
          <span className="dots">
            <span />
            <span />
            <span />
          </span>
          Listening
        </div>
      )}
    </div>
  )
}
