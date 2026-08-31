import type {
  ChatMessage,
  CoachBrief,
  CoachProject,
  CoachScores,
  SimDifficulty,
  TranscriptSegment
} from '@shared/types'
import * as store from './store'
import { completeText, extractJson, transcriptBlock, type AiKeys } from './ai'

function projectContext(project: CoachProject): string {
  const materials = store.getCoachMaterialsText(project.id)
  return [
    `Presentation: ${project.goal}`,
    `Audience: ${project.audience}`,
    project.when ? `Happens: ${new Date(project.when).toLocaleString()}` : '',
    materials ? `\nPresenter's materials:\n${materials}` : '\n(No materials uploaded yet.)'
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------- preparation brief ----------

export async function buildBrief(keys: AiKeys, project: CoachProject): Promise<CoachBrief | null> {
  const system = [
    'You are a world-class presentation coach preparing a presenter. From their goal, audience, and materials, produce a preparation brief.',
    'Return ONLY JSON:',
    '{"structure": [string], "keyMessage": string, "weakAreas": [string], "expectedQuestions": [string]}',
    '- structure: the 5-9 sections their presentation should follow, in order, short labels.',
    '- keyMessage: THE single most important thing this audience must walk away believing (one sentence).',
    '- weakAreas: 2-5 specific weaknesses or gaps you can see in their materials, stated bluntly but constructively.',
    '- expectedQuestions: 5-8 questions this specific audience is likely to ask — include the uncomfortable ones.'
  ].join('\n')
  const text = await completeText(keys, system, projectContext(project))
  const parsed = extractJson<Partial<CoachBrief>>(text)
  if (!parsed || !parsed.keyMessage) return null
  return {
    structure: Array.isArray(parsed.structure) ? parsed.structure.map(String) : [],
    keyMessage: String(parsed.keyMessage),
    weakAreas: Array.isArray(parsed.weakAreas) ? parsed.weakAreas.map(String) : [],
    expectedQuestions: Array.isArray(parsed.expectedQuestions)
      ? parsed.expectedQuestions.map(String)
      : []
  }
}

// ---------- rehearsal scoring ----------

export interface ScoreResult {
  scores: CoachScores
  feedback: string[]
  summary: string
}

export async function scoreRehearsal(
  keys: AiKeys,
  project: CoachProject,
  segments: TranscriptSegment[],
  durationSec: number
): Promise<ScoreResult | null> {
  if (segments.length === 0) return null
  const system = [
    'You are a rigorous but encouraging presentation coach scoring a REHEARSAL from its transcript.',
    'Judge against the presenter\'s goal, audience, and materials. Be honest — inflated scores help no one.',
    'Return ONLY JSON:',
    '{"content": n, "clarity": n, "structure": n, "confidence": n, "timing": n, "overall": n, "feedback": [string], "summary": string}',
    '- All scores 0-100. content = coverage & correctness vs materials; clarity = how understandable; structure = logical flow (opening→close); confidence = judge from filler words, hesitations, restarts, hedging in the transcript; timing = pacing across the run and total length appropriateness.',
    '- overall: weighted judgment, not an average.',
    '- feedback: 3-6 specific, actionable notes (cite moments as [[M:SS]] where useful; name the exact weakness).',
    '- summary: 2 sentences — the single biggest strength and the single biggest thing to fix before the real event.'
  ].join('\n')
  const user = [
    projectContext(project),
    project.brief ? `\nPreparation brief key message: ${project.brief.keyMessage}` : '',
    `\nRehearsal duration: ${Math.round(durationSec)}s`,
    '\nRehearsal transcript:',
    transcriptBlock(segments)
  ]
    .filter(Boolean)
    .join('\n')
  const text = await completeText(keys, system, user)
  const parsed = extractJson<Partial<CoachScores> & { feedback?: unknown[]; summary?: string }>(text)
  if (!parsed || typeof parsed.overall !== 'number') return null
  const clamp = (n: unknown): number =>
    Math.max(0, Math.min(100, Math.round(typeof n === 'number' ? n : 0)))
  return {
    scores: {
      content: clamp(parsed.content),
      clarity: clamp(parsed.clarity),
      structure: clamp(parsed.structure),
      confidence: clamp(parsed.confidence),
      timing: clamp(parsed.timing),
      overall: clamp(parsed.overall)
    },
    feedback: Array.isArray(parsed.feedback) ? parsed.feedback.map(String).slice(0, 6) : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : ''
  }
}

// ---------- audience simulation ----------

const DIFFICULTY_STYLE: Record<SimDifficulty, string> = {
  friendly:
    'Friendly mode: warm and encouraging. Ask fair, straightforward questions. Verdicts are gentle and constructive.',
  professional:
    'Professional mode: courteous but businesslike. Ask substantive questions that a well-prepared audience member would ask.',
  challenging:
    'Challenging mode: skeptical and probing. Push on weak points, ask for evidence, and follow up when answers are vague.',
  grilling:
    'Grilling mode: relentless. Interrupt weak reasoning, attack assumptions, demand numbers, and do NOT accept hand-waving. If an answer does not hold, say so bluntly and press again. This is the pressure test.'
}

export function simSystemPrompt(
  project: CoachProject,
  persona: string,
  difficulty: SimDifficulty
): string {
  return [
    `You are role-playing a ${persona} in the audience of a practice presentation. The presenter is training with you before the real thing. Stay in character the entire time.`,
    DIFFICULTY_STYLE[difficulty],
    'Rules:',
    '- Ask ONE question at a time, grounded in the presenter\'s materials and goal. Prefer the questions that would genuinely be asked by this persona — including the uncomfortable ones.',
    '- After each of the presenter\'s answers: give a one-line verdict — start it with exactly "✓ Strong:", "△ Needs work:" or "✗ Doesn\'t hold:" — plus one short reason. Then either follow up (if the answer was weak) or move to the next question.',
    '- Keep every message short: the verdict line and the next question. No lectures, no summaries unless asked.',
    '- If the presenter says something factually at odds with their own materials, catch it.',
    '- When the presenter says they want to stop or asks how they did, break character once and give a 3-line debrief: strongest answer, weakest answer, and the one thing to prepare better.',
    '',
    projectContext(project),
    project.brief
      ? `\nQuestions the coach expects this audience to ask:\n${project.brief.expectedQuestions.map((q) => `- ${q}`).join('\n')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** One short live coaching whisper during a studio rehearsal — usually null. */
export async function liveCoachHint(
  keys: AiKeys,
  project: CoachProject,
  segments: TranscriptSegment[]
): Promise<string | null> {
  if (segments.length < 4) return null
  const lastStart = segments[segments.length - 1].start
  const recent = segments.filter((s) => s.start >= lastStart - 150)
  const system = [
    'You are silently observing a LIVE practice presentation. You may send the presenter ONE short coaching whisper — or stay silent.',
    'Whisper ONLY if clearly useful right now: pacing (rushing or dragging), filler words piling up, rambling away from the planned structure, skipping or overrunning a planned section, or burying the key message.',
    'One short imperative sentence, glanceable mid-presentation. Most checks should return null — silence is the default.',
    'Return ONLY JSON: {"hint": string | null}'
  ].join('\n')
  const user = [
    `Goal: ${project.goal} — audience: ${project.audience}.`,
    project.brief
      ? `Planned structure: ${project.brief.structure.join(' → ')}. Key message: ${project.brief.keyMessage}`
      : '',
    '',
    'Recent speech:',
    transcriptBlock(recent)
  ]
    .filter(Boolean)
    .join('\n')
  const text = await completeText(keys, system, user)
  const parsed = extractJson<{ hint?: string | null }>(text)
  const hint = parsed?.hint
  return typeof hint === 'string' && hint.trim().length > 0 ? hint.trim() : null
}

/** Compact practice memory for the live Co-Pilot when a project is linked to an event. */
export function practiceContext(eventId: string): string | null {
  const project = store.listCoachProjects().find((p) => p.eventId === eventId)
  if (!project) return null
  const parts: string[] = []
  if (project.brief) {
    parts.push(`Key message they practiced: ${project.brief.keyMessage}`)
    if (project.brief.weakAreas.length > 0) {
      parts.push(`Known weak areas: ${project.brief.weakAreas.join('; ')}`)
    }
  }
  const last = project.rehearsals[project.rehearsals.length - 1]
  if (last) {
    parts.push(
      `Last rehearsal (${last.scores.overall}/100): ${last.summary} ${last.feedback.join(' ')}`
    )
  }
  const sim = store.getCoachSim(project.id)
  if (sim.length > 0) {
    const recent = sim.slice(-12).map((m) => `${m.role === 'user' ? 'Presenter' : 'Audience'}: ${m.content}`)
    parts.push(`Practiced Q&A (most recent):\n${recent.join('\n')}`)
  }
  if (parts.length === 0) return null
  return `The presenter PRACTICED for this event with Sitka Coach. Use this practice memory — when a live audience question matches something practiced, remind them of their practiced answer:\n${parts.join('\n')}`.slice(
    0,
    6000
  )
}
