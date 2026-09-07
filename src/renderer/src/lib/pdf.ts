/**
 * A small PDF writer with no dependencies: enough for Sitka's documents and
 * slide decks (headings, paragraphs, bullets, numbered lists, simple tables,
 * bold runs). Uses the built-in Helvetica faces, so nothing is embedded and
 * the file is tiny. Text is WinAnsi; characters outside it become "?".
 */

// Helvetica / Helvetica-Bold advance widths for ASCII 32..126 (per 1000 em).
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]

// Unicode → WinAnsi byte for the characters Sitka's writing actually uses.
const WINANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89, '‹': 0x8b,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '›': 0x9b,
  ' ': 0x20, '£': 0xa3, '©': 0xa9, '®': 0xae, '°': 0xb0, '±': 0xb1, '²': 0xb2, '³': 0xb3, '·': 0xb7,
  '×': 0xd7, '÷': 0xf7, 'é': 0xe9, 'è': 0xe8, 'ê': 0xea, 'á': 0xe1, 'à': 0xe0, 'ä': 0xe4, 'ö': 0xf6,
  'ü': 0xfc, 'ñ': 0xf1, 'ç': 0xe7, 'í': 0xed, 'ó': 0xf3, 'ú': 0xfa, 'É': 0xc9, 'Ü': 0xdc, 'Ö': 0xd6, 'Ä': 0xc4
}

function toWinAnsi(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 63
    // ASCII, including the newlines and tabs that hold the file together.
    if (c <= 126) out.push(c)
    else if (WINANSI[ch] !== undefined) out.push(WINANSI[ch])
    else if (c >= 0xa0 && c <= 0xff) out.push(c)
    else out.push(63)
  }
  return out
}

function width(s: string, size: number, bold: boolean): number {
  const table = bold ? W_BOLD : W_REG
  let w = 0
  for (const b of toWinAnsi(s)) {
    w += b >= 32 && b <= 126 ? table[b - 32] : 556
  }
  return (w / 1000) * size
}

function pdfString(s: string): string {
  let out = '('
  for (const b of toWinAnsi(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b)
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0')
    else out += String.fromCharCode(b)
  }
  return out + ')'
}

interface Run {
  text: string
  bold: boolean
}

/** Split "**bold**" runs and strip other inline marks. */
function runs(md: string): Run[] {
  const clean = md
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1')
    .replace(/\[\[(?:[a-fA-F0-9]{6,}@)?(\d{1,2}:\d{2}(?::\d{2})?)\]\]/g, '($1)')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
  const out: Run[] = []
  const parts = clean.split(/\*\*/)
  parts.forEach((p, i) => {
    if (p) out.push({ text: p, bold: i % 2 === 1 })
  })
  return out
}

interface Word {
  text: string
  bold: boolean
  w: number
}

function words(rs: Run[], size: number): Word[] {
  const out: Word[] = []
  for (const r of rs) {
    for (const t of r.text.split(/(\s+)/)) {
      if (!t) continue
      if (/^\s+$/.test(t)) out.push({ text: ' ', bold: r.bold, w: width(' ', size, r.bold) })
      else out.push({ text: t, bold: r.bold, w: width(t, size, r.bold) })
    }
  }
  return out
}

/** Wrap words into lines no wider than maxW. */
function wrap(ws: Word[], maxW: number): Word[][] {
  const lines: Word[][] = []
  let line: Word[] = []
  let w = 0
  for (const word of ws) {
    if (word.text === ' ') {
      if (line.length) {
        line.push(word)
        w += word.w
      }
      continue
    }
    if (w + word.w > maxW && line.length) {
      while (line.length && line[line.length - 1].text === ' ') line.pop()
      lines.push(line)
      line = []
      w = 0
    }
    line.push(word)
    w += word.w
  }
  while (line.length && line[line.length - 1].text === ' ') line.pop()
  if (line.length) lines.push(line)
  return lines
}

class Doc {
  private pages: string[] = []
  private cur: string[] = []
  private y = 0
  constructor(
    private pageW: number,
    private pageH: number,
    private margin: number
  ) {
    this.newPage()
  }
  get usableW(): number {
    return this.pageW - this.margin * 2
  }
  newPage(): void {
    if (this.cur.length) this.pages.push(this.cur.join('\n'))
    this.cur = []
    this.y = this.pageH - this.margin
  }
  ensure(h: number): void {
    if (this.y - h < this.margin) this.newPage()
  }
  space(h: number): void {
    this.y -= h
  }
  /** Draw one wrapped line of words at x. */
  line(ws: Word[], x: number, size: number, gray = 0): void {
    let cx = x
    const parts: string[] = [`BT ${gray} g`]
    let font = ''
    for (const w of ws) {
      const f = w.bold ? '/F2' : '/F1'
      if (f !== font) {
        parts.push(`${f} ${size} Tf`)
        font = f
      }
      parts.push(`1 0 0 1 ${cx.toFixed(2)} ${this.y.toFixed(2)} Tm ${pdfString(w.text)} Tj`)
      cx += w.w
    }
    parts.push('ET')
    this.cur.push(parts.join(' '))
  }
  paragraph(md: string, size: number, opts: { bold?: boolean; indent?: number; bullet?: string; gray?: number; lineHeight?: number } = {}): void {
    const indent = opts.indent ?? 0
    const lh = size * (opts.lineHeight ?? 1.45)
    const rs = opts.bold ? [{ text: md.replace(/\*\*/g, ''), bold: true }] : runs(md)
    const lines = wrap(words(rs, size), this.usableW - indent)
    lines.forEach((ln, i) => {
      this.ensure(lh)
      this.y -= lh
      if (i === 0 && opts.bullet) {
        this.line([{ text: opts.bullet, bold: false, w: 0 }], this.margin + indent - width(opts.bullet, size, false) - 5, size, opts.gray ?? 0)
      }
      this.line(ln, this.margin + indent, size, opts.gray ?? 0)
    })
  }
  rule(): void {
    this.ensure(10)
    this.y -= 6
    this.cur.push(`0.85 G 0.6 w ${this.margin} ${this.y.toFixed(2)} m ${(this.pageW - this.margin).toFixed(2)} ${this.y.toFixed(2)} l S`)
    this.y -= 6
  }
  footer(text: string): void {
    // applied to every page at build time
    this.footerText = text
  }
  private footerText = ''
  build(): Uint8Array {
    if (this.cur.length) this.pages.push(this.cur.join('\n'))
    const objs: string[] = []
    const add = (s: string): number => {
      objs.push(s)
      return objs.length
    }
    add('<< /Type /Catalog /Pages 2 0 R >>') // 1
    add('') // 2: pages, filled later
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>') // 3
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>') // 4
    const pageIds: number[] = []
    this.pages.forEach((content, i) => {
      const foot = this.footerText
        ? `BT 0.55 g /F1 8.5 Tf 1 0 0 1 ${this.margin} ${(this.margin * 0.55).toFixed(2)} Tm ${pdfString(this.footerText)} Tj ET ` +
          `BT 0.55 g /F1 8.5 Tf 1 0 0 1 ${(this.pageW - this.margin - width(String(i + 1), 8.5, false)).toFixed(2)} ${(this.margin * 0.55).toFixed(2)} Tm ${pdfString(String(i + 1))} Tj ET`
        : ''
      const stream = content + '\n' + foot
      const bytes = toWinAnsi(stream).length
      const cId = add(`<< /Length ${bytes} >>\nstream\n${stream}\nendstream`)
      const pId = add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cId} 0 R >>`
      )
      pageIds.push(pId)
    })
    objs[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`

    let out = '%PDF-1.4\n%âãÏÓ\n'
    const offsets: number[] = []
    objs.forEach((o, i) => {
      offsets.push(toWinAnsi(out).length)
      out += `${i + 1} 0 obj\n${o}\nendobj\n`
    })
    const xref = toWinAnsi(out).length
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Uint8Array.from(toWinAnsi(out))
  }
}

/** A document PDF from Markdown: A4, serif-free, numbered pages. */
export function markdownToPdf(title: string, md: string): Uint8Array {
  const doc = new Doc(595.28, 841.89, 56)
  doc.footer(title)
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = []
  let numbered = 0
  let inCode = false
  let table: string[][] = []

  const flushPara = (): void => {
    if (para.length) {
      doc.paragraph(para.join(' '), 10.5)
      doc.space(5)
    }
    para = []
  }
  const flushTable = (): void => {
    if (table.length === 0) return
    const cols = Math.max(...table.map((r) => r.length))
    const colW = doc.usableW / cols
    table.forEach((row, ri) => {
      doc.ensure(16)
      doc.space(14)
      row.forEach((cell, ci) => {
        const ws = words(runs(cell), 9.5).map((w) => (ri === 0 ? { ...w, bold: true, w: width(w.text, 9.5, true) } : w))
        // single line per cell, clipped by wrapping to the first line
        const first = wrap(ws, colW - 8)[0] ?? []
        doc.line(first, 56 + ci * colW, 9.5)
      })
      if (ri === 0) doc.rule()
    })
    doc.space(8)
    table = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/^```/.test(line)) {
      flushPara()
      inCode = !inCode
      continue
    }
    if (inCode) {
      doc.paragraph(line || ' ', 9, { indent: 10, gray: 0.25, lineHeight: 1.35 })
      continue
    }
    if (!line.trim()) {
      flushPara()
      flushTable()
      numbered = 0
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      flushPara()
      flushTable()
      const level = h[1].length
      const size = level === 1 ? 22 : level === 2 ? 15 : 12.5
      doc.space(level === 1 ? 4 : 12)
      doc.paragraph(h[2], size, { bold: true, lineHeight: 1.25 })
      doc.space(level === 1 ? 10 : 5)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara()
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue
      table.push(line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
      continue
    }
    const ul = line.match(/^\s*[-*•]\s+(.+)$/)
    if (ul) {
      flushPara()
      flushTable()
      doc.paragraph(ul[1], 10.5, { indent: 16, bullet: '•' })
      continue
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.+)$/)
    if (ol) {
      flushPara()
      flushTable()
      numbered = numbered + 1
      doc.paragraph(ol[2], 10.5, { indent: 18, bullet: `${numbered}.` })
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara()
      doc.rule()
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  flushTable()
  return doc.build()
}

export interface PdfSlide {
  title: string
  bullets: string[]
  notes?: string
}

/** A slide deck PDF: one landscape page per slide, notes at the foot. */
export function deckToPdf(title: string, subtitle: string | undefined, slides: PdfSlide[]): Uint8Array {
  const doc = new Doc(841.89, 595.28, 60)
  doc.footer(title)
  slides.forEach((s, i) => {
    if (i > 0) doc.newPage()
    doc.space(i === 0 ? 150 : 40)
    doc.paragraph(s.title, i === 0 ? 40 : 28, { bold: true, lineHeight: 1.15 })
    if (i === 0 && subtitle) {
      doc.space(10)
      doc.paragraph(subtitle, 16, { gray: 0.45 })
    }
    doc.space(16)
    for (const b of s.bullets) doc.paragraph(b, 16, { indent: 22, bullet: '•', lineHeight: 1.5 })
    if (s.notes) {
      doc.space(26)
      doc.rule()
      doc.paragraph('Notes', 9, { bold: true, gray: 0.45 })
      doc.paragraph(s.notes, 10, { gray: 0.35 })
    }
  })
  return doc.build()
}
