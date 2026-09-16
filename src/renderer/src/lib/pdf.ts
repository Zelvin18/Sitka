/**
 * A small PDF writer with no dependencies: enough for Sitka's documents and
 * slide decks (headings, paragraphs, bullets, numbered lists, simple tables,
 * code, bold runs), in colour, with shapes, in a choice of styles. It uses
 * the fonts every PDF reader carries (Helvetica, Times, Courier), so nothing
 * is embedded and the file is tiny. Text is WinAnsi; characters outside it
 * become "?".
 *
 * Five document styles and five deck styles live here as data, and the same
 * definitions drive the PowerPoint and web-page exports, so a style chosen
 * once looks the same whichever file is made from it.
 */

// ---------- fonts ----------
// Advance widths for ASCII 32..126 (per 1000 em), from the standard AFMs.
const W_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
const W_HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]
const W_TIMES = [250,333,408,500,500,833,778,333,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541]
const W_TIMES_B = [250,333,555,500,500,1000,833,333,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520]

type Face = 'sans' | 'sansBold' | 'serif' | 'serifBold' | 'mono'
const FONT_ID: Record<Face, string> = { sans: '/F1', sansBold: '/F2', serif: '/F3', serifBold: '/F4', mono: '/F5' }
const FONT_DEF: Record<Face, string> = {
  sans: 'Helvetica',
  sansBold: 'Helvetica-Bold',
  serif: 'Times-Roman',
  serifBold: 'Times-Bold',
  mono: 'Courier'
}
const WIDTHS: Record<Face, number[] | null> = { sans: W_HELV, sansBold: W_HELV_B, serif: W_TIMES, serifBold: W_TIMES_B, mono: null }

const WINANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89, '‹': 0x8b,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '›': 0x9b,
  ' ': 0x20, '£': 0xa3, '©': 0xa9, '®': 0xae, '°': 0xb0, '±': 0xb1, '²': 0xb2, '³': 0xb3, '·': 0xb7,
  '×': 0xd7, '÷': 0xf7, 'é': 0xe9, 'è': 0xe8, 'ê': 0xea, 'á': 0xe1, 'à': 0xe0, 'ä': 0xe4, 'ö': 0xf6,
  'ü': 0xfc, 'ñ': 0xf1, 'ç': 0xe7, 'í': 0xed, 'ó': 0xf3, 'ú': 0xfa, 'É': 0xc9, 'Ü': 0xdc, 'Ö': 0xd6, 'Ä': 0xc4,
  '✓': 0x76, '→': 0x9b, '■': 0x95, '▪': 0x95
}

function toWinAnsi(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 63
    if (c <= 126) out.push(c)
    else if (WINANSI[ch] !== undefined) out.push(WINANSI[ch])
    else if (c >= 0xa0 && c <= 0xff) out.push(c)
    else out.push(63)
  }
  return out
}

function width(s: string, size: number, face: Face): number {
  const table = WIDTHS[face]
  let w = 0
  for (const b of toWinAnsi(s)) {
    if (!table) w += 600
    else w += b >= 32 && b <= 126 ? table[b - 32] : 556
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

// ---------- colour ----------
export type RGB = [number, number, number]
export const hex = (h: string): RGB => {
  const n = parseInt(h.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
export const toHex = (c: RGB): string =>
  '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
const rg = (c: RGB): string => `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} rg`
const RG = (c: RGB): string => `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} RG`

// ---------- styles ----------
export interface DocTemplate {
  id: string
  name: string
  desc: string
  /** body and headings in a serif face */
  serif: boolean
  /** the page itself, when not white */
  page: RGB | null
  ink: RGB
  muted: RGB
  accent: RGB
  rule: RGB
  /** the cover page's shape */
  cover: 'editorial' | 'block' | 'band' | 'paper' | 'dark'
  /** a running band at the head of every page */
  band: boolean
  /** headings numbered 01, 02 … */
  numbered: boolean
  /** section headings in capitals */
  caps: boolean
  bullet: string
  /** table header fill */
  tableHead: RGB
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: 'editorial',
    name: 'Editorial',
    desc: 'Serif, generous margins, hairline rules. A magazine essay.',
    serif: true,
    page: null,
    ink: hex('#141416'),
    muted: hex('#6a6a72'),
    accent: hex('#141416'),
    rule: hex('#d9d9d4'),
    cover: 'editorial',
    band: false,
    numbered: false,
    caps: true,
    bullet: '—',
    tableHead: hex('#f2f2ef')
  },
  {
    id: 'studio',
    name: 'Studio',
    desc: 'Sans, bold black headings, one blue accent. Made to be read on a screen.',
    serif: false,
    page: null,
    ink: hex('#101012'),
    muted: hex('#6d6d75'),
    accent: hex('#2f5bff'),
    rule: hex('#e3e3e8'),
    cover: 'block',
    band: false,
    numbered: false,
    caps: false,
    bullet: '•',
    tableHead: hex('#eef2ff')
  },
  {
    id: 'boardroom',
    name: 'Boardroom',
    desc: 'Navy, a running header, square bullets. For the people who sign things.',
    serif: false,
    page: null,
    ink: hex('#15161c'),
    muted: hex('#5f6572'),
    accent: hex('#0f2747'),
    rule: hex('#d5d9e2'),
    cover: 'band',
    band: true,
    numbered: true,
    caps: true,
    bullet: '▪',
    tableHead: hex('#e6ebf4')
  },
  {
    id: 'paper',
    name: 'Paper',
    desc: 'Warm cream pages, serif, a brown-ink accent. Notes you would keep.',
    serif: true,
    page: hex('#fbf7ef'),
    ink: hex('#2a241d'),
    muted: hex('#7a6f61'),
    accent: hex('#7a4f27'),
    rule: hex('#e3d9c8'),
    cover: 'paper',
    band: false,
    numbered: false,
    caps: false,
    bullet: '•',
    tableHead: hex('#f1e9dc')
  },
  {
    id: 'signal',
    name: 'Signal',
    desc: 'A black cover, white pages, big numbered sections in green. Modern and loud.',
    serif: false,
    page: null,
    ink: hex('#0d0d0f'),
    muted: hex('#6b6b73'),
    accent: hex('#1f9d55'),
    rule: hex('#e6e6e9'),
    cover: 'dark',
    band: false,
    numbered: true,
    caps: false,
    bullet: '→',
    tableHead: hex('#e9f6ee')
  }
]

export interface DeckTemplate {
  id: string
  name: string
  desc: string
  serif: boolean
  bg: RGB
  ink: RGB
  muted: RGB
  accent: RGB
  titleBg: RGB
  titleInk: RGB
  /** an accent shape on content slides */
  bar: 'left' | 'top' | 'under' | 'none'
  /** slide numbers */
  numbered: boolean
  bullet: string
}

export const DECK_TEMPLATES: DeckTemplate[] = [
  {
    id: 'mono',
    name: 'Mono',
    desc: 'White slides, huge black titles, a thin rule. Nothing between you and the idea.',
    serif: false,
    bg: hex('#ffffff'),
    ink: hex('#111113'),
    muted: hex('#6e6e76'),
    accent: hex('#111113'),
    titleBg: hex('#111113'),
    titleInk: hex('#ffffff'),
    bar: 'under',
    numbered: true,
    bullet: '—'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    desc: 'Dark slides, white type, a soft grey accent. Made for a dim room.',
    serif: false,
    bg: hex('#0f0f11'),
    ink: hex('#f2f2f4'),
    muted: hex('#9a9aa3'),
    accent: hex('#c9c9d0'),
    titleBg: hex('#0f0f11'),
    titleInk: hex('#f2f2f4'),
    bar: 'left',
    numbered: true,
    bullet: '•'
  },
  {
    id: 'ocean',
    name: 'Ocean',
    desc: 'Deep blue title, white slides with blue headings and a side bar. Calm and corporate.',
    serif: false,
    bg: hex('#ffffff'),
    ink: hex('#14202e'),
    muted: hex('#5f6b7a'),
    accent: hex('#0b3d6e'),
    titleBg: hex('#0b2a4a'),
    titleInk: hex('#ffffff'),
    bar: 'left',
    numbered: true,
    bullet: '▪'
  },
  {
    id: 'warm',
    name: 'Warm',
    desc: 'Cream slides, serif titles, a terracotta accent. Human, unhurried.',
    serif: true,
    bg: hex('#f7f0e4'),
    ink: hex('#2b231b'),
    muted: hex('#7d7064'),
    accent: hex('#c2603d'),
    titleBg: hex('#c2603d'),
    titleInk: hex('#fff7ee'),
    bar: 'under',
    numbered: false,
    bullet: '•'
  },
  {
    id: 'bold',
    name: 'Bold',
    desc: 'A vivid orange title slide, black headings, a top band. For a pitch.',
    serif: false,
    bg: hex('#ffffff'),
    ink: hex('#0e0e10'),
    muted: hex('#6b6b73'),
    accent: hex('#ff4f1f'),
    titleBg: hex('#ff4f1f'),
    titleInk: hex('#ffffff'),
    bar: 'top',
    numbered: true,
    bullet: '→'
  }
]

export const docTemplate = (id?: string | null): DocTemplate => DOC_TEMPLATES.find((t) => t.id === id) ?? DOC_TEMPLATES[0]
export const deckTemplate = (id?: string | null): DeckTemplate => DECK_TEMPLATES.find((t) => t.id === id) ?? DECK_TEMPLATES[0]

// ---------- inline runs ----------
interface Run {
  text: string
  bold: boolean
}

/** Split "**bold**" runs and strip other inline marks. */
function runs(md: string): Run[] {
  const clean = md
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1')
    .replace(/\[\[(?:[a-fA-F0-9-]{6,}@)?(\d{1,2}:\d{2}(?::\d{2})?)\]\]/g, '($1)')
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
  face: Face
  w: number
}

function words(rs: Run[], size: number, serif: boolean): Word[] {
  const out: Word[] = []
  for (const r of rs) {
    const face: Face = r.bold ? (serif ? 'serifBold' : 'sansBold') : serif ? 'serif' : 'sans'
    for (const t of r.text.split(/(\s+)/)) {
      if (!t) continue
      if (/^\s+$/.test(t)) out.push({ text: ' ', face, w: width(' ', size, face) })
      else out.push({ text: t, face, w: width(t, size, face) })
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

// ---------- the writer ----------
interface ParaOpts {
  bold?: boolean
  indent?: number
  bullet?: string
  color?: RGB
  bulletColor?: RGB
  lineHeight?: number
  serif?: boolean
  face?: Face
  /** keep the block on one page when it can fit on the next */
  keep?: number
}

class Pdf {
  private pages: string[] = []
  private cur: string[] = []
  y = 0
  /** drawn onto every page as it begins (bands, page background) */
  onPage: ((n: number) => void) | null = null
  /** drawn onto every page at build time (footers) */
  onFinish: ((n: number, total: number) => string) | null = null
  private started = false
  constructor(
    readonly pageW: number,
    readonly pageH: number,
    readonly margin: number,
    readonly top: number = margin
  ) {}
  get usableW(): number {
    return this.pageW - this.margin * 2
  }
  get pageCount(): number {
    return this.pages.length + (this.started ? 1 : 0)
  }
  /** a new page; the decoration hook runs before anything else is drawn */
  newPage(): void {
    if (this.started) this.pages.push(this.cur.join('\n'))
    this.cur = []
    this.started = true
    this.y = this.pageH - this.top
    this.onPage?.(this.pages.length)
  }
  ensure(h: number): void {
    if (!this.started) this.newPage()
    if (this.y - h < this.margin) this.newPage()
  }
  space(h: number): void {
    if (!this.started) this.newPage()
    this.y -= h
  }
  raw(op: string): void {
    if (!this.started) this.newPage()
    this.cur.push(op)
  }
  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    this.raw(`${rg(color)} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`)
  }
  hline(x1: number, x2: number, y: number, color: RGB, w = 0.6): void {
    this.raw(`${RG(color)} ${w} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`)
  }
  /** one string at a place, no wrapping */
  text(s: string, x: number, y: number, size: number, face: Face, color: RGB): void {
    this.raw(`BT ${rg(color)} ${FONT_ID[face]} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(s)} Tj ET`)
  }
  /** one wrapped line of words at x, on the cursor */
  line(ws: Word[], x: number, size: number, color: RGB, y = this.y): void {
    let cx = x
    const parts: string[] = [`BT ${rg(color)}`]
    let font = ''
    for (const w of ws) {
      const f = FONT_ID[w.face]
      if (f !== font) {
        parts.push(`${f} ${size} Tf`)
        font = f
      }
      parts.push(`1 0 0 1 ${cx.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(w.text)} Tj`)
      cx += w.w
    }
    parts.push('ET')
    this.raw(parts.join(' '))
  }
  /** the height a paragraph will take, to keep headings with their text */
  measure(md: string, size: number, opts: ParaOpts = {}): number {
    const lh = size * (opts.lineHeight ?? 1.45)
    const serif = opts.serif ?? false
    const rs = opts.bold ? [{ text: md.replace(/\*\*/g, ''), bold: true }] : runs(md)
    return wrap(words(rs, size, serif), this.usableW - (opts.indent ?? 0)).length * lh
  }
  paragraph(md: string, size: number, opts: ParaOpts = {}): void {
    const indent = opts.indent ?? 0
    const lh = size * (opts.lineHeight ?? 1.45)
    const serif = opts.serif ?? false
    const color = opts.color ?? [0, 0, 0]
    let ws: Word[]
    if (opts.face) {
      ws = md.split(/(\s+)/).filter(Boolean).map((t) => ({ text: /^\s+$/.test(t) ? ' ' : t, face: opts.face!, w: width(/^\s+$/.test(t) ? ' ' : t, size, opts.face!) }))
    } else {
      const rs = opts.bold ? [{ text: md.replace(/\*\*/g, ''), bold: true }] : runs(md)
      ws = words(rs, size, serif)
    }
    const lines = wrap(ws, this.usableW - indent)
    if (opts.keep) this.ensure(Math.min(lines.length * lh + opts.keep, this.pageH - this.margin - this.top))
    lines.forEach((ln, i) => {
      this.ensure(lh)
      this.y -= lh
      if (i === 0 && opts.bullet) {
        const bf: Face = serif ? 'serif' : 'sans'
        this.text(opts.bullet, this.margin + indent - width(opts.bullet, size, bf) - 6, this.y, size, bf, opts.bulletColor ?? color)
      }
      this.line(ln, this.margin + indent, size, color)
    })
  }
  build(): Uint8Array {
    if (this.started) this.pages.push(this.cur.join('\n'))
    const objs: string[] = []
    const add = (s: string): number => {
      objs.push(s)
      return objs.length
    }
    add('<< /Type /Catalog /Pages 2 0 R >>') // 1
    add('') // 2
    const fontIds: Record<string, number> = {}
    for (const face of ['sans', 'sansBold', 'serif', 'serifBold', 'mono'] as Face[]) {
      fontIds[FONT_ID[face]] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_DEF[face]} /Encoding /WinAnsiEncoding >>`)
    }
    const fontRes = Object.entries(fontIds)
      .map(([name, id]) => `${name} ${id} 0 R`)
      .join(' ')
    const pageIds: number[] = []
    const total = this.pages.length
    this.pages.forEach((content, i) => {
      const extra = this.onFinish ? this.onFinish(i, total) : ''
      const stream = content + '\n' + extra
      const bytes = toWinAnsi(stream).length
      const cId = add(`<< /Length ${bytes} >>\nstream\n${stream}\nendstream`)
      const pId = add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] /Resources << /Font << ${fontRes} >> >> /Contents ${cId} 0 R >>`
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

/** a footer line for a page: running title left, page number right */
function footerOps(p: Pdf, t: { muted: RGB; serif: boolean }, title: string, n: number, total: number, from: number): string {
  if (n < from) return ''
  const face: Face = t.serif ? 'serif' : 'sans'
  const y = (p.margin * 0.55).toFixed(2)
  const num = `${n - from + 1} / ${total - from}`
  return (
    `BT ${rg(t.muted)} ${FONT_ID[face]} 8.5 Tf 1 0 0 1 ${p.margin} ${y} Tm ${pdfString(title)} Tj ET ` +
    `BT ${rg(t.muted)} ${FONT_ID[face]} 8.5 Tf 1 0 0 1 ${(p.pageW - p.margin - width(num, 8.5, face)).toFixed(2)} ${y} Tm ${pdfString(num)} Tj ET`
  )
}

// ---------- documents ----------
export interface DocMeta {
  /** a line under the title on the cover: a date, an author, a subtitle */
  subtitle?: string
  /** a small line at the foot of the cover */
  byline?: string
}

/** A document PDF from Markdown, A4, in one of the five styles, with a cover. */
export function markdownToPdf(title: string, md: string, templateId?: string | null, meta: DocMeta = {}): Uint8Array {
  const t = docTemplate(templateId)
  const W = 595.28
  const H = 841.89
  const margin = t.id === 'editorial' ? 68 : 56
  const p = new Pdf(W, H, margin, t.band ? 84 : margin)
  const serif = t.serif
  const heavy: Face = serif ? 'serifBold' : 'sansBold'
  const light: Face = serif ? 'serif' : 'sans'

  // every page: the paper and the running band
  p.onPage = (n) => {
    if (t.page) p.rect(0, 0, W, H, t.page)
    if (n === 0) return
    if (t.band) {
      p.rect(0, H - 40, W, 40, t.accent)
      p.text(title.length > 70 ? title.slice(0, 67) + '…' : title, margin, H - 25, 9, 'sansBold', [1, 1, 1])
    } else if (t.id === 'signal') {
      p.rect(margin, H - 30, 26, 4, t.accent)
    } else if (t.id === 'studio') {
      p.rect(0, H - 6, W, 6, t.accent)
    }
  }
  p.onFinish = (n, total) => footerOps(p, t, title, n, total, 1)

  // ---- the cover ----
  p.newPage()
  const cover = (): void => {
    const titleSize = title.length > 48 ? 30 : 38
    const titleLines = wrap(words([{ text: title, bold: true }], titleSize, serif), t.cover === 'block' ? W * 0.52 : p.usableW)
    const drawTitle = (x: number, yTop: number, color: RGB, maxW?: number): number => {
      let y = yTop
      const ls = maxW ? wrap(words([{ text: title, bold: true }], titleSize, serif), maxW) : titleLines
      for (const ln of ls) {
        y -= titleSize * 1.12
        p.line(ln, x, titleSize, color, y)
      }
      return y
    }
    const sub = meta.subtitle ?? ''
    switch (t.cover) {
      case 'editorial': {
        p.hline(margin, W - margin, H - 150, t.ink, 1.2)
        let y = drawTitle(margin, H - 170, t.ink)
        if (sub) {
          y -= 30
          p.text(sub, margin, y, 12.5, 'serif', t.muted)
        }
        p.hline(margin, W - margin, y - 26, t.rule, 0.6)
        if (meta.byline) p.text(meta.byline, margin, margin + 8, 9.5, 'serif', t.muted)
        break
      }
      case 'block': {
        p.rect(0, 0, W * 0.36, H, t.accent)
        let y = drawTitle(W * 0.36 + 34, H * 0.62, t.ink, W * 0.64 - 34 - margin)
        if (sub) {
          y -= 28
          p.text(sub, W * 0.36 + 34, y, 12.5, 'sans', t.muted)
        }
        if (meta.byline) p.text(meta.byline, W * 0.36 + 34, margin + 8, 9.5, 'sans', t.muted)
        break
      }
      case 'band': {
        p.rect(0, H * 0.42, W, H * 0.58, t.accent)
        let y = drawTitle(margin, H * 0.42 + H * 0.58 * 0.62, [1, 1, 1])
        if (sub) {
          y -= 28
          p.text(sub, margin, y, 12.5, 'sans', [0.86, 0.9, 0.96])
        }
        p.rect(margin, H * 0.42 - 22, 46, 5, t.accent)
        if (meta.byline) p.text(meta.byline, margin, margin + 8, 9.5, 'sans', t.muted)
        break
      }
      case 'paper': {
        p.rect(margin, H - 140, 54, 3, t.accent)
        let y = drawTitle(margin, H - 160, t.ink)
        if (sub) {
          y -= 30
          p.text(sub, margin, y, 12.5, 'serif', t.accent)
        }
        if (meta.byline) p.text(meta.byline, margin, margin + 8, 9.5, 'serif', t.muted)
        break
      }
      case 'dark': {
        p.rect(0, 0, W, H, t.ink)
        p.rect(margin, H - 120, 14, 14, t.accent)
        let y = drawTitle(margin, H - 150, [1, 1, 1])
        if (sub) {
          y -= 30
          p.text(sub, margin, y, 12.5, 'sans', [0.68, 0.68, 0.72])
        }
        if (meta.byline) p.text(meta.byline, margin, margin + 8, 9.5, 'sans', [0.55, 0.55, 0.6])
        break
      }
    }
  }
  cover()
  p.newPage()

  // ---- the body ----
  const body = serif ? 11 : 10.5
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = []
  let numbered = 0
  let inCode = false
  let codeLines: string[] = []
  let table: string[][] = []
  let section = 0

  const flushPara = (): void => {
    if (para.length) {
      p.paragraph(para.join(' '), body, { color: t.ink, serif, lineHeight: 1.5 })
      p.space(6)
    }
    para = []
  }
  const flushCode = (): void => {
    if (codeLines.length === 0) return
    const lh = 9 * 1.4
    const h = codeLines.length * lh + 16
    p.ensure(Math.min(h, 400))
    const boxTop = p.y
    const drawn = Math.min(codeLines.length, Math.floor((p.y - p.margin - 16) / lh))
    p.rect(p.margin, boxTop - drawn * lh - 16, p.usableW, drawn * lh + 16, t.page ? [0.94, 0.92, 0.87] : [0.955, 0.955, 0.96])
    p.y -= 8
    for (const ln of codeLines.slice(0, drawn)) {
      p.y -= lh
      p.text(ln.length > 96 ? ln.slice(0, 95) + '…' : ln, p.margin + 10, p.y, 9, 'mono', t.ink)
    }
    p.y -= 8
    const rest = codeLines.slice(drawn)
    codeLines = []
    if (rest.length) {
      p.newPage()
      codeLines = rest
      flushCode()
    }
    p.space(8)
  }
  const flushTable = (): void => {
    if (table.length === 0) return
    const cols = Math.max(...table.map((r) => r.length))
    const colW = p.usableW / cols
    table.forEach((row, ri) => {
      p.ensure(20)
      if (ri === 0) p.rect(p.margin, p.y - 18, p.usableW, 18, t.tableHead)
      p.y -= 13
      row.forEach((cell, ci) => {
        const face: Face = ri === 0 ? heavy : light
        const ws = cell
          .replace(/\*\*/g, '')
          .split(/(\s+)/)
          .filter(Boolean)
          .map((w) => ({ text: /^\s+$/.test(w) ? ' ' : w, face, w: width(/^\s+$/.test(w) ? ' ' : w, 9.5, face) }))
        const first = wrap(ws, colW - 10)[0] ?? []
        p.line(first, p.margin + 5 + ci * colW, 9.5, ri === 0 ? t.accent : t.ink)
      })
      p.y -= 5
      p.hline(p.margin, W - p.margin, p.y, t.rule, 0.5)
    })
    p.space(10)
    table = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/^```/.test(line)) {
      flushPara()
      if (inCode) flushCode()
      inCode = !inCode
      continue
    }
    if (inCode) {
      codeLines.push(line)
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
      const textRaw = h[2].replace(/\*\*/g, '')
      if (level === 1) {
        p.space(6)
        p.paragraph(textRaw, 22, { bold: true, serif, color: t.ink, lineHeight: 1.2, keep: 40 })
        p.space(8)
      } else if (level === 2) {
        section++
        p.space(14)
        const label = t.caps ? textRaw.toUpperCase() : textRaw
        if (t.numbered) {
          // the number sits on the heading's own baseline
          const size = t.caps ? 11.5 : 16
          const lh = size * (t.id === 'signal' ? 1.5 : 1.7)
          p.ensure(lh + 30)
          const before = p.y
          const indent = t.id === 'signal' ? 40 : 26
          p.paragraph(label, size, { bold: true, serif, color: t.id === 'signal' ? t.ink : t.accent, indent, lineHeight: t.id === 'signal' ? 1.5 : 1.7 })
          p.text(String(section).padStart(2, '0'), p.margin, before - lh, t.id === 'signal' ? 22 : 12, heavy, t.accent)
        } else {
          p.paragraph(label, t.caps ? 11 : 15.5, { bold: true, serif, color: t.caps ? t.muted : t.accent, lineHeight: 1.3, keep: 30 })
          if (t.caps) {
            p.y -= 4
            p.hline(p.margin, p.margin + 28, p.y, t.accent, 1.2)
          }
        }
        p.space(6)
      } else {
        p.space(8)
        p.paragraph(textRaw, 12, { bold: true, serif, color: t.ink, lineHeight: 1.3, keep: 24 })
        p.space(3)
      }
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
      p.paragraph(ul[1], body, { indent: 18, bullet: t.bullet, bulletColor: t.accent, color: t.ink, serif, lineHeight: 1.5 })
      p.space(2)
      continue
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.+)$/)
    if (ol) {
      flushPara()
      flushTable()
      numbered = numbered + 1
      p.paragraph(ol[2], body, { indent: 22, bullet: `${numbered}.`, bulletColor: t.accent, color: t.ink, serif, lineHeight: 1.5 })
      p.space(2)
      continue
    }
    const quote = line.match(/^\s*>\s?(.+)$/)
    if (quote) {
      flushPara()
      flushTable()
      p.space(4)
      const top = p.y - body * 0.45
      p.paragraph(quote[1], body, { indent: 16, color: t.muted, serif, lineHeight: 1.5 })
      p.rect(p.margin, p.y - 3, 2.5, top - p.y + 3, t.accent)
      p.space(4)
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara()
      p.ensure(12)
      p.y -= 6
      p.hline(p.margin, W - p.margin, p.y, t.rule, 0.6)
      p.y -= 6
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  if (inCode) flushCode()
  flushTable()
  return p.build()
}

// ---------- decks ----------
export interface PdfSlide {
  title: string
  bullets: string[]
  notes?: string
}

/** A slide deck PDF: one landscape page per slide, in one of the five styles, notes at the foot. */
export function deckToPdf(title: string, subtitle: string | undefined, slides: PdfSlide[], templateId?: string | null): Uint8Array {
  const t = deckTemplate(templateId)
  const W = 841.89
  const H = 595.28
  const margin = 60
  const p = new Pdf(W, H, margin)
  const serif = t.serif
  const heavy: Face = serif ? 'serifBold' : 'sansBold'
  const light: Face = serif ? 'serif' : 'sans'
  p.onPage = (n) => {
    p.rect(0, 0, W, H, n === 0 ? t.titleBg : t.bg)
    if (n === 0) return
    if (t.bar === 'left') p.rect(0, 0, 10, H, t.accent)
    if (t.bar === 'top') p.rect(0, H - 12, W, 12, t.accent)
  }
  p.onFinish = (n, total) => {
    if (n === 0 || !t.numbered) return ''
    const num = `${n} / ${total - 1}`
    return `BT ${rg(t.muted)} ${FONT_ID[light]} 9 Tf 1 0 0 1 ${(W - margin - width(num, 9, light)).toFixed(2)} ${(margin * 0.5).toFixed(2)} Tm ${pdfString(num)} Tj ET`
  }
  slides.forEach((s, i) => {
    p.newPage()
    if (i === 0) {
      // the title slide
      const size = s.title.length > 40 ? 40 : 52
      const ls = wrap(words([{ text: s.title, bold: true }], size, serif), W - margin * 2)
      let y = H * 0.56 + (ls.length * size * 1.1) / 2
      for (const ln of ls) {
        y -= size * 1.1
        p.line(ln, margin, size, t.titleInk, y)
      }
      const sub = subtitle ?? s.bullets[0]
      if (sub) p.text(sub, margin, y - 34, 16, light, t.id === 'ocean' || t.id === 'bold' || t.id === 'mono' || t.id === 'warm' ? [1, 1, 1] : t.muted)
      if (t.bar !== 'none') p.rect(margin, y - 60, 60, 4, t.id === 'mono' ? t.titleInk : t.id === 'midnight' ? t.accent : [1, 1, 1])
      return
    }
    // a content slide
    const titleSize = s.title.length > 50 ? 24 : 30
    p.space(30)
    p.paragraph(s.title, titleSize, { bold: true, serif, color: t.id === 'ocean' ? t.accent : t.ink, lineHeight: 1.15 })
    if (t.bar === 'under') {
      p.y -= 10
      p.rect(margin, p.y, 48, 3, t.accent)
      p.y -= 8
    }
    p.space(18)
    for (const b of s.bullets) {
      p.paragraph(b, 17, { indent: 26, bullet: t.bullet, bulletColor: t.accent, color: t.ink, serif, lineHeight: 1.5 })
      p.space(4)
    }
    if (s.notes) {
      const noteH = p.measure(s.notes, 10, { serif, lineHeight: 1.4 }) + 30
      const yNotes = Math.min(p.y - 26, margin + noteH)
      p.y = yNotes
      p.hline(margin, W - margin, p.y, t.muted, 0.5)
      p.y -= 14
      p.text('NOTES', margin, p.y, 8, heavy, t.muted)
      p.y -= 4
      p.paragraph(s.notes, 10, { color: t.muted, serif, lineHeight: 1.4 })
    }
  })
  return p.build()
}
