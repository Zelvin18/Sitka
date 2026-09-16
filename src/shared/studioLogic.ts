import type { TranscriptSegment } from './types'

/**
 * The practice studio's listening: what can be measured from the words and
 * their timing without any model at all, so it is on screen within a second
 * of being said, and the prompts for the parts that need one.
 */

const FILLER_RE = /\b(um+|uh+|erm+|ah+|hmm+|like|you know|sort of|kind of|basically|actually|literally|right\?|okay so|so yeah)\b/gi

export interface SpeechMetrics {
  /** words per minute over the last minute of speech, 0 when nothing yet */
  wpm: number
  /** filler words in the last minute */
  fillers: number
  /** the longest silence in the last 45 seconds, in seconds */
  pause: number
  /** words said in total */
  words: number
}

export function speechMetrics(segments: TranscriptSegment[], nowSec: number): SpeechMetrics {
  const recent = segments.filter((s) => s.end >= nowSec - 60)
  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
  const recentWords = recent.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
  const span = recent.length ? Math.max(20, Math.min(60, nowSec - Math.max(recent[0].start, nowSec - 60))) : 0
  const wpm = span > 0 ? Math.round((recentWords / span) * 60) : 0
  const fillers = recent.reduce((n, s) => n + (s.text.match(FILLER_RE)?.length ?? 0), 0)
  const last45 = segments.filter((s) => s.end >= nowSec - 45)
  let pause = 0
  for (let i = 1; i < last45.length; i++) pause = Math.max(pause, last45[i].start - last45[i - 1].end)
  if (last45.length > 0) pause = Math.max(pause, nowSec - last45[last45.length - 1].end)
  return { wpm, fillers, pause: Math.round(pause), words }
}

/** Where a pace sits: a word for the pill. */
export function paceLabel(wpm: number): { label: string; off: boolean } {
  if (wpm === 0) return { label: '—', off: false }
  if (wpm < 110) return { label: 'slow', off: true }
  if (wpm > 175) return { label: 'fast', off: true }
  return { label: 'good', off: false }
}

// ---------- the audience ----------

export const AUDIENCE_QUESTION_SYSTEM = [
  'You are one member of the audience at a live practice presentation, listening to the presenter right now. You have just raised your hand.',
  'Ask ONE question that this audience would genuinely ask about what was just said: the sharp, specific question that tests whether the presenter really knows their material. Prefer numbers, assumptions, risks, "how exactly", "what if". Not a question already asked.',
  'Spoken style, as a person would say it aloud: one or two sentences, at most 30 words. No preamble, no "great presentation".',
  'Pick who you are: a short role that fits this audience (for example "Lead investor", "CFO", "Skeptical customer", "Professor", "Head of engineering").',
  'Return ONLY JSON: {"persona": string, "question": string}'
].join('\n')

export function audienceQuestionUser(context: string, segments: TranscriptSegment[], asked: string[]): string {
  const lastStart = segments.length ? segments[segments.length - 1].start : 0
  const recent = segments.filter((s) => s.start >= lastStart - 180)
  return [
    context,
    asked.length ? `\nQuestions already asked (do not repeat):\n${asked.map((q) => `- ${q}`).join('\n')}` : '',
    '\nWhat the presenter said in the last few minutes:',
    recent.map((s) => s.text.trim()).join(' ')
  ]
    .filter(Boolean)
    .join('\n')
}

export const JUDGE_ANSWER_SYSTEM = [
  'You are the audience member who asked a question at a live practice presentation, and a demanding coach at once. The presenter has just answered aloud; the transcript of their answer is below.',
  'Judge the answer honestly: "strong" when it actually answers the question with specifics; "needs-work" when it is on the right track but vague, incomplete or unsupported; "weak" when it dodges, contradicts the materials, or does not hold.',
  'reason: one or two sentences on exactly what was missing, vague, wrong or good. Speak to the presenter as "you".',
  'strongAnswer: the answer they should have given, in two or three sentences, drawn from their materials and goal, with the numbers and specifics that were missing. Give it even when the answer was strong (then: how to make it land harder). Never leave it empty.',
  'spoken: one short line the audience member says aloud in reply, in character, under 14 words ("Thanks, that is clear." / "I am not sure that answers it." / "Good, and the timeline?").',
  'Return ONLY JSON: {"verdict": "strong" | "needs-work" | "weak", "reason": string, "strongAnswer": string, "spoken": string}'
].join('\n')

export function judgeAnswerUser(context: string, persona: string, question: string, answer: string): string {
  return [
    context,
    `\nThe ${persona} asked: "${question}"`,
    `\nThe presenter answered (spoken, transcribed):\n${answer.trim() || '(nothing was said)'}`
  ].join('\n')
}

export const STUDIO_HINT_SYSTEM = [
  'You are silently observing a LIVE practice presentation. You may send the presenter ONE short coaching whisper, or stay silent.',
  'Whisper ONLY when clearly useful right now, about one of: rushing or dragging; filler words piling up; a sentence trailing off or a claim left hanging; rambling away from the planned structure; skipping or overrunning a planned section; burying the key message; a key term from the materials that came through garbled, mangled or unlike itself in the transcript (a possible mispronunciation or mumble: name the term and say to say it clearly); anything that would count against them in front of the real audience.',
  'One short imperative sentence, glanceable mid-presentation, at most 12 words. Most checks should return null; silence is the default.',
  'Return ONLY JSON: {"hint": string | null}'
].join('\n')

export interface AudienceQuestion {
  persona: string
  question: string
}
export interface AnswerVerdict {
  verdict: 'strong' | 'needs-work' | 'weak'
  reason: string
  strongAnswer: string
  spoken: string
}

export function parseAudienceQuestion(parsed: { persona?: unknown; question?: unknown } | null): AudienceQuestion | null {
  if (!parsed || typeof parsed.question !== 'string' || !parsed.question.trim()) return null
  return {
    persona: typeof parsed.persona === 'string' && parsed.persona.trim() ? parsed.persona.trim().slice(0, 40) : 'Audience member',
    question: parsed.question.trim().slice(0, 300)
  }
}

export function parseVerdict(parsed: Partial<AnswerVerdict> | null): AnswerVerdict | null {
  if (!parsed || typeof parsed.reason !== 'string') return null
  const v = parsed.verdict === 'strong' || parsed.verdict === 'weak' ? parsed.verdict : 'needs-work'
  return {
    verdict: v,
    reason: parsed.reason.trim(),
    strongAnswer: typeof parsed.strongAnswer === 'string' ? parsed.strongAnswer.trim() : '',
    spoken: typeof parsed.spoken === 'string' ? parsed.spoken.trim().slice(0, 120) : ''
  }
}
