import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CreateRequest,
  Creation,
  CreationKind,
  PresentationDeck,
  SessionMeta
} from '@shared/types'
import { parseDeck } from '@shared/createLogic'
import AiText from './AiText'
import ConfirmDialog from './ConfirmDialog'
import { formatDate } from '../lib/format'
import { copyRich } from '../lib/clipboard'
import { deckPage, documentPage, mdToHtml, wordDocument } from '../lib/mdToHtml'
import { IconCode, IconCopy, IconDoc, IconPlus, IconSlides, IconTrash, Mark } from '../lib/icons'

interface Props {
  sessions: SessionMeta[]
  hasChatKey: boolean
  onOpenSettings: () => void
  onOpenSessionAt: (sessionId: string, seconds?: number) => void
}

const KINDS: { id: CreationKind; label: string; desc: string; hint: string }[] = [
  {
    id: 'document',
    label: 'Document',
    desc: 'Reports, memos, briefs, emails, study guides.',
    hint: 'e.g. Write a one-page brief of Tuesday’s meeting for the people who missed it'
  },
  {
    id: 'presentation',
    label: 'Presentation',
    desc: 'A full slide deck with speaker notes.',
    hint: 'e.g. Turn the lecture on memory into a 10-slide deck for my study group'
  },
  {
    id: 'code',
    label: 'Code',
    desc: 'Working code, complete files, ready to run.',
    hint: 'e.g. Build a small script that turns a CSV of grades into a summary table'
  }
]

const kindIcon = (k: CreationKind, size = 15): React.JSX.Element =>
  k === 'document' ? (
    <IconDoc size={size} strokeWidth={1.7} />
  ) : k === 'presentation' ? (
    <IconSlides size={size} strokeWidth={1.7} />
  ) : (
    <IconCode size={size} strokeWidth={1.7} />
  )

interface CodeFile {
  name: string
  lang: string
  code: string
}

/** Split a code answer into its explanation and its fenced files. */
function parseCode(md: string): { prose: string; files: CodeFile[] } {
  const files: CodeFile[] = []
  const re = /```([\w+-]*)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  let prose = ''
  let last = 0
  while ((m = re.exec(md))) {
    prose += md.slice(last, m.index)
    last = m.index + m[0].length
    const lang = m[1] || ''
    let code = m[2].replace(/\s+$/, '')
    let name = ''
    const first = code.split('\n')[0] ?? ''
    const fm = first.match(/^\s*(?:\/\/|#|--|;|<!--|\/\*)\s*(?:file:)?\s*([\w@./\\-]+\.[A-Za-z0-9]+)\s*(?:-->|\*\/)?\s*$/)
    if (fm) {
      name = fm[1]
      code = code.split('\n').slice(1).join('\n')
    }
    files.push({ name: name || `file${files.length + 1}${lang ? '.' + lang : '.txt'}`, lang, code })
  }
  prose += md.slice(last)
  return { prose: prose.trim(), files }
}

function printHtml(html: string): void {
  const w = window.open('', '_blank')
  if (!w) return
  w.document.open()
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 500)
}

const safeName = (t: string): string => t.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'sitka'

export default function CreateView({
  sessions,
  hasChatKey,
  onOpenSettings,
  onOpenSessionAt
}: Props): React.JSX.Element {
  const [creations, setCreations] = useState<Creation[]>([])
  const [selected, setSelected] = useState<Creation | null>(null)
  const [kind, setKind] = useState<CreationKind>('document')
  const [prompt, setPrompt] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refine, setRefine] = useState('')
  const [presentAt, setPresentAt] = useState<number | null>(null)
  const [showNotes, setShowNotes] = useState(true)
  const [pendingDelete, setPendingDelete] = useState<Creation | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setCreations(await window.sitka.listCreations())
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const recent = useMemo(
    () => sessions.filter((s) => s.status === 'complete').slice(0, 10),
    [sessions]
  )

  const run = async (req: CreateRequest): Promise<void> => {
    setGenerating(true)
    setError(null)
    try {
      const res = await window.sitka.generateCreation(req)
      if (res.error) {
        setError(
          res.error === 'missing-key'
            ? 'Add an AI key in Settings to let Sitka create things.'
            : res.error
        )
        return
      }
      if (res.creation) {
        setSelected(res.creation)
        setRefine('')
        await refresh()
      }
    } finally {
      setGenerating(false)
    }
  }

  const generate = (): void => {
    if (!prompt.trim() || generating) return
    void run({ kind, prompt: prompt.trim(), sessionIds: [...chosen] })
  }

  const doRefine = (): void => {
    if (!selected || !refine.trim() || generating) return
    void run({
      kind: selected.kind,
      prompt: selected.prompt,
      sessionIds: selected.sessionIds,
      previous: { id: selected.id, content: selected.content, instruction: refine.trim() }
    })
  }

  const confirmDelete = (): void => {
    const c = pendingDelete
    setPendingDelete(null)
    if (!c) return
    void window.sitka.deleteCreation(c.id).then(() => refresh())
    if (selected?.id === c.id) setSelected(null)
  }

  const copy = (text: string): void => {
    void copyRich(text).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      }
    })
  }

  const deck: PresentationDeck | null =
    selected?.kind === 'presentation' ? parseDeck(selected.content) : null
  const code = selected?.kind === 'code' ? parseCode(selected.content) : null

  const seekFor = (seconds: number, sid?: string): void => {
    const id = sid
      ? sessions.find((s) => s.id.startsWith(sid))?.id
      : selected?.sessionIds.length === 1
        ? selected.sessionIds[0]
        : undefined
    if (id) onOpenSessionAt(id, seconds)
  }

  // ---- presenting ----
  useEffect(() => {
    if (presentAt === null || !deck) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPresentAt(null)
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown')
        setPresentAt((i) => Math.min(deck.slides.length - 1, (i ?? 0) + 1))
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') setPresentAt((i) => Math.max(0, (i ?? 0) - 1))
      if (e.key.toLowerCase() === 'n') setShowNotes((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presentAt, deck])

  // ---- exports ----
  const exportDoc = (how: 'md' | 'word' | 'pdf'): void => {
    if (!selected) return
    const name = safeName(selected.title)
    if (how === 'md') void window.sitka.saveTextFile(`${name}.md`, selected.content)
    else if (how === 'word')
      void window.sitka.saveTextFile(`${name}.doc`, wordDocument(selected.title, mdToHtml(selected.content)))
    else printHtml(documentPage(selected.title, mdToHtml(selected.content)))
  }
  const exportDeck = (how: 'html' | 'pdf'): void => {
    if (!selected || !deck) return
    const html = deckPage(deck.title, deck.subtitle, deck.slides)
    if (how === 'html') void window.sitka.saveTextFile(`${safeName(deck.title)}.html`, html)
    else printHtml(html)
  }
  const exportCode = (): void => {
    if (!code) return
    for (const f of code.files) void window.sitka.saveTextFile(f.name.split(/[\\/]/).pop() ?? f.name, f.code)
  }

  return (
    <div className="create-view">
      {creations.length > 0 && (
      <aside className="create-list">
        <div className="create-list-head">
          <span className="side-label" style={{ padding: 0 }}>Your creations</span>
          <button
            className="btn btn-ghost btn-sm"
            title="Start a new creation"
            onClick={() => {
              setSelected(null)
              setError(null)
            }}
          >
            <IconPlus size={13} strokeWidth={2.4} />
            New
          </button>
        </div>
        {creations.map((c) => (
            <button
              key={c.id}
              className={`create-item${selected?.id === c.id ? ' active' : ''}`}
              onClick={() => {
                setSelected(c)
                setError(null)
              }}
            >
              <span className="create-item-icon">{kindIcon(c.kind, 14)}</span>
              <span className="create-item-text">
                <span className="create-item-title">{c.title}</span>
                <span className="create-item-date">{formatDate(c.updatedAt)}</span>
              </span>
            </button>
        ))}
      </aside>
      )}

      <div className="create-main">
        {!selected ? (
          <div className="content-inner" style={{ maxWidth: 760 }}>
            <h1 className="page-title">Create</h1>
            <p className="page-subtitle">
              Tell Sitka what you need. It writes documents, designs presentations and builds
              code, and it can ground the work in what it heard in your sessions.
            </p>

            <div className="create-kinds">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  className={`create-kind${kind === k.id ? ' on' : ''}`}
                  onClick={() => setKind(k.id)}
                >
                  <span className="create-kind-icon">{kindIcon(k.id, 18)}</span>
                  <span className="create-kind-label">{k.label}</span>
                  <span className="create-kind-desc">{k.desc}</span>
                </button>
              ))}
            </div>

            <textarea
              className="input create-prompt"
              placeholder={KINDS.find((k) => k.id === kind)?.hint}
              value={prompt}
              rows={4}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generate()
              }}
            />

            {recent.length > 0 && (
              <div className="create-ground">
                <div className="create-ground-label">Ground it in your sessions</div>
                <div className="create-chips">
                  {recent.map((s) => (
                    <button
                      key={s.id}
                      className={`create-chip${chosen.has(s.id) ? ' on' : ''}`}
                      onClick={() =>
                        setChosen((prev) => {
                          const next = new Set(prev)
                          if (next.has(s.id)) next.delete(s.id)
                          else next.add(s.id)
                          return next
                        })
                      }
                      title={s.title}
                    >
                      {s.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="create-actions">
              <button
                className="btn btn-primary btn-lg"
                onClick={generate}
                disabled={generating || !prompt.trim()}
              >
                {generating ? (
                  <>
                    <Mark size={16} live /> Designing…
                  </>
                ) : (
                  'Create'
                )}
              </button>
              <span className="create-hint">Ctrl+Enter</span>
            </div>

            {!hasChatKey && (
              <div className="notice" style={{ marginTop: 16 }}>
                Add an AI key in{' '}
                <button className="link-btn" onClick={onOpenSettings}>
                  Settings
                </button>{' '}
                to let Sitka create things for you.
              </div>
            )}
            {error && <div className="notice notice-error" style={{ marginTop: 16 }}>{error}</div>}
          </div>
        ) : (
          <div className="create-result">
            <div className="create-head">
              <span className="create-badge">
                {kindIcon(selected.kind, 13)}
                {selected.kind}
              </span>
              <h1 className="create-title">{selected.title}</h1>
              <div className="create-tools">
                {selected.kind === 'document' && (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={() => copy(selected.content)}>
                      <IconCopy size={13} />
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => exportDoc('md')}>
                      Markdown
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => exportDoc('word')}>
                      Word
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => exportDoc('pdf')}>
                      PDF
                    </button>
                  </>
                )}
                {selected.kind === 'presentation' && deck && (
                  <>
                    <button className="btn btn-sm" onClick={() => setPresentAt(0)}>
                      Present
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => exportDeck('html')}>
                      Deck file
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => exportDeck('pdf')}>
                      PDF
                    </button>
                  </>
                )}
                {selected.kind === 'code' && code && (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={() => copy(selected.content)}>
                      <IconCopy size={13} />
                      {copied ? 'Copied' : 'Copy all'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={exportCode}>
                      Save files
                    </button>
                  </>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  title="Delete"
                  onClick={() => setPendingDelete(selected)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>

            <div className="create-body">
              {selected.kind === 'document' && (
                <div className="doc-page">
                  <AiText text={selected.content} onSeek={seekFor} />
                </div>
              )}

              {selected.kind === 'presentation' &&
                (deck ? (
                  <div className="deck-grid">
                    {deck.slides.map((s, i) => (
                      <button key={i} className="deck-card" onClick={() => setPresentAt(i)}>
                        <span className="deck-card-n">{i + 1}</span>
                        <span className="deck-card-title">{s.title}</span>
                        {i === 0 && deck.subtitle && (
                          <span className="deck-card-sub">{deck.subtitle}</span>
                        )}
                        {s.bullets.length > 0 && (
                          <ul className="deck-card-bullets">
                            {s.bullets.slice(0, 4).map((b, j) => (
                              <li key={j}>{b}</li>
                            ))}
                          </ul>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="notice notice-error">This deck could not be read.</div>
                ))}

              {selected.kind === 'code' && code && (
                <div className="code-result">
                  {code.prose && (
                    <div className="code-prose">
                      <AiText text={code.prose} onSeek={seekFor} />
                    </div>
                  )}
                  {code.files.map((f, i) => (
                    <div key={i} className="code-file">
                      <div className="code-file-head">
                        <span className="code-file-name">{f.name}</span>
                        {f.lang && <span className="code-file-lang">{f.lang}</span>}
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ marginLeft: 'auto' }}
                          onClick={() => copy(f.code)}
                        >
                          <IconCopy size={12} />
                          Copy
                        </button>
                      </div>
                      <pre className="code-pre">
                        <code>{f.code}</code>
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="create-refine">
              {error && <div className="notice notice-error" style={{ marginBottom: 8 }}>{error}</div>}
              <div className="create-refine-row">
                <input
                  className="input"
                  placeholder="Tell Sitka what to change… (e.g. shorter, add a section on risks, make it friendlier)"
                  value={refine}
                  onChange={(e) => setRefine(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') doRefine()
                  }}
                  disabled={generating}
                />
                <button
                  className="btn btn-primary"
                  onClick={doRefine}
                  disabled={generating || !refine.trim()}
                >
                  {generating ? (
                    <>
                      <Mark size={15} live /> Working…
                    </>
                  ) : (
                    'Refine'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {presentAt !== null && deck && (
        <div className="present" onClick={(e) => {
          const x = (e as React.MouseEvent).clientX
          setPresentAt((i) => {
            const n = i ?? 0
            return x > window.innerWidth / 2 ? Math.min(deck.slides.length - 1, n + 1) : Math.max(0, n - 1)
          })
        }}>
          <div className={`present-slide${presentAt === 0 ? ' title' : ''}`}>
            <h1>{deck.slides[presentAt].title}</h1>
            {presentAt === 0 && deck.subtitle && <p className="present-sub">{deck.subtitle}</p>}
            {deck.slides[presentAt].bullets.length > 0 && (
              <ul>
                {deck.slides[presentAt].bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            )}
          </div>
          {showNotes && deck.slides[presentAt].notes && (
            <div className="present-notes">{deck.slides[presentAt].notes}</div>
          )}
          <div className="present-bar" onClick={(e) => e.stopPropagation()}>
            <span>
              {presentAt + 1} / {deck.slides.length}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowNotes((v) => !v)}>
              {showNotes ? 'Hide notes' : 'Notes'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPresentAt(null)}>
              Exit
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this creation?"
          message={`“${pendingDelete.title}” will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
