/** Compact markdown + [[M:SS]] citation-chip renderer (shared by public pages). */

const RE_FW = /【\s*((?:[a-fA-F0-9]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\s*】/g
const RE_BR = /\[{1,2}\s*((?:[a-fA-F0-9]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\s*\]{1,2}/g
const RE_CHIP = /\[\[((?:[a-fA-F0-9]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\]\]/g

export const normCites = (t: string): string =>
  (t || '').replace(RE_FW, '[[$1]]').replace(RE_BR, '[[$1]]')
export const escH = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function parseTs(ts: string): number | null {
  const p = ts.split(':').map(Number)
  if (p.some(isNaN)) return null
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  if (p.length === 2) return p[0] * 60 + p[1]
  return null
}

export function inlineMd(s: string): string {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  s = s.replace(RE_CHIP, (_m, body: string) => {
    const at = body.indexOf('@')
    const label = at >= 0 ? body.slice(at + 1) : body
    const sec = parseTs(label)
    if (sec === null || at >= 0) return label
    return `<button class="tchip" data-s="${sec}">${label}</button>`
  })
  return s
}

function rowCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

export function md(src: string): string {
  const lines = escH(normCites(src)).split(/\r?\n/)
  const out: string[] = []
  let i = 0
  let inCode = false
  let codeBuf: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listBuf: string[] = []
  const flushList = (): void => {
    if (listType) {
      out.push(`<${listType}>${listBuf.join('')}</${listType}>`)
      listType = null
      listBuf = []
    }
  }
  while (i < lines.length) {
    const L = lines[i]
    if (/^```/.test(L)) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
        codeBuf = []
        inCode = false
      } else {
        flushList()
        inCode = true
      }
      i++
      continue
    }
    if (inCode) {
      codeBuf.push(L)
      i++
      continue
    }
    if (
      /^\s*\|/.test(L) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      flushList()
      const head = rowCells(L)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(rowCells(lines[i]))
        i++
      }
      out.push(
        `<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>'
      )
      continue
    }
    let mm = /^(#{1,6})\s+(.*)$/.exec(L)
    if (mm) {
      flushList()
      const lv = Math.min(mm[1].length + 1, 4)
      out.push(`<h${lv}>${inlineMd(mm[2])}</h${lv}>`)
      i++
      continue
    }
    mm = /^\s*[-*+]\s+(.*)$/.exec(L)
    if (mm) {
      if (listType !== 'ul') {
        flushList()
        listType = 'ul'
      }
      listBuf.push(`<li>${inlineMd(mm[1])}</li>`)
      i++
      continue
    }
    mm = /^\s*\d+[.)]\s+(.*)$/.exec(L)
    if (mm) {
      if (listType !== 'ol') {
        flushList()
        listType = 'ol'
      }
      listBuf.push(`<li>${inlineMd(mm[1])}</li>`)
      i++
      continue
    }
    if (!L.trim()) {
      flushList()
      i++
      continue
    }
    flushList()
    out.push(`<p>${inlineMd(L)}</p>`)
    i++
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
  flushList()
  return out.join('')
}
