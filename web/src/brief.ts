// The brief: the document a person sends their boss, lecturer or team
// after a session. Written by Sitca from what was said (never the raw
// transcript), then laid out as a clean modern page whose styling Google
// Docs and Word both keep when they open it.

export interface BriefMeta {
  title: string
  when: string
  minutes: number
  kind: string
  speakers: string[]
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** What Sitca is asked for: a shape every brief follows. */
export function briefPrompt(kind: string): string {
  const meeting = kind === 'meeting'
  const lecture = kind === 'lecture'
  return [
    'You write the document a person shares after a session: a clean brief for a boss, a lecturer, a team or a friend who was not there. It must read as if a careful professional wrote it: specific, plain, nothing padded, nothing vague.',
    'You are given the session\'s summary, its notes and an excerpt of what was said. Write from these only; never invent a figure, a name or a claim. Where the material is thin, the brief is short.',
    'Return ONLY markdown in exactly this shape, and nothing else:',
    '# <a specific title, at most 9 words>',
    '> <one sentence saying what this session was and who spoke, if known>',
    '## Overview',
    '<one paragraph, three to five sentences: what it was about and what it concluded>',
    '## Key takeaways',
    '<five to eight bullets; each a full, specific sentence carrying a fact, a figure, a name or a decision — never a topic label>',
    '## <three to six themed sections, each with a short heading of two to five words>',
    '<under each: a short paragraph and/or bullets with the substance; where numbers, dates, comparisons or lists of items appear, a markdown table with a header row (for example | Figure | Value | Context |)>',
    meeting ? '## Decisions and actions\n<a table: | What | Who | By when | — one row per decision or task; "—" where unknown>' : '',
    '## Open questions',
    '<bullets: what was asked and not settled, or what a reader should follow up; omit the section if there are none>',
    lecture ? '## Terms to know\n<a table: | Term | Meaning | — the concepts a student must be able to define>' : '',
    'Rules: no timestamps, no [[citations]], no mention of a transcript, a recording, a video player, on-screen text, adverts, a sidebar, subscribing or the word "speaker N" unless a name is truly unknown (then say "the speaker"). Plain English, short sentences, British spelling. No closing remarks, no "in conclusion", no offers.'
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

const P = 'font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.55;color:#202124;margin:0 0 8pt'
const H2 = 'font-family:Arial,Helvetica,sans-serif;font-size:14pt;font-weight:700;color:#111;margin:20pt 0 6pt;padding-bottom:3pt;border-bottom:1px solid #d9d9d9'
const H3 = 'font-family:Arial,Helvetica,sans-serif;font-size:12pt;font-weight:700;color:#111;margin:14pt 0 4pt'
const LI = 'font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.5;color:#202124;margin:0 0 4pt'
const TH = 'font-family:Arial,Helvetica,sans-serif;font-size:10pt;font-weight:700;color:#111;background:#f1f3f4;border:1px solid #d9d9d9;padding:6pt 8pt;text-align:left'
const TD = 'font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#202124;border:1px solid #d9d9d9;padding:6pt 8pt;vertical-align:top'

function inline(t: string): string {
  return esc(t)
    .replace(/\[\[(\d+:\d{2}(?::\d{2})?)\]\]/g, '')
    .replace(/\s\((?:\d+:\d{2}(?::\d{2})?)(?:\s*[-‑–]\s*(?:\d+:\d{2}(?::\d{2})?|onward))?\)/g, '')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<span style="font-family:Consolas,monospace;font-size:10pt">$1</span>')
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)
const isSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

/** The brief's markdown as the body of the page. */
export function briefBody(md: string): { title: string; subtitle: string; html: string } {
  const lines = md.replace(/\r/g, '').split('\n')
  let title = ''
  let subtitle = ''
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const close = (): void => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) {
      close()
      continue
    }
    const h1 = line.match(/^#\s+(.+)$/)
    if (h1 && !title) {
      title = h1[1].trim()
      continue
    }
    const quote = line.match(/^>\s*(.+)$/)
    if (quote && !subtitle && out.length === 0) {
      subtitle = quote[1].trim()
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
      out.push('<table style="border-collapse:collapse;width:100%;margin:6pt 0 10pt">')
      out.push('<tr>' + head.map((h) => `<th style="${TH}">${inline(h)}</th>`).join('') + '</tr>')
      for (const row of rows) out.push('<tr>' + head.map((_, c) => `<td style="${TD}">${inline(row[c] ?? '')}</td>`).join('') + '</tr>')
      out.push('</table>')
      i = r - 1
      continue
    }
    const h = line.match(/^(#{2,4})\s+(.+)$/)
    if (h) {
      close()
      out.push(`<p style="${h[1].length === 2 ? H2 : H3}">${inline(h[2])}</p>`)
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
  return { title, subtitle, html: out.join('\n') }
}

/** The whole page: title block, facts, the body, a quiet footer. */
export function briefHtml(md: string, meta: BriefMeta): { title: string; html: string } {
  const b = briefBody(md)
  const title = b.title || meta.title
  const facts: [string, string][] = [
    ['Date', meta.when],
    ['Length', `${meta.minutes} min`],
    ['Type', meta.kind ? meta.kind[0].toUpperCase() + meta.kind.slice(1) : 'Session'],
    ...(meta.speakers.length ? [['Speakers', meta.speakers.join(', ')] as [string, string]] : [])
  ]
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:36pt 48pt;background:#fff">
<p style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;font-weight:700;letter-spacing:1.5pt;color:#8a8a8a;margin:0 0 6pt">SESSION BRIEF</p>
<p style="font-family:Arial,Helvetica,sans-serif;font-size:24pt;font-weight:700;line-height:1.15;color:#111;margin:0 0 6pt">${esc(title)}</p>
${b.subtitle ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;font-style:italic;color:#5f6368;margin:0 0 14pt">${inline(b.subtitle)}</p>` : ''}
<table style="border-collapse:collapse;margin:0 0 18pt">
<tr>${facts.map(([k, v]) => `<td style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#8a8a8a;padding:0 22pt 2pt 0;border:0">${esc(k.toUpperCase())}</td>`).join('')}</tr>
<tr>${facts.map(([, v]) => `<td style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;font-weight:700;color:#202124;padding:0 22pt 0 0;border:0">${esc(v)}</td>`).join('')}</tr>
</table>
${b.html}
<p style="font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#9a9a9a;margin:28pt 0 0;padding-top:8pt;border-top:1px solid #e3e3e3">Prepared with Sitca — the AI that attends with you · sitcaai.vercel.app</p>
</body></html>`
  return { title, html }
}
