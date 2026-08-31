/**
 * Rich clipboard support: Sitka content is markdown internally, but a copy
 * should paste as real formatting in Word/Docs/Outlook (text/html flavor)
 * while still giving clean plain text everywhere else.
 */

import { normalizeCitations } from './format'

const CITE_RE = /\[\[(?:[a-fA-F0-9]{6,}@)?(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–—]\s*\d{1,2}:\d{2}(?::\d{2})?)?)\]\]/g

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(CITE_RE, '($1)')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\\[()[\]]/g, '')
}

const isTableLine = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 2
}
const isTableSep = (line: string): boolean =>
  /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim())
const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export function mdToHtml(md: string): string {
  const lines = normalizeCitations(md).split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null

  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') {
      closeList()
      continue
    }

    if (isTableLine(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList()
      const header = cells(line)
      out.push('<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse">')
      out.push('<tr>' + header.map((h) => `<th>${inlineHtml(h)}</th>`).join('') + '</tr>')
      let ri = i + 2
      while (ri < lines.length && isTableLine(lines[ri].trim())) {
        out.push(
          '<tr>' + cells(lines[ri].trim()).map((c) => `<td>${inlineHtml(c)}</td>`).join('') + '</tr>'
        )
        ri++
      }
      out.push('</table>')
      i = ri - 1
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = Math.min(3, heading[1].length)
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`)
      continue
    }

    if (/^[-*_]{3,}$/.test(line)) {
      closeList()
      out.push('<hr>')
      continue
    }

    const bullet = line.match(/^[-•*]\s+(.*)$/)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inlineHtml(bullet[1])}</li>`)
      continue
    }

    const num = line.match(/^\d+[.)]\s+(.*)$/)
    if (num) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inlineHtml(num[1])}</li>`)
      continue
    }

    closeList()
    out.push(`<p>${inlineHtml(line)}</p>`)
  }
  closeList()

  return `<div style="font-family:Calibri,-apple-system,'Segoe UI',sans-serif;font-size:11pt;line-height:1.5">${out.join('\n')}</div>`
}

export function mdToPlain(md: string): string {
  return normalizeCitations(md)
    .replace(CITE_RE, '($1)')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/\\[()[\]]/g, '')
}

export async function copyRich(md: string): Promise<boolean> {
  const html = mdToHtml(md)
  const plain = mdToPlain(md)
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      })
    ])
    return true
  } catch {
    try {
      await navigator.clipboard.writeText(plain)
      return true
    } catch {
      return false
    }
  }
}

/** Strips markdown and citations so text-to-speech reads naturally. */
export function cleanForSpeech(md: string): string {
  return mdToPlain(md)
    .replace(/\(\d{1,2}:\d{2}(?::\d{2})?[^)]*\)/g, '')
    .replace(/[|#*_`]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
