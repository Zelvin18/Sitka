import React, { useEffect, useState } from 'react'
import type { Profile, SessionMeta } from '@shared/types'
import { IconFolder, IconSettings, IconSparkle } from '../lib/icons'

interface Props {
  sessions: SessionMeta[]
  onSettings: () => void
  onLibrary: () => void
  onOverview: () => void
}

const initials = (name: string): string =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || 'S'

function hoursLabel(ms: number): string {
  const h = ms / 3600000
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`
}

/**
 * The person, top right. An avatar with their initials; the menu shows who
 * they are, what their workspace holds (real counts only), and the few
 * places they go from anywhere: Settings, Library, Overview, sign out.
 */
export default function ProfileMenu({
  sessions,
  onSettings,
  onLibrary,
  onOverview
}: Props): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void window.sitka.getProfile().then(setProfile)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const done = sessions.filter((s) => s.status === 'complete' && !s.sample)
  const totalMs = done.reduce((n, s) => n + (s.durationMs || 0), 0)
  const name = profile?.name ?? ''

  return (
    <>
      <button
        className={`avatar-btn${open ? ' open' : ''}`}
        title={name ? `${name}${profile?.email ? ` · ${profile.email}` : ''}` : 'You'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {initials(name)}
      </button>

      {open && (
        <>
          <div className="menu-overlay" onMouseDown={() => setOpen(false)} />
          <div className="profile-menu" role="menu">
            <div className="profile-head">
              <span className="avatar-big">{initials(name)}</span>
              <span className="profile-who">
                <span className="profile-name">{name || 'You'}</span>
                <span className="profile-sub">
                  {profile?.email ?? (profile?.cloud ? 'Online workspace' : 'Local workspace on this computer')}
                </span>
              </span>
            </div>

            <div className="profile-stats">
              <span>
                <b>{done.length}</b> {done.length === 1 ? 'session' : 'sessions'}
              </span>
              <span className="profile-stats-dot" />
              <span>
                <b>{hoursLabel(totalMs)}</b> captured
              </span>
            </div>

            <div className="profile-links">
              <button
                className="menu-item profile-link"
                onClick={() => {
                  setOpen(false)
                  onOverview()
                }}
              >
                <IconSparkle size={14} />
                Overview
              </button>
              <button
                className="menu-item profile-link"
                onClick={() => {
                  setOpen(false)
                  onLibrary()
                }}
              >
                <IconFolder size={14} />
                Library
              </button>
              <button
                className="menu-item profile-link"
                onClick={() => {
                  setOpen(false)
                  onSettings()
                }}
              >
                <IconSettings size={14} />
                Settings
              </button>
            </div>

            <div className="profile-keys">
              <span>
                <kbd>Ctrl</kbd>
                <kbd>K</kbd> search anything
              </span>
              <span>
                <kbd>Ctrl</kbd>
                <kbd>Shift</kbd>
                <kbd>R</kbd> record now
              </span>
            </div>

            {profile?.cloud && (
              <div className="profile-foot">
                <button
                  className="menu-item profile-link"
                  onClick={() => {
                    setOpen(false)
                    void window.sitka.signOut()
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
