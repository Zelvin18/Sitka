import React, { useCallback, useEffect, useState } from 'react'
import type { MemoryKind, MemoryObject } from '@shared/types'
import { parseTimestamp } from '../lib/format'
import { IconPlay } from '../lib/icons'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  onOpenSessionAt: (sessionId: string, seconds?: number) => void
}

const TABS: { kind: MemoryKind; label: string; empty: string }[] = [
  { kind: 'decision', label: 'Decisions', empty: 'Decisions from your meetings will collect here.' },
  { kind: 'commitment', label: 'Promises', empty: 'Who promised what, and by when — from what was said.' },
  { kind: 'person', label: 'People', empty: 'What the people in your sessions care about.' },
  { kind: 'concept', label: 'Concepts', empty: 'Ideas you were taught, each with the moment it was explained.' }
]

const todayIso = (): string => new Date().toISOString().slice(0, 10)

function niceDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * What Sitka remembers across sessions — decisions, promises, people and
 * concepts — with the moments they came from. "What matters" surfaces the
 * items that need a look; nothing here is a number Sitka has not earned.
 */
export default function MemoryPanel({ onOpenSessionAt }: Props): React.JSX.Element | null {
  const [items, setItems] = useState<MemoryObject[]>([])
  const [tab, setTab] = useState<MemoryKind>('decision')
  const [open, setOpen] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<MemoryObject | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setItems(await window.sitka.listMemory())
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.sitka.onSessionUpdated(() => void refresh())
    return off
  }, [refresh])

  if (items.length === 0) return null

  const today = todayIso()
  const attention = items.filter(
    (o) =>
      (o.kind === 'decision' && o.status === 'changed') ||
      (o.kind === 'commitment' && o.status === 'open' && o.due !== undefined && o.due < today)
  )
  const list = items
    .filter((o) => o.kind === tab)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const setStatus = (o: MemoryObject, status: 'open' | 'changed' | 'done'): void => {
    void window.sitka.updateMemory(o.id, { status }).then(() => refresh())
  }

  const jump = (sessionId: string, time: string): void => {
    onOpenSessionAt(sessionId, parseTimestamp(time) ?? 0)
  }

  const moment = (m: MemoryObject['timeline'][number]): React.JSX.Element => (
    <button
      key={`${m.sessionId}-${m.time}-${m.at}`}
      className="mem-moment"
      title={m.note}
      onClick={() => jump(m.sessionId, m.time)}
    >
      <IconPlay size={9} strokeWidth={2.4} />
      <span className="mem-moment-time">{m.time}</span>
      <span className="mem-moment-title">{m.sessionTitle}</span>
    </button>
  )

  return (
    <div className="mem-panel">
      {attention.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 22 }}>
            What matters
          </div>
          <div className="mem-attention">
            {attention.map((o) => (
              <div key={o.id} className="mem-alert">
                <div className="mem-alert-kicker">
                  {o.kind === 'decision' ? 'Decision changed' : 'Promise overdue'}
                </div>
                <div className="mem-alert-title">{o.title}</div>
                <div className="mem-alert-detail">
                  {o.kind === 'commitment'
                    ? `${o.owner ? o.owner + ' · ' : ''}due ${o.due ? niceDate(o.due) : ''} · nothing said about it since`
                    : o.detail}
                </div>
                <div className="mem-alert-row">
                  {o.timeline.slice(-2).map(moment)}
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setStatus(o, o.kind === 'decision' ? 'open' : 'done')}
                  >
                    {o.kind === 'decision' ? 'Understood' : 'Mark done'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mem-head">
        <div className="section-title" style={{ margin: 0 }}>
          Memory
        </div>
        <div className="seg">
          {TABS.map((t) => {
            const n = items.filter((o) => o.kind === t.kind).length
            return (
              <button
                key={t.kind}
                className={`seg-btn${tab === t.kind ? ' on' : ''}`}
                onClick={() => setTab(t.kind)}
              >
                {t.label}
                {n > 0 && <span className="seg-n">{n}</span>}
              </button>
            )
          })}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="transcript-waiting">{TABS.find((t) => t.kind === tab)?.empty}</div>
      ) : (
        <div className="mem-list">
          {list.map((o) => {
            const expanded = open === o.id
            return (
              <div
                key={o.id}
                className={`mem-item${expanded ? ' open' : ''}${o.status === 'done' ? ' done' : ''}`}
                onClick={() => setOpen(expanded ? null : o.id)}
              >
                <div className="mem-item-top">
                  <div className="mem-item-title">{o.title}</div>
                  {o.kind === 'commitment' && (
                    <span className="mem-tag">
                      {o.status === 'done'
                        ? 'Done'
                        : o.due
                          ? `Due ${niceDate(o.due)}`
                          : 'Open'}
                    </span>
                  )}
                  {o.kind === 'decision' && o.status === 'changed' && (
                    <span className="mem-tag hot">Changed</span>
                  )}
                </div>
                <div className="mem-item-detail">
                  {o.kind === 'commitment' && o.owner ? `${o.owner} — ` : ''}
                  {o.detail}
                </div>
                {expanded && (
                  <div className="mem-timeline" onClick={(e) => e.stopPropagation()}>
                    {[...o.timeline].reverse().map((m) => (
                      <div key={`${m.sessionId}-${m.at}`} className="mem-tl-row">
                        {moment(m)}
                        <span className="mem-tl-note">{m.note}</span>
                      </div>
                    ))}
                    <div className="mem-tl-actions">
                      {o.kind === 'commitment' && o.status !== 'done' && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setStatus(o, 'done')}>
                          Mark done
                        </button>
                      )}
                      {o.kind === 'commitment' && o.status === 'done' && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setStatus(o, 'open')}>
                          Reopen
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setPendingDelete(o)}
                        style={{ color: 'var(--text-3)' }}
                      >
                        Forget
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Forget this?"
          message={`“${pendingDelete.title}” will be removed from Sitka's memory. The sessions it came from are untouched.`}
          onConfirm={() => {
            const o = pendingDelete
            setPendingDelete(null)
            void window.sitka.deleteMemory(o.id).then(() => refresh())
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
