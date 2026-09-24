import React, { useEffect, useState } from 'react'
import type { SessionMeta } from '@shared/types'
import {
  IconBriefcase,
  IconBroadcast,
  IconDots,
  IconFolder,
  IconHome,
  IconMenu,
  IconPlus,
  IconSettings,
  IconSparkle,
  IconWand,
  Mark
} from '../lib/icons'
import { formatDuration } from '../lib/format'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  sessions: SessionMeta[]
  activeView: string
  activeSessionId?: string
  recordingSessionId?: string
  onHomePage: () => void
  /** Live: join, host, or send Sitca */
  onLive: () => void
  /** Studio: practise a talk, make something from a session */
  onStudio: () => void
  /** the person's organisation, when they belong to one */
  onWorkspace?: () => void
  onHome: () => void
  onNewSession: () => void
  onBrain: () => void
  onOpenSession: (id: string) => void
  onSettings: () => void
  onCollapse: () => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
}

interface MenuState {
  id: string
  x: number
  y: number
}

const PHONE_QUERY = '(max-width: 859px)'

export default function Sidebar({
  sessions,
  activeView,
  activeSessionId,
  recordingSessionId,
  onHomePage,
  onLive,
  onStudio,
  onWorkspace,
  onHome,
  onNewSession,
  onBrain,
  onOpenSession,
  onSettings,
  onCollapse,
  onRenameSession,
  onDeleteSession
}: Props): React.JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // On a phone the sidebar is a drawer with little height: the places stay
  // in view, the sessions get the room, and the way to a new session sits at
  // the foot with Settings beside it.
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY)
    const on = (): void => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  // Each place in the sidebar answers for the pages that live under it, so
  // the highlight follows the person into an event, a rehearsal, a space.
  const place = (v: string): string =>
    v === 'livehub' || v === 'events' || v === 'join'
      ? 'live'
      : v === 'studio' || v === 'coach' || v === 'create'
        ? 'studio'
        : v === 'org' || v === 'business' || v === 'education'
          ? 'workspace'
          : v
  const here = place(activeView)

  const menuSession = menu ? sessions.find((s) => s.id === menu.id) : undefined

  const openMenu = (e: React.MouseEvent, id: string): void => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ id, x: rect.right, y: rect.bottom })
  }

  const startRename = (): void => {
    if (!menuSession) return
    setDraft(menuSession.title)
    setRenamingId(menuSession.id)
    setMenu(null)
  }

  const commitRename = (): void => {
    const id = renamingId
    const next = draft.trim()
    setRenamingId(null)
    if (id && next) onRenameSession(id, next)
  }

  const renderRow = (s: SessionMeta): React.JSX.Element => (
    <div
      key={s.id}
      className={`side-item${
        activeSessionId === s.id && activeView !== 'home' ? ' active' : ''
      }`}
      onClick={() => renamingId !== s.id && onOpenSession(s.id)}
    >
      {recordingSessionId === s.id ? <span className="rec-dot" /> : null}
      {renamingId === s.id ? (
        <input
          className="input side-rename"
          value={draft}
          autoFocus
          spellCheck={false}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setRenamingId(null)
          }}
          onBlur={commitRename}
        />
      ) : (
        <>
          <span className="side-item-title">{s.title}</span>
          {s.space && (
            <span className="side-item-tag" title={s.space === 'education' ? 'Filed under Education' : 'Filed under Business'}>
              {s.space === 'education' ? 'Edu' : 'Biz'}
            </span>
          )}
          {s.status === 'complete' && (
            <span className="side-item-time">{formatDuration(s.durationMs)}</span>
          )}
          <button
            className="side-dots"
            title="Session options"
            onClick={(e) => openMenu(e, s.id)}
          >
            <IconDots size={14} strokeWidth={2.6} />
          </button>
        </>
      )}
    </div>
  )

  const item = (view: string, label: string, icon: React.ReactNode, go: () => void, extra = ''): React.JSX.Element => (
    <button className={`side-item${here === view ? ' active' : ''}${extra}`} onClick={go}>
      {icon}
      {label}
    </button>
  )
  const places = (size: number): React.JSX.Element => (
    <>
      {item('homepage', 'Home', <IconHome size={size} />, onHomePage)}
      {item('home', 'Library', <IconFolder size={size} />, onHome)}
      {item('live', 'Live', <IconBroadcast size={size} />, onLive)}
      {item('brain', 'Insights', <IconSparkle size={size} />, onBrain)}
      {item('studio', 'Studio', <IconWand size={size} />, onStudio)}
      {onWorkspace && item('workspace', 'Workspace', <IconBriefcase size={size} />, onWorkspace)}
    </>
  )

  const sessionsBlock = (
    <div className="side-sessions" style={{ marginTop: 0 }}>
      {sessions.length === 0 && (
        <>
          <div className="side-label">Sessions</div>
          <div style={{ padding: '4px 10px', fontSize: 12.5, color: 'var(--text-3)' }}>
            No sessions yet
          </div>
        </>
      )}
      {sessions.some((s) => s.hosted) && (
        <div className="side-label">Hosted events</div>
      )}
      {sessions.filter((s) => s.hosted).map(renderRow)}
      {sessions.some((s) => !s.hosted) && <div className="side-label">My sessions</div>}
      {sessions.filter((s) => !s.hosted).map(renderRow)}
    </div>
  )

  const dialogs = (
    <>
      {menu && menuSession && (
        <>
          <div className="menu-overlay" onMouseDown={() => setMenu(null)} />
          <div
            className="menu"
            style={{
              top: Math.min(menu.y + 4, window.innerHeight - 120),
              left: Math.max(8, menu.x - 168)
            }}
          >
            <button className="menu-item" onClick={() => (setMenu(null), onOpenSession(menuSession.id))}>
              Open
            </button>
            <button className="menu-item" onClick={startRename}>
              Rename
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item danger"
              disabled={menuSession.id === recordingSessionId}
              onClick={() => {
                setMenu(null)
                setPendingDelete(menuSession)
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete session?"
          message={`“${pendingDelete.title}” — the recording, transcript, notes, and chat will be permanently deleted. This cannot be undone.`}
          onConfirm={() => {
            const id = pendingDelete.id
            setPendingDelete(null)
            onDeleteSession(id)
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  )

  const head = (
    <div className="sidebar-drag" style={{ justifyContent: 'space-between' }}>
      <button
        type="button"
        className="wordmark wordmark-btn"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="Home"
        onClick={onHomePage}
      >
        <Mark size={18} />
        Sitca
      </button>
      <button
        className="btn btn-ghost btn-sm"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="Hide sidebar"
        onClick={onCollapse}
      >
        <IconMenu size={22} strokeWidth={2} />
      </button>
    </div>
  )

  if (phone) {
    return (
      <aside className="sidebar sidebar-phone">
        {head}
        <div className="side-section">{places(16)}</div>
        {sessionsBlock}
        <div className="side-bottom">
          <button className="side-new-bottom" onClick={onNewSession} title="Start a new session">
            <IconPlus size={16} strokeWidth={2.6} />
            New session
          </button>
          <button
            className={`side-gear${activeView === 'settings' ? ' active' : ''}`}
            onClick={onSettings}
            title="Settings"
            aria-label="Settings"
          >
            <IconSettings size={18} strokeWidth={1.8} />
          </button>
        </div>
        {dialogs}
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      {head}

      <div className="side-section">
        <button className="side-new" onClick={onNewSession} title="Start a new session">
          <span className="side-new-icon">
            <IconPlus size={15} strokeWidth={2.4} />
          </span>
          <span className="side-new-text">
            <span className="side-new-name">New session</span>
            <span className="side-new-sub">Screen, meeting or audio</span>
          </span>
        </button>
      </div>

      <div className="side-section">{places(15)}</div>

      {sessionsBlock}

      <div className="side-footer">
        {item('settings', 'Settings', <IconSettings size={15} />, onSettings)}
      </div>

      {dialogs}
    </aside>
  )
}
