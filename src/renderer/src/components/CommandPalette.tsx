import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { BrainSearchHit, SessionMeta } from '@shared/types'
import { formatTime } from '../lib/format'
import { IconHome, IconPlay, IconPlus, IconSettings, IconSparkle } from '../lib/icons'

interface Props {
  sessions: SessionMeta[]
  onClose: () => void
  onAction: (action: 'new' | 'brain' | 'home' | 'settings') => void
  onOpenSessionAt: (sessionId: string, seconds?: number) => void
}

interface Item {
  key: string
  icon: React.ReactNode
  label: string
  hint?: string
  run: () => void
}

export default function CommandPalette({
  sessions,
  onClose,
  onAction,
  onOpenSessionAt
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<BrainSearchHit[]>([])
  const [sel, setSel] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < 3) {
      setHits([])
      return
    }
    debounceRef.current = setTimeout(() => {
      void window.sitka.searchLibrary(q).then((r) => setHits(r.slice(0, 6)))
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const items = useMemo((): Item[] => {
    const q = query.trim().toLowerCase()
    const actions: Item[] = [
      {
        key: 'a-new',
        icon: <IconPlus size={14} />,
        label: 'New live session',
        run: () => onAction('new')
      },
      {
        key: 'a-brain',
        icon: <IconSparkle size={14} />,
        label: 'Open Overview',
        run: () => onAction('brain')
      },
      {
        key: 'a-home',
        icon: <IconHome size={14} />,
        label: 'Library',
        run: () => onAction('home')
      },
      {
        key: 'a-settings',
        icon: <IconSettings size={14} />,
        label: 'Settings',
        run: () => onAction('settings')
      }
    ].filter((a) => q === '' || a.label.toLowerCase().includes(q))

    const sessionItems: Item[] = sessions
      .filter((s) => q !== '' && s.title.toLowerCase().includes(q))
      .slice(0, 5)
      .map((s) => ({
        key: `s-${s.id}`,
        icon: <IconPlay size={13} />,
        label: s.title,
        hint: 'session',
        run: () => onOpenSessionAt(s.id)
      }))

    const hitItems: Item[] = hits.map((h, i) => ({
      key: `h-${h.sessionId}-${i}`,
      icon: <IconPlay size={13} />,
      label: h.snippet.length > 70 ? `${h.snippet.slice(0, 70)}…` : h.snippet,
      hint: `${h.sessionTitle} · ${formatTime(h.time)}`,
      run: () => onOpenSessionAt(h.sessionId, h.time)
    }))

    return [...actions, ...sessionItems, ...hitItems]
  }, [query, sessions, hits, onAction, onOpenSessionAt])

  useEffect(() => {
    setSel(0)
  }, [query, items.length])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(items.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[sel]
      if (item) {
        onClose()
        item.run()
      }
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          placeholder="Search sessions, moments, or type a command…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="palette-list">
          {items.length === 0 && (
            <div className="palette-empty">Nothing matches “{query.trim()}”.</div>
          )}
          {items.map((item, i) => (
            <div
              key={item.key}
              className={`palette-item${i === sel ? ' sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                onClose()
                item.run()
              }}
            >
              <span className="palette-icon">{item.icon}</span>
              <span className="palette-label">{item.label}</span>
              {item.hint && <span className="palette-hint">{item.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
