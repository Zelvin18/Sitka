import React, { useEffect, useRef } from 'react'
import { ON_SCREEN_PREFIX, type Speaker, type TranscriptSegment } from '@shared/types'
import { speakerName } from '@shared/speakers'
import { formatTime } from '../lib/format'
import { IconScreen } from '../lib/icons'

interface Props {
  segments: TranscriptSegment[]
  /** current playback (or live) position in seconds, used to highlight the active segment */
  currentTime?: number
  onSeek?: (seconds: number) => void
  /** keep scrolled to the bottom as new segments arrive (live mode) */
  followLive?: boolean
  emptyText: string
  transcribing?: boolean
  /** the voices in the recording, once told apart: lines are labelled with who spoke */
  speakers?: Speaker[]
  /** a tap on a speaker's label: name them */
  onSpeaker?: (id: number) => void
  /** words to find: only lines that carry them are shown, the words marked */
  query?: string
}

export default function TranscriptPane({
  segments,
  currentTime,
  onSeek,
  followLive,
  emptyText,
  transcribing,
  speakers,
  onSpeaker,
  query
}: Props): React.JSX.Element {
  const q = (query ?? '').trim().toLowerCase()
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

  // a label is shown where the voice changes, not on every line: the
  // transcript reads like a conversation, one name per turn
  let lastSpeaker: number | undefined
  return (
    <div className="transcript" ref={scrollRef}>
      {segments.length === 0 && !transcribing && (
        <div className="transcript-waiting">{emptyText}</div>
      )}
      {q && segments.every((s) => !s.text.toLowerCase().includes(q)) && (
        <div className="transcript-waiting">Nothing in the session says “{query?.trim()}”.</div>
      )}
      {segments.map((seg, i) => {
        if (q && !seg.text.toLowerCase().includes(q)) return null
        const onScreen = seg.text.startsWith(ON_SCREEN_PREFIX)
        const turn = !onScreen && seg.speaker !== undefined && seg.speaker !== lastSpeaker
        if (!onScreen && seg.speaker !== undefined) lastSpeaker = seg.speaker
        return (
          <div
            key={`${seg.start}-${i}`}
            className={`transcript-seg${i === activeIndex ? ' active' : ''}${onScreen ? ' onscreen' : ''}${turn ? ' turn' : ''}`}
            data-seg-start={seg.start}
            onClick={() => onSeek?.(seg.start)}
          >
            <span className="ts">{formatTime(seg.start)}</span>
            <span className="transcript-text">
              {onScreen && (
                <span className="onscreen-tag">
                  <IconScreen size={11} strokeWidth={2} />
                  On screen
                </span>
              )}
              {turn && (
                <button
                  type="button"
                  className={`speaker-tag v${(seg.speaker as number) % 6}${speakers?.find((s) => s.id === seg.speaker)?.name ? ' named' : ''}`}
                  title={onSpeaker ? 'Name this voice' : undefined}
                  onClick={(e) => {
                    if (!onSpeaker) return
                    e.stopPropagation()
                    onSpeaker(seg.speaker as number)
                  }}
                >
                  {speakerName(speakers, seg.speaker)}
                </button>
              )}
              {marked(onScreen ? seg.text.slice(ON_SCREEN_PREFIX.length) : seg.text, q)}
            </span>
          </div>
        )
      })}
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

/** The text with the found words marked. */
function marked(text: string, q: string): React.ReactNode {
  if (!q) return text
  const out: React.ReactNode[] = []
  const lower = text.toLowerCase()
  let at = 0
  let i = lower.indexOf(q)
  let k = 0
  while (i >= 0) {
    if (i > at) out.push(text.slice(at, i))
    out.push(<mark key={k++}>{text.slice(i, i + q.length)}</mark>)
    at = i + q.length
    i = lower.indexOf(q, at)
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}
