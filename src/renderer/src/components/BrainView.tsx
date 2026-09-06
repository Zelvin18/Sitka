import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrainConversation,
  BrainSearchHit,
  ChatMessage,
  SessionMeta
} from '@shared/types'
import ChatPane from './ChatPane'
import ConfirmDialog from './ConfirmDialog'
import MemoryPanel from './MemoryPanel'
import { formatDate, formatTime } from '../lib/format'
import { IconPlay, IconPlus } from '../lib/icons'

interface Props {
  sessions: SessionMeta[]
  hasChatKey: boolean
  onOpenSettings: () => void
  onOpenSessionAt: (sessionId: string, seconds?: number) => void
}

type Mode = 'ask' | 'search' | 'memory'

const MODES: { id: Mode; label: string }[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'search', label: 'Search' },
  { id: 'memory', label: 'Memory' }
]

/**
 * Overview: one page, one thing at a time. Ask (the library chat, full height),
 * Search (every moment ever said), Memory (decisions, promises, people, concepts).
 */
export default function BrainView({
  sessions,
  hasChatKey,
  onOpenSettings,
  onOpenSessionAt
}: Props): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('ask')
  const [recents, setRecents] = useState<BrainConversation[]>([])
  const [active, setActive] = useState<BrainConversation | null>(null)
  const [chatKey, setChatKey] = useState(0)
  const [hasContent, setHasContent] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<BrainSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const convRef = useRef<BrainConversation | null>(null)
  const [pendingDelete, setPendingDelete] = useState<BrainConversation | null>(null)
  const [showAllChats, setShowAllChats] = useState(false)

  const refreshRecents = useCallback(async (): Promise<void> => {
    setRecents(await window.sitka.listBrainChats())
  }, [])

  useEffect(() => {
    void refreshRecents()
  }, [refreshRecents])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(() => {
      void window.sitka.searchLibrary(q).then((results) => {
        setHits(results)
        setSearching(false)
      })
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const resolveLabel = useMemo(() => {
    return (sidPrefix: string): string | undefined =>
      sessions.find((s) => s.id.startsWith(sidPrefix))?.title
  }, [sessions])

  // Every completed exchange saves the conversation (creating it on first use).
  const persist = useCallback(
    (messages: ChatMessage[]): void => {
      if (messages.length === 0) return
      setHasContent(true)
      if (!convRef.current) {
        const firstUser = messages.find((m) => m.role === 'user')
        convRef.current = {
          id: crypto.randomUUID(),
          title: (firstUser?.content ?? 'Conversation').slice(0, 60),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages
        }
      } else {
        convRef.current = {
          ...convRef.current,
          messages,
          updatedAt: Date.now()
        }
      }
      void window.sitka.saveBrainChat(convRef.current).then(() => refreshRecents())
    },
    [refreshRecents]
  )

  const newChat = useCallback((): void => {
    convRef.current = null
    setActive(null)
    setHasContent(false)
    setShowAllChats(false)
    setChatKey((k) => k + 1)
  }, [])

  const openConversation = (conv: BrainConversation): void => {
    convRef.current = conv
    setActive(conv)
    setHasContent(true)
    setShowAllChats(false)
    setMode('ask')
    setChatKey((k) => k + 1)
  }

  const confirmDelete = (): void => {
    const conv = pendingDelete
    setPendingDelete(null)
    if (!conv) return
    void window.sitka.deleteBrainChat(conv.id).then(() => refreshRecents())
    if (convRef.current?.id === conv.id) newChat()
  }

  const q = query.trim()

  return (
    <div className="brain-view">
      <div className="brain-hero">
        <h1 className="page-title">Overview</h1>
        <p className="page-subtitle" style={{ marginBottom: 16 }}>
          Everything Sitka has ever attended with you. Ask it, search it, or see what it
          remembers.
        </p>
        <div className="brain-modes">
          <div className="seg">
            {MODES.map((m) => (
              <button
                key={m.id}
                className={`seg-btn${mode === m.id ? ' on' : ''}`}
                onClick={() => {
                  setMode(m.id)
                  setShowAllChats(false)
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode === 'ask' && recents.length > 0 && (
            <button
              className="link-btn"
              onClick={() => setShowAllChats((v) => !v)}
              style={{ fontSize: 13 }}
            >
              {showAllChats ? 'Back to chat' : `Conversations (${recents.length})`}
            </button>
          )}
        </div>
      </div>

      <div className="brain-body">
        {mode === 'ask' && showAllChats && (
          <div className="brain-results">
            {recents.map((c) => (
              <div key={c.id} className="convo-line" onClick={() => openConversation(c)}>
                <span className="convo-line-title">{c.title}</span>
                <span className="convo-date" style={{ flexShrink: 0, marginTop: 0 }}>
                  {formatDate(c.updatedAt)}
                </span>
                <button
                  className="convo-line-delete"
                  title="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation()
                    setPendingDelete(c)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {mode === 'ask' && !showAllChats && (
          <>
            {!hasContent && recents.length > 0 && (
              <div className="brain-recents">
                <span className="brain-recents-label">Pick up</span>
                {recents.slice(0, 3).map((c) => (
                  <button
                    key={c.id}
                    className="brain-recent"
                    title={c.title}
                    onClick={() => openConversation(c)}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
            )}
            <div className="brain-chat">
              <ChatPane
                key={chatKey}
                sessionId="__brain__"
                brain
                live={false}
                initialChat={active?.messages ?? []}
                hasChatKey={hasChatKey}
                hasTranscript
                headerTitle="Ask your whole library"
                headerExtra={
                  hasContent ? (
                    <button className="btn btn-ghost btn-sm" onClick={newChat}>
                      <IconPlus size={13} strokeWidth={2.2} />
                      New chat
                    </button>
                  ) : undefined
                }
                resolveLabel={resolveLabel}
                onPersist={persist}
                onSeek={(seconds, sid) => {
                  if (!sid) return
                  const session = sessions.find((s) => s.id.startsWith(sid))
                  if (session) onOpenSessionAt(session.id, seconds)
                }}
                onOpenSettings={onOpenSettings}
                suggestions={[
                  'What have I learned recently?',
                  'Find every moment about a topic…',
                  'Compare what different sessions said about the same thing'
                ]}
              />
            </div>
          </>
        )}

        {mode === 'search' && (
          <>
            <div className="brain-searchwrap">
              <input
                className="input brain-search"
                placeholder="Search every moment ever said…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                autoFocus
              />
            </div>
            <div className="brain-results">
              {q.length < 2 && (
                <div className="transcript-waiting">
                  Type a word or a phrase. Every matching moment across your sessions
                  appears here, and each one opens the session at that exact second.
                </div>
              )}
              {q.length >= 2 && searching && hits.length === 0 && (
                <div className="transcript-waiting">Searching…</div>
              )}
              {q.length >= 2 && !searching && hits.length === 0 && (
                <div className="transcript-waiting">No moment found for “{q}”.</div>
              )}
              {hits.map((h, i) => (
                <div
                  key={`${h.sessionId}-${h.time}-${i}`}
                  className="brain-hit"
                  onClick={() => onOpenSessionAt(h.sessionId, h.time)}
                >
                  <div className="brain-hit-top">
                    <span className="brain-hit-title">{h.sessionTitle}</span>
                    <span className="ts-chip">
                      <IconPlay size={10} strokeWidth={2.4} />
                      {formatTime(h.time)}
                    </span>
                  </div>
                  <div className="brain-hit-snippet">{h.snippet}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {mode === 'memory' && (
          <div className="brain-results">
            <MemoryPanel
              onOpenSessionAt={onOpenSessionAt}
              emptyNote="Nothing remembered yet. Decisions, promises, people and concepts are drawn from every session once it ends, each pinned to the moment it was said."
            />
          </div>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete conversation?"
          message={`“${pendingDelete.title}” will be permanently deleted. This cannot be undone.`}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
