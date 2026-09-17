import React, { useEffect, useState } from 'react'

const ASKED = 'sitka.nameAsked'

/**
 * Asked once of an account that never gave a name (older accounts were known
 * by their email). What is typed becomes what Sitca calls the person, on
 * screen and in a kind word now and then. "Not now" keeps the peace until
 * the next time the app opens.
 */
export default function NamePrompt(): React.JSX.Element | null {
  const [show, setShow] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.sitka
      .getProfile()
      .then((p) => {
        if (cancelled || !p.needsName) return
        try {
          if (sessionStorage.getItem(ASKED) === '1') return
        } catch {
          /* no storage: ask anyway */
        }
        setShow(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (!show) return null

  const later = (): void => {
    try {
      sessionStorage.setItem(ASKED, '1')
    } catch {
      /* ignore */
    }
    setShow(false)
  }
  const save = async (): Promise<void> => {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    const p = await window.sitka.setProfileName(clean).catch(() => null)
    setBusy(false)
    if (p) {
      window.dispatchEvent(new CustomEvent('sitka:profile', { detail: p }))
      setShow(false)
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={later}>
      <div className="dialog name-prompt" onMouseDown={(e) => e.stopPropagation()}>
        <div className="name-prompt-title">What should Sitca call you?</div>
        <div className="name-prompt-sub">
          Your name, not your email — so the workspace, and a word of encouragement in practice, feel like yours.
        </div>
        <input
          className="input"
          autoFocus
          value={name}
          maxLength={80}
          placeholder="Your name"
          autoComplete="name"
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') later()
          }}
        />
        <div className="name-prompt-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={later}>
            Not now
          </button>
          <button type="button" className="btn btn-sm" disabled={!name.trim() || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'That’s me'}
          </button>
        </div>
      </div>
    </div>
  )
}
