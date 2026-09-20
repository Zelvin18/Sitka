// The brief: the document a person sends their boss, lecturer or team
// after a session. Written by Sitca from what was said (never the raw
// transcript), then laid out as a designed page — numbered sections, a row
// of figures at a glance, call-out boxes, tables with a dark header and
// striped rows — whose styling Google Docs and Word both keep.

export interface BriefMeta {
  title: string
  when: string
  minutes: number
  kind: string
  speakers: string[]
  /** the video or call it was recorded from, when known */
  source?: { title: string; url: string }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** What Sitca is asked for: a shape every brief follows, which the page knows how to draw. */
export function briefPrompt(kind: string): string {
  const meeting = kind === 'meeting'
  const lecture = kind === 'lecture'
  return [
    'You write the document a person shares after a session: a designed brief for a boss, a lecturer, a team or a friend who was not there. It must read as if a careful professional wrote it: specific, plain, nothing padded, nothing vague.',
    'You are given the session\'s summary, its notes and an excerpt of what was said. Write from these only; never invent a figure, a name or a claim. Where the material is thin, the brief is short.',
    'Return ONLY markdown in exactly this shape, and nothing else. The lines that start with ">" right after a heading are the heading\'s one-line subline; lines that start with "!!" are call-out boxes; the "Stats:" line becomes three figure tiles.',
    '# <a specific title, at most 9 words>',
    '> <one sentence saying what this was — a lecture, a talk, a video, a meeting — naming the speaker or the source when given; if neither is known, describe the subject instead; never write "the presenter" or "delivered by the speaker">',
    'Stats: <figure> — <what it is> | <figure> — <what it is> | <figure> — <what it is>',
    '<the three figures that matter most, taken from the session: a sum of money, a count, a percentage, a length of time; each figure short (like "$500", "77%", "4"), each label at most five words; leave the whole line out if the session has no figures>',
    '## At a glance',
    '> What the session covered',
    '<one paragraph, three to five sentences: what it was about and what it concluded>',
    '## Key takeaways',
    '> The numbers and ideas worth remembering',
    '<five to eight bullets; each a full, specific sentence carrying a fact, a figure, a name or a decision — never a topic label>',
    '!! Bottom line: <two sentences: what the speaker concluded or recommended, and the single most useful thing a reader could act on — the speaker\'s conclusion, not yours>',
    '## <three to six themed sections, each with a short heading of two to five words>',
    '> <a subline of four to nine words saying what this section gives the reader>',
    '<under each: three to five bullets or a short paragraph with the substance; where numbers, dates, steps, comparisons or lists of items appear, a markdown table with a header row (for example | Step | Action | Cost |); optionally one "!! <Two-word label>: <one sentence>" call-out at the end of the section for the idea in one line>',
    meeting ? '## Decisions and actions\n> Who does what, by when\n<a table: | What | Who | By when | — one row per decision or task; "—" where unknown>' : '',
    lecture ? '## Terms to know\n> The concepts to be able to define\n<a table: | Term | Meaning |>' : '',
    '## Session close',
    '> What it leaves you with',
    '!! Recommended path from the session: <two or three sentences: the order of steps the speaker suggested, or the conclusion, in their terms>',
    '## Open questions',
    '<bullets: only questions actually raised in the session and left unanswered, or points the speaker said were uncertain — never questions of your own; if there were none, the single line "None raised in the session.">',
    'Rules: no timestamps, no [[citations]], no mention of a transcript, a recording, a video player, on-screen text, adverts, a sidebar, subscribing, or "speaker N" unless a name is truly unknown (then "the speaker"). Plain English, short sentences, British spelling. Ordinary hyphens and spaces in numbers ($5,000 not $5 000; 77% not 77 %). No closing remarks, no offers.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** Lines of the transcript worth giving the writer: speech, not what was on screen. */
export function speechOnly(lines: { text: string; speaker?: string }[], maxChars = 14000): string {
  const out: string[] = []
  let n = 0
  for (const l of lines) {
    if (/^\[On screen\]/i.test(l.text)) continue
    const t = (l.speaker ? `${l.speaker}: ` : '') + l.text.trim()
    if (!t) continue
    if (n + t.length > maxChars) break
    out.push(t)
    n += t.length + 1
  }
  return out.join('\n')
}

// ---------- the page ----------
// Colours and type as the design: navy for the title and table heads, teal
// for the small labels, slate for the body, pale fills for tiles and
// call-outs. Everything is inline so a Doc or a Word file keeps it.

const FONT = "font-family:Aptos,'Segoe UI',Arial,Helvetica,sans-serif"
const NAVY = '#102A43'
const TEAL = '#1F7A8C'
const MUTED = '#627D98'
const BODY = '#334E68'
const P = `${FONT};font-size:10.5pt;line-height:1.55;color:${BODY};margin:0 0 8pt`
const LI = `${FONT};font-size:10.5pt;line-height:1.5;color:${BODY};margin:0 0 5pt`
const SEC = `${FONT};font-size:11pt;font-weight:700;letter-spacing:0.4pt;color:${TEAL};margin:22pt 0 2pt`
const SUB = `${FONT};font-size:9.5pt;color:${MUTED};margin:0 0 8pt`
const H3 = `${FONT};font-size:11pt;font-weight:700;color:${NAVY};margin:12pt 0 4pt`
const TH = `${FONT};font-size:9.5pt;font-weight:700;color:#ffffff;background:${NAVY};border:1px solid ${NAVY};padding:6pt 8pt;text-align:left`
const TD = (odd: boolean): string => `${FONT};font-size:10pt;color:${BODY};background:${odd ? '#F8FAFC' : '#FFFFFF'};border:1px solid #E1E7EF;padding:6pt 8pt;vertical-align:top`
const CALL = `${FONT};font-size:10pt;line-height:1.5;color:${BODY};background:#EEF7F8;border:1px solid #D4E9EC;padding:9pt 12pt`
const CALL_LABEL = `${FONT};font-size:8.5pt;font-weight:700;letter-spacing:1pt;color:${TEAL}`

function inline(t: string): string {
  return esc(t)
    .replace(/\[\[(\d+:\d{2}(?::\d{2})?)\]\]/g, '')
    .replace(/\s\((?:\d+:\d{2}(?::\d{2})?)(?:\s*[-‑–]\s*(?:\d+:\d{2}(?::\d{2})?|onward))?\)/g, '')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<span style="font-family:Consolas,monospace;font-size:9.5pt">$1</span>')
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)
const isSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

function callout(label: string, text: string): string {
  return `<table style="border-collapse:collapse;width:100%;margin:8pt 0 12pt"><tr><td style="${CALL}"><span style="${CALL_LABEL}">${esc(label.toUpperCase())}</span><br>${inline(text)}</td></tr></table>`
}

function statTiles(spec: string): string {
  const tiles = spec
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.+?)\s+[—–-]\s+(.+)$/)
      return m ? { value: m[1].trim(), label: m[2].trim() } : { value: s, label: '' }
    })
    .slice(0, 3)
  if (tiles.length === 0) return ''
  const cell = (t: { value: string; label: string }, i: number): string =>
    `<td style="${FONT};width:${Math.floor(100 / tiles.length)}%;background:#F5F8FA;border:1px solid #E1E7EF;padding:10pt 12pt;vertical-align:top${i ? ';border-left:none' : ''}"><span style="font-size:18pt;font-weight:700;color:${NAVY}">${esc(t.value)}</span><br><span style="font-size:9pt;color:${MUTED}">${esc(t.label)}</span></td>`
  return `<table style="border-collapse:collapse;width:100%;margin:0 0 14pt"><tr>${tiles.map(cell).join('')}</tr></table>`
}

/** The brief's markdown as the body of the page. */
export function briefBody(md: string): { title: string; subtitle: string; stats: string; html: string } {
  const lines = md.replace(/\r/g, '').split('\n')
  let title = ''
  let subtitle = ''
  let stats = ''
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let section = 0
  let lastWasHeading = false
  const close = (): void => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) {
      close()
      continue
    }
    const h1 = line.match(/^#\s+(.+)$/)
    if (h1 && !title) {
      title = h1[1].trim()
      continue
    }
    const st = line.match(/^Stats:\s*(.+)$/i)
    if (st && !stats) {
      stats = statTiles(st[1])
      continue
    }
    const quote = line.match(/^>\s*(.+)$/)
    if (quote) {
      if (!subtitle && out.length === 0) subtitle = quote[1].trim()
      else if (lastWasHeading) out.push(`<p style="${SUB}">${inline(quote[1])}</p>`)
      else out.push(`<p style="${P};font-style:italic;color:${MUTED}">${inline(quote[1])}</p>`)
      lastWasHeading = false
      continue
    }
    lastWasHeading = false
    const call = line.match(/^!!\s*([^:]{2,40}):\s*(.+)$/)
    if (call) {
      close()
      out.push(callout(call[1], call[2]))
      continue
    }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      close()
      const head = cells(line)
      const rows: string[][] = []
      let r = i + 2
      while (r < lines.length && isRow(lines[r])) {
        rows.push(cells(lines[r]))
        r++
      }
      out.push('<table style="border-collapse:collapse;width:100%;margin:6pt 0 12pt">')
      out.push('<tr>' + head.map((h) => `<th style="${TH}">${inline(h)}</th>`).join('') + '</tr>')
      rows.forEach((row, ri) => out.push('<tr>' + head.map((_, c) => `<td style="${TD(ri % 2 === 0)}">${inline(row[c] ?? '')}</td>`).join('') + '</tr>'))
      out.push('</table>')
      i = r - 1
      continue
    }
    const h = line.match(/^(#{2,4})\s+(.+)$/)
    if (h) {
      close()
      if (h[1].length === 2) {
        section++
        out.push(`<p style="${SEC}">${String(section).padStart(2, '0')}&nbsp;&nbsp;${inline(h[2])}</p>`)
        lastWasHeading = true
      } else out.push(`<p style="${H3}">${inline(h[2])}</p>`)
      continue
    }
    const ul = line.match(/^[-*•]\s+(.+)$/)
    const ol = line.match(/^\d+[.)]\s+(.+)$/)
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        close()
        list = kind
        out.push(`<${kind} style="margin:0 0 8pt 18pt;padding:0">`)
      }
      out.push(`<li style="${LI}">${inline((ul || ol)![1])}</li>`)
      continue
    }
    if (/^[-*_]{3,}$/.test(line)) {
      close()
      continue
    }
    close()
    out.push(`<p style="${P}">${inline(line)}</p>`)
  }
  close()
  return { title, subtitle, stats, html: out.join('\n') }
}

/** The whole page: label, title, subline, figures, facts, the body, a footer band. */
export function briefHtml(md: string, meta: BriefMeta): { title: string; html: string } {
  const b = briefBody(md)
  const title = b.title || meta.title
  const facts: [string, string][] = [
    ['Date', meta.when],
    ['Length', `${meta.minutes} min`],
    ['Type', meta.kind ? meta.kind[0].toUpperCase() + meta.kind.slice(1) : 'Session'],
    ...(meta.speakers.length ? [['Speakers', meta.speakers.join(', ')] as [string, string]] : []),
    ...(meta.source?.title ? [['Source', meta.source.title] as [string, string]] : [])
  ]
  const factCell = ([k, v]: [string, string]): string =>
    `<td style="${FONT};padding:0 20pt 0 0;border:0;vertical-align:top"><span style="font-size:8.5pt;font-weight:700;letter-spacing:1pt;color:${MUTED}">${esc(k.toUpperCase())}</span><br><span style="font-size:10.5pt;font-weight:700;color:${NAVY}">${
      k === 'Source' && meta.source?.url ? `<a href="${esc(meta.source.url)}" style="color:${NAVY};text-decoration:none">${esc(v)}</a>` : esc(v)
    }</span></td>`
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:40pt 52pt;background:#ffffff">
<p style="${FONT};font-size:9pt;font-weight:700;letter-spacing:2pt;color:${TEAL};margin:0 0 8pt">SESSION BRIEF</p>
<p style="${FONT};font-size:27pt;font-weight:700;line-height:1.12;color:${NAVY};margin:0 0 8pt">${esc(title)}</p>
${b.subtitle ? `<p style="${FONT};font-size:11pt;line-height:1.5;color:${MUTED};margin:0 0 16pt">${inline(b.subtitle)}</p>` : ''}
${b.stats}
<table style="border-collapse:collapse;margin:0 0 6pt"><tr>${facts.map(factCell).join('')}</tr></table>
<table style="border-collapse:collapse;width:100%;margin:8pt 0 4pt"><tr><td style="border:0;border-top:2px solid ${NAVY};padding:0;height:1pt"></td></tr></table>
${b.html}
<table style="border-collapse:collapse;width:100%;margin:26pt 0 0"><tr><td style="${FONT};background:${NAVY};color:#ffffff;padding:10pt 14pt;border:0"><span style="font-size:10pt;font-weight:700">Prepared with Sitca</span><br><span style="font-size:9pt;color:#C9D6E3">The AI that attends with you · sitcaai.vercel.app</span></td></tr></table>
</body></html>`
  return { title, html }
}
