import React from 'react'

/**
 * A document on screen, in real document elements — headings by level,
 * paragraphs, lists, tables, quotes — so the page's style (the same five
 * styles the PDF is set in) can lay it out: numbered section bands, a
 * heading column, drop capitals, pull quotes. The chat's renderer flattens
 * everything to the same few blocks; a document deserves its structure.
 */
export default function DocPreview({ text, layout }: { text: string; layout: string }): React.JSX.Element {
  const blocks = parse(text)
  const title = blocks.find((b): b is Extract<Block, { kind: 'h' }> => b.kind === 'h' && b.level === 1)
  return (
    <>
      {layout === 'report' && <div className="doc-band">{title ? inline(title.text) : 'Document'}</div>}
      {layout === 'sections' && title && <div className="doc-cover">{inline(title.text)}</div>}
      {blocks.map((b, i) => render(b, i, layout))}
    </>
  )
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; text: string }

function parse(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('```')) {
      flush()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++])
      out.push({ kind: 'code', text: buf.join('\n') })
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flush()
      out.push({ kind: 'h', level: h[1].length, text: h[2].trim() })
      continue
    }
    const t = line.match(/^Title:\s*(.+)$/i)
    if (t && out.length === 0) {
      out.push({ kind: 'h', level: 1, text: t[1].trim() })
      continue
    }
    if (/^[-*_]{3,}$/.test(line)) {
      flush()
      out.push({ kind: 'hr' })
      continue
    }
    if (line.startsWith('>')) {
      flush()
      const q: string[] = [line.replace(/^>\s?/, '')]
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('>')) q.push(lines[++i].trim().replace(/^>\s?/, ''))
      out.push({ kind: 'quote', text: q.join(' ') })
      continue
    }
    if (line.startsWith('|')) {
      flush()
      const rows: string[][] = []
      let j = i
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        const cells = lines[j]
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
        j++
      }
      i = j - 1
      if (rows.length) out.push({ kind: 'table', head: rows[0], rows: rows.slice(1) })
      continue
    }
    const bullet = line.match(/^[-•*]\s+(.*)$/)
    if (bullet) {
      flush()
      const items = [bullet[1]]
      while (i + 1 < lines.length) {
        const nx = lines[i + 1].trim()
        const m = nx.match(/^[-•*]\s+(.*)$/)
        if (m) {
          items.push(m[1])
          i++
        } else if (nx && !/^(#|\d+\.\s|\||>|```)/.test(nx) && /^\s{2,}/.test(lines[i + 1])) {
          items[items.length - 1] += ' ' + nx
          i++
        } else break
      }
      out.push({ kind: 'ul', items })
      continue
    }
    const num = line.match(/^\d+[.)]\s+(.*)$/)
    if (num) {
      flush()
      const items = [num[1]]
      while (i + 1 < lines.length) {
        const m = lines[i + 1].trim().match(/^\d+[.)]\s+(.*)$/)
        if (!m) break
        items.push(m[1])
        i++
      }
      out.push({ kind: 'ol', items })
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

/** bold, italics, code and links within a line */
function inline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('*')) out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (lm)
        out.push(
          <a key={k++} href={lm[2]} target="_blank" rel="noreferrer">
            {lm[1]}
          </a>
        )
      else out.push(tok)
    }
    last = m.index + tok.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

function render(b: Block, i: number, layout: string): React.ReactNode {
  switch (b.kind) {
    case 'h': {
      // the title is set once, at the head; the sections' headings follow their level
      if (b.level === 1) return <h1 key={i}>{inline(b.text)}</h1>
      if (b.level === 2) return <h2 key={i}>{inline(layout === 'report' || layout === 'sections' ? b.text.replace(/^\d+[.)]\s+/, '') : b.text)}</h2>
      if (b.level === 3) return <h3 key={i}>{inline(b.text)}</h3>
      return <h4 key={i}>{inline(b.text)}</h4>
    }
    case 'p':
      return <p key={i}>{inline(b.text)}</p>
    case 'ul':
      return (
        <ul key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={i}>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ol>
      )
    case 'quote':
      return <blockquote key={i}>{inline(b.text)}</blockquote>
    case 'hr':
      return <hr key={i} />
    case 'code':
      return (
        <pre key={i} className="doc-code">
          <code>{b.text}</code>
        </pre>
      )
    case 'table':
      return (
        <div key={i} className="doc-table-wrap">
          <table className={`doc-table${layout === 'report' ? ' striped' : ''}`}>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}
