import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { randomUUID } from 'crypto'
import type { ChatMessage, TranscriptSegment } from '@shared/types'
import * as store from './store'
import {
  completeText,
  extractJson,
  formatTime,
  streamChatGeneric,
  transcriptBlock,
  type AiKeys
} from './ai'
import { attendeeHtml } from './attendeePage'

const MAX_ASKS_PER_HOUR = 12
const MAX_CONCURRENT_AI = 3

export const LIVE_VOICE_LANGUAGES = [
  'Shona',
  'Ndebele',
  'Swahili',
  'French',
  'Portuguese',
  'Spanish',
  'German',
  'Arabic',
  'Chinese',
  'Hindi'
]

interface Attendee {
  id: string
  persona: string
  lang: string
  chat: ChatMessage[]
  askTimes: number[]
  lastCatchupSec: number
}

export interface AudienceQuestion {
  id: string
  text: string
  topic: string
  at: number
}

interface ConferenceState {
  /** null while a scheduled event is waiting to start */
  sessionId: string | null
  eventId?: string
  startsAt?: number
  title: string
  server: Server
  url: string
  port: number
  attendees: Map<string, Attendee>
  questions: AudienceQuestion[]
  sseClients: Map<string, ServerResponse>
  ended: boolean
  peakClients: number
  askLog: number[]
  /** per-language translated segment texts, index-aligned with the transcript */
  translations: Map<string, { count: number; lines: (string | undefined)[] }>
  pushBusy: boolean
  lastSegmentCount: number
  pushTimer: ReturnType<typeof setInterval>
  aiInFlight: number
  packCache: Map<string, { summary: string; takeaways: string[] }>
  /** latest stage snapshot pushed by the host app (attendee phones poll /frame) */
  frame: { buf: Buffer; at: number } | null
}

let conf: ConferenceState | null = null

type KeysProvider = () => AiKeys
let getKeys: KeysProvider = () => ({ anthropicApiKey: '', groqApiKey: '' })
let notifyHost: () => void = () => undefined

export function configureConference(keysProvider: KeysProvider, onUpdate: () => void): void {
  getKeys = keysProvider
  notifyHost = onUpdate
}

function lanIp(): string {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return '127.0.0.1'
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data) as Record<string, unknown>)
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  } catch {
    /* client gone */
  }
}

function segmentsPayload(segments: TranscriptSegment[]): { t: string; s: number; text: string }[] {
  return segments.map((s) => ({ t: formatTime(s.start), s: s.start, text: s.text }))
}

// ---------- Live Voice (translated captions) ----------

function voiceConfig(): { enabled: boolean; languages: string[] } {
  const event = conf?.eventId ? store.getEvent(conf.eventId) : null
  return event?.liveVoice ?? { enabled: true, languages: LIVE_VOICE_LANGUAGES }
}

/** Captions need translating for this attendee (non-English, host-offered language). */
function translationAppliesFor(lang: string | undefined): boolean {
  if (!lang || lang.toLowerCase() === 'english') return false
  const vc = voiceConfig()
  return vc.enabled && vc.languages.includes(lang)
}

/** The phone may offer spoken audio — English listens to the original directly. */
function voiceActiveFor(lang: string | undefined): boolean {
  const vc = voiceConfig()
  if (!vc.enabled) return false
  if (!lang || lang.toLowerCase() === 'english') return true
  return vc.languages.includes(lang)
}

function langOfClient(attId: string): string | undefined {
  return conf?.attendees.get(attId)?.lang
}

/** Extend the translation cache for one language up to the current transcript. */
async function ensureTranslations(lang: string, segments: TranscriptSegment[]): Promise<void> {
  if (!conf) return
  let cache = conf.translations.get(lang)
  if (!cache) {
    cache = { count: 0, lines: [] }
    conf.translations.set(lang, cache)
  }
  if (cache.count >= segments.length) return
  const fresh = segments.slice(cache.count)
  const startIndex = cache.count
  cache.count = segments.length // claim before await so parallel ticks don't duplicate
  try {
    const system = [
      `Translate each numbered line of live speech into ${lang}. Natural spoken style; keep names and numbers exact.`,
      `Return ONLY JSON: {"lines": [string]} with exactly ${fresh.length} entries, in order.`
    ].join('\n')
    const user = fresh.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
    const out = await completeText(getKeys(), system, user)
    const parsed = extractJson<{ lines?: unknown[] }>(out)
    if (parsed && Array.isArray(parsed.lines)) {
      fresh.forEach((_s, i) => {
        const line = parsed.lines![i]
        if (typeof line === 'string' && line.trim()) cache!.lines[startIndex + i] = line.trim()
      })
    }
  } catch {
    /* failed batch: originals will be shown for these lines */
  }
}

/**
 * Push any transcript segments the audience hasn't seen yet.
 * Original-language clients are served immediately; translated clients get
 * their lines as soon as the batch translation lands.
 */
async function pushNewSegments(): Promise<void> {
  if (!conf || !conf.sessionId || conf.pushBusy) return
  conf.pushBusy = true
  try {
    const segments = store.getTranscript(conf.sessionId)
    if (segments.length <= conf.lastSegmentCount) return
    const from = conf.lastSegmentCount
    conf.lastSegmentCount = segments.length

    const original = segmentsPayload(segments.slice(from))
    const pending: { lang: string; client: ServerResponse }[] = []
    for (const [attId, client] of conf.sseClients) {
      const lang = langOfClient(attId)
      if (translationAppliesFor(lang)) pending.push({ lang: lang!, client })
      else sendSse(client, 'segments', original)
    }
    if (pending.length === 0) return

    const langs = [...new Set(pending.map((p) => p.lang))]
    await Promise.all(langs.map((lang) => ensureTranslations(lang, segments)))
    if (!conf) return
    for (const p of pending) {
      sendSse(p.client, 'segments', translatedPayload(segments, from, p.lang))
    }
  } finally {
    if (conf) conf.pushBusy = false
  }
}

/** Called right after new transcript segments are stored — no waiting for the poll. */
export function notifySegments(sessionId: string): void {
  if (conf && conf.sessionId === sessionId) void pushNewSegments()
}

/** Latest stage snapshot from the host app (JPEG data URL). */
export function updateFrame(dataUrl: string): void {
  if (!conf || !conf.sessionId) return
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl)
  if (!m) return
  conf.frame = { buf: Buffer.from(m[1], 'base64'), at: Date.now() }
}

function translatedPayload(
  segments: TranscriptSegment[],
  from: number,
  lang: string
): { t: string; s: number; text: string }[] {
  const cache = conf?.translations.get(lang)
  return segments.slice(from).map((s, i) => ({
    t: formatTime(s.start),
    s: s.start,
    text: cache?.lines[from + i] ?? s.text
  }))
}

// ---------- AI helpers ----------

/** Pure prompt builder shared by the LAN server and the cloud relay. */
export function buildAttendeeSystem(opts: {
  persona: string
  lang: string
  segments: TranscriptSegment[]
  materialsText: string | null
  preEvent: boolean
}): string {
  const { persona, lang, segments, preEvent } = opts
  const materials = opts.materialsText
  return [
    preEvent
      ? 'You are Sitka, a personal AI companion for an audience member of an upcoming live event. The event has NOT started yet, but the host has shared preparation materials (below) — answer from those, and say clearly when something will only be known once the event begins.'
      : 'You are Sitka, a personal AI companion for one audience member at a live event. You have been listening to the event with them; the transcript so far is below.',
    `This attendee describes themself as: "${persona}". Calibrate every answer to that perspective and knowledge level — the same talk means different things to different people.`,
    lang && lang.toLowerCase() !== 'english'
      ? `Respond ENTIRELY in ${lang}, even though the source material is in another language.`
      : '',
    'Rules:',
    '- Ground every answer in the provided material; if something was not covered, say so plainly instead of guessing.',
    '- When asked what YOU think — an opinion, a critique, whether the speaker is right, what you would challenge — give a genuine, reasoned point of view drawing on your broader knowledge as well as the talk. Never say you cannot have an opinion; make clear what is your view and what the speaker said.',
    '- When you reference a specific moment of the talk, cite it inline with the exact format [[M:SS]] using a single timestamp that appears in the transcript (for example [[12:37]]). Plain ASCII double square brackets only — never fullwidth brackets like 【 】, single brackets, or parentheses. The app turns these into tappable links that jump to that moment.',
    '- Match the length of your answer to the question. A simple or specific question gets a short, direct answer of one to three sentences — no headings, no lists, no preamble. Only produce structured answers for catch-ups, summaries, or when detail is asked for.',
    '- Formatting: plain sentences, **bold** for key terms, "-" bullets for genuine lists, numbered lists for steps, and "## " headings only in long structured answers. Use a markdown table only for a comparison or when a table is asked for. This renders on a phone — keep it tight.',
    '- Do not end answers with offers like "let me know if you want more" — just answer.',
    materials ? `\nEvent materials shared by the host:\n${materials}` : '',
    preEvent ? '' : `\nTranscript so far:\n${transcriptBlock(segments)}`
  ]
    .filter(Boolean)
    .join('\n')
}

function attendeeSystem(persona: string, lang: string, segments: TranscriptSegment[]): string {
  return buildAttendeeSystem({
    persona,
    lang,
    segments,
    materialsText: store.getMaterialsText(conf?.eventId),
    preEvent: conf?.sessionId === null
  })
}

function liveSegments(): TranscriptSegment[] {
  return conf?.sessionId ? store.getTranscript(conf.sessionId) : []
}

async function askForAttendee(att: Attendee, question: string): Promise<string> {
  const segments = liveSegments()
  return streamChatGeneric({
    keys: getKeys(),
    system: attendeeSystem(att.persona, att.lang, segments),
    history: att.chat.slice(-8),
    question,
    onDelta: () => undefined
  })
}

export interface QuestionReview {
  answeredAt?: string | null
  answer?: string | null
  refined?: string
  topic?: string
}

/** Pure question review shared by the LAN server and the cloud relay. */
export async function reviewQuestionWith(
  keys: AiKeys,
  text: string,
  segments: TranscriptSegment[]
): Promise<QuestionReview> {
  const system = [
    'An audience member wants to submit a question to the speaker of a live event. You are given the transcript so far.',
    'Return ONLY JSON: {"answeredAt": "M:SS" | null, "answer": string | null, "refined": string, "topic": string}',
    '- If the speaker already clearly addressed this question, set answeredAt to the transcript timestamp where, and answer to a 1-2 sentence summary of what they said. Otherwise both null.',
    '- refined: the question rewritten to be clear and concise (keep the original language and meaning).',
    '- topic: a 2-4 word topic label for grouping similar questions.'
  ].join('\n')
  const out = await completeText(
    keys,
    system,
    `Question: ${text}\n\nTranscript:\n${transcriptBlock(segments)}`
  )
  return extractJson<QuestionReview>(out) ?? { refined: text, topic: 'General' }
}

function reviewQuestion(text: string): Promise<QuestionReview> {
  return reviewQuestionWith(getKeys(), text, liveSegments())
}

/** Pure take-home pack builder shared by the LAN server and the cloud relay. */
export async function buildPackWith(
  keys: AiKeys,
  lang: string,
  segments: TranscriptSegment[]
): Promise<{ summary: string; takeaways: string[] }> {
  const system = [
    'Create a take-home pack for an audience member from this event transcript.',
    lang.toLowerCase() !== 'english' ? `Write EVERYTHING in ${lang}.` : '',
    'Return ONLY JSON: {"summary": string, "takeaways": [string]} — summary is 3-5 sentences; takeaways are 4-7 short bullet points of the most important ideas.'
  ]
    .filter(Boolean)
    .join('\n')
  const out = await completeText(keys, system, transcriptBlock(segments))
  const parsed = extractJson<{ summary?: string; takeaways?: string[] }>(out)
  return {
    summary: parsed?.summary ?? 'Summary unavailable.',
    takeaways: Array.isArray(parsed?.takeaways) ? parsed.takeaways.map(String) : []
  }
}

async function buildPack(lang: string): Promise<{ summary: string; takeaways: string[] }> {
  if (!conf) return { summary: '', takeaways: [] }
  const cached = conf.packCache.get(lang)
  if (cached) return cached
  const pack = await buildPackWith(getKeys(), lang, liveSegments())
  conf.packCache.set(lang, pack)
  return pack
}

// ---------- request handling ----------

async function withAiSlot<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
  if (!conf || conf.aiInFlight >= MAX_CONCURRENT_AI) return 'busy'
  conf.aiInFlight++
  try {
    return await fn()
  } finally {
    if (conf) conf.aiInFlight--
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!conf) {
    json(res, 503, { error: 'Event is not live.' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(attendeeHtml(conf.title))
    return
  }

  if (req.method === 'GET' && path === '/frame') {
    // Stale frames (host stopped sharing) 404 so phones hide the stage view.
    if (!conf.frame || Date.now() - conf.frame.at > 15000) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(conf.frame.buf)
    return
  }

  if (req.method === 'GET' && path === '/events') {
    const attId = url.searchParams.get('att') ?? ''
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    conf.sseClients.set(attId || randomUUID(), res)
    conf.peakClients = Math.max(conf.peakClients, conf.sseClients.size)
    const initEvent = conf.eventId ? store.getEvent(conf.eventId) : null
    const initLang = langOfClient(attId)
    const translated = translationAppliesFor(initLang)
    const initSegments = liveSegments()
    if (translated) await ensureTranslations(initLang!, initSegments)
    sendSse(res, 'init', {
      title: conf.title,
      ended: conf.ended,
      waiting: conf.sessionId === null,
      startsAt: conf.startsAt ?? null,
      preChat:
        conf.sessionId === null &&
        store.getMaterialsText(conf.eventId) !== null &&
        initEvent?.preEventChat !== false,
      voice: { active: voiceActiveFor(initLang), lang: initLang ?? 'English' },
      segments: translated
        ? translatedPayload(initSegments, 0, initLang!)
        : segmentsPayload(initSegments)
    })
    req.on('close', () => {
      if (conf) {
        for (const [key, client] of conf.sseClients) {
          if (client === res) conf.sseClients.delete(key)
        }
      }
      notifyHost()
    })
    notifyHost()
    return
  }

  if (req.method === 'POST' && path === '/join') {
    const body = await readBody(req)
    const attendee: Attendee = {
      id: randomUUID(),
      persona: String(body.persona ?? 'Curious attendee').slice(0, 80),
      lang: String(body.lang ?? 'English').slice(0, 30),
      chat: [],
      askTimes: [],
      lastCatchupSec: 0
    }
    conf.attendees.set(attendee.id, attendee)
    notifyHost()
    json(res, 200, { attendeeId: attendee.id })
    return
  }

  const body = req.method === 'POST' ? await readBody(req) : {}
  const attendee = conf.attendees.get(String(body.attendeeId ?? url.searchParams.get('att') ?? ''))
  const notStarted = conf.sessionId === null
  const gateEvent = conf.eventId ? store.getEvent(conf.eventId) : null
  const preChatAllowed =
    store.getMaterialsText(conf.eventId) !== null && gateEvent?.preEventChat !== false
  // Pre-event: with host materials shared (and the host allowing it), the
  // companion already answers questions.
  const blocked = notStarted
    ? preChatAllowed
      ? ['/catchup', '/question', '/pack']
      : ['/ask', '/catchup', '/question', '/pack']
    : []
  if (blocked.includes(path)) {
    json(res, 400, {
      error:
        path === '/ask'
          ? 'The host will unlock the AI when the event starts — hang tight.'
          : 'The event has not started yet — hang tight.'
    })
    return
  }

  if (req.method === 'POST' && path === '/ask') {
    if (!attendee) {
      json(res, 400, { error: 'Please rejoin (scan the QR again).' })
      return
    }
    const now = Date.now()
    attendee.askTimes = attendee.askTimes.filter((t) => now - t < 3600000)
    if (attendee.askTimes.length >= MAX_ASKS_PER_HOUR) {
      json(res, 429, { error: 'Question limit reached — try again in a while.' })
      return
    }
    const question = String(body.question ?? '').slice(0, 600)
    if (!question.trim()) {
      json(res, 400, { error: 'Empty question.' })
      return
    }
    const result = await withAiSlot(() => askForAttendee(attendee, question))
    if (result === 'busy') {
      json(res, 429, { error: 'Sitka is busy — try again in a few seconds.' })
      return
    }
    attendee.askTimes.push(now)
    conf.askLog.push(now)
    conf.peakClients = Math.max(conf.peakClients, conf.sseClients.size)
    attendee.chat.push(
      { role: 'user', content: question, at: now },
      { role: 'assistant', content: result, at: Date.now() }
    )
    json(res, 200, { answer: result })
    return
  }

  if (req.method === 'POST' && path === '/catchup') {
    if (!attendee) {
      json(res, 400, { error: 'Please rejoin (scan the QR again).' })
      return
    }
    const segments = liveSegments()
    const nowSec = segments.length > 0 ? segments[segments.length - 1].start : 0
    const since = attendee.lastCatchupSec
    attendee.lastCatchupSec = nowSec
    const scope = since > 30 ? `since [${formatTime(since)}]` : 'so far'
    const result = await withAiSlot(() =>
      askForAttendee(
        attendee,
        `Catch me up: in a few short bullets, what has happened ${scope}? End with one line on what is being discussed right now.`
      )
    )
    if (result === 'busy') {
      json(res, 429, { error: 'Sitka is busy — try again in a few seconds.' })
      return
    }
    json(res, 200, { answer: result })
    return
  }

  if (req.method === 'POST' && path === '/question') {
    if (!attendee) {
      json(res, 400, { error: 'Please rejoin (scan the QR again).' })
      return
    }
    const text = String(body.text ?? '').slice(0, 500)
    if (!text.trim()) {
      json(res, 400, { error: 'Empty question.' })
      return
    }
    const force = Boolean(body.force)
    const review = await withAiSlot(() => reviewQuestion(text))
    if (review === 'busy') {
      json(res, 429, { error: 'Sitka is busy — try again in a few seconds.' })
      return
    }
    if (!force && review.answeredAt && review.answer) {
      json(res, 200, {
        alreadyAnswered: { at: review.answeredAt, answer: review.answer }
      })
      return
    }
    conf.questions.push({
      id: randomUUID(),
      text: review.refined || text,
      topic: review.topic || 'General',
      at: Date.now()
    })
    notifyHost()
    json(res, 200, { submitted: true, refined: review.refined || text })
    return
  }

  if (req.method === 'GET' && path === '/pack') {
    if (!attendee) {
      json(res, 400, { error: 'Please rejoin (scan the QR again).' })
      return
    }
    const pack = await withAiSlot(() => buildPack(attendee.lang))
    if (pack === 'busy') {
      json(res, 429, { error: 'Sitka is busy — try again in a few seconds.' })
      return
    }
    const meta = conf.sessionId ? store.getMeta(conf.sessionId) : null
    json(res, 200, {
      title: conf.title,
      summary: pack.summary,
      takeaways: pack.takeaways,
      moments: (meta?.highlights ?? []).map((h) => `[${h.time}] ${h.label}`),
      myChat: attendee.chat.map((m) => ({ role: m.role, content: m.content }))
    })
    return
  }

  json(res, 404, { error: 'Not found' })
}

// ---------- lifecycle ----------

async function launchState(
  title: string,
  opts: { sessionId: string | null; eventId?: string; startsAt?: number; preferredPort?: number }
): Promise<{ url?: string; error?: string }> {
  if (conf) await stopConference()

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        json(res, 500, { error: 'Something went wrong.' })
      } catch {
        /* noop */
      }
    })
  })

  const first = opts.preferredPort ?? 4680
  const port = await new Promise<number | null>((resolve) => {
    let attempt = first
    let wrapped = false
    const tryListen = (): void => {
      server.once('error', () => {
        attempt++
        if (attempt > 4699) {
          if (wrapped) {
            resolve(null)
            return
          }
          wrapped = true
          attempt = 4680
        }
        tryListen()
      })
      server.listen(attempt, '0.0.0.0', () => {
        server.removeAllListeners('error')
        resolve(attempt)
      })
    }
    tryListen()
  })
  if (port === null) return { error: 'No free port for the event server.' }

  const url = `http://${lanIp()}:${port}`
  conf = {
    sessionId: opts.sessionId,
    eventId: opts.eventId,
    startsAt: opts.startsAt,
    title,
    server,
    url,
    port,
    attendees: new Map(),
    questions: [],
    sseClients: new Map(),
    ended: false,
    peakClients: 0,
    askLog: [],
    translations: new Map(),
    pushBusy: false,
    lastSegmentCount: opts.sessionId ? store.getTranscript(opts.sessionId).length : 0,
    aiInFlight: 0,
    packCache: new Map(),
    frame: null,
    // Fallback sweep only — notifySegments() pushes the moment segments land.
    pushTimer: setInterval(() => void pushNewSegments(), 2000)
  }
  return { url }
}

/** Starts (or resumes) the waiting server for a scheduled event. */
export async function startWaitingEvent(event: {
  id: string
  title: string
  startsAt?: number
  port?: number
}): Promise<{ url?: string; port?: number; error?: string }> {
  const result = await launchState(event.title, {
    sessionId: null,
    eventId: event.id,
    startsAt: event.startsAt,
    preferredPort: event.port
  })
  if (result.error) return result
  return { url: result.url, port: conf?.port }
}

export async function startConference(sessionId: string): Promise<{ url?: string; error?: string }> {
  const meta = store.getMeta(sessionId)
  if (!meta) return { error: 'Session not found.' }

  // A scheduled event is waiting: go live on the SAME url the QR already points
  // to — but only when this session belongs to that event (or to none).
  if (conf && conf.sessionId === null && (!meta.eventId || conf.eventId === meta.eventId)) {
    conf.sessionId = sessionId
    conf.lastSegmentCount = 0
    conf.ended = false
    if (conf.eventId) {
      const event = store.getEvent(conf.eventId)
      if (event) {
        event.sessionId = sessionId
        store.saveEvent(event)
      }
    }
    for (const client of conf.sseClients.values()) {
      sendSse(client, 'live', { title: conf.title })
    }
    notifyHost()
    return { url: conf.url }
  }

  if (meta.eventId) {
    const event = store.getEvent(meta.eventId)
    if (event) {
      event.sessionId = sessionId
      store.saveEvent(event)
    }
  }
  return launchState(meta.title, { sessionId, eventId: meta.eventId })
}

function groupQuestions(): { topic: string; items: { text: string; at: number }[] }[] {
  if (!conf) return []
  const byTopic = new Map<string, { text: string; at: number }[]>()
  for (const q of conf.questions) {
    const list = byTopic.get(q.topic) ?? []
    list.push({ text: q.text, at: q.at })
    byTopic.set(q.topic, list)
  }
  return [...byTopic.entries()]
    .map(([topic, items]) => ({ topic, items }))
    .sort((a, b) => b.items.length - a.items.length)
}

export function endConference(sessionId: string): void {
  if (!conf || conf.sessionId !== sessionId) return
  conf.ended = true
  conf.packCache.clear()
  // Persist the audience report so the session's Event Report survives.
  store.saveReport(sessionId, {
    joined: conf.attendees.size,
    peak: conf.peakClients,
    aiAsks: conf.askLog.length,
    questions: groupQuestions(),
    agenda: store.getMeta(sessionId)?.agenda,
    endedAt: Date.now()
  })
  for (const client of conf.sseClients.values()) sendSse(client, 'ended', {})
}

export async function stopConference(): Promise<void> {
  const state = conf
  conf = null
  if (!state) return
  clearInterval(state.pushTimer)
  for (const client of state.sseClients.values()) {
    try {
      client.end()
    } catch {
      /* noop */
    }
  }
  await new Promise<void>((resolve) => state.server.close(() => resolve()))
}

export function conferenceStatus(): {
  running: boolean
  url?: string
  ended?: boolean
  waiting?: boolean
  eventId?: string
  attendees?: number
  recentAsks?: number
  questions?: { topic: string; items: { text: string; at: number }[] }[]
} {
  if (!conf) return { running: false }
  const now = Date.now()
  return {
    running: true,
    url: conf.url,
    ended: conf.ended,
    waiting: conf.sessionId === null,
    eventId: conf.eventId,
    attendees: conf.sseClients.size,
    recentAsks: conf.askLog.filter((t) => now - t < 300000).length,
    questions: groupQuestions()
  }
}
