import React from 'react'
import { normalizeCitations, parseTimestamp } from '../lib/format'
import { IconPlay } from '../lib/icons'

interface Props {
  text: string
  /** sessionId is set for cross-session citations like [[ab12cd34@12:37]] */
  onSeek: (seconds: number, sessionId?: string) => void
  /** resolve a session-id prefix to a display label (Brain answers) */
  resolveLabel?: (sessionIdPrefix: string) => string | undefined
}

// [[M:SS]], a range [[0:52-0:57]], or a cross-session cite [[ab12cd34@12:37]].
const TS_RE =
  /\[\[(?:([a-fA-F0-9]{6,})@)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\]\]/g
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g

/** Remove LaTeX delimiters the models sometimes emit: \( \) \[ \] */
function stripLatex(text: string): string {
  return text.replace(/\\[()[\]]/g, '')
}

function renderStyled(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const parts = text.split(INLINE_RE)
  parts.forEach((part, i) => {
    if (!part) return
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-s${i}`}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="msg-code">
          {part.slice(1, -1)}
        </code>
      )
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      nodes.push(<em key={`${keyPrefix}-e${i}`}>{part.slice(1, -1)}</em>)
    } else {
      nodes.push(part)
    }
  })
  return nodes
}

interface InlineCtx {
  onSeek: (s: number, sessionId?: string) => void
  resolveLabel?: (sid: string) => string | undefined
}

function renderInline(text: string, ctx: InlineCtx, keyPrefix: string): React.ReactNode[] {
  const cleaned = stripLatex(text)
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
const isTableSeparator = (line: string): boolean =>
  /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim())

export default function AiText({ text, onSeek, resolveLabel }: Props): React.JSX.Element {
  const ctx: InlineCtx = { onSeek, resolveLabel }
  const blocks: React.ReactNode[] = []
  const lines = normalizeCitations(text).split('\n')
  let paragraph: string[] = []
  let bullets: string[] = []
  let numbered: string[] = []
  let key = 0

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const joined = paragraph.join(' ')
    blocks.push(<p key={`p${key++}`}>{renderInline(joined, ctx, `p${key}`)}</p>)
    paragraph = []
  }
  const flushBullets = (): void => {
    if (bullets.length === 0) return
    blocks.push(
      <ul key={`u${key++}`}>
        {bullets.map((b, i) => (
          <li key={i}>{renderInline(b, ctx, `u${key}-${i}`)}</li>
        ))}
      </ul>
    )
    bullets = []
  }
  const flushNumbered = (): void => {
    if (numbered.length === 0) return
    blocks.push(
      <ol key={`o${key++}`}>
        {numbered.map((b, i) => (
          <li key={i}>{renderInline(b, ctx, `o${key}-${i}`)}</li>
        ))}
      </ol>
    )
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
      flushParagraph()
      flushNumbered()
      bullets.push(bullet[1])
      continue
    }

    const num = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (num) {
      flushParagraph()
      flushBullets()
      numbered.push(num[1])
      continue
    }

    flushBullets()
    flushNumbered()
    paragraph.push(trimmed)
  }
  flushAll()

  return <div className="msg-ai">{blocks}</div>
}
