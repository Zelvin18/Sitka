import React, { useEffect, useRef, useState } from 'react'
import type { SessionMeta } from '@shared/types'
import { IconChatPhone, IconCopy, IconMail, IconShare } from '../lib/icons'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  meta: SessionMeta
  /** called with the public url when sharing starts, null when it stops */
  onChange: (url: string | null) => void
  onClose: () => void
}

/**
 * Share a session as a public recap page: the summary, key moments, notes and
 * transcript (the recording itself stays private). Pressing Share is asking
 * for the link, so the link is made at once and shown ready to copy, with the
 * usual ways to send it; there is no separate "create" step to mistake for a
 * copy.
 */
export default function ShareCard({ meta, onChange, onClose }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const url = meta.recapUrl ?? null
  const asked = useRef(false)

  const publish = (enable: boolean): void => {
    setBusy(true)
    setError(null)
    void window.sitka.publishRecap(meta.id, enable).then((res) => {
      setBusy(false)
      if (res.error) setError(res.error)
      else onChange(enable && res.url ? res.url : null)
    })
  }

  // the link is made the moment the card opens
  useEffect(() => {
    if (url || asked.current) return
    asked.current = true
    publish(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = (): void => {
    if (!url) return
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const title = meta.title || 'A session'
  const message = url ? `${title}: the recap on Sitca\n${url}` : ''
  const open = (href: string): void => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  const canShareNatively = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const ways = url
    ? [
        { label: 'WhatsApp', icon: <IconChatPhone size={15} />, go: () => open(`https://wa.me/?text=${encodeURIComponent(message)}`) },
        {
          label: 'Email',
          icon: <IconMail size={15} />,
          go: () => {
            location.href = `mailto:?subject=${encodeURIComponent(`${title}: the recap`)}&body=${encodeURIComponent(message)}`
          }
        },
        {
          label: 'Gmail',
          icon: <IconMail size={15} />,
          go: () => open(`https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(`${title}: the recap`)}&body=${encodeURIComponent(message)}`)
        },
        { label: 'LinkedIn', icon: <span className="share-way-mark">in</span>, go: () => open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`) },
        {
          label: 'X',
          icon: <span className="share-way-mark">X</span>,
          go: () => open(`https://x.com/intent/post?text=${encodeURIComponent(`${title}: the recap`)}&url=${encodeURIComponent(url)}`)
        },
        ...(canShareNatively
          ? [
              {
                label: 'More',
                icon: <IconShare size={15} />,
                go: () => void navigator.share({ title: `${title}: the recap`, text: `${title}: the recap on Sitca`, url }).catch(() => undefined)
              }
            ]
          : [])
      ]
    : []

  return (
    <div className="share-card">
      <div className="share-card-head">
        <div className="share-card-title">Share this session</div>
        <button className="share-card-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="share-card-desc">
        Anyone with the link sees the summary, key moments, notes and transcript, and can ask about them. The recording stays private.
      </div>

      <div className="share-card-linkrow">
        <div className={`share-card-url${url ? '' : ' pending'}`}>{url ?? (busy ? 'Making your link…' : error ? 'The link could not be made.' : 'Making your link…')}</div>
        {url ? (
          <button className="btn btn-primary btn-sm share-card-copy" onClick={copy}>
            <IconCopy size={13} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
        ) : (
          error && (
            <button className="btn btn-sm" onClick={() => publish(true)} disabled={busy}>
              Try again
            </button>
          )
        )}
      </div>
      {error && <div className="share-card-error">{error}</div>}

      {url && (
        <div className="share-ways">
          {ways.map((w) => (
            <button key={w.label} className="share-way" onClick={w.go}>
              <span className="share-way-icon">{w.icon}</span>
              <span>{w.label}</span>
            </button>
          ))}
        </div>
      )}

      {url && (
        <div className="share-card-foot">
          <button className="share-card-quiet" onClick={() => publish(true)} disabled={busy} title="Bring the page up to date with the latest summary and notes">
            {busy ? 'Updating…' : 'Update page'}
          </button>
          <span aria-hidden="true">·</span>
          <button className="share-card-quiet" onClick={() => setConfirmStop(true)} disabled={busy}>
            Stop sharing
          </button>
        </div>
      )}
      {confirmStop && (
        <ConfirmDialog
          title="Stop sharing this session?"
          message="The link will stop working for everyone who has it. You can share again later."
          confirmLabel="Stop sharing"
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false)
            publish(false)
            onClose()
          }}
        />
      )}
    </div>
  )
}
