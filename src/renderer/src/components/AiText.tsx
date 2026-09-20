import React from 'react'
import { normalizeCitations, parseTimestamp } from '../lib/format'
import { IconPlay } from '../lib/icons'
import { renderMath } from '../lib/math'
import { Chart, Flow, parseChart, parseFlow } from '../lib/figures'
import { IconDoc } from '../lib/icons'
import { mdToHtml, wordDocument } from '../lib/mdToHtml'
import { markdownToPdf } from '../lib/pdf'

/**
 * A document Sitca wrote in the conversation (a ```document block): shown as
 * a card with the title, the body, and the ways to take it away.
 */
function DocCard({
  text,
  onSeek,
  resolveLabel
}: {
  text: string
  onSeek: Props['onSeek']
  resolveLabel?: Props['resolveLabel']
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const titled = /^\s*title\s*:/i.test(first)
  const title = titled ? first.replace(/^\s*title\s*:\s*/i, '').trim() || 'Document' : 'Document'
  const body = (titled ? lines.slice(1) : lines).join('\n').trim()
  const fileName = (title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'document') as string
  const save = (name: string, bytes: Uint8Array): void => {
    const copy = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(copy).set(bytes)
    void window.sitka.saveBinaryFile(name, copy)
  }
  return (
    <div className="doc-card">
      <div className="doc-card-head">
        <span className="doc-icon">
          <IconDoc size={15} strokeWidth={1.8} />
        </span>
        <span className="doc-card-title" title={title}>
          {title}
        </span>
        <span className="doc-card-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void navigator.clipboard.writeText(`# ${title}\n\n${body}`).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Save as a Word document"
            onClick={() =>
              save(`${fileName}.doc`, new TextEncoder().encode(wordDocument(title, mdToHtml(body))))
            }
          >
            Word
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Save as a PDF"
            onClick={() => save(`${fileName}.pdf`, markdownToPdf(title, body))}
          >
            PDF
          </button>
        </span>
      </div>
      <div className={`doc-card-body${open ? ' open' : ''}`}>
        <AiText text={body} onSeek={onSeek} resolveLabel={resolveLabel} />
      </div>
      {body.length > 1200 && (
        <button className="doc-card-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show the whole document'}
        </button>
      )}
    </div>
  )
}

interface Props {
  text: string
  /** sessionId is set for cross-session citations like [[ab12cd34@12:37]] */
  onSeek: (seconds: number, sessionId?: string) => void
  /** resolve a session-id prefix to a display label (Brain answers) */
  resolveLabel?: (sessionIdPrefix: string) => string | undefined
}

// [[M:SS]], a range [[0:52-0:57]], or a cross-session cite [[ab12cd34@12:37]].
const TS_RE =
  /\[\[(?:([a-fA-F0-9-]{6,})@)?(\d{1,2}:\d{2}(?::\d{2})?)(?:(?:\s*[-‐-―−]\s*|\s+to\s+)(\d{1,2}:\d{2}(?::\d{2})?))?\]\]/g
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g

function renderStyled(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const parts = text.split(INLINE_RE)
  parts.forEach((part, i) => {
    if (!part) return
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-s${i}`}>{renderMath(part.slice(2, -2), `${keyPrefix}-s${i}`)}</strong>
      )
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="msg-code">
          {part.slice(1, -1)}
        </code>
      )
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      nodes.push(<em key={`${keyPrefix}-e${i}`}>{renderMath(part.slice(1, -1), `${keyPrefix}-e${i}`)}</em>)
    } else {
      nodes.push(...renderMath(part, `${keyPrefix}-p${i}`))
    }
  })
  return nodes
}

interface InlineCtx {
  onSeek: (s: number, sessionId?: string) => void
  resolveLabel?: (sid: string) => string | undefined
}

function renderInline(text: string, ctx: InlineCtx, keyPrefix: string): React.ReactNode[] {
  const cleaned = text
  const nodes: React.ReactNode[] = []
  let last = 0
  let i = 0
  for (const match of cleaned.matchAll(TS_RE)) {
    const idx = match.index ?? 0
    if (idx > last) nodes.push(...renderStyled(cleaned.slice(last, idx), `${keyPrefix}-t${i}`))
    const sid = match[1]
    const start = match[2]
    const end = match[3]
    const seconds = parseTimestamp(start)
    const sessionLabel = sid ? ctx.resolveLabel?.(sid) : undefined
    const timeLabel = end ? `${start}–${end}` : start
    nodes.push(
      <button
        key={`${keyPrefix}-ts${i}`}
        className="ts-chip"
        onClick={() => seconds !== null && ctx.onSeek(seconds, sid)}
        title={sessionLabel ? `Open "${sessionLabel}" at ${start}` : `Jump to ${start}`}
      >
        <IconPlay size={10} strokeWidth={2.4} />
        {sessionLabel ? `${sessionLabel} · ${timeLabel}` : timeLabel}
      </button>
    )
    last = idx + match[0].length
    i++
  }
  if (last < cleaned.length) nodes.push(...renderStyled(cleaned.slice(last), `${keyPrefix}-end`))
  return nodes
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

const isTableLine = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 2
}
/** Lines that are mostly box-drawing: +----+, | cell |, arrows. */
const looksBoxArt = (line: string): boolean => {
  if (line.length < 6) return false
  if (/^\+[-=+]{3,}/.test(line) || /^\|.*\|$/.test(line) || /^[|+\-=\s]*[v^]\s*$/.test(line)) return true
  const drawn = (line.match(/[+|\-=]/g) ?? []).length
  return drawn >= 6 && drawn / line.length > 0.4
}
/** Fence contents that are really notes: headings, bullets, bold, numbered steps. */
const looksLikeMarkdown = (body: string[]): boolean => {
  const marks = body.filter((l) => /^\s*(#{1,4}\s|[-*•]\s|\d+[.)]\s|\*\*)/.test(l)).length
  const code = body.filter((l) => /[{};]\s*$|^\s*(import|const|let|function|def|class|return)\b|=>|<\/?\w+>/.test(l)).length
  return marks >= 2 && marks > code
}
const isTableSeparator = (line: string): boolean =>
  /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim())

export default function AiText({ text, onSeek, resolveLabel }: Props): React.JSX.Element {
  const ctx: InlineCtx = { onSeek, resolveLabel }
  const blocks: React.ReactNode[] = []
  const lines = normalizeCitations(text).split('\n')
  let paragraph: string[] = []
  // list items keep one level of sub-points, so an indented "- " nests
  // instead of flattening into its parent's list
  let bullets: { text: string; sub: string[] }[] = []
  let numbered: { text: string; sub: string[] }[] = []
  let key = 0
  const indentOf = (line: string): number => line.length - line.trimStart().length
  const renderItems = (
    items: { text: string; sub: string[] }[],
    prefix: string
  ): React.ReactNode[] =>
    items.map((b, i) => (
      <li key={i}>
        {renderInline(b.text, ctx, `${prefix}-${i}`)}
        {b.sub.length > 0 && (
          <ul>
            {b.sub.map((s, j) => (
              <li key={j}>{renderInline(s, ctx, `${prefix}-${i}-${j}`)}</li>
            ))}
          </ul>
        )}
      </li>
    ))

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const joined = paragraph.join(' ')
    blocks.push(<p key={`p${key++}`}>{renderInline(joined, ctx, `p${key}`)}</p>)
    paragraph = []
  }
  const flushBullets = (): void => {
    if (bullets.length === 0) return
    blocks.push(<ul key={`u${key++}`}>{renderItems(bullets, `u${key}`)}</ul>)
    bullets = []
  }
  const flushNumbered = (): void => {
    if (numbered.length === 0) return
    blocks.push(<ol key={`o${key++}`}>{renderItems(numbered, `o${key}`)}</ol>)
    numbered = []
  }
  const flushAll = (): void => {
    flushParagraph()
    flushBullets()
    flushNumbered()
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      flushAll()
      continue
    }

    // Fenced block: a chart or diagram the AI drew, or plain code.
    const fence = trimmed.match(/^```\s*([\w-]*)\s*$/)
    if (fence) {
      flushAll()
      const lang = fence[1].toLowerCase()
      const body: string[] = []
      let ei = li + 1
      while (ei < lines.length && !/^\s*```/.test(lines[ei])) {
        body.push(lines[ei])
        ei++
      }
      const text = body.join('\n')
      // Prose or notes that the model wrapped in a fence by mistake: read as
      // the markdown they are, not shown as a block of code
      if ((lang === '' || lang === 'markdown' || lang === 'md' || lang === 'text' || lang === 'txt') && looksLikeMarkdown(body)) {
        lines.splice(li, ei - li + 1, ...body)
        li--
        continue
      }
      const chart = lang === 'chart' ? parseChart(text) : null
      const flow = lang === 'flow' || lang === 'diagram' ? parseFlow(text) : null
      if (lang === 'document' || lang === 'doc') {
        blocks.push(
          <DocCard key={`f${key++}`} text={text} onSeek={onSeek} resolveLabel={resolveLabel} />
        )
      } else if (chart) blocks.push(<Chart key={`f${key++}`} spec={chart} />)
      else if (flow) blocks.push(<Flow key={`f${key++}`} spec={flow} />)
      else
        blocks.push(
          <pre key={`f${key++}`} className="msg-pre">
            <code>{text}</code>
          </pre>
        )
      li = ei
      continue
    }

    // Table: a header row followed by a separator row.
    if (isTableLine(trimmed) && li + 1 < lines.length && isTableSeparator(lines[li + 1])) {
      flushAll()
      const header = tableCells(trimmed)
      const rows: string[][] = []
      let ri = li + 2
      while (ri < lines.length && isTableLine(lines[ri].trim())) {
        rows.push(tableCells(lines[ri].trim()))
        ri++
      }
      blocks.push(
        <div key={`tw${key++}`} className="msg-table-wrap">
          <table className="msg-table">
            <thead>
              <tr>
                {header.map((h, i) => (
                  <th key={i}>{renderInline(h, ctx, `th${key}-${i}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{renderInline(c, ctx, `td${key}-${i}-${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      li = ri - 1
      continue
    }

    // A picture drawn with characters (boxes, arrows): kept in a fixed-width
    // block so its lines stay aligned, instead of flowing into a paragraph
    if (looksBoxArt(trimmed)) {
      flushAll()
      const art: string[] = [line]
      let ai = li + 1
      while (ai < lines.length && lines[ai].trim() !== '' && (looksBoxArt(lines[ai].trim()) || /^[|+]/.test(lines[ai].trim()))) {
        art.push(lines[ai].trimEnd())
        ai++
      }
      blocks.push(
        <pre key={`a${key++}`} className="msg-pre msg-art">
          <code>{art.join('\n')}</code>
        </pre>
      )
      li = ai - 1
      continue
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushAll()
      blocks.push(
        <div key={`h${key++}`} className="msg-h">
          {renderInline(heading[2], ctx, `h${key}`)}
        </div>
      )
      continue
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushAll()
      blocks.push(<hr key={`r${key++}`} className="msg-hr" />)
      continue
    }

    const bullet = trimmed.match(/^[-•*]\s+(.*)$/)
    if (bullet) {
      // indented under an open item: a sub-point of that item
      if (indentOf(line) >= 2 && (bullets.length > 0 || numbered.length > 0)) {
        const open = bullets.length > 0 ? bullets : numbered
        open[open.length - 1].sub.push(bullet[1])
        continue
      }
      flushParagraph()
      flushNumbered()
      bullets.push({ text: bullet[1], sub: [] })
      continue
    }

    const num = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (num) {
      if (indentOf(line) >= 2 && (bullets.length > 0 || numbered.length > 0)) {
        const open = bullets.length > 0 ? bullets : numbered
        open[open.length - 1].sub.push(num[1])
        continue
      }
      flushParagraph()
      flushBullets()
      numbered.push({ text: num[1], sub: [] })
      continue
    }

    flushBullets()
    flushNumbered()
    paragraph.push(trimmed)
  }
  flushAll()

  return <div className="msg-ai">{blocks}</div>
}
