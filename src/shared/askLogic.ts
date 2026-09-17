/**
 * When a question needs a look, and where. Sitca only reads the live screen
 * when the words ask for it, and it can look back at what was on screen at an
 * earlier moment when the question points there.
 */

const SCREEN_WORDS =
  /\b(screen|board|whiteboard|slide|slides|shown|showing|shows|displayed|display|written|write|writes|drawn|drawing|chart|graph|table|diagram|figure|image|picture|photo|equation|formula|formulas|code|page|see|seeing|look|looking|read|visible|highlighted|presenting|presentation|this|these|that one|here|on the left|on the right|column|row|axis|label)\b/i

/** Does this question need a picture of what is on screen right now? */
export function needsScreen(question: string): boolean {
  const q = question.trim()
  if (!q) return false
  if (SCREEN_WORDS.test(q)) return true
  // very short questions ("what is this?", "explain") lean on the screen
  return q.split(/\s+/).length <= 3 && /\?$/.test(q)
}

const PAST_WORDS =
  /\b(earlier|before|previous|previously|back|ago|a while|at the (start|beginning|end)|first|last|when (he|she|they|the speaker|the lecturer|the teacher)|showed|shown|had|was|were|did)\b/i

/** A moment named in the question, in seconds, if there is one. */
export function timeInQuestion(question: string, durationSec?: number): number | null {
  const q = question.toLowerCase()
  let m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(q)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    const c = m[3] !== undefined ? Number(m[3]) : null
    return c !== null ? a * 3600 + b * 60 + c : a * 60 + b
  }
  m = /\b(?:minute|min)\s*(\d{1,3})\b/.exec(q) ?? /\b(\d{1,3})\s*(?:minutes?|mins?)\b/.exec(q)
  if (m) return Number(m[1]) * 60
  m = /\b(\d{1,2})\s*(?:hours?|hrs?)\b/.exec(q)
  if (m) return Number(m[1]) * 3600
  if (/\b(at the (start|beginning)|in the beginning|first slide)\b/.test(q)) return 0
  if (/\b(at the end|last slide|the end)\b/.test(q) && durationSec) return durationSec
  return null
}

/** Does the question point back at something that was on screen earlier? */
export function looksBack(question: string): boolean {
  const q = question.trim()
  if (!q) return false
  const visual = SCREEN_WORDS.test(q)
  return visual && (PAST_WORDS.test(q) || timeInQuestion(q) !== null)
}

const STOP = new Set(
  'what which when where about that this there their they them then than with from into your have been were was does did has had the and for are but not you our its his her she him can could would should will just like more most some such very also only into onto over under after before earlier later show shown showed screen slide slides board table chart graph diagram figure image picture said say tell explain please'.split(
    ' '
  )
)

/**
 * Which stored frames to look at again. A named time wins; otherwise the
 * frames whose reading shares the most words with the question.
 */
export function pickFrames<T extends { time: number; text: string }>(
  frames: T[],
  question: string,
  durationSec?: number,
  max = 2
): T[] {
  if (frames.length === 0) return []
  const at = timeInQuestion(question, durationSec)
  if (at !== null) {
    return [...frames]
      .map((f) => ({ f, d: Math.abs(f.time - at) }))
      .filter((x) => x.d <= 240)
      .sort((a, b) => a.d - b.d)
      .slice(0, max)
      .map((x) => x.f)
      .sort((a, b) => a.time - b.time)
  }
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP.has(w))
  if (words.length === 0) return []
  const scored = frames
    .map((f) => {
      const t = (f.text || '').toLowerCase()
      let s = 0
      for (const w of words) if (t.includes(w)) s++
      return { f, s }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.f.time - a.f.time)
  return scored
    .slice(0, max)
    .map((x) => x.f)
    .sort((a, b) => a.time - b.time)
}

export function mmss(sec: number): string {
  const t = Math.max(0, Math.floor(sec))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}
