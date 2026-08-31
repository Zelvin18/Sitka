import type { BrainSearchHit, BrainStats, TranscriptSegment } from '@shared/types'
import * as store from './store'
import { formatTime } from './ai'

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'what', 'when', 'where', 'how', 'why', 'did', 'do', 'does',
  'about', 'with', 'that', 'this', 'it', 'at', 'as', 'be', 'by', 'we', 'i',
  'you', 'he', 'she', 'they', 'my', 'me', 'his', 'her', 'their', 'have', 'has',
  'had', 'can', 'could', 'will', 'would', 'say', 'said', 'tell', 'told', 'from'
])

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const t of terms) {
    let idx = lower.indexOf(t)
    while (idx !== -1) {
      score++
      idx = lower.indexOf(t, idx + t.length)
    }
  }
  return score
}

interface Ranked {
  sessionId: string
  sessionTitle: string
  createdAt: number
  seg: TranscriptSegment
  score: number
}

function rankSegments(query: string): Ranked[] {
  const terms = tokenize(query)
  const ranked: Ranked[] = []
  for (const meta of store.listSessions()) {
    if (meta.status !== 'complete') continue
    const titleBoost = terms.length > 0 ? scoreText(meta.title, terms) : 0
    for (const seg of store.getTranscript(meta.id)) {
      const score = terms.length > 0 ? scoreText(seg.text, terms) : 0
      if (score + titleBoost > 0) {
        ranked.push({
          sessionId: meta.id,
          sessionTitle: meta.title,
          createdAt: meta.createdAt,
          seg,
          score: score * 2 + titleBoost
        })
      }
    }
  }
  return ranked.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
}

export function searchLibrary(query: string): BrainSearchHit[] {
  const q = query.trim()
  if (!q) return []
  let ranked = rankSegments(q)
  // Phrase fallback for short/stopword-only queries.
  if (ranked.length === 0) {
    const phrase = q.toLowerCase()
    for (const meta of store.listSessions()) {
      if (meta.status !== 'complete') continue
      for (const seg of store.getTranscript(meta.id)) {
        if (seg.text.toLowerCase().includes(phrase)) {
          ranked.push({
            sessionId: meta.id,
            sessionTitle: meta.title,
            createdAt: meta.createdAt,
            seg,
            score: 1
          })
        }
      }
    }
  }
  return ranked.slice(0, 30).map((r) => ({
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle,
    time: r.seg.start,
    snippet: r.seg.text
  }))
}

const CONTEXT_CHAR_BUDGET = 28000

/** Builds the system context for a Brain question: library index + relevant excerpts. */
export function buildBrainContext(question: string): string {
  const sessions = store.listSessions().filter((m) => m.status === 'complete')
  const index = sessions.map((m) => {
    const date = new Date(m.createdAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
    const summary = m.summary ? ` Summary: ${m.summary}` : ''
    return `- [id: ${m.id.slice(0, 8)}] "${m.title}" — ${date}.${summary}`
  })

  let ranked = rankSegments(question)
  if (ranked.length === 0) {
    // General question ("what did I learn this week?") — feed the most recent
    // sessions' transcripts instead.
    for (const meta of sessions.slice(0, 3)) {
      for (const seg of store.getTranscript(meta.id)) {
        ranked.push({
          sessionId: meta.id,
          sessionTitle: meta.title,
          createdAt: meta.createdAt,
          seg,
          score: 1
        })
      }
    }
  }

  // Keep top-ranked segments within budget, then order them naturally
  // (by session, by time) so the model reads coherent excerpts.
  const chosen: Ranked[] = []
  let used = 0
  for (const r of ranked) {
    const cost = r.seg.text.length + 24
    if (used + cost > CONTEXT_CHAR_BUDGET) break
    chosen.push(r)
    used += cost
  }
  chosen.sort(
    (a, b) => a.sessionId.localeCompare(b.sessionId) || a.seg.start - b.seg.start
  )

  const excerpts = chosen.map(
    (r) => `[${r.sessionId.slice(0, 8)} @ ${formatTime(r.seg.start)}] ${r.seg.text}`
  )

  return [
    "The user's session library:",
    ...(index.length > 0 ? index : ['(no completed sessions yet)']),
    '',
    'Relevant transcript excerpts (marker = [sessionId @ time]):',
    ...(excerpts.length > 0 ? excerpts : ['(no relevant excerpts found)'])
  ].join('\n')
}

export function brainSystemPrompt(context: string): string {
  return [
    "You are Sitka Brain — the user's memory across every session they have captured with Sitka (lectures, meetings, presentations, events).",
    'You are given the library index and the transcript excerpts most relevant to the current question.',
    '',
    'Rules:',
    '- Ground answers in the excerpts. If the library does not cover something, say so plainly.',
    '- Cite moments inline with the exact format [[<sessionId>@M:SS]], copying the 8-character session id and a timestamp from the excerpt markers — for example [[ab12cd34@12:37]]. The app turns these into clickable links that open that session at that exact moment, so cite whenever you point at specific content.',
    '- Citations must use plain ASCII double square brackets exactly as shown: [[ and ]]. Never use fullwidth brackets like 【 】, single brackets, or parentheses around a citation.',
    '- When a question spans several sessions, synthesize across them and cite each session you draw from.',
    '- Match the length of your answer to the question: short direct answers for simple questions; structured answers only for summaries, comparisons, or study requests.',
    '- Formatting: plain sentences, **bold** key terms, "-" bullets for lists. No LaTeX — write math in plain text.',
    '- Do not end with offers like "let me know if you want more".',
    '',
    context
  ].join('\n')
}

/**
 * Moments from the user's OTHER sessions relevant to a question — lets the AI
 * teach on top of what the user has already covered.
 */
export function priorLearningContext(
  question: string,
  excludeSessionId: string
): string | null {
  const ranked = rankSegments(question).filter((r) => r.sessionId !== excludeSessionId)
  if (ranked.length === 0) return null
  const chosen: Ranked[] = []
  let used = 0
  for (const r of ranked) {
    const cost = r.seg.text.length + 40
    if (used + cost > 5000) break
    chosen.push(r)
    used += cost
  }
  chosen.sort(
    (a, b) => a.sessionId.localeCompare(b.sessionId) || a.seg.start - b.seg.start
  )
  return chosen
    .map(
      (r) =>
        `[${r.sessionId.slice(0, 8)} @ ${formatTime(r.seg.start)}] (from "${r.sessionTitle}") ${r.seg.text}`
    )
    .join('\n')
}

export function libraryStats(): BrainStats {
  let totalMs = 0
  let words = 0
  let moments = 0
  const sessions = store.listSessions().filter((m) => m.status === 'complete')
  for (const meta of sessions) {
    totalMs += meta.durationMs
    for (const seg of store.getTranscript(meta.id)) {
      words += seg.text.split(/\s+/).filter(Boolean).length
    }
    const notes = store.getNotes(meta.id)
    moments += notes?.moments.length ?? meta.highlights?.length ?? 0
  }
  return { sessions: sessions.length, totalMs, words, moments }
}
