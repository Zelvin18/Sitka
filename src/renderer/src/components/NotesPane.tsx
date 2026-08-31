import React from 'react'
import type { SessionNotes } from '@shared/types'
import AiText from './AiText'
import { parseTimestamp } from '../lib/format'
import { IconHelp, IconStar } from '../lib/icons'

interface Props {
  notes: SessionNotes | null
  onSeek: (seconds: number) => void
  emptyText: string
  updating?: boolean
}

export default function NotesPane({
  notes,
  onSeek,
  emptyText,
  updating
}: Props): React.JSX.Element {
  if (!notes || !notes.markdown) {
    return (
      <div className="transcript">
        <div className="transcript-waiting">
          {updating ? (
            <>
              <span className="dots">
                <span />
                <span />
                <span />
              </span>
              Writing notes…
            </>
          ) : (
            emptyText
          )}
        </div>
      </div>
    )
  }

  const important = notes.moments.filter((m) => m.kind === 'important')
  const questions = notes.moments.filter((m) => m.kind === 'question')

  return (
    <div className="transcript">
      {important.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 4 }}>
            Important points
          </div>
          {important.map((m, i) => {
            const secs = parseTimestamp(m.time)
            return (
              <div
                key={`imp-${i}`}
                className="highlight-row"
                onClick={() => secs !== null && onSeek(secs)}
              >
                <IconStar size={13} />
                <span className="ts" style={{ textAlign: 'left', minWidth: 48 }}>
                  {m.time}
                </span>
                <span>{m.label}</span>
              </div>
            )
          })}
        </>
      )}

      {questions.length > 0 && (
        <>
          <div className="section-title">Questions asked</div>
          {questions.map((m, i) => {
            const secs = parseTimestamp(m.time)
            return (
              <div
                key={`q-${i}`}
                className="highlight-row"
                onClick={() => secs !== null && onSeek(secs)}
              >
                <IconHelp size={13} />
                <span className="ts" style={{ textAlign: 'left', minWidth: 48 }}>
                  {m.time}
                </span>
                <span>{m.label}</span>
              </div>
            )
          })}
        </>
      )}

      <div className="section-title">Notes</div>
      <AiText text={notes.markdown} onSeek={onSeek} />
      {updating && (
        <div className="transcript-waiting">
          <span className="dots">
            <span />
            <span />
            <span />
          </span>
          Updating…
        </div>
      )}
    </div>
  )
}
