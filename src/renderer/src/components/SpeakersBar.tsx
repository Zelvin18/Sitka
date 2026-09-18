import React, { useEffect, useRef, useState } from 'react'
import type { Speaker } from '@shared/types'
import { speakerName } from '@shared/speakers'
import { IconPlay } from '../lib/icons'

interface Props {
  speakers: Speaker[] | undefined
  /** when the voices were last told apart */
  at?: number
  /** why it could not be done the last time */
  error?: string
  /** the recording is someone else's, or not in the cloud: no listening again */
  canIdentify: boolean
  busy: boolean
  onIdentify: () => void
  /** play the recording from a moment where a voice is heard clearly */
  onListen: (seconds: number) => void
  onName: (id: number, name: string) => Promise<void>
  /** a voice the transcript asked to name (a tap on its label) */
  naming: number | null
  onNamingDone: () => void
}

function minutes(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  return `${Math.round(seconds / 60)} min`
}

/**
 * Who spoke. Above the transcript: one chip per voice, how long it spoke,
 * a play button to hear it, and a tap to give it a name. Until the voices
 * have been told apart, the one button that does it.
 */
export default function SpeakersBar({
  speakers,
  at,
  error,
  canIdentify,
  busy,
  onIdentify,
  onListen,
  onName,
  naming,
  onNamingDone
}: Props): React.JSX.Element | null {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // the transcript's label was tapped: the same little form opens here
  useEffect(() => {
    if (naming === null) return
    setEditing(naming)
    setDraft(speakers?.find((s) => s.id === naming)?.name ?? '')
    onNamingDone()
  }, [naming, speakers, onNamingDone])
  useEffect(() => {
    if (editing !== null) inputRef.current?.focus()
  }, [editing])

  const save = async (): Promise<void> => {
    if (editing === null || saving) return
    setSaving(true)
    await onName(editing, draft)
    setSaving(false)
    setEditing(null)
  }

  if (!speakers || speakers.length === 0) {
    if (!canIdentify && !error) return null
    return (
      <div className="speakers-bar">
        <div className="speakers-empty">
          <span className="speakers-hint">
            {busy
              ? 'Listening to the recording again, telling the voices apart…'
              : error
                ? error
                : 'Sitca can listen again and tell who said what.'}
          </span>
          {canIdentify && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onIdentify}>
              {busy ? 'Listening…' : error ? 'Try again' : 'Tell voices apart'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="speakers-bar">
      <div className="speakers-row">
        {speakers.map((s) => (
          <span key={s.id} className={`speaker-chip v${s.id % 6}${s.name ? ' named' : ''}`}>
            <button
              type="button"
              className="speaker-chip-play"
              title="Hear this voice"
              aria-label={`Hear ${speakerName(speakers, s.id)}`}
              onClick={() => onListen(s.at)}
            >
              <IconPlay size={10} strokeWidth={2.4} />
            </button>
            {editing === s.id ? (
              <span className="speaker-chip-edit">
                <input
                  ref={inputRef}
                  className="input"
                  value={draft}
                  maxLength={60}
                  placeholder={`Speaker ${s.id + 1}`}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
                <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void save()}>
                  {saving ? '…' : 'Save'}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="speaker-chip-name"
                title="Name this voice"
                onClick={() => {
                  setEditing(s.id)
                  setDraft(s.name ?? '')
                }}
              >
                {speakerName(speakers, s.id)}
                <span className="speaker-chip-mins">{minutes(s.seconds)}</span>
              </button>
            )}
          </span>
        ))}
        {canIdentify && (
          <button
            type="button"
            className="btn btn-ghost btn-sm speakers-again"
            disabled={busy}
            title={at ? `Told apart ${new Date(at).toLocaleDateString()}` : undefined}
            onClick={onIdentify}
          >
            {busy ? 'Listening…' : 'Listen again'}
          </button>
        )}
      </div>
      {speakers.some((s) => !s.name) && (
        <div className="speakers-hint">Tap a voice to name it. Then ask Sitca what that person said.</div>
      )}
      {error && <div className="speakers-hint speakers-error">{error}</div>}
    </div>
  )
}
