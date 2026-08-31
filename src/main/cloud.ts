/**
 * Cloud relay: mirrors a hosted event into Supabase so attendees anywhere
 * (via the Vercel web app) can follow along — no venue Wi-Fi required.
 *
 * The Electron app is the only writer (service_role key, REST only — the main
 * process has no WebSocket, so pending work is polled). Phones read and insert
 * through the anon key; this module answers their asks with the host's AI keys,
 * which never leave this machine.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import type { ScheduledEvent, TranscriptSegment } from '@shared/types'
import * as store from './store'
import { completeText, extractJson, formatTime, streamChatGeneric, type AiKeys } from './ai'
import {
  buildAttendeeSystem,
  buildPackWith,
  reviewQuestionWith,
  LIVE_VOICE_LANGUAGES
} from './conference'

const POLL_MS = 3000

interface CloudState {
  client: SupabaseClient
  eventId: string
  sessionId: string | null
  url: string
  pollTimer: ReturnType<typeof setInterval>
  pushBusy: boolean
  lastSegmentCount: number
  /** lang -> number of segments already translated+pushed */
  translated: Map<string, number>
  frameBusy: boolean
  answering: Set<string>
  attendeeCache: Map<string, { persona: string; lang: string }>
  attendeeCount: number
  askCount: number
  questions: { topic: string; items: { text: string; at: number; votes?: number }[] }[]
  reactions: { landed: number; lost: number; recentLost: number }
  poll: {
    id: string
    question: string
    options: string[]
    counts: number[]
    total: number
    status: 'open' | 'closed'
  } | null
  packCache: Map<string, string>
}

let cloud: CloudState | null = null

type KeysProvider = () => AiKeys
let getKeys: KeysProvider = () => ({ anthropicApiKey: '', groqApiKey: '' })
let notifyHost: () => void = () => undefined

export function configureCloud(keysProvider: KeysProvider, onUpdate: () => void): void {
  getKeys = keysProvider
  notifyHost = onUpdate
}

export function cloudConfigured(): boolean {
  const s = store.getSettings()
  return Boolean(s.supabaseUrl && s.supabaseServiceKey && s.webAppUrl)
}

export function isCloudActive(): boolean {
  return cloud !== null
}

function webUrlFor(eventId: string): string {
  return store.getSettings().webAppUrl.replace(/\/+$/, '') + '/e/' + eventId
}

function makeClient(): SupabaseClient {
  const s = store.getSettings()
  return createClient(s.supabaseUrl, s.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

function eventRow(event: ScheduledEvent, status: string, sessionId: string | null): object {
  return {
    id: event.id,
    title: event.title,
    status,
    starts_at: event.startsAt ? new Date(event.startsAt).toISOString() : null,
    agenda: event.agenda ?? [],
    pre_event_chat: event.preEventChat !== false,
    materials_present: store.getMaterialsText(event.id) !== null,
    live_voice: event.liveVoice ?? { enabled: true, languages: LIVE_VOICE_LANGUAGES },
    session_id: sessionId,
    updated_at: new Date().toISOString()
  }
}

/** Publish (or re-publish) an event as waiting — the QR/link is live from now on. */
export async function startCloudWaiting(
  event: ScheduledEvent
): Promise<{ url?: string; error?: string }> {
  try {
    stopCloudPolling()
    const client = makeClient()
    const { error } = await client.from('events').upsert(eventRow(event, 'waiting', null))
    if (error) return { error: 'Supabase: ' + error.message }
    cloud = {
      client,
      eventId: event.id,
      sessionId: null,
      url: webUrlFor(event.id),
      pushBusy: false,
      lastSegmentCount: 0,
      translated: new Map(),
      frameBusy: false,
      answering: new Set(),
      attendeeCache: new Map(),
      attendeeCount: 0,
      askCount: 0,
      questions: [],
      reactions: { landed: 0, lost: 0, recentLost: 0 },
      poll: null,
      packCache: new Map(),
      pollTimer: setInterval(() => void pollCloud(), POLL_MS)
    }
    return { url: cloud.url }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The armed event goes live with a recording session. */
export async function goLiveCloud(
  sessionId: string,
  eventId: string
): Promise<{ url?: string; error?: string }> {
  const event = store.getEvent(eventId)
  if (!event) return { error: 'Event not found.' }
  if (!cloud || cloud.eventId !== eventId) {
    const res = await startCloudWaiting(event)
    if (res.error || !cloud) return { error: res.error ?? 'Could not reach Supabase.' }
  }
  cloud.sessionId = sessionId
  cloud.lastSegmentCount = 0
  cloud.translated = new Map()
  cloud.packCache.clear()
  event.sessionId = sessionId
  store.saveEvent(event)
  const { error } = await cloud.client.from('events').upsert(eventRow(event, 'live', sessionId))
  if (error) return { error: 'Supabase: ' + error.message }
  notifyHost()
  return { url: cloud.url }
}

/** Host edited the event (languages, agenda, pre-event chat…) — mirror it. */
export function syncCloudEvent(eventId: string): void {
  if (!cloud || cloud.eventId !== eventId) return
  const event = store.getEvent(eventId)
  if (!event) return
  void cloud.client
    .from('events')
    .upsert(eventRow(event, cloud.sessionId ? 'live' : 'waiting', cloud.sessionId))
    .then(() => undefined)
    .catch(() => undefined)
}

// ---------- live push ----------

async function ensureCloudTranslations(
  lang: string,
  segments: TranscriptSegment[]
): Promise<void> {
  if (!cloud) return
  const done = cloud.translated.get(lang) ?? 0
  if (done >= segments.length) return
  const fresh = segments.slice(done)
  const startIndex = done
  cloud.translated.set(lang, segments.length) // claim before await
  try {
    const system = [
      `Translate each numbered line of live speech into ${lang}. Natural spoken style; keep names and numbers exact.`,
      `Return ONLY JSON: {"lines": [string]} with exactly ${fresh.length} entries, in order.`
    ].join('\n')
    const user = fresh.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
    const out = await completeText(getKeys(), system, user)
    const parsed = extractJson<{ lines?: unknown[] }>(out)
    if (!cloud || !parsed || !Array.isArray(parsed.lines)) return
    const rows = fresh
      .map((_s, i) => ({ line: parsed.lines![i], idx: startIndex + i }))
      .filter((r) => typeof r.line === 'string' && (r.line as string).trim())
      .map((r) => ({
        event_id: cloud!.eventId,
        lang,
        idx: r.idx,
        text: (r.line as string).trim()
      }))
    if (rows.length > 0) await cloud.client.from('translations').upsert(rows)
  } catch {
    /* failed batch: phones keep the original lines */
  }
}

/** Called right after new transcript segments are stored. */
export function notifyCloudSegments(sessionId: string): void {
  if (cloud && cloud.sessionId === sessionId) void pushCloudSegments()
}

async function pushCloudSegments(): Promise<void> {
  if (!cloud || !cloud.sessionId || cloud.pushBusy) return
  cloud.pushBusy = true
  try {
    const segments = store.getTranscript(cloud.sessionId)
    if (segments.length <= cloud.lastSegmentCount) return
    const from = cloud.lastSegmentCount
    cloud.lastSegmentCount = segments.length
    const rows = segments.slice(from).map((s, i) => ({
      event_id: cloud!.eventId,
      idx: from + i,
      start_sec: s.start,
      label: formatTime(s.start),
      text: s.text
    }))
    await cloud.client.from('segments').upsert(rows)

    // Translate for every language an attendee joined with (host-offered only).
    const event = store.getEvent(cloud.eventId)
    const vc = event?.liveVoice ?? { enabled: true, languages: LIVE_VOICE_LANGUAGES }
    if (vc.enabled) {
      const langs = new Set<string>()
      for (const a of cloud.attendeeCache.values()) {
        if (a.lang.toLowerCase() !== 'english' && vc.languages.includes(a.lang)) langs.add(a.lang)
      }
      await Promise.all([...langs].map((lang) => ensureCloudTranslations(lang, segments)))
    }
  } catch {
    /* transient network problem — the next push retries from lastSegmentCount */
  } finally {
    if (cloud) cloud.pushBusy = false
  }
}

/** Latest stage snapshot (JPEG data URL) → storage, phones poll it. */
export function updateCloudFrame(dataUrl: string): void {
  if (!cloud || !cloud.sessionId || cloud.frameBusy) return
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl)
  if (!m) return
  cloud.frameBusy = true
  const buf = Buffer.from(m[1], 'base64')
  void cloud.client.storage
    .from('stage')
    .upload(`${cloud.eventId}.jpg`, buf, { upsert: true, contentType: 'image/jpeg' })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (cloud) cloud.frameBusy = false
    })
}

// ---------- answering attendees ----------

function cloudSegments(): TranscriptSegment[] {
  return cloud?.sessionId ? store.getTranscript(cloud.sessionId) : []
}

async function attendeeInfo(id: string): Promise<{ persona: string; lang: string }> {
  if (!cloud) return { persona: 'Curious attendee', lang: 'English' }
  const cached = cloud.attendeeCache.get(id)
  if (cached) return cached
  const { data } = await cloud.client
    .from('attendees')
    .select('persona,lang')
    .eq('id', id)
    .single()
  const info = {
    persona: (data?.persona as string) || 'Curious attendee',
    lang: (data?.lang as string) || 'English'
  }
  cloud.attendeeCache.set(id, info)
  return info
}

interface AskRow {
  id: string
  attendee_id: string
  kind: 'ask' | 'catchup' | 'pack'
  question: string
}

async function answerAsk(row: AskRow): Promise<void> {
  if (!cloud) return
  const state = cloud
  try {
    const att = await attendeeInfo(row.attendee_id)
    const segments = cloudSegments()
    let answer: string
    if (row.kind === 'pack') {
      const cached = state.packCache.get(att.lang)
      if (cached) {
        answer = cached
      } else {
        const pack = await buildPackWith(getKeys(), att.lang, segments)
        const meta = state.sessionId ? store.getMeta(state.sessionId) : null
        answer = JSON.stringify({
          summary: pack.summary,
          takeaways: pack.takeaways,
          moments: (meta?.highlights ?? []).map((h) => `[${h.time}] ${h.label}`)
        })
        state.packCache.set(att.lang, answer)
      }
    } else {
      const question =
        row.kind === 'catchup'
          ? 'Catch me up: in a few short bullets, what has happened so far? End with one line on what is being discussed right now.'
          : row.question
      const { data: prior } = await state.client
        .from('asks')
        .select('question,answer')
        .eq('attendee_id', row.attendee_id)
        .eq('kind', 'ask')
        .eq('status', 'answered')
        .order('created_at', { ascending: false })
        .limit(4)
      const history = (prior ?? [])
        .reverse()
        .flatMap((p) => [
          { role: 'user' as const, content: p.question as string, at: 0 },
          { role: 'assistant' as const, content: (p.answer as string) ?? '', at: 0 }
        ])
      answer = await streamChatGeneric({
        keys: getKeys(),
        system: buildAttendeeSystem({
          persona: att.persona,
          lang: att.lang,
          segments,
          materialsText: store.getMaterialsText(state.eventId),
          preEvent: state.sessionId === null
        }),
        history,
        question,
        onDelta: () => undefined
      })
    }
    await state.client
      .from('asks')
      .update({ status: 'answered', answer, answered_at: new Date().toISOString() })
      .eq('id', row.id)
    state.askCount++
  } catch {
    await state.client
      .from('asks')
      .update({ status: 'error', answer: 'Sitka could not answer — try again.' })
      .eq('id', row.id)
      .then(() => undefined)
      .catch(() => undefined)
  } finally {
    state.answering.delete(row.id)
  }
}

interface QuestionRow {
  id: string
  text: string
  force: boolean
}

async function reviewCloudQuestion(row: QuestionRow): Promise<void> {
  if (!cloud) return
  const state = cloud
  try {
    if (row.force) {
      await state.client
        .from('speaker_questions')
        .update({ status: 'submitted', refined: row.text, topic: 'General' })
        .eq('id', row.id)
      notifyHost()
      return
    }
    const review = await reviewQuestionWith(getKeys(), row.text, cloudSegments())
    if (review.answeredAt && review.answer) {
      await state.client
        .from('speaker_questions')
        .update({
          status: 'already_answered',
          answered_at_label: review.answeredAt,
          answer: review.answer,
          refined: review.refined ?? row.text,
          topic: review.topic ?? 'General'
        })
        .eq('id', row.id)
    } else {
      await state.client
        .from('speaker_questions')
        .update({
          status: 'submitted',
          refined: review.refined ?? row.text,
          topic: review.topic ?? 'General'
        })
        .eq('id', row.id)
      notifyHost()
    }
  } catch {
    await state.client
      .from('speaker_questions')
      .update({ status: 'error' })
      .eq('id', row.id)
      .then(() => undefined)
      .catch(() => undefined)
  } finally {
    state.answering.delete(row.id)
  }
}

// ---------- the poll loop (asks, questions, stats) ----------

async function pollCloud(): Promise<void> {
  if (!cloud) return
  const state = cloud
  try {
    // pending work
    const [{ data: asks }, { data: qs }] = await Promise.all([
      state.client
        .from('asks')
        .select('id,attendee_id,kind,question')
        .eq('event_id', state.eventId)
        .eq('status', 'pending')
        .limit(6),
      state.client
        .from('speaker_questions')
        .select('id,text,force')
        .eq('event_id', state.eventId)
        .eq('status', 'checking')
        .limit(6)
    ])
    for (const row of (asks ?? []) as AskRow[]) {
      if (state.answering.size >= 3 || state.answering.has(row.id)) continue
      state.answering.add(row.id)
      void answerAsk(row)
    }
    for (const row of (qs ?? []) as QuestionRow[]) {
      if (state.answering.has(row.id)) continue
      state.answering.add(row.id)
      void reviewCloudQuestion(row)
    }

    // stats + attendee language roster (drives which translations run)
    const { data: atts } = await state.client
      .from('attendees')
      .select('id,persona,lang')
      .eq('event_id', state.eventId)
    const prevCount = state.attendeeCount
    state.attendeeCount = atts?.length ?? state.attendeeCount
    for (const a of atts ?? []) {
      state.attendeeCache.set(a.id as string, {
        persona: (a.persona as string) || 'Curious attendee',
        lang: (a.lang as string) || 'English'
      })
    }
    const { data: subs } = await state.client
      .from('speaker_questions')
      .select('id,refined,text,topic,created_at')
      .eq('event_id', state.eventId)
      .eq('status', 'submitted')
      .order('created_at', { ascending: true })
    const qids = (subs ?? []).map((q) => q.id as string)
    const voteCount = new Map<string, number>()
    if (qids.length > 0) {
      const { data: qv } = await state.client
        .from('question_votes')
        .select('question_id')
        .in('question_id', qids)
      for (const v of qv ?? []) {
        const k = v.question_id as string
        voteCount.set(k, (voteCount.get(k) ?? 0) + 1)
      }
    }
    const byTopic = new Map<string, { text: string; at: number; votes: number }[]>()
    for (const q of subs ?? []) {
      const topic = (q.topic as string) || 'General'
      const list = byTopic.get(topic) ?? []
      list.push({
        text: (q.refined as string) || (q.text as string),
        at: new Date(q.created_at as string).getTime(),
        votes: voteCount.get(q.id as string) ?? 0
      })
      byTopic.set(topic, list)
    }
    state.questions = [...byTopic.entries()]
      .map(([topic, items]) => ({ topic, items: items.sort((a, b) => b.votes - a.votes) }))
      .sort((a, b) => b.items.length - a.items.length)

    // reactions + latest poll (may not exist before wave2.sql runs — ignore errors)
    try {
      const { data: reacts } = await state.client
        .from('reactions')
        .select('kind,at')
        .eq('event_id', state.eventId)
      let landed = 0
      let lost = 0
      let recentLost = 0
      const cutoff = Date.now() - 180000
      for (const r of reacts ?? []) {
        if (r.kind === 'landed') landed++
        else {
          lost++
          if (new Date(r.at as string).getTime() > cutoff) recentLost++
        }
      }
      state.reactions = { landed, lost, recentLost }
      const { data: pollRows } = await state.client
        .from('polls')
        .select('*')
        .eq('event_id', state.eventId)
        .order('created_at', { ascending: false })
        .limit(1)
      if (pollRows && pollRows.length > 0) {
        const p = pollRows[0]
        const options = (p.options as string[]) ?? []
        const counts = options.map(() => 0)
        const { data: pv } = await state.client
          .from('poll_votes')
          .select('choice')
          .eq('poll_id', p.id)
        for (const v of pv ?? []) {
          const idx = Number(v.choice)
          if (idx >= 0 && idx < counts.length) counts[idx]++
        }
        state.poll = {
          id: p.id as string,
          question: p.question as string,
          options,
          counts,
          total: (pv ?? []).length,
          status: (p.status as 'open' | 'closed') ?? 'open'
        }
      } else {
        state.poll = null
      }
    } catch {
      /* wave2 tables missing — features stay dormant */
    }
    if (state.attendeeCount !== prevCount) notifyHost()

    // sweep any segments the instant-push missed
    void pushCloudSegments()
  } catch {
    /* offline blip — next poll retries */
  }
}

// ---------- lifecycle ----------

async function generateCloudProxyBriefs(
  client: SupabaseClient,
  evId: string,
  sessionId: string
): Promise<void> {
  try {
    const { data: rows } = await client
      .from('proxies')
      .select('attendee_id,request')
      .eq('event_id', evId)
      .eq('status', 'pending')
      .limit(40)
    if (!rows || rows.length === 0) return
    const segments = store.getTranscript(sessionId)
    const materials = store.getMaterialsText(evId) ?? ''
    for (const p of rows) {
      try {
        const system = [
          'You attended a live event on behalf of someone who could not be there. Write their personal brief.',
          `They told you what they care about:\n"${p.request}"`,
          'Structure: open with 2-3 sentences on the event overall; then "## What happened about your topics" — address EACH thing they asked for, citing moments as [[M:SS]] where discussed, or say plainly it was not covered (answer from the materials if you can); end with "## Worth knowing anyway" — 2-3 bullets of other important moments.',
          'Be specific and grounded — never invent coverage that did not happen.',
          materials ? `\nEvent materials:\n${materials.slice(0, 8000)}` : ''
        ]
          .filter(Boolean)
          .join('\n')
        const brief = await completeText(
          getKeys(),
          system,
          segments.map((s) => `[${formatTime(s.start)}] ${s.text}`).join('\n')
        )
        await client.from('proxies').update({ status: 'ready', brief }).eq('attendee_id', p.attendee_id)
      } catch {
        await client.from('proxies').update({ status: 'error' }).eq('attendee_id', p.attendee_id)
      }
    }
  } catch {
    /* proxies table missing — dormant */
  }
}

export function endCloudEvent(sessionId: string): void {
  if (!cloud || cloud.sessionId !== sessionId) return
  const state = cloud
  store.saveReport(sessionId, {
    joined: state.attendeeCount,
    peak: state.attendeeCount,
    aiAsks: state.askCount,
    questions: state.questions,
    agenda: store.getMeta(sessionId)?.agenda,
    endedAt: Date.now()
  })
  const event = store.getEvent(state.eventId)
  void state.client
    .from('events')
    .upsert(event ? eventRow(event, 'ended', sessionId) : { id: state.eventId, status: 'ended' })
    .then(() => undefined)
    .catch(() => undefined)
  void generateCloudProxyBriefs(state.client, state.eventId, sessionId)
}

function stopCloudPolling(): void {
  if (cloud) clearInterval(cloud.pollTimer)
}

export function stopCloud(): void {
  stopCloudPolling()
  cloud = null
}

export function cloudStatus(): {
  running: boolean
  url?: string
  ended?: boolean
  waiting?: boolean
  eventId?: string
  attendees?: number
  recentAsks?: number
  questions?: { topic: string; items: { text: string; at: number; votes?: number }[] }[]
  reactions?: { landed: number; lost: number; recentLost: number }
  poll?: {
    id: string
    question: string
    options: string[]
    counts: number[]
    total: number
    status: 'open' | 'closed'
  }
} {
  if (!cloud) return { running: false }
  return {
    running: true,
    url: cloud.url,
    ended: false,
    waiting: cloud.sessionId === null,
    eventId: cloud.eventId,
    attendees: cloud.attendeeCount,
    recentAsks: cloud.askCount,
    questions: cloud.questions,
    reactions: cloud.reactions,
    poll: cloud.poll ?? undefined
  }
}

export async function cloudLaunchPoll(
  question: string,
  options: string[]
): Promise<{ error?: string }> {
  if (!cloud) return { error: 'Go live on an online event first.' }
  const cleanOpts = options.map((o) => o.trim()).filter(Boolean).slice(0, 6)
  if (!question.trim() || cleanOpts.length < 2) {
    return { error: 'A poll needs a question and at least two options.' }
  }
  try {
    await cloud.client
      .from('polls')
      .update({ status: 'closed' })
      .eq('event_id', cloud.eventId)
      .eq('status', 'open')
    const { error } = await cloud.client.from('polls').insert({
      id: randomUUID(),
      event_id: cloud.eventId,
      question: question.trim().slice(0, 200),
      options: cleanOpts,
      status: 'open'
    })
    if (error) return { error: error.message }
    return {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Room's Mind: cluster the audience's private questions into live themes. */
export async function cloudRoomMind(
  sessionId: string
): Promise<{ themes: { topic: string; count: number }[]; error?: string }> {
  if (!cloud || cloud.sessionId !== sessionId) return { themes: [] }
  try {
    const { data: asks } = await cloud.client
      .from('asks')
      .select('question,created_at')
      .eq('event_id', cloud.eventId)
      .eq('kind', 'ask')
      .order('created_at', { ascending: false })
      .limit(40)
    const recent = (asks ?? []).filter(
      (a) => Date.now() - new Date(a.created_at as string).getTime() < 20 * 60000
    )
    if (recent.length < 3) return { themes: [] }
    const system = [
      'You are analyzing the PRIVATE questions a live audience is asking their AI companions during a talk — the speaker cannot see them individually. Your job: reveal what the room is collectively struggling with or curious about, without exposing anyone.',
      'Cluster the questions into at most 4 themes.',
      'Return ONLY JSON: {"themes": [{"topic": "2-5 word label", "count": <number of questions in this theme>}]}',
      'Order by count, largest first. Merge near-duplicates.'
    ].join('\n')
    const out = await completeText(
      getKeys(),
      system,
      recent.map((a, i) => `${i + 1}. ${a.question}`).join('\n')
    )
    const parsed = extractJson<{ themes?: { topic?: string; count?: number }[] }>(out)
    return {
      themes: (parsed?.themes ?? [])
        .filter((t) => t.topic)
        .map((t) => ({ topic: String(t.topic), count: Math.max(1, Number(t.count) || 1) }))
        .slice(0, 4)
    }
  } catch {
    return { themes: [] }
  }
}

export async function cloudRoomRecap(
  sessionId: string,
  topic: string
): Promise<{ text?: string; error?: string }> {
  try {
    const segments = store.getTranscript(sessionId)
    const system = [
      `A live audience is collectively struggling with: "${topic}". Using the transcript, write a crystal-clear recap of that point in 3-5 short sentences, as if explaining it fresh to someone who just got lost.`,
      'Plain text, no markdown headings, no preamble — it may be read aloud by the speaker or pushed to every attendee phone.'
    ].join('\n')
    const text = await completeText(
      getKeys(),
      system,
      segments
        .slice(-80)
        .map((s) => `[${formatTime(s.start)}] ${s.text}`)
        .join('\n')
    )
    return { text: text.trim() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function cloudPushRoomNote(text: string): Promise<{ error?: string }> {
  if (!cloud) return { error: 'Go live first.' }
  const { error } = await cloud.client.from('room_notes').insert({
    id: randomUUID(),
    event_id: cloud.eventId,
    text: text.trim().slice(0, 1200)
  })
  return error ? { error: error.message } : {}
}

/** Publish (or unpublish) a hosted session's recording as a public replay page. */
export async function cloudPublishReplay(
  sessionId: string,
  enable: boolean
): Promise<{ url?: string; enabled?: boolean; error?: string }> {
  const meta = store.getMeta(sessionId)
  if (!meta) return { error: 'Session not found.' }
  if (!meta.eventId) {
    return { error: 'Only sessions hosted as events can be published as replays.' }
  }
  try {
    const client = cloud?.client ?? makeClient()
    if (!enable) {
      await client
        .from('events')
        .update({ replay: { enabled: false }, updated_at: new Date().toISOString() })
        .eq('id', meta.eventId)
      return { enabled: false }
    }
    const { readFile } = await import('fs/promises')
    let video: Buffer
    try {
      video = await readFile(store.videoPath(sessionId))
    } catch {
      return { error: 'No recording found for this session.' }
    }
    const { error } = await client.storage
      .from('replays')
      .upload(`${meta.eventId}.webm`, video, { upsert: true, contentType: 'video/webm' })
    if (error) return { error: 'Upload failed: ' + error.message }
    await client
      .from('events')
      .update({
        replay: {
          enabled: true,
          title: meta.title,
          summary: meta.summary ?? '',
          highlights: meta.highlights ?? [],
          durationMs: meta.durationMs,
          publishedAt: Date.now()
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', meta.eventId)
    return { enabled: true, url: webUrlFor(meta.eventId).replace('/e/', '/r/') }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function cloudClosePoll(): Promise<void> {
  if (!cloud) return
  await cloud.client
    .from('polls')
    .update({ status: 'closed' })
    .eq('event_id', cloud.eventId)
    .eq('status', 'open')
    .then(() => undefined)
    .catch(() => undefined)
}
