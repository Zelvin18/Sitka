import React, { useState } from 'react'
import type { SessionMeta } from '@shared/types'
import { IconLink } from '../lib/icons'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  meta: SessionMeta
  /** called with the public url when sharing starts, null when it stops */
  onChange: (url: string | null) => void
  onClose: () => void
}

/**
 * Share any session as a public recap page. Text only — the summary, key
 * moments, notes and transcript. The recording never leaves the workspace.
 */
export default function ShareCard({ meta, onChange, onClose }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const url = meta.recapUrl ?? null

  const publish = (enable: boolean): void => {
    setBusy(true)
    setError(null)
    void window.sitka.publishRecap(meta.id, enable).then((res) => {
      setBusy(false)
      if (res.error) setError(res.error)
      else onChange(enable && res.url ? res.url : null)
    })
  }

  const copy = (): void => {
    if (!url) return
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="share-card">
      <div className="share-card-body">
        <div className="share-card-title">
          {url ? 'This session is shared' : 'Share a recap of this session'}
        </div>
        <div className="share-card-desc">
          {url
            ? 'Anyone with the link can read the summary, key moments, notes and transcript, and ask the session questions. The recording stays private.'
            : 'Creates a public page with the summary, key moments, notes and the clickable transcript. Colleagues can ask it questions without an account. The recording stays private.'}
        </div>
        {url && (
          <button className="share-card-link" onClick={copy} title="Copy link">
            <IconLink size={13} />
            <span>{url}</span>
          </button>
        )}
        {error && <div className="share-card-error">{error}</div>}
      </div>
      <div className="share-card-actions">
        {url ? (
          <>
            <button className="btn btn-sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={publish.bind(null, true)} disabled={busy}>
              {busy ? 'Updating…' : 'Update'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmStop(true)} disabled={busy}>
              Stop sharing
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => publish(true)} disabled={busy}>
              {busy ? 'Creating link…' : 'Create link'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </div>
      {confirmStop && (
        <ConfirmDialog
          title="Stop sharing this session?"
          message="The link will stop working for everyone who has it. You can share again later."
          confirmLabel="Stop sharing"
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false)
            publish(false)
          }}
        />
      )}
    </div>
  )
}
