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
import SaveDialog, { type SaveFormat } from './SaveDialog'
import { formatDate } from '../lib/format'
import { copyRich } from '../lib/clipboard'
import { deckPage, mdToHtml, wordDocument } from '../lib/mdToHtml'
import { deckToPdf, deckTemplate, docTemplate, markdownToPdf, toHex } from '../lib/pdf'
import { deckToPptx } from '../lib/pptx'
import { zip } from '../lib/zip'
import StylePicker from './StylePicker'
import Designing from './Designing'
import DeckDeco from './DeckDeco'
import DocPreview from './DocPreview'
import { deckDesign, pointMark } from '@shared/deckDesign'
import { withoutTimes } from '@shared/timesLogic'
import { highlight } from '../lib/highlight'
import {
  IconCode,
  IconCopy,
  IconDoc,
  IconDownload,
  IconExpand,
  IconShare,
  IconPlus,
  IconSlides,
  IconTrash,
  Mark
} from '../lib/icons'

const DOC_FORMATS: SaveFormat[] = [
  { id: 'word', label: 'Word document', tag: '.doc', desc: 'Opens in Microsoft Word or Google Docs, ready to edit.' },
  { id: 'pdf', label: 'PDF', tag: '.pdf', desc: 'A finished, fixed page to share or print. Downloads straight away.' },
  { id: 'md', label: 'Markdown', tag: '.md', desc: 'Plain text with formatting marks, for Notion, Obsidian or a wiki.' }
]

const DECK_FORMATS: SaveFormat[] = [
  { id: 'pptx', label: 'PowerPoint', tag: '.pptx', desc: 'Opens in PowerPoint, Keynote or Google Slides, in the chosen style, with the speaker notes in place.' },
  { id: 'pdf', label: 'PDF', tag: '.pdf', desc: 'One page per slide with the speaker notes underneath. Downloads straight away.' },
  { id: 'html', label: 'Web page', tag: '.html', desc: 'One file that opens in any browser. Arrow keys move between slides.' }
]

const CODE_FORMATS: SaveFormat[] = [
  { id: 'files', label: 'Code files', tag: '.zip', desc: 'Every file with its own name, together in one zip, ready to drop into a project.' }
]

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
    hint: 'e.g. A one-page brief of a session for the people who missed it'
  },
  {
    id: 'presentation',
    label: 'Presentation',
    desc: 'A full slide deck with speaker notes.',
    hint: 'e.g. A 10-slide deck from a session, one idea per slide'
  },
  {
    id: 'code',
    label: 'Code',
    desc: 'Working code, complete files, ready to run.',
    hint: 'e.g. A small tool that does one job, built from what a session covered'
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

const saveBytes = (name: string, bytes: Uint8Array): void => {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  void window.sitka.saveBinaryFile(name, copy)
}

const safeName = (t: string): string => t.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'sitka'
/** a phone (or a laptop with a share sheet) that can pass a file on */
const canShareFiles = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function'

/** the document preview in its style: paper, ink, accent, the face */
function docPageStyle(id?: string): React.CSSProperties {
  const t = docTemplate(id)
  return {
    ['--doc-paper' as string]: t.page ? toHex(t.page) : undefined,
    ['--doc-ink' as string]: toHex(t.ink),
    ['--doc-accent' as string]: toHex(t.accent),
    ['--doc-muted' as string]: toHex(t.muted),
    ['--doc-rule' as string]: toHex(t.rule),
    ['--doc-font' as string]: t.serif ? 'Georgia, "Times New Roman", serif' : 'inherit',
    background: t.page ? toHex(t.page) : '#ffffff',
    color: toHex(t.ink)
  }
}
/** a slide card in its style */
function deckCardStyle(id: string | undefined, title: boolean): React.CSSProperties {
  const t = deckTemplate(id)
  return {
    background: toHex(title ? t.titleBg : t.bg),
    color: toHex(title ? t.titleInk : t.ink),
    fontFamily: t.serif ? 'Georgia, "Times New Roman", serif' : undefined,
    ['--deck-accent' as string]: toHex(t.accent),
    ['--deck-muted' as string]: title ? toHex(t.titleInk) : t.id === 'midnight' ? '#c9c9d0' : toHex(t.ink),
    borderLeft: !title && t.bar === 'left' && t.slide === 'number' ? `5px solid ${toHex(t.accent)}` : undefined
  }
}
/** the presenting screen in its style */
function presentStyle(id?: string): React.CSSProperties {
  const t = deckTemplate(id)
  return {
    ['--pr-bg' as string]: toHex(t.bg),
    ['--pr-title-bg' as string]: toHex(t.titleBg),
    ['--pr-ink' as string]: toHex(t.ink),
    ['--pr-title-ink' as string]: toHex(t.titleInk),
    ['--pr-accent' as string]: toHex(t.accent),
    ['--pr-muted' as string]: toHex(t.muted),
    ['--pr-font' as string]: t.serif ? 'Georgia, "Times New Roman", serif' : 'inherit'
  }
}

export default function CreateView({
  sessions,
  hasChatKey,
  onOpenSettings,
  onOpenSessionAt
}: Props): React.JSX.Element {
  const [creations, setCreations] = useState<Creation[]>([])
  const [selected, setSelected] = useState<Creation | null>(null)
  const [kind, setKind] = useState<CreationKind>('document')
  const [docStyle, setDocStyle] = useState('editorial')
  const [deckStyle, setDeckStyle] = useState('mono')
  const [prompt, setPrompt] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refine, setRefine] = useState('')
  const [presentAt, setPresentAt] = useState<number | null>(null)
  const [showNotes, setShowNotes] = useState(true)
  const [pendingDelete, setPendingDelete] = useState<Creation | null>(null)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setCreations(await window.sitka.listCreations())
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const complete = useMemo(() => sessions.filter((s) => s.status === 'complete'), [sessions])
  // the latest few are offered as chips; every chosen one stays a chip; the rest wait behind a chooser
  const recent = useMemo(() => {
    const latest = complete.slice(0, 5)
    const chosenOnes = complete.filter((s) => chosen.has(s.id) && !latest.some((l) => l.id === s.id))
    return [...latest, ...chosenOnes]
  }, [complete, chosen])
  const [chooserOpen, setChooserOpen] = useState(false)
  const [chooserFilter, setChooserFilter] = useState('')
  const toggleChosen = (id: string): void =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // the finished document across the whole screen, with a way out
  const [viewing, setViewing] = useState(false)
  useEffect(() => {
    if (!viewing) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing])
  // the making page: shown in place of the form (or the result) while
  // something is made, and until the maker opens or downloads it
  const [designing, setDesigning] = useState<{ kind: CreationKind; made: Creation | null } | null>(null)
  const run = async (req: CreateRequest): Promise<void> => {
    setGenerating(true)
    setError(null)
    setDesigning({ kind: req.kind, made: null })
    try {
      const res = await window.sitka.generateCreation(req)
      if (res.error) {
        setDesigning(null)
        setError(
          res.error === 'missing-key'
            ? 'Add an AI key in Settings to let Sitca create things.'
            : res.error
        )
        return
      }
      if (res.creation) {
        const style = req.previous ? selected?.template : req.kind === 'document' ? docStyle : req.kind === 'presentation' ? deckStyle : undefined
        const made = style ? { ...res.creation, template: style } : res.creation
        if (style) await window.sitka.saveCreation(made)
        setRefine('')
        await refresh()
        setDesigning({ kind: req.kind, made })
      } else setDesigning(null)
    } catch (err) {
      setDesigning(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }
  // the phone's own share sheet, with the PDF in it
  const shareMade = async (): Promise<void> => {
    if (!selected) return
    const name = safeName(selected.title)
    const bytes =
      selected.kind === 'presentation' && deck
        ? deckToPdf(deck.title, deck.subtitle, deck.slides, selected.template)
        : markdownToPdf(selected.title, withoutTimes(selected.content), selected.template, { subtitle: new Date(selected.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) })
    const file = new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], `${name}.pdf`, { type: 'application/pdf' })
    try {
      await navigator.share({ files: [file], title: selected.title })
    } catch {
      /* the sheet was closed */
    }
  }
  const openMade = (): void => {
    if (designing?.made) {
      setSelected(designing.made)
      if (designing.made.kind === 'document' && window.innerWidth < 860) setViewing(true)
      if (designing.made.kind === 'presentation' && window.innerWidth < 860) setPresentAt(0)
    }
    setDesigning(null)
  }
  const downloadMade = (): void => {
    if (designing?.made) {
      setSelected(designing.made)
      setSaving(true)
    }
    setDesigning(null)
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

  // a style changed on a finished creation is kept with it
  const restyle = (id: string): void => {
    if (!selected) return
    const next = { ...selected, template: id, updatedAt: Date.now() }
    setSelected(next)
    void window.sitka.saveCreation(next).then(() => refresh())
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
    // a file that leaves the app carries no clocks: (0:15) means nothing to whoever it is sent to
    const text = withoutTimes(selected.content)
    if (how === 'md') void window.sitka.saveTextFile(`${name}.md`, text)
    else if (how === 'word')
      void window.sitka.saveTextFile(`${name}.doc`, wordDocument(selected.title, mdToHtml(text), selected.template))
    else saveBytes(`${name}.pdf`, markdownToPdf(selected.title, text, selected.template, { subtitle: new Date(selected.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) }))
  }
  const exportDeck = (how: 'html' | 'pdf' | 'pptx'): void => {
    if (!selected || !deck) return
    if (how === 'html') {
      void window.sitka.saveTextFile(
        `${safeName(deck.title)}.html`,
        deckPage(deck.title, deck.subtitle, deck.slides, selected.template)
      )
    } else if (how === 'pptx') saveBytes(`${safeName(deck.title)}.pptx`, deckToPptx(deck.title, deck.subtitle, deck.slides, selected.template))
    else saveBytes(`${safeName(deck.title)}.pdf`, deckToPdf(deck.title, deck.subtitle, deck.slides, selected.template))
  }
  const exportCode = (): void => {
    if (!code || !selected) return
    // one file is saved as itself; several travel together as a zip, which
    // every browser allows where a burst of downloads is blocked
    if (code.files.length === 1) {
      const f = code.files[0]
      void window.sitka.saveTextFile(f.name.split(/[\/]/).pop() ?? f.name, f.code)
      return
    }
    saveBytes(`${safeName(selected.title)}.zip`, zip(code.files.map((f) => ({ name: f.name.replace(/^[\/]+/, ''), data: f.code }))))
  }

  const saveFormats: SaveFormat[] =
    selected?.kind === 'document' ? DOC_FORMATS : selected?.kind === 'presentation' ? DECK_FORMATS : CODE_FORMATS
  const saveAs = (formatId: string): void => {
    setSaving(false)
    if (!selected) return
    if (selected.kind === 'document') exportDoc(formatId as 'md' | 'word' | 'pdf')
    else if (selected.kind === 'presentation') exportDeck(formatId as 'html' | 'pdf' | 'pptx')
    else exportCode()
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
              setPrompt('')
              setChosen(new Set())
              setDesigning(null)
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
                setDesigning(null)
                if (c.kind === 'document' && window.innerWidth < 860) setViewing(true)
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
        {designing ? (
          <Designing
            kind={designing.kind}
            made={designing.made}
            code={designing.kind === 'code' && designing.made ? parseCode(designing.made.content).files : undefined}
            onOpen={openMade}
            onDownload={downloadMade}
          />
        ) : !selected ? (
          <div className="content-inner" style={{ maxWidth: 760 }}>
            <h1 className="page-title">Create</h1>
            <p className="page-subtitle">
              Tell Sitca what you need. It writes documents, designs presentations and builds
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

            {kind !== 'code' && (
              <StylePicker
                kind={kind}
                value={kind === 'document' ? docStyle : deckStyle}
                onChange={(id) => (kind === 'document' ? setDocStyle(id) : setDeckStyle(id))}
              />
            )}

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

            {complete.length > 0 && (
              <div className="create-ground">
                <div className="create-ground-label">
                  Ground it in your sessions
                  {chosen.size > 0 && <span className="setup-optional">{chosen.size} chosen</span>}
                </div>
                <div className="create-chips">
                  {recent.map((s) => (
                    <button
                      key={s.id}
                      className={`create-chip${chosen.has(s.id) ? ' on' : ''}`}
                      onClick={() => toggleChosen(s.id)}
                      title={s.title}
                    >
                      {s.title}
                    </button>
                  ))}
                  {complete.length > recent.length && (
                    <button className="create-chip more" onClick={() => setChooserOpen(true)}>
                      Choose from all {complete.length}…
                    </button>
                  )}
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
                to let Sitca create things for you.
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
                {selected.kind === 'presentation' && deck && (
                  <button className="btn btn-sm" onClick={() => setPresentAt(0)}>
                    Present
                  </button>
                )}
                {selected.kind !== 'presentation' && (
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(selected.content)}>
                    <IconCopy size={13} />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                )}
                {selected.kind === 'document' && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setViewing(true)} title="Read it across the whole screen">
                    <IconExpand size={13} />
                    Full screen
                  </button>
                )}
                {selected.kind !== 'code' && canShareFiles() && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void shareMade()}>
                    <IconShare size={13} />
                    Share
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => setSaving(true)}>
                  <IconDownload size={13} />
                  Download
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  title="Delete"
                  onClick={() => setPendingDelete(selected)}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>

            {selected.kind !== 'code' && (
              <StylePicker compact kind={selected.kind} value={selected.template ?? (selected.kind === 'document' ? 'editorial' : 'mono')} onChange={restyle} />
            )}

            <div className="create-body">
              {selected.kind === 'document' && (
                <div className={`doc-page lay-${docTemplate(selected.template).layout}`} style={docPageStyle(selected.template)}>
                  <DocPreview text={selected.content} layout={docTemplate(selected.template).layout} />
                </div>
              )}

              {selected.kind === 'presentation' &&
                (deck ? (
                  <div className="deck-grid">
                    {deck.slides.map((s, i) => (
                      <button
                        key={i}
                        className={`deck-card d-${deckTemplate(selected.template).id}${i === 0 ? ' first' : ` lay-${deckTemplate(selected.template).slide}`}`}
                        style={deckCardStyle(selected.template, i === 0)}
                        onClick={() => setPresentAt(i)}
                      >
                        <DeckDeco templateId={selected.template} title={i === 0} />
                        <span className="deck-card-n">{i + 1}</span>
                        {i > 0 && deckTemplate(selected.template).slide === 'number' && <span className="deck-card-big">{String(i).padStart(2, '0')}</span>}
                        <span className="deck-card-head">
                          {i > 0 && deckDesign(selected.template).numberTile && <span className="deck-tile">{String(i).padStart(2, '0')}</span>}
                          <span className="deck-card-title">{s.title}</span>
                          {i === 0 && deck.subtitle && <span className="deck-card-sub">{deck.subtitle}</span>}
                          {i > 0 && deckTemplate(selected.template).slide === 'split' && <span className="deck-panel-n">{String(i).padStart(2, '0')}</span>}
                        </span>
                        {s.bullets.filter((b) => !(i === 0 && b === deck.subtitle)).length > 0 && (
                          <ul className={`deck-card-bullets marks-${deckDesign(selected.template).marker}`}>
                            {s.bullets.filter((b) => !(i === 0 && b === deck.subtitle)).slice(0, 4).map((b, j) => (
                              <li key={j} data-mark={pointMark(deckDesign(selected.template).marker, j, deckTemplate(selected.template).bullet)}>
                                {b}
                              </li>
                            ))}
                          </ul>
                        )}
                        {i > 0 && deckDesign(selected.template).footer && <span className="deck-foot">{deck.title}</span>}
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
                        <code>
                          {highlight(f.code, f.lang || f.name.split('.').pop() || '').map((tk, k) =>
                            tk.kind === 'plain' ? tk.text : <span key={k} className={`tk-${tk.kind}`}>{tk.text}</span>
                          )}
                        </code>
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
                  placeholder="Tell Sitca what to change… (e.g. shorter, add a section on risks, make it friendlier)"
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
        <div className="present" style={presentStyle(selected?.template)} onClick={(e) => {
          const x = (e as React.MouseEvent).clientX
          setPresentAt((i) => {
            const n = i ?? 0
            return x > window.innerWidth / 2 ? Math.min(deck.slides.length - 1, n + 1) : Math.max(0, n - 1)
          })
        }}>
          <div className={`present-slide d-${deckTemplate(selected?.template).id}${presentAt === 0 ? ' title' : ` lay-${deckTemplate(selected?.template).slide}`}`}>
            <DeckDeco templateId={selected?.template} title={presentAt === 0} />
            {presentAt > 0 && deckTemplate(selected?.template).slide === 'number' && <div className="present-big">{String(presentAt).padStart(2, '0')}</div>}
            <div className="present-head">
              {presentAt > 0 && deckDesign(selected?.template).numberTile && <span className="deck-tile">{String(presentAt).padStart(2, '0')}</span>}
              <h1>{deck.slides[presentAt].title}</h1>
              {presentAt > 0 && deckTemplate(selected?.template).slide === 'split' && <span className="deck-panel-n">{String(presentAt).padStart(2, '0')}</span>}
            </div>
            {presentAt === 0 && deck.subtitle && <p className="present-sub">{deck.subtitle}</p>}
            {deck.slides[presentAt].bullets.filter((b) => !(presentAt === 0 && b === deck.subtitle)).length > 0 && (
              <ul className={`marks-${deckDesign(selected?.template).marker}`}>
                {deck.slides[presentAt].bullets.filter((b) => !(presentAt === 0 && b === deck.subtitle)).map((b, j) => (
                  <li key={j} data-mark={pointMark(deckDesign(selected?.template).marker, j, deckTemplate(selected?.template).bullet)}>
                    {b}
                  </li>
                ))}
              </ul>
            )}
            {presentAt > 0 && deckDesign(selected?.template).footer && <span className="deck-foot">{deck.title}</span>}
          </div>
          {showNotes && deck.slides[presentAt].notes && (
            <div className="present-notes">{deck.slides[presentAt].notes}</div>
          )}
          <button className="viewer-close present-close" aria-label="Close" onClick={(e) => { e.stopPropagation(); setPresentAt(null) }}>
            ×
          </button>
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

      {chooserOpen && (
        <div className="dialog-overlay" onMouseDown={() => setChooserOpen(false)}>
          <div className="dialog chooser" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dialog-title">Ground it in your sessions</div>
            <input
              className="input"
              placeholder="Find a session…"
              value={chooserFilter}
              autoFocus={window.innerWidth >= 860}
              onChange={(e) => setChooserFilter(e.target.value)}
            />
            <div className="chooser-list">
              {complete
                .filter((s) => !chooserFilter.trim() || s.title.toLowerCase().includes(chooserFilter.trim().toLowerCase()))
                .map((s) => (
                  <label key={s.id} className={`chooser-row${chosen.has(s.id) ? ' on' : ''}`}>
                    <input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggleChosen(s.id)} />
                    <span className="chooser-title">{s.title}</span>
                    <span className="chooser-date">{formatDate(s.createdAt)}</span>
                  </label>
                ))}
            </div>
            <div className="dialog-actions">
              {chosen.size > 0 && (
                <button className="btn btn-ghost" onClick={() => setChosen(new Set())}>
                  Clear
                </button>
              )}
              <button className="btn btn-primary" onClick={() => setChooserOpen(false)}>
                Done{chosen.size > 0 ? ` · ${chosen.size}` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewing && selected && selected.kind === 'document' && (
        <div className="viewer" role="dialog" aria-label={selected.title}>
          <div className="viewer-bar">
            <span className="viewer-title">{selected.title}</span>
            <div className="viewer-tools">
              {canShareFiles() && (
                <button className="btn btn-ghost btn-sm" onClick={() => void shareMade()}>
                  <IconShare size={13} />
                  Share
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setSaving(true)}>
                <IconDownload size={13} />
                Download
              </button>
              <button className="viewer-close" aria-label="Close" onClick={() => setViewing(false)}>
                ×
              </button>
            </div>
          </div>
          <div className="viewer-styles">
            <StylePicker compact kind="document" value={selected.template ?? 'editorial'} onChange={restyle} />
          </div>
          <div className="viewer-body">
            <div className={`doc-page lay-${docTemplate(selected.template).layout}`} style={docPageStyle(selected.template)}>
              <DocPreview text={selected.content} layout={docTemplate(selected.template).layout} />
            </div>
          </div>
        </div>
      )}

      {saving && selected && (
        <SaveDialog
          title={selected.title}
          formats={saveFormats}
          onSave={saveAs}
          onCancel={() => setSaving(false)}
        />
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
