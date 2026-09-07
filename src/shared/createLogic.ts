import type { Creation, CreateRequest, CreationKind, PresentationDeck, TranscriptSegment } from './types'

/** Pure prompt builders and parsers for Create — shared by desktop and web. */

export interface SessionContext {
  title: string
  segments: TranscriptSegment[]
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** Session material, trimmed so several sessions still fit a single request. */
export function contextBlock(contexts: SessionContext[], maxChars = 60000): string {
  if (contexts.length === 0) return ''
  const per = Math.floor(maxChars / contexts.length)
  return contexts
    .map((c) => {
      const lines = c.segments.map((s) => `[${fmt(s.start)}] ${s.text.trim()}`)
      let text = lines.join('\n')
      if (text.length > per) text = text.slice(0, per) + '\n… (trimmed)'
      return `=== Session: "${c.title}" ===\n${text}`
    })
    .join('\n\n')
}

const VOICE = [
  'You are Sitka, a sharp, warm assistant who makes finished work, not drafts.',
  'Write like an excellent human professional: specific, concrete, no filler, no throat-clearing, no closing offers.',
  'Never invent facts, figures, names or quotes. If session material is provided, ground the work in it; if something is not known, leave it out or mark it as to be confirmed.',
  'Use plain text for any math (no LaTeX). Never mention that you are an AI.'
].join('\n')

export function createSystemPrompt(kind: CreationKind): string {
  if (kind === 'document') {
    return [
      VOICE,
      '',
      'TASK: write a complete, polished document in Markdown.',
      '- Start with a single "# " title line, then "## " sections. Short paragraphs; "-" bullets and numbered steps where they genuinely help; a Markdown table when comparing things.',
      '- Match length and tone to the request: a memo is a page, a report can be several, an email is short.',
      '- If sessions were provided and you reference a specific moment, cite it inline as [[M:SS]] using a timestamp from that session.',
      '- Output ONLY the document Markdown. No preamble, no explanation, no code fences around the whole document.'
    ].join('\n')
  }
  if (kind === 'presentation') {
    return [
      VOICE,
      '',
      'TASK: design a presentation.',
      'Return ONLY a JSON object, no prose and no code fences, with this exact shape:',
      '{"title": string, "subtitle": string, "slides": [{"title": string, "bullets": string[], "notes": string}]}',
      '- 6 to 14 slides. The first slide is the title slide (its bullets may be empty). End with a summary or next-steps slide.',
      '- Each slide: a crisp title (max 8 words) and 2-5 bullets of at most 12 words each. Bullets are statements, not fragments of the title.',
      '- "notes" is what the presenter says for that slide: 2-4 sentences, natural spoken language.',
      '- One idea per slide. No slide should repeat another.'
    ].join('\n')
  }
  return [
    VOICE,
    '',
    'TASK: write complete, working code.',
    '- Begin with a two or three sentence explanation of what the code does and how to run it.',
    '- Then one fenced code block per file, each with the language tag, and the file path as the first line in a comment (for example "// src/app.ts" or "# main.py").',
    '- Prefer a small number of complete files over fragments. Include any commands needed to install or run.',
    '- Follow the conventions of the language. No placeholders like "your code here".'
  ].join('\n')
}

export function createUserPrompt(req: CreateRequest, contexts: SessionContext[]): string {
  const parts: string[] = []
  const material = contextBlock(contexts)
  if (material) parts.push('Session material to ground the work in:\n\n' + material + '\n')
  if (req.previous) {
    parts.push('Here is the current version:\n\n' + req.previous.content + '\n')
    parts.push('Revise it according to this instruction, keeping everything that still applies:\n' + req.previous.instruction)
    parts.push('Return the complete revised version in the same format as before.')
  } else {
    parts.push('Request:\n' + req.prompt.trim())
  }
  return parts.join('\n')
}

// ---------- parsing ----------

function stripOuterFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return m ? m[1] : t
}

export function parseDeck(raw: string): PresentationDeck | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const deck = JSON.parse(m[0]) as PresentationDeck
    if (!deck || !Array.isArray(deck.slides) || deck.slides.length === 0) return null
    deck.slides = deck.slides.map((s) => ({
      title: String(s.title ?? '').trim(),
      bullets: Array.isArray(s.bullets) ? s.bullets.map((b) => String(b)) : [],
      notes: s.notes ? String(s.notes) : undefined
    }))
    deck.title = String(deck.title ?? 'Untitled').trim()
    return deck
  } catch {
    return null
  }
}

export function titleFromMarkdown(md: string, fallback: string): string {
  const h = md.match(/^#\s+(.+)$/m)
  return (h ? h[1] : fallback).replace(/[*_`#]/g, '').trim().slice(0, 80)
}

/** Turn a raw model answer into a stored creation (or throw a readable error). */
export function finishCreation(
  req: CreateRequest,
  raw: string,
  existing?: Creation
): Creation {
  const now = Date.now()
  const base: Creation = existing ?? {
    id: '',
    kind: req.kind,
    title: '',
    prompt: req.prompt,
    content: '',
    sessionIds: req.sessionIds,
    createdAt: now,
    updatedAt: now
  }
  if (req.kind === 'presentation') {
    const deck = parseDeck(raw)
    if (!deck) throw new Error('Sitka could not lay out the slides — try asking again.')
    return { ...base, title: deck.title, content: JSON.stringify(deck), updatedAt: now }
  }
  const content = req.kind === 'document' ? stripOuterFence(raw) : raw.trim()
  if (!content) throw new Error('Sitka returned nothing — try asking again.')
  const fallback = req.prompt.trim().slice(0, 60) || 'Untitled'
  const title =
    req.kind === 'document'
      ? titleFromMarkdown(content, fallback)
      : existing?.title || fallback
  return { ...base, title, content, updatedAt: now }
}
