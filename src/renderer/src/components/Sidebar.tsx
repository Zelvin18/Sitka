import React, { useState } from 'react'
import type { SessionMeta } from '@shared/types'
import {
  IconBroadcast,
  IconDots,
  IconFolder,
  IconHome,
  IconMic,
  IconPanel,
  IconPlus,
  IconSettings,
  IconSparkle
} from '../lib/icons'
import { formatDuration } from '../lib/format'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  sessions: SessionMeta[]
  activeView: string
  activeSessionId?: string
  recordingSessionId?: string
  onHomePage: () => void
  onEvents: () => void
  onCoach: () => void
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

export default function Sidebar({
  sessions,
  activeView,
  activeSessionId,
  recordingSessionId,
  onHomePage,
  onEvents,
  onCoach,
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

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" style={{ justifyContent: 'space-between' }}>
        <div className="wordmark">
          <span className="wordmark-dot" />
          Sitka
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title="Hide sidebar"
          onClick={onCollapse}
        >
          <IconPanel size={14} />
        </button>
      </div>

      <div className="side-section">
        <button className="btn btn-primary" onClick={onNewSession} style={{ width: '100%' }}>
          <IconPlus size={15} strokeWidth={2.2} />
          New live session
        </button>
      </div>

      <div className="side-section">
        <button
          className={`side-item${activeView === 'homepage' ? ' active' : ''}`}
          onClick={onHomePage}
        >
          <IconHome size={15} />
          Home
        </button>
        <button
          className={`side-item${activeView === 'brain' ? ' active' : ''}`}
          onClick={onBrain}
        >
          <IconSparkle size={15} />
          Overview
        </button>
        <button
          className={`side-item${activeView === 'events' ? ' active' : ''}`}
          onClick={onEvents}
        >
          <IconBroadcast size={15} />
          Events
        </button>
        <button
          className={`side-item${activeView === 'coach' ? ' active' : ''}`}
          onClick={onCoach}
        >
          <IconMic size={15} />
          Coach
        </button>
        <button
          className={`side-item${activeView === 'home' ? ' active' : ''}`}
          onClick={onHome}
        >
          <IconFolder size={15} />
          Library
        </button>
      </div>

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

      <div className="side-footer">
        <button
          className={`side-item${activeView === 'settings' ? ' active' : ''}`}
          onClick={onSettings}
        >
          <IconSettings size={15} />
          Settings
        </button>
      </div>

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
    </aside>
  )
}
