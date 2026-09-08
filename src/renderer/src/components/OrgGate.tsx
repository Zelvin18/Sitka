import React, { useState } from 'react'
import type { Organization, Space } from '@shared/types'
import { IconBriefcase, IconCap, IconPlus, Mark } from '../lib/icons'

interface Props {
  kind: Space
  onJoined: (org: Organization) => void
}

/**
 * The door into an organisation: join with a code, or create one.
 * Shown on the Business and Education pages until the user belongs to one.
 */
export default function OrgGate({ kind, onJoined }: Props): React.JSX.Element {
  const education = kind === 'education'
  const [mode, setMode] = useState<'idle' | 'join' | 'create'>('idle')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const join = async (): Promise<void> => {
    if (!code.trim() || busy) return
    setBusy(true)
    setError(null)
    const res = await window.sitka.joinOrg(code)
    setBusy(false)
    if (res.error || !res.org) {
      setError(res.error ?? 'Could not join.')
      return
    }
    onJoined(res.org)
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    const res = await window.sitka.createOrg(name, kind)
    setBusy(false)
    if (res.error || !res.org) {
      setError(res.error ?? 'Could not create it.')
      return
    }
    onJoined(res.org)
  }

  return (
    <div className="org-gate">
      <div className="org-gate-art">
        {education ? <IconCap size={22} strokeWidth={1.5} /> : <IconBriefcase size={22} strokeWidth={1.5} />}
      </div>
      <div className="org-gate-text">
        <div className="org-gate-title">
          {education ? 'Part of a university or school?' : 'Part of a company or team?'}
        </div>
        <div className="org-gate-desc">
          {education
            ? 'Join your institution and Sitka becomes the companion for every course you take: it knows what your lecturers taught, in their words, and what they shared.'
            : 'Join your organisation and Sitka becomes your company’s memory: what was decided in every meeting, why, and who promised what.'}
        </div>
      </div>

      {mode === 'idle' && (
        <div className="org-gate-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setMode('join')}>
            Join with a code
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode('create')}>
            <IconPlus size={13} strokeWidth={2.2} />
            {education ? 'Set up my institution' : 'Set up my organisation'}
          </button>
        </div>
      )}

      {mode === 'join' && (
        <div className="org-gate-form">
          <input
            className="input org-gate-code"
            placeholder="Six-character code"
            value={code}
            maxLength={8}
            autoFocus
            spellCheck={false}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void join()
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={() => void join()} disabled={busy || !code.trim()}>
            {busy ? <Mark size={14} live /> : 'Join'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </div>
      )}

      {mode === 'create' && (
        <div className="org-gate-form">
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={education ? 'Institution name, e.g. University of Zimbabwe' : 'Organisation name'}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? <Mark size={14} live /> : 'Create'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </div>
      )}

      {error && <div className="notice notice-error" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  )
}
