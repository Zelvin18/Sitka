import Anthropic from '@anthropic-ai/sdk'
import type {
  ChatMessage,
  SessionHighlight,
  SessionMoment,
  SessionNotes,
  StudyPack,
  TranscriptSegment
} from '@shared/types'

export interface AiKeys {
  anthropicApiKey: string
  groqApiKey: string
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
  return m ? { mediaType: m[1], data: m[2] } : null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * fetch with retries: transient network failures ("fetch failed"), rate limits
 * (429), and server errors (5xx) get retried with backoff instead of bubbling
 * straight up to the user.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 4
): Promise<Response> {
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init)
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        await sleep(1200 * (i + 1))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(1200 * (i + 1))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

const MODEL = 'claude-opus-5'

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function transcriptBlock(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '(No speech has been transcribed yet.)'
  return segments.map((s) => `[${formatTime(s.start)}] ${s.text.trim()}`).join('\n')
}

function askSystemPrompt(live: boolean): string {
  return [
    'You are Sitka, an AI assistant that is attending a live session (a lecture, meeting, presentation, or event) together with the user.',
    live
      ? 'The session is happening RIGHT NOW. The transcript below covers everything captured so far, up to the present moment. When the user asks about "now" or "currently", focus on the most recent parts of the transcript.'
      : 'The session has ended. The transcript below covers the full recording.',
    '',
    'Rules:',
    '- Ground every answer in the transcript. If something was not covered, say so plainly instead of guessing.',
    '- When the user asks what YOU think — your opinion, a critique, whether something is right or a good idea, whether you agree, what you would add or challenge — give a genuine, reasoned point of view: strengths, weaknesses, counter-arguments, and your own assessment, drawing on your broader knowledge as well as the session. Never say you cannot have or express an opinion. Make clear what is your view and what the speaker said.',
    '- When you reference a specific moment, cite it inline with the exact format [[M:SS]] or [[H:MM:SS]] using a single timestamp that appears in the transcript (for example [[12:37]]). Never cite a range — cite the moment it starts. The app turns these into clickable links that jump the recording to that moment.',
    '- Citations must use plain ASCII double square brackets exactly as shown: [[ and ]]. Never use fullwidth brackets like 【 】, single brackets, or parentheses around a citation.',
    '- When the user asks "when was X discussed" or wants to find a moment, give the timestamp citation(s) plus a one-line description of each.',
    '- Match the length of your answer to the question. A simple or specific question gets a short, direct answer of one to three sentences — no headings, no lists, no preamble. Only produce long, structured answers when the user asks for notes, a summary, a study guide, or detail.',
    '- Formatting: plain sentences, **bold** for key terms, "-" bullets for genuine lists, and numbered lists for steps. Use markdown headings (## or ###) only in long structured answers like notes or study guides. Use a markdown table only when the user explicitly asks for a table or comparison. Never use LaTeX or \\( \\) \\[ \\] notation — write any math in plain text, e.g. f\'(x) = 2x or x^2.',
    '- Do not end answers with offers like "let me know if you want more" — just answer.',
    '- If the user asks you to explain a concept from the session, explain it in your own words at the level they ask for.',
    '- If a "Prior learning" section is provided (moments from the user\'s OTHER sessions), connect your explanation to what they already covered when genuinely relevant — mention the session by name (e.g. \'you covered this in "Intro to Limits"\') and cite those moments as [[<sessionId>@M:SS]] using the ids shown there. Do not force connections that are not helpful.',
    '',
    'Transcript of the session (each line is prefixed with its start time):'
  ].join('\n')
}

export interface AskParams {
  apiKey: string
  segments: TranscriptSegment[]
  history: ChatMessage[]
  question: string
  live: boolean
  /** JPEG data URL of the current screen frame (live sessions) */
  frame?: string
  /** relevant excerpts from the user's other sessions (teach-to-history) */
  priorContext?: string
  onDelta: (text: string) => void
}

const PRIOR_HEADER =
  "Prior learning — moments from the user's OTHER sessions related to this question (marker = [sessionId @ time]):"

export async function streamAsk(params: AskParams): Promise<string> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const frame = params.frame ? parseDataUrl(params.frame) : null
  const lastContent: Anthropic.MessageParam['content'] = frame
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: frame.mediaType as 'image/jpeg',
            data: frame.data
          }
        },
        {
          type: 'text',
          text: `(The attached image is what is currently on screen in the live session.)\n\n${params.question}`
        }
      ]
    : params.question
  const messages: Anthropic.MessageParam[] = [
    ...params.history.map(
      (m): Anthropic.MessageParam => ({ role: m.role, content: m.content })
    ),
    { role: 'user', content: lastContent }
  ]

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: askSystemPrompt(params.live) },
    {
      type: 'text',
      text: transcriptBlock(params.segments),
      cache_control: { type: 'ephemeral' }
    }
  ]
  if (params.priorContext) {
    system.push({ type: 'text', text: `${PRIOR_HEADER}\n${params.priorContext}` })
  }
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system,
    messages
  })

  stream.on('text', (delta) => params.onDelta(delta))
  const final = await stream.finalMessage()
  return final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export interface AnalysisResult {
  title: string
  summary: string
  highlights: SessionHighlight[]
}

export type AnalysisKind = 'lecture' | 'meeting' | 'presentation' | 'other'

function analysisSystem(kind: AnalysisKind = 'other'): string {
  const focus: Record<AnalysisKind, string> = {
    lecture:
      'This is a LECTURE: focus on the concepts taught, definitions, worked examples, and anything flagged as important for exams or assessments.',
    meeting:
      'This is a MEETING: focus the summary on decisions made, action items (who is responsible for what), deadlines, and risks or concerns raised. Prefer highlights that mark decisions, assignments, and commitments.',
    presentation:
      'This is a PRESENTATION: focus on the key messages, announcements, data points, and audience questions.',
    other: ''
  }
  return [
    'You analyze a timestamped transcript of a recorded session (lecture, meeting, presentation, or event).',
    focus[kind],
    'Return ONLY a JSON object, no prose and no code fences, with this exact shape:',
    '{"title": string, "summary": string, "highlights": [{"time": string, "label": string}]}',
    '- "title": a short, specific title for the session (max 8 words, no quotes inside).',
    '- "summary": 2-4 sentences capturing what the session was about and its most important points.',
    '- "highlights": 3-8 key moments worth revisiting, each with "time" copied exactly from a timestamp in the transcript (like "12:37") and a short label (max 10 words).'
  ]
    .filter(Boolean)
    .join('\n')
}

export async function analyzeSession(
  apiKey: string,
  segments: TranscriptSegment[],
  kind: AnalysisKind = 'other'
): Promise<AnalysisResult | null> {
  if (segments.length === 0) return null
  const client = new Anthropic({ apiKey })
  const system = analysisSystem(kind)

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: transcriptBlock(segments) }]
  })

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return parseAnalysis(text)
}

function parseAnalysis(text: string): AnalysisResult | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as Partial<AnalysisResult>
    if (!parsed.title || !parsed.summary) return null
    return {
      title: String(parsed.title),
      summary: String(parsed.summary),
      highlights: Array.isArray(parsed.highlights)
        ? parsed.highlights
            .filter((h) => h && typeof h.time === 'string' && typeof h.label === 'string')
            .map((h) => ({ time: h.time, label: h.label }))
        : []
    }
  } catch {
    return null
  }
}

// ---------- Groq (free-tier fallback provider) ----------

const GROQ_BASE = 'https://api.groq.com/openai/v1'
const GROQ_STT_MODEL = 'whisper-large-v3-turbo'

// Groq retires model ids frequently, so never hardcode one: ask the API what is
// currently hosted and pick the best chat model available.
const GROQ_PREFERRED_CHAT_MODELS = [
  'moonshotai/kimi-k2-instruct-0905',
  'moonshotai/kimi-k2-instruct',
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant'
]
const GROQ_PREFERRED_VISION_MODELS = [
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct'
]
const GROQ_NON_CHAT_RE = /whisper|tts|guard|embed|moderation|allam/i

let cachedGroqModelIds: string[] | null = null

async function listGroqModels(apiKey: string): Promise<string[]> {
  if (cachedGroqModelIds) return cachedGroqModelIds
  const res = await fetchWithRetry(`${GROQ_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Could not list Groq models (${res.status}): ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { data?: { id: string }[] }
  cachedGroqModelIds = (data.data ?? []).map((m) => m.id)
  return cachedGroqModelIds
}

/** Reasoning models emit private <think> blocks — only pick them as a last resort. */
const GROQ_REASONING_RE = /deepseek|qwq|qwen|r1|reason|think|gpt-oss/i

async function pickGroqChatModel(apiKey: string): Promise<string> {
  const ids = await listGroqModels(apiKey)
  const picked =
    GROQ_PREFERRED_CHAT_MODELS.find((p) => ids.includes(p)) ??
    ids.find((id) => !GROQ_NON_CHAT_RE.test(id) && !GROQ_REASONING_RE.test(id)) ??
    ids.find((id) => !GROQ_NON_CHAT_RE.test(id))
  if (!picked) throw new Error('No chat model available on this Groq account.')
  return picked
}

function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim()
}

async function pickGroqVisionModel(apiKey: string): Promise<string | null> {
  const ids = await listGroqModels(apiKey)
  return (
    GROQ_PREFERRED_VISION_MODELS.find((p) => ids.includes(p)) ??
    ids.find((id) => /llama-4|vision/i.test(id) && !GROQ_NON_CHAT_RE.test(id)) ??
    null
  )
}

type GroqContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | GroqContentPart[]
}

async function groqChat(
  apiKey: string,
  messages: GroqChatMessage[],
  onDelta?: (text: string) => void,
  modelOverride?: string
): Promise<string> {
  const groqModel = modelOverride ?? (await pickGroqChatModel(apiKey))
  const res = await fetchWithRetry(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: groqModel,
      messages,
      stream: Boolean(onDelta),
      // reasoning models: keep the thinking out of the answer
      ...(GROQ_REASONING_RE.test(groqModel) ? { reasoning_format: 'hidden' } : {})
    })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Groq request failed (${res.status}): ${body.slice(0, 300)}`)
  }

  if (!onDelta) {
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    return stripThinking(data.choices?.[0]?.message?.content ?? '')
  }

  // Parse the OpenAI-compatible SSE stream.
  let full = ''
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[]
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
  return stripThinking(full)
}

export async function streamAskGroq(params: AskParams): Promise<string> {
  // Frames need a vision-capable model; if none is hosted, fall back to text.
  let visionModel: string | null = null
  if (params.frame) {
    visionModel = await pickGroqVisionModel(params.apiKey).catch(() => null)
  }
  const lastContent: string | GroqContentPart[] =
    params.frame && visionModel
      ? [
          { type: 'image_url', image_url: { url: params.frame } },
          {
            type: 'text',
            text: `(The attached image is what is currently on screen in the live session.)\n\n${params.question}`
          }
        ]
      : params.question
  const messages: GroqChatMessage[] = [
    {
      role: 'system',
      content:
        `${askSystemPrompt(params.live)}\n\n${transcriptBlock(params.segments)}` +
        (params.priorContext ? `\n\n${PRIOR_HEADER}\n${params.priorContext}` : '')
    },
    ...params.history.map(
      (m): GroqChatMessage => ({ role: m.role, content: m.content })
    ),
    { role: 'user', content: lastContent }
  ]
  return groqChat(params.apiKey, messages, params.onDelta, visionModel ?? undefined)
}

export async function analyzeSessionGroq(
  apiKey: string,
  segments: TranscriptSegment[],
  kind: AnalysisKind = 'other'
): Promise<AnalysisResult | null> {
  if (segments.length === 0) return null
  const text = await groqChat(apiKey, [
    { role: 'system', content: analysisSystem(kind) },
    { role: 'user', content: transcriptBlock(segments) }
  ])
  return parseAnalysis(text)
}

// ---------- generic streaming chat (used by Brain) ----------

export interface ChatStreamParams {
  keys: AiKeys
  system: string
  history: ChatMessage[]
  question: string
  onDelta: (text: string) => void
}

export async function streamChatGeneric(params: ChatStreamParams): Promise<string> {
  if (params.keys.anthropicApiKey) {
    const client = new Anthropic({ apiKey: params.keys.anthropicApiKey })
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: [
        { type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }
      ],
      messages: [
        ...params.history.map(
          (m): Anthropic.MessageParam => ({ role: m.role, content: m.content })
        ),
        { role: 'user', content: params.question }
      ]
    })
    stream.on('text', (delta) => params.onDelta(delta))
    const final = await stream.finalMessage()
    return final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  return groqChat(
    params.keys.groqApiKey,
    [
      { role: 'system', content: params.system },
      ...params.history.map(
        (m): GroqChatMessage => ({ role: m.role, content: m.content })
      ),
      { role: 'user', content: params.question }
    ],
    params.onDelta
  )
}

// ---------- shared provider dispatch for one-shot completions ----------

export async function completeText(keys: AiKeys, system: string, user: string): Promise<string> {
  if (keys.anthropicApiKey) {
    const client = new Anthropic({ apiKey: keys.anthropicApiKey })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }]
    })
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  return groqChat(keys.groqApiKey, [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ])
}

export function extractJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as T
  } catch {
    return null
  }
}

// ---------- live notes + moment detection ----------

const NOTES_SYSTEM = [
  'You maintain live, organized notes for a session (lecture, meeting, or presentation) as it happens.',
  'You are given the timestamped transcript so far, and the previous version of the notes (which may be empty).',
  'Rewrite the notes so they cover everything discussed so far. Notes are NOT a transcript copy: organize by topic with "## " headings, short "-" bullets, key definitions in **bold**, and concrete examples where given.',
  'Also detect notable moments:',
  '- kind "important": points the speaker emphasized, stressed, repeated, or flagged (e.g. "this will be on the exam", "the key thing is", a major decision or announcement).',
  '- kind "question": actual questions asked aloud during the session, quoted or closely paraphrased.',
  'Each moment needs "time" copied exactly from a transcript timestamp (like "12:37") and a short "label" (max 12 words).',
  'Return ONLY a JSON object, no prose and no code fences:',
  '{"notes": "<markdown string>", "moments": [{"time": "M:SS", "label": string, "kind": "important" | "question"}]}',
  'Keep the moments list complete for the whole session so far (carry earlier moments forward, do not drop them).'
].join('\n')

interface NotesJson {
  notes?: string
  moments?: { time?: string; label?: string; kind?: string }[]
}

export async function updateNotes(
  keys: AiKeys,
  segments: TranscriptSegment[],
  previous: SessionNotes | null
): Promise<SessionNotes | null> {
  if (segments.length === 0) return null
  const user = [
    previous?.markdown
      ? `Previous notes:\n${previous.markdown}`
      : 'Previous notes: (none yet)',
    '',
    'Transcript so far:',
    transcriptBlock(segments)
  ].join('\n')
  // A model occasionally returns malformed JSON — retry once before giving up.
  let parsed: NotesJson | null = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const text = await completeText(keys, NOTES_SYSTEM, user)
    const candidate = extractJson<NotesJson>(text)
    if (candidate && typeof candidate.notes === 'string') parsed = candidate
  }
  if (!parsed || typeof parsed.notes !== 'string') return null
  const moments: SessionMoment[] = Array.isArray(parsed.moments)
    ? parsed.moments
        .filter(
          (m) =>
            m &&
            typeof m.time === 'string' &&
            typeof m.label === 'string' &&
            (m.kind === 'important' || m.kind === 'question')
        )
        .map((m) => ({
          time: m.time as string,
          label: m.label as string,
          kind: m.kind as 'important' | 'question'
        }))
    : []
  return { markdown: parsed.notes, moments, updatedAt: Date.now() }
}

// ---------- host co-pilot (stage manager for live presenters) ----------

export interface HostAudience {
  attendees: number
  questions: { topic: string; count: number }[]
  recentAsks: number
}

export function hostSystemPrompt(
  segments: TranscriptSegment[],
  agenda: string[] | undefined,
  audience: HostAudience,
  materials?: string | null,
  practice?: string | null
): string {
  return [
    'You are Sitka Co-Pilot — the stage manager for a presenter who is LIVE in front of an audience RIGHT NOW.',
    'The presenter knows their own material better than you do. NEVER explain their content back to them — unless they explicitly ask you to draft or phrase something.',
    'Behavior: extremely brief and glanceable. 1-3 short sentences, or a tight list of at most 4 items. Imperative and concrete. Zero filler, zero preamble, no offers of more help. They have seconds to read while presenting.',
    'Focus on: what the audience needs, questions waiting for the speaker, planned topics not yet covered, pacing, and drafting crisp answers or transitions when asked.',
    'Cite moments as [[M:SS]] with timestamps from the transcript when pointing at something specific.',
    '',
    agenda && agenda.length > 0
      ? `Planned topics:\n${agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
      : 'No planned topics were provided.',
    '',
    `Audience right now: ${audience.attendees} connected. Private AI questions in the last 5 minutes: ${audience.recentAsks}.`,
    audience.questions.length > 0
      ? `Questions waiting for the speaker (by topic): ${audience.questions
          .map((q) => `${q.topic} (${q.count})`)
          .join(', ')}`
      : 'No questions submitted for the speaker yet.',
    materials ? `\nEvent materials (the host's own prep documents):\n${materials}` : '',
    practice ? `\n${practice}` : '',
    '',
    'Transcript so far:',
    transcriptBlock(segments)
  ]
    .filter(Boolean)
    .join('\n')
}

export async function checkCoverage(
  keys: AiKeys,
  segments: TranscriptSegment[],
  agenda: string[]
): Promise<boolean[]> {
  if (agenda.length === 0 || segments.length === 0) return agenda.map(() => false)
  const system = [
    'You are given a live transcript and the presenter\'s planned topics.',
    'Decide which planned topics have been substantively covered so far (mentioned in passing does not count).',
    `Return ONLY JSON: {"covered": [${agenda.map(() => 'boolean').join(', ')}]} — one boolean per topic, in order.`
  ].join('\n')
  const user = `Planned topics:\n${agenda
    .map((a, i) => `${i + 1}. ${a}`)
    .join('\n')}\n\nTranscript:\n${transcriptBlock(segments)}`
  const text = await completeText(keys, system, user)
  const parsed = extractJson<{ covered?: unknown[] }>(text)
  if (!parsed || !Array.isArray(parsed.covered)) return agenda.map(() => false)
  return agenda.map((_a, i) => parsed.covered![i] === true)
}

// ---------- proactive nudges (live sessions) ----------

const NUDGE_SYSTEM = [
  'You quietly watch a live session on behalf of the user and decide whether something JUST happened that deserves a proactive alert.',
  'Alert ONLY for one of these, and only if it happened in the RECENT part of the transcript:',
  '1. The speaker answered or directly addressed one of the questions the user asked earlier (their questions are listed).',
  '2. An explicit action item, task, or deadline was assigned to the audience or the user.',
  '3. The speaker flagged something as important for an exam, assessment, grade, or decision.',
  '4. The speaker clearly contradicted something said earlier in the session.',
  'Be very conservative — most checks should produce no alert. Never repeat an alert similar to one already shown (listed).',
  'Return ONLY JSON: {"nudge": string | null}. The nudge is ONE short sentence, starting with what happened, including a citation [[M:SS]] with a timestamp copied from the transcript.'
].join('\n')

export async function detectNudge(
  keys: AiKeys,
  segments: TranscriptSegment[],
  userQuestions: string[],
  priorNudges: string[]
): Promise<string | null> {
  if (segments.length < 4) return null
  const lastStart = segments[segments.length - 1].start
  const recent = segments.filter((s) => s.start >= lastStart - 180)
  if (recent.length === 0) return null
  const earlier = segments.filter((s) => s.start < lastStart - 180)
  let earlierBlock = transcriptBlock(earlier)
  if (earlierBlock.length > 8000) earlierBlock = `…${earlierBlock.slice(-8000)}`

  const user = [
    'Earlier transcript (context):',
    earlierBlock,
    '',
    'RECENT transcript (judge only this part):',
    transcriptBlock(recent),
    '',
    userQuestions.length > 0
      ? `Questions the user asked earlier:\n${userQuestions.map((q) => `- ${q}`).join('\n')}`
      : 'The user has not asked any questions yet.',
    priorNudges.length > 0
      ? `Alerts already shown (do not repeat):\n${priorNudges.map((n) => `- ${n}`).join('\n')}`
      : ''
  ].join('\n')

  const text = await completeText(keys, NUDGE_SYSTEM, user)
  const parsed = extractJson<{ nudge?: string | null }>(text)
  const nudge = parsed?.nudge
  return typeof nudge === 'string' && nudge.trim().length > 0 ? nudge.trim() : null
}

// ---------- study pack (student mode) ----------

const STUDY_SYSTEM = [
  'You create a study pack from the timestamped transcript of a recorded lecture or presentation.',
  'Return ONLY a JSON object, no prose and no code fences, with this exact shape:',
  '{"concepts": [{"term": string, "definition": string}], "flashcards": [{"front": string, "back": string}], "quiz": [{"question": string, "options": [string, string, string, string], "answerIndex": number, "explanation": string}]}',
  '- concepts: 5-20 key terms actually covered, each with a clear one-sentence definition in plain language.',
  '- flashcards: 8-20 cards. Front is a question or prompt; back is a concise answer. Cover the most examinable material.',
  '- quiz: 5-12 multiple-choice questions with exactly 4 options each. answerIndex is the 0-based index of the correct option. explanation is one sentence on why it is correct.',
  'Everything must come from the session content. Write at the level the material was taught.'
].join('\n')

interface StudyJson {
  concepts?: { term?: string; definition?: string }[]
  flashcards?: { front?: string; back?: string }[]
  quiz?: {
    question?: string
    options?: string[]
    answerIndex?: number
    explanation?: string
  }[]
}

export async function generateStudyPack(
  keys: AiKeys,
  segments: TranscriptSegment[]
): Promise<StudyPack | null> {
  if (segments.length === 0) return null
  let parsed: StudyJson | null = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const text = await completeText(keys, STUDY_SYSTEM, transcriptBlock(segments))
    parsed = extractJson<StudyJson>(text)
  }
  if (!parsed) return null
  const pack: StudyPack = {
    concepts: (parsed.concepts ?? [])
      .filter((c) => c && typeof c.term === 'string' && typeof c.definition === 'string')
      .map((c) => ({ term: c.term as string, definition: c.definition as string })),
    flashcards: (parsed.flashcards ?? [])
      .filter((f) => f && typeof f.front === 'string' && typeof f.back === 'string')
      .map((f) => ({ front: f.front as string, back: f.back as string })),
    quiz: (parsed.quiz ?? [])
      .filter(
        (q) =>
          q &&
          typeof q.question === 'string' &&
          Array.isArray(q.options) &&
          q.options.length >= 2 &&
          typeof q.answerIndex === 'number' &&
          q.answerIndex >= 0 &&
          q.answerIndex < q.options.length
      )
      .map((q) => ({
        question: q.question as string,
        options: (q.options as string[]).map(String),
        answerIndex: q.answerIndex as number,
        explanation: typeof q.explanation === 'string' ? q.explanation : ''
      })),
    generatedAt: Date.now()
  }
  if (pack.concepts.length === 0 && pack.flashcards.length === 0 && pack.quiz.length === 0) {
    return null
  }
  return pack
}

// ---------- transcription (OpenAI Whisper, or Groq's hosted Whisper) ----------

interface WhisperSegment {
  start: number
  end: number
  text: string
}

interface WhisperResponse {
  text?: string
  duration?: number
  segments?: WhisperSegment[]
}

export type SttProvider = 'openai' | 'groq'

export async function transcribeChunk(
  provider: SttProvider,
  apiKey: string,
  audio: Buffer,
  offsetSec: number
): Promise<TranscriptSegment[]> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: 'audio/webm' }),
    'chunk.webm'
  )
  form.append('model', provider === 'groq' ? GROQ_STT_MODEL : 'whisper-1')
  form.append('response_format', 'verbose_json')

  const endpoint =
    provider === 'groq'
      ? `${GROQ_BASE}/audio/transcriptions`
      : 'https://api.openai.com/v1/audio/transcriptions'
  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const data = (await res.json()) as WhisperResponse
  if (data.segments && data.segments.length > 0) {
    return data.segments
      .filter((s) => s.text && s.text.trim().length > 0)
      .map((s) => ({
        start: offsetSec + s.start,
        end: offsetSec + s.end,
        text: s.text.trim()
      }))
  }
  if (data.text && data.text.trim().length > 0) {
    return [
      {
        start: offsetSec,
        end: offsetSec + (data.duration ?? 15),
        text: data.text.trim()
      }
    ]
  }
  return []
}
