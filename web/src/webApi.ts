/**
 * Cloud backend for the full Sitka web app.
 * Implements the complete window.sitka surface (the Electron preload API)
 * against Supabase (data + storage) and the /api AI proxies, so the untouched
 * desktop renderer runs online. The signed-in user's browser tab is the brain:
 * it captures, transcribes, answers attendees, and stores everything here.
 */
import type { SupabaseClient, User } from '@supabase/supabase-js'
import type { SitkaApi } from '../../src/preload/index'
import {
  memorySystemPrompt,
  memoryTranscript,
  mergeMemory,
  type MemoryExtraction
} from '../../src/shared/memoryLogic'
import type {
  AiStreamEvent,
  AskRequest,
  BrainAskRequest,
  BrainConversation,
  BrainSearchHit,
  BrainStats,
  ChatMessage,
  CoachBrief,
  CoachProject,
  CoachRehearsal,
  CoachScores,
  EventReport,
  MemoryObject,
  ScheduledEvent,
  SessionData,
  SessionMeta,
  SessionNotes,
  Settings,
  SimDifficulty,
  StudyPack,
  TranscribeResult,
  TranscriptSegment
} from '../../src/shared/types'

const ALL_LANGS = [
  'Shona', 'Ndebele', 'Swahili', 'French', 'Portuguese',
  'Spanish', 'German', 'Arabic', 'Chinese', 'Hindi'
]

// ---------- small helpers ----------
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
function transcriptBlock(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '(No speech has been transcribed yet.)'
  return segments.map((s) => `[${formatTime(s.start)}] ${s.text.trim()}`).join('\n')
}
function extractJson<T>(text: string): T | null {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(text.slice(a, b + 1)) as T
  } catch {
    return null
  }
}
function uid(): string {
  return crypto.randomUUID()
}
function downloadText(name: string, text: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  a.download = name
  a.click()
}

export async function installWebApi(sb: SupabaseClient): Promise<void> {
  const { data: sess } = await sb.auth.getSession()
  const user: User = sess!.session!.user

  // Does this deployment provide platform AI keys? (Users then need none.)
  let platform = { chat: false, stt: false }
  try {
    const r = await fetch('/api/health')
    if (r.ok) platform = { ...platform, ...(await r.json()) }
  } catch {
    /* offline — user keys still work */
  }

  // ---------- settings (AI keys live only in this browser) ----------
  const SETTINGS_KEY = 'sitka-web-settings'
  // The interface treats a non-empty key as "AI available". When the
  // deployment's platform keys cover the user, expose this placeholder so
  // every AI feature lights up; it is stripped before any real use.
  const PLATFORM = 'platform-managed'
  const real = (k: string): string => (k === PLATFORM ? '' : k)
  function storedSettings(): Settings {
    const base: Settings = {
      anthropicApiKey: '',
      openaiApiKey: '',
      groqApiKey: '',
      supabaseUrl: '',
      supabaseServiceKey: '',
      webAppUrl: location.origin
    }
    try {
      const s = { ...base, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<Settings>) }
      s.anthropicApiKey = real(s.anthropicApiKey)
      s.openaiApiKey = real(s.openaiApiKey)
      s.groqApiKey = real(s.groqApiKey)
      return s
    } catch {
      return base
    }
  }
  function getSettings(): Settings {
    const s = storedSettings()
    if (!s.anthropicApiKey && !s.groqApiKey && platform.chat) s.groqApiKey = PLATFORM
    if (!s.openaiApiKey && !s.groqApiKey && platform.stt) s.groqApiKey = PLATFORM
    return s
  }

  async function aiChat(
    system: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
    maxTokens = 2000
  ): Promise<string> {
    const k = storedSettings()
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys: { anthropicApiKey: k.anthropicApiKey, groqApiKey: k.groqApiKey },
        system,
        messages,
        maxTokens
      })
    })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'AI error')
    return j.text || ''
  }
  function hasChatKey(): boolean {
    const k = storedSettings()
    return Boolean(k.anthropicApiKey || k.groqApiKey) || platform.chat
  }
  function hasSttKey(): boolean {
    const k = storedSettings()
    return Boolean(k.openaiApiKey || k.groqApiKey) || platform.stt
  }

  // ---------- event emitters ----------
  const aiListeners = new Set<(e: AiStreamEvent) => void>()
  const markListeners = new Set<(p: { sessionId: string; time: number }) => void>()
  const confListeners = new Set<() => void>()
  const sessListeners = new Set<(m: SessionMeta) => void>()
  const emitAi = (e: AiStreamEvent): void => aiListeners.forEach((cb) => cb(e))
  const emitConf = (): void => confListeners.forEach((cb) => cb())
  const emitSession = (m: SessionMeta): void => sessListeners.forEach((cb) => cb(m))

  // ---------- session store (Supabase rows, cached per open session) ----------
  const cache = new Map<string, SessionData>()
  interface Row {
    id: string
    meta: SessionMeta
    transcript: TranscriptSegment[]
    chat: ChatMessage[]
    notes: SessionNotes | null
    study: StudyPack | null
    marks: number[]
    report: EventReport | null
    thumb: string | null
  }
  function rowToData(r: Row): SessionData {
    return {
      meta: r.meta,
      segments: r.transcript || [],
      chat: r.chat || [],
      notes: r.notes || null,
      study: r.study || null,
      marks: r.marks || [],
      report: r.report || null
    }
  }
  async function loadSession(id: string): Promise<SessionData | null> {
    const c = cache.get(id)
    if (c) return c
    const { data } = await sb.from('sessions').select('*').eq('id', id).single()
    if (!data) return null
    const d = rowToData(data as Row)
    cache.set(id, d)
    return d
  }
  async function patchSession(id: string, patch: Record<string, unknown>): Promise<void> {
    await sb
      .from('sessions')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
  }

  // Recording buffers: chunks are uploaded as rolling ~8MB parts DURING the
  // recording, so a crashed tab loses seconds — not the session — and no
  // single file ever hits the storage size cap.
  interface RecBuf {
    parts: number
    chunks: ArrayBuffer[]
    bytes: number
    thumbDone: boolean
    chain: Promise<void>
  }
  const recBuf = new Map<string, RecBuf>()
  const PART_BYTES = 8 * 1024 * 1024
  let recordingState: { id: string; startedAt: number } | null = null

  function videoPath(id: string): string {
    return `${user.id}/${id}.webm`
  }
  function partPath(id: string, n: number): string {
    return `${user.id}/${id}/part-${String(n).padStart(4, '0')}.webm`
  }

  function flushPart(id: string, force: boolean): void {
    const b = recBuf.get(id)
    if (!b || b.chunks.length === 0) return
    if (!force && b.bytes < PART_BYTES) return
    const chunks = b.chunks
    const bytes = b.bytes
    const partNo = b.parts
    b.chunks = []
    b.bytes = 0
    b.parts++
    b.chain = b.chain.then(async () => {
      const blob = new Blob(chunks, { type: 'video/webm' })
      try {
        const { error } = await sb.storage
          .from('recordings')
          .upload(partPath(id, partNo), blob, { upsert: true, contentType: 'video/webm' })
        if (error) throw error
        if (!b.thumbDone && partNo === 0) {
          b.thumbDone = true
          const thumb = await makeThumb(blob)
          if (thumb) await patchSession(id, { thumb })
        }
      } catch {
        // Upload failed (offline blip): put the data back for the next flush.
        b.chunks = chunks.concat(b.chunks)
        b.bytes += bytes
        b.parts = partNo
      }
    })
  }

  async function makeThumb(blob: Blob): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const v = document.createElement('video')
        v.muted = true
        v.src = URL.createObjectURL(blob)
        const done = (out: string | null): void => {
          URL.revokeObjectURL(v.src)
          resolve(out)
        }
        v.onloadeddata = () => {
          v.currentTime = Math.min(1.2, (v.duration || 2) / 2)
        }
        v.onseeked = () => {
          try {
            const c = document.createElement('canvas')
            const scale = Math.min(1, 480 / (v.videoWidth || 480))
            c.width = Math.round((v.videoWidth || 480) * scale)
            c.height = Math.round((v.videoHeight || 270) * scale)
            c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
            done(c.toDataURL('image/jpeg', 0.72))
          } catch {
            done(null)
          }
        }
        v.onerror = () => done(null)
        setTimeout(() => done(null), 8000)
      } catch {
        resolve(null)
      }
    })
  }

  // ---------- ask prompts (mirrors the desktop ai.ts) ----------
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
      '- Formatting: plain sentences, **bold** for key terms, "-" bullets for genuine lists, and numbered lists for steps. Use markdown headings (## or ###) only in long structured answers like notes or study guides. Use a markdown table only when the user explicitly asks for a table or comparison. Never use LaTeX — write any math in plain text.',
      '- Do not end answers with offers like "let me know if you want more" — just answer.',
      '',
      'Transcript of the session (each line is prefixed with its start time):'
    ].join('\n')
  }
  function attendeeSystemPrompt(
    persona: string,
    lang: string,
    segments: TranscriptSegment[],
    materials: string,
    preEvent: boolean
  ): string {
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
      '- When you reference a specific moment of the talk, cite it inline with the exact format [[M:SS]] using a single timestamp that appears in the transcript (for example [[12:37]]). Plain ASCII double square brackets only. The app turns these into tappable links.',
      '- Match the length of your answer to the question: short and direct by default; structure only for catch-ups and summaries.',
      '- Formatting: **bold** for key terms, "-" bullets for genuine lists, "## " headings only in long answers, tables only for comparisons. This renders on a phone — keep it tight.',
      '- Do not end answers with offers like "let me know if you want more" — just answer.',
      materials ? `\nEvent materials shared by the host:\n${materials.slice(0, 14000)}` : '',
      preEvent ? '' : `\nTranscript so far:\n${transcriptBlock(segments)}`
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ---------- live audience (this tab is the conference brain) ----------
  interface ConfPoll {
    id: string
    question: string
    options: string[]
    counts: number[]
    total: number
    status: 'open' | 'closed'
  }
  interface Conf {
    eventId: string
    sessionId: string
    url: string
    workTimer: number
    statsTimer: number
    answering: Set<string>
    attendeeLangs: Map<string, string>
    attendeeCount: number
    askCount: number
    questions: { topic: string; items: { text: string; at: number; votes?: number }[] }[]
    reactions: { landed: number; lost: number; recentLost: number }
    poll: ConfPoll | null
    translated: Map<string, number>
    frameBusy: boolean
  }
  let conf: Conf | null = null
  /** Online events are always reachable; this tracks which one the Events page presents as armed. */
  let armedId: string | null = null

  async function eventMaterialsText(eventId: string): Promise<string> {
    const { data } = await sb.from('events').select('materials_text').eq('id', eventId).single()
    return (data?.materials_text as string) || ''
  }
  function confSegments(): TranscriptSegment[] {
    if (!conf) return []
    return cache.get(conf.sessionId)?.segments ?? []
  }

  async function confAnswerAsk(row: {
    id: string
    attendee_id: string
    kind: string
    question: string
  }): Promise<void> {
    if (!conf) return
    const c = conf
    try {
      const { data: att } = await sb
        .from('attendees')
        .select('persona,lang')
        .eq('id', row.attendee_id)
        .single()
      const persona = (att?.persona as string) || 'Curious attendee'
      const lang = (att?.lang as string) || 'English'
      const segments = confSegments()
      let answer: string
      if (row.kind === 'pack') {
        const system = [
          'Create a take-home pack for an audience member from this event transcript.',
          lang.toLowerCase() !== 'english' ? `Write EVERYTHING in ${lang}.` : '',
          'Return ONLY JSON: {"summary": string, "takeaways": [string]} — summary is 3-5 sentences; takeaways are 4-7 short bullet points.'
        ]
          .filter(Boolean)
          .join('\n')
        const out = await aiChat(system, [{ role: 'user', content: transcriptBlock(segments) }])
        const parsed = extractJson<{ summary?: string; takeaways?: string[] }>(out)
        answer = JSON.stringify({
          summary: parsed?.summary ?? 'Summary unavailable.',
          takeaways: Array.isArray(parsed?.takeaways) ? parsed.takeaways.map(String) : [],
          moments: []
        })
      } else {
        const question =
          row.kind === 'catchup'
            ? 'Catch me up: in a few short bullets, what has happened so far? End with one line on what is being discussed right now.'
            : row.question
        const { data: prior } = await sb
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
            { role: 'user' as const, content: p.question as string },
            { role: 'assistant' as const, content: (p.answer as string) || '' }
          ])
        const materials = await eventMaterialsText(c.eventId)
        answer = await aiChat(attendeeSystemPrompt(persona, lang, segments, materials, false), [
          ...history,
          { role: 'user', content: question }
        ])
      }
      await sb
        .from('asks')
        .update({ status: 'answered', answer, answered_at: new Date().toISOString() })
        .eq('id', row.id)
      c.askCount++
    } catch {
      await sb
        .from('asks')
        .update({ status: 'error', answer: 'Sitka could not answer — try again.' })
        .eq('id', row.id)
    } finally {
      c.answering.delete(row.id)
    }
  }

  async function confReviewQuestion(row: {
    id: string
    text: string
    force: boolean
  }): Promise<void> {
    if (!conf) return
    const c = conf
    try {
      if (row.force) {
        await sb
          .from('speaker_questions')
          .update({ status: 'submitted', refined: row.text, topic: 'General' })
          .eq('id', row.id)
        emitConf()
        return
      }
      const system = [
        'An audience member wants to submit a question to the speaker of a live event. You are given the transcript so far.',
        'Return ONLY JSON: {"answeredAt": "M:SS" | null, "answer": string | null, "refined": string, "topic": string}',
        '- If the speaker already clearly addressed this question, set answeredAt to the transcript timestamp where, and answer to a 1-2 sentence summary. Otherwise both null.',
        '- refined: the question rewritten to be clear and concise. topic: a 2-4 word topic label.'
      ].join('\n')
      const out = await aiChat(system, [
        { role: 'user', content: `Question: ${row.text}\n\nTranscript:\n${transcriptBlock(confSegments())}` }
      ])
      const review = extractJson<{
        answeredAt?: string | null
        answer?: string | null
        refined?: string
        topic?: string
      }>(out)
      if (review?.answeredAt && review.answer) {
        await sb
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
        await sb
          .from('speaker_questions')
          .update({
            status: 'submitted',
            refined: review?.refined ?? row.text,
            topic: review?.topic ?? 'General'
          })
          .eq('id', row.id)
        emitConf()
      }
    } catch {
      await sb.from('speaker_questions').update({ status: 'error' }).eq('id', row.id)
    } finally {
      c.answering.delete(row.id)
    }
  }

  async function confPollWork(): Promise<void> {
    if (!conf || !hasChatKey()) return
    const c = conf
    const [{ data: asks }, { data: qs }] = await Promise.all([
      sb.from('asks').select('id,attendee_id,kind,question').eq('event_id', c.eventId).eq('status', 'pending').limit(4),
      sb.from('speaker_questions').select('id,text,force').eq('event_id', c.eventId).eq('status', 'checking').limit(4)
    ])
    for (const row of (asks ?? []) as { id: string; attendee_id: string; kind: string; question: string }[]) {
      if (c.answering.size >= 2 || c.answering.has(row.id)) continue
      c.answering.add(row.id)
      void confAnswerAsk(row)
    }
    for (const row of (qs ?? []) as { id: string; text: string; force: boolean }[]) {
      if (c.answering.has(row.id)) continue
      c.answering.add(row.id)
      void confReviewQuestion(row)
    }
  }

  async function confPollStats(): Promise<void> {
    if (!conf) return
    const c = conf
    const { data: atts } = await sb.from('attendees').select('id,lang').eq('event_id', c.eventId)
    const prev = c.attendeeCount
    c.attendeeCount = atts?.length ?? c.attendeeCount
    for (const a of atts ?? []) c.attendeeLangs.set(a.id as string, (a.lang as string) || 'English')
    const { data: subs } = await sb
      .from('speaker_questions')
      .select('id,refined,text,topic,created_at')
      .eq('event_id', c.eventId)
      .eq('status', 'submitted')
      .order('created_at', { ascending: true })
    // upvote counts per question
    const qids = (subs ?? []).map((q) => q.id as string)
    const voteCount = new Map<string, number>()
    if (qids.length > 0) {
      const { data: qv } = await sb
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
    c.questions = [...byTopic.entries()]
      .map(([topic, items]) => ({ topic, items: items.sort((a, b) => b.votes - a.votes) }))
      .sort(
        (a, b) =>
          b.items.reduce((n, i) => n + i.votes, 0) + b.items.length -
          (a.items.reduce((n, i) => n + i.votes, 0) + a.items.length)
      )

    // reactions: totals + "lost" in the last 3 minutes (the pulse signal)
    const { data: reacts } = await sb
      .from('reactions')
      .select('kind,at')
      .eq('event_id', c.eventId)
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
    c.reactions = { landed, lost, recentLost }

    // latest poll + live tallies
    const { data: pollRows } = await sb
      .from('polls')
      .select('*')
      .eq('event_id', c.eventId)
      .order('created_at', { ascending: false })
      .limit(1)
    if (pollRows && pollRows.length > 0) {
      const p = pollRows[0]
      const options = (p.options as string[]) ?? []
      const counts = options.map(() => 0)
      const { data: pv } = await sb.from('poll_votes').select('choice').eq('poll_id', p.id)
      for (const v of pv ?? []) {
        const idx = Number(v.choice)
        if (idx >= 0 && idx < counts.length) counts[idx]++
      }
      c.poll = {
        id: p.id as string,
        question: p.question as string,
        options,
        counts,
        total: (pv ?? []).length,
        status: (p.status as 'open' | 'closed') ?? 'open'
      }
    } else {
      c.poll = null
    }
    if (c.attendeeCount !== prev) emitConf()
  }

  async function confPushSegments(newSegs: TranscriptSegment[], startIdx: number): Promise<void> {
    if (!conf) return
    const c = conf
    const rows = newSegs.map((s, i) => ({
      event_id: c.eventId,
      idx: startIdx + i,
      start_sec: s.start,
      label: formatTime(s.start),
      text: s.text
    }))
    await sb.from('segments').insert(rows)
    // translations for the languages attendees actually joined with
    const { data: ev } = await sb.from('events').select('live_voice').eq('id', c.eventId).single()
    const vc = (ev?.live_voice as { enabled: boolean; languages: string[] }) ?? {
      enabled: true,
      languages: ALL_LANGS
    }
    if (!vc.enabled) return
    const all = confSegments()
    const langs = new Set<string>()
    for (const lang of c.attendeeLangs.values()) {
      if (lang.toLowerCase() !== 'english' && vc.languages.includes(lang)) langs.add(lang)
    }
    for (const lang of langs) {
      const done = c.translated.get(lang) ?? 0
      if (done >= all.length) continue
      const fresh = all.slice(done)
      const from = done
      c.translated.set(lang, all.length)
      try {
        const system = [
          `Translate each numbered line of live speech into ${lang}. Natural spoken style; keep names and numbers exact.`,
          `Return ONLY JSON: {"lines": [string]} with exactly ${fresh.length} entries, in order.`
        ].join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: fresh.map((s, i) => `${i + 1}. ${s.text}`).join('\n') }
        ])
        const parsed = extractJson<{ lines?: unknown[] }>(out)
        if (!parsed || !Array.isArray(parsed.lines)) continue
        const trows = fresh
          .map((_s, i) => ({ line: parsed.lines![i], idx: from + i }))
          .filter((r) => typeof r.line === 'string' && (r.line as string).trim())
          .map((r) => ({ event_id: c.eventId, lang, idx: r.idx, text: (r.line as string).trim() }))
        if (trows.length > 0) await sb.from('translations').insert(trows)
      } catch {
        /* skip batch */
      }
    }
  }

  async function generateProxyBriefs(evId: string, segments: TranscriptSegment[]): Promise<void> {
    try {
      const { data: rows } = await sb
        .from('proxies')
        .select('attendee_id,request')
        .eq('event_id', evId)
        .eq('status', 'pending')
        .limit(40)
      if (!rows || rows.length === 0) return
      const materials = await eventMaterialsText(evId)
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
          const brief = await aiChat(
            system,
            [{ role: 'user', content: transcriptBlock(segments) }],
            2200
          )
          await sb
            .from('proxies')
            .update({ status: 'ready', brief })
            .eq('attendee_id', p.attendee_id)
        } catch {
          await sb.from('proxies').update({ status: 'error' }).eq('attendee_id', p.attendee_id)
        }
      }
    } catch {
      /* proxies table missing or offline — feature stays dormant */
    }
  }

  async function endConf(sessionId: string): Promise<void> {
    if (!conf || conf.sessionId !== sessionId) return
    const c = conf
    clearInterval(c.workTimer)
    clearInterval(c.statsTimer)
    const report: EventReport = {
      joined: c.attendeeCount,
      peak: c.attendeeCount,
      aiAsks: c.askCount,
      questions: c.questions,
      agenda: cache.get(sessionId)?.meta.agenda,
      endedAt: Date.now()
    }
    const d = cache.get(sessionId)
    if (d) d.report = report
    await patchSession(sessionId, { report })
    await sb
      .from('events')
      .update({ status: 'ended', updated_at: new Date().toISOString() })
      .eq('id', c.eventId)
    void generateProxyBriefs(c.eventId, d?.segments ?? [])
    conf = null
  }

  // ---------- events table mapping ----------
  interface EvRow {
    id: string
    title: string
    status: string
    starts_at: string | null
    agenda: string[]
    pre_event_chat: boolean
    materials: { name: string; chars: number; text?: string }[]
    live_voice: { enabled: boolean; languages: string[] }
    session_id: string | null
    updated_at: string
  }
  function evRowToScheduled(r: EvRow): ScheduledEvent {
    return {
      id: r.id,
      title: r.title,
      startsAt: r.starts_at ? new Date(r.starts_at).getTime() : undefined,
      createdAt: new Date(r.updated_at).getTime(),
      agenda: r.agenda || [],
      materials: (r.materials || []).map((m) => ({ name: m.name, chars: m.chars })),
      preEventChat: r.pre_event_chat !== false,
      liveVoice: r.live_voice ?? { enabled: true, languages: ALL_LANGS },
      sessionId: r.session_id ?? undefined
    }
  }
  function eventUrl(id: string): string {
    return `${location.origin}/e/${id}`
  }
  async function saveEventMaterials(
    id: string,
    materials: { name: string; chars: number; text: string }[]
  ): Promise<ScheduledEvent | null> {
    const materialsText = materials.map((m) => `--- ${m.name} ---\n${m.text}`).join('\n\n')
    await sb
      .from('events')
      .update({
        materials,
        materials_text: materialsText || null,
        materials_present: materials.length > 0,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
    const { data } = await sb.from('events').select('*').eq('id', id).single()
    return data ? evRowToScheduled(data as EvRow) : null
  }
  function pickTextFile(): Promise<{ name: string; text: string } | null> {
    return new Promise((resolve) => {
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = '.txt,.md,.csv,.json,.vtt,.srt'
      inp.onchange = () => {
        const f = inp.files?.[0]
        if (!f) {
          resolve(null)
          return
        }
        const r = new FileReader()
        r.onload = () => resolve({ name: f.name, text: String(r.result || '') })
        r.onerror = () => resolve(null)
        r.readAsText(f)
      }
      inp.oncancel = () => resolve(null)
      inp.click()
    })
  }

  // ---------- brain (library intelligence, ranked client-side) ----------
  function tokenize(q: string): string[] {
    return q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)
  }
  async function allSessions(): Promise<Row[]> {
    const { data } = await sb
      .from('sessions')
      .select('id,meta,transcript,chat,notes,study,marks,report,thumb')
      .order('created_at', { ascending: false })
    return (data as Row[]) || []
  }
  function rankHits(rows: Row[], query: string, limit: number): BrainSearchHit[] {
    const toks = tokenize(query)
    if (toks.length === 0) return []
    const hits: (BrainSearchHit & { score: number })[] = []
    for (const r of rows) {
      for (const seg of r.transcript || []) {
        const lower = seg.text.toLowerCase()
        let score = 0
        for (const t of toks) if (lower.includes(t)) score++
        if (score > 0) {
          hits.push({
            sessionId: r.id,
            sessionTitle: r.meta.title,
            time: seg.start,
            snippet: seg.text.slice(0, 180),
            score
          })
        }
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit).map(({ score: _s, ...h }) => h)
  }

  // ---------- memory store (decisions, promises, people, concepts) ----------
  async function loadMemory(): Promise<MemoryObject[]> {
    const { data } = await sb.from('memory_objects').select('data').order('updated_at', { ascending: false })
    return ((data ?? []) as { data: MemoryObject }[]).map((r) => r.data)
  }
  async function saveMemoryList(list: MemoryObject[], previousIds: Set<string>): Promise<void> {
    const rows = list.map((o) => ({
      id: o.id,
      owner: user.id,
      data: o,
      updated_at: new Date(o.updatedAt).toISOString()
    }))
    if (rows.length > 0) await sb.from('memory_objects').upsert(rows)
    const gone = [...previousIds].filter((id) => !list.some((o) => o.id === id))
    if (gone.length > 0) await sb.from('memory_objects').delete().in('id', gone)
  }
  async function rememberSession(meta: SessionMeta, segments: TranscriptSegment[]): Promise<void> {
    if (segments.length < 6 || !hasChatKey()) return
    try {
      const existing = await loadMemory()
      const today = new Date().toISOString().slice(0, 10)
      const out = await aiChat(
        memorySystemPrompt(meta.kind, existing, today),
        [{ role: 'user', content: memoryTranscript(segments) }],
        2500
      )
      const parsed = extractJson<MemoryExtraction>(out)
      if (!parsed) return
      const merged = mergeMemory(existing, parsed, { id: meta.id, title: meta.title }, uid)
      await saveMemoryList(merged, new Set(existing.map((o) => o.id)))
    } catch {
      /* memory is best-effort — the session itself is already saved */
    }
  }

  // ---------- coach store ----------
  interface CoachRow {
    id: string
    data: CoachProject & { materialTexts?: { name: string; text: string }[] }
    sim: ChatMessage[]
  }
  async function loadCoach(id: string): Promise<CoachRow | null> {
    const { data } = await sb.from('coach_projects').select('*').eq('id', id).single()
    return (data as CoachRow) || null
  }
  async function saveCoach(row: CoachRow): Promise<void> {
    await sb
      .from('coach_projects')
      .update({ data: row.data, sim: row.sim, updated_at: new Date().toISOString() })
      .eq('id', row.id)
  }
  function coachContext(p: CoachRow['data']): string {
    const mats = (p.materialTexts || []).map((m) => `--- ${m.name} ---\n${m.text}`).join('\n\n')
    return [
      `Presentation: "${p.title}". Goal: ${p.goal || 'not specified'}. Audience: ${p.audience || 'general'}.`,
      mats ? `Materials:\n${mats.slice(0, 12000)}` : '(No materials uploaded yet.)'
    ].join('\n')
  }

  // ---------- the API ----------
  const api: SitkaApi = {
    getSettings: async () => getSettings(),
    setSettings: async (s: Settings) => {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          ...s,
          anthropicApiKey: real(s.anthropicApiKey.trim()),
          openaiApiKey: real(s.openaiApiKey.trim()),
          groqApiKey: real(s.groqApiKey.trim())
        })
      )
    },

    listSources: async () => [
      {
        id: 'browser-screen',
        name: 'Your screen — the browser will ask which one',
        thumbnail:
          'data:image/svg+xml;utf8,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" rx="12" fill="#26262a"/><rect x="40" y="34" width="240" height="92" rx="8" fill="none" stroke="#8a8a92" stroke-width="3"/><rect x="130" y="138" width="60" height="8" rx="4" fill="#8a8a92"/></svg>'
          ),
        kind: 'screen' as const
      }
    ],

    getThumb: async (id: string) => {
      const { data } = await sb.from('sessions').select('thumb').eq('id', id).single()
      return (data?.thumb as string) || null
    },

    createSession: async (title, kind, hosted, agenda, eventId) => {
      const meta: SessionMeta = {
        id: uid(),
        title: title || 'Untitled session',
        createdAt: Date.now(),
        durationMs: 0,
        status: 'recording',
        kind,
        hosted,
        agenda,
        eventId
      }
      await sb.from('sessions').insert({
        id: meta.id,
        owner: user.id,
        meta,
        transcript: [],
        chat: [],
        marks: []
      })
      cache.set(meta.id, {
        meta,
        segments: [],
        chat: [],
        notes: null,
        study: null,
        marks: [],
        report: null
      })
      recBuf.set(meta.id, {
        parts: 0,
        chunks: [],
        bytes: 0,
        thumbDone: false,
        chain: Promise.resolve()
      })
      return meta
    },

    hostCoverage: async (id: string) => {
      const d = await loadSession(id)
      if (!d || !d.meta.agenda?.length || !hasChatKey()) return { covered: [] }
      try {
        const system = [
          'You are checking which planned agenda topics a live speaker has already covered, from the transcript so far.',
          `Agenda:\n${d.meta.agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
          `Return ONLY JSON: {"covered": [boolean]} with exactly ${d.meta.agenda.length} entries, in agenda order.`
        ].join('\n')
        const out = await aiChat(system, [{ role: 'user', content: transcriptBlock(d.segments) }])
        const parsed = extractJson<{ covered?: unknown[] }>(out)
        if (parsed && Array.isArray(parsed.covered)) {
          return { covered: parsed.covered.map(Boolean) }
        }
      } catch {
        /* quiet */
      }
      return { covered: [] }
    },

    reportInsights: async (id: string) => {
      const d = await loadSession(id)
      if (!d?.report) return { error: 'No audience report for this session.' }
      if (d.report.insights) return { report: d.report }
      try {
        const system = [
          'You are analyzing a hosted live event for the speaker: transcript + audience data.',
          'Return ONLY JSON: {"overview": string, "coverage": [{"topic": string, "covered": boolean, "note": string}], "followUps": [string]}',
          '- overview: 3-4 sentences on how the event went, grounded in the data.',
          '- coverage: one entry per agenda topic (empty array if no agenda).',
          '- followUps: 3-5 concrete follow-up actions for the host.'
        ].join('\n')
        const userMsg = [
          `Agenda: ${(d.report.agenda ?? []).join('; ') || '(none)'}`,
          `Attendees joined: ${d.report.joined}. AI questions asked privately: ${d.report.aiAsks}.`,
          `Audience questions: ${d.report.questions.map((g) => `${g.topic}: ${g.items.map((i) => i.text).join(' | ')}`).join(' // ') || '(none)'}`,
          `Transcript:\n${transcriptBlock(d.segments)}`
        ].join('\n')
        const out = await aiChat(system, [{ role: 'user', content: userMsg }])
        const parsed = extractJson<EventReport['insights']>(out)
        if (parsed) {
          d.report.insights = parsed
          await patchSession(id, { report: d.report })
        }
        return { report: d.report }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    listSessions: async () => (await allSessions()).map((r) => r.meta),

    getSession: async (id: string) => loadSession(id),

    deleteSession: async (id: string) => {
      await sb.from('sessions').delete().eq('id', id)
      cache.delete(id)
      const { data: listing } = await sb.storage
        .from('recordings')
        .list(`${user.id}/${id}`, { limit: 1000 })
      const paths = (listing ?? []).map((f) => `${user.id}/${id}/${f.name}`)
      paths.push(videoPath(id))
      await sb.storage.from('recordings').remove(paths)
    },

    saveChat: async (id, chat) => {
      const d = await loadSession(id)
      if (d) d.chat = chat
      await patchSession(id, { chat })
    },

    appendChunk: async (id, chunk) => {
      const b = recBuf.get(id)
      if (!b) return
      b.chunks.push(chunk)
      b.bytes += chunk.byteLength
      flushPart(id, false)
    },

    readVideo: async (id, file = 'video') => {
      if (file === 'reel') return null
      // Part-based recordings: download every part and stitch them together.
      const { data: listing } = await sb.storage
        .from('recordings')
        .list(`${user.id}/${id}`, { limit: 1000, sortBy: { column: 'name', order: 'asc' } })
      if (listing && listing.length > 0) {
        const buffers: ArrayBuffer[] = []
        for (const f of listing) {
          const { data } = await sb.storage
            .from('recordings')
            .download(`${user.id}/${id}/${f.name}`)
          if (data) buffers.push(await data.arrayBuffer())
        }
        const total = buffers.reduce((n, b) => n + b.byteLength, 0)
        if (total > 0) {
          const out = new Uint8Array(total)
          let at = 0
          for (const b of buffers) {
            out.set(new Uint8Array(b), at)
            at += b.byteLength
          }
          return out
        }
      }
      // Legacy single-file recordings.
      const { data } = await sb.storage.from('recordings').download(videoPath(id))
      if (!data) return null
      return new Uint8Array(await data.arrayBuffer())
    },

    setRecordingState: async (state) => {
      recordingState = state
    },

    markNow: async () => {
      if (!recordingState) return
      const time = (Date.now() - recordingState.startedAt) / 1000
      const d = await loadSession(recordingState.id)
      if (!d) return
      d.marks.push(time)
      await patchSession(recordingState.id, { marks: d.marks })
      markListeners.forEach((cb) => cb({ sessionId: recordingState!.id, time }))
    },
    onSessionMarked: (cb) => {
      markListeners.add(cb)
      return () => markListeners.delete(cb)
    },

    generateReel: async () => ({ error: 'Highlight reels are not available on the web version yet — use the desktop app.' }),
    saveReel: async () => ({ error: 'Not available on the web version.' }),

    prepareSession: async (id: string) => (await loadSession(id))?.meta ?? null,

    renameSession: async (id, title) => {
      const d = await loadSession(id)
      if (!d) return null
      d.meta.title = title
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
      return d.meta
    },

    exportSession: async (id, kind) => {
      const text = await api.getExportText(id, kind)
      if (!text) return { error: 'Nothing to export yet.' }
      const d = await loadSession(id)
      downloadText(`${(d?.meta.title || 'sitka').replace(/[^\w-]+/g, '-')}-${kind}.md`, text)
      return { ok: true }
    },

    getExportText: async (id, kind) => {
      const d = await loadSession(id)
      if (!d) return null
      if (kind === 'transcript') {
        if (d.segments.length === 0) return null
        return `# ${d.meta.title} — transcript\n\n${d.segments.map((s) => `**[${formatTime(s.start)}]** ${s.text.trim()}`).join('\n\n')}`
      }
      if (kind === 'notes') {
        if (!d.notes) return null
        const moments = d.notes.moments
          .map((m) => `- ${m.kind === 'important' ? 'Important' : 'Question'} [${m.time}] ${m.label}`)
          .join('\n')
        return `# ${d.meta.title} — notes\n\n${d.notes.markdown}\n\n## Moments\n${moments}`
      }
      if (kind === 'study') {
        if (!d.study) return null
        return [
          `# ${d.meta.title} — study pack`,
          '## Key concepts',
          ...d.study.concepts.map((c) => `- **${c.term}** — ${c.definition}`),
          '## Flashcards',
          ...d.study.flashcards.map((f) => `- Q: ${f.front}\n  A: ${f.back}`),
          '## Quiz',
          ...d.study.quiz.map(
            (q, i) =>
              `${i + 1}. ${q.question}\n${q.options.map((o, j) => `   ${j === q.answerIndex ? '✓' : '-'} ${o}`).join('\n')}\n   _${q.explanation}_`
          )
        ].join('\n\n')
      }
      // overview
      const parts = [`# ${d.meta.title}`]
      if (d.meta.summary) parts.push(d.meta.summary)
      if (d.meta.highlights?.length) {
        parts.push('## Key moments', ...d.meta.highlights.map((h) => `- [${h.time}] ${h.label}`))
      }
      if (d.marks.length) {
        parts.push('## Your marks', ...d.marks.map((m) => `- [${formatTime(m)}]`))
      }
      return parts.length > 1 ? parts.join('\n\n') : null
    },

    finalizeSession: async (id, durationMs) => {
      recordingState = null
      const d = await loadSession(id)
      if (!d) return null
      d.meta.durationMs = durationMs
      d.meta.status = 'complete'
      await endConf(id)

      // Flush the tail of the recording and wait for every part to land.
      const b = recBuf.get(id)
      if (b) {
        flushPart(id, true)
        await b.chain
        if (b.chunks.length > 0) {
          // A part failed even after retry queuing — save it locally so nothing is lost.
          const blob = new Blob(b.chunks, { type: 'video/webm' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `${d.meta.title.replace(/[^\w-]+/g, '-')}-partial.webm`
          a.click()
        }
        recBuf.delete(id)
      }
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)

      // analysis in the background
      if (hasChatKey() && d.segments.length > 2) {
        void (async () => {
          try {
            const kindFocus =
              d.meta.kind === 'meeting'
                ? 'Focus on decisions made, action items, and who committed to what.'
                : d.meta.kind === 'lecture'
                  ? 'Focus on the core concepts taught and what is most likely to be examined.'
                  : 'Focus on the key messages and the moments that mattered.'
            const system = [
              'You analyze a timestamped transcript of a recorded session (lecture, meeting, presentation, or event).',
              kindFocus,
              'Return ONLY a JSON object, no prose and no code fences, with this exact shape:',
              '{"title": string, "summary": string, "highlights": [{"time": "M:SS", "label": string}]}',
              '- "title": a short, specific title for the session based on what it was about (max 8 words, no quotes inside).',
              '- "summary": 2-4 sentences capturing what the session was about and its most important points.',
              '- "highlights": 3-8 key moments worth revisiting, each with "time" copied exactly from a timestamp in the transcript (like "12:37") and a short label (max 10 words).'
            ].join('\n')
            const out = await aiChat(system, [{ role: 'user', content: transcriptBlock(d.segments) }])
            const parsed = extractJson<{
              title?: string
              summary?: string
              highlights?: { time: string; label: string }[]
            }>(out)
            if (parsed?.summary) {
              // Like the desktop app: the session is named after what it was about.
              if (parsed.title && String(parsed.title).trim()) {
                d.meta.title = String(parsed.title).trim().slice(0, 80)
              }
              d.meta.summary = parsed.summary
              d.meta.highlights = (parsed.highlights ?? []).slice(0, 10)
              d.meta.analyzed = true
              await patchSession(id, { meta: d.meta })
              emitSession(d.meta)
              // Memory: decisions, promises, people and concepts, pinned to their moments.
              await rememberSession(d.meta, d.segments)
            }
          } catch {
            /* analysis is best-effort */
          }
        })()
      }
      return d.meta
    },

    transcribeChunk: async (id, chunk, offsetSec) => {
      if (!hasSttKey()) return { error: 'missing-key' }
      try {
        const bytes = new Uint8Array(chunk)
        let bin = ''
        const step = 0x8000
        for (let i = 0; i < bytes.length; i += step) {
          bin += String.fromCharCode(...bytes.subarray(i, i + step))
        }
        const k = storedSettings()
        const r = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keys: { openaiApiKey: k.openaiApiKey, groqApiKey: k.groqApiKey },
            audioB64: btoa(bin),
            mime: 'audio/webm',
            offsetSec
          })
        })
        const j = await r.json()
        if (!r.ok) return { error: j.error || 'Transcription failed.' }
        const segments: TranscriptSegment[] = j.segments || []
        if (segments.length > 0) {
          const d = await loadSession(id)
          if (d) {
            const startIdx = d.segments.length
            d.segments.push(...segments)
            await patchSession(id, { transcript: d.segments })
            if (conf?.sessionId === id) void confPushSegments(segments, startIdx)
          }
        }
        return { segments }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    askAi: async (req: AskRequest) => {
      try {
        const d = await loadSession(req.sessionId)
        const segments = d?.segments ?? []
        let system: string
        if (req.host) {
          system = [
            'You are the host co-pilot for a live event — the speaker glances at you mid-talk.',
            'Be extremely terse: 1-3 short sentences, no headings, no fluff. Reference moments as [[M:SS]] when useful.',
            `Audience right now: ${conf?.attendeeCount ?? 0} connected, ${conf?.questions.reduce((n, g) => n + g.items.length, 0) ?? 0} questions waiting${conf?.questions[0] ? ` (top topic: ${conf.questions[0].topic})` : ''}.`,
            d?.meta.agenda?.length ? `Planned agenda: ${d.meta.agenda.join('; ')}` : '',
            `\nTranscript so far:\n${transcriptBlock(segments)}`
          ]
            .filter(Boolean)
            .join('\n')
        } else {
          system = `${askSystemPrompt(req.live)}\n${transcriptBlock(segments)}`
        }
        const history = req.history.slice(-10).map((m) => ({ role: m.role, content: m.content }))
        const text = await aiChat(system, [...history, { role: 'user', content: req.question }])
        emitAi({ requestId: req.requestId, type: 'delta', text })
        emitAi({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        emitAi({
          requestId: req.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },

    askBrain: async (req: BrainAskRequest) => {
      try {
        const rows = await allSessions()
        const hits = rankHits(rows, req.question, 40)
        const titleById = new Map(rows.map((r) => [r.id, r.meta.title]))
        const context =
          hits.length > 0
            ? hits
                .map((h) => `[[${h.sessionId.slice(0, 8)}@${formatTime(h.time)}]] (${h.sessionTitle}) ${h.snippet}`)
                .join('\n')
            : '(No matching moments found in the library.)'
        const idMap = new Map(rows.map((r) => [r.id.slice(0, 8), r.id]))
        const system = [
          'You are Sitka Overview — the intelligence over EVERYTHING this user has attended and recorded.',
          `Their library: ${rows.length} sessions — ${rows.map((r) => `"${r.meta.title}"`).slice(0, 20).join(', ')}.`,
          'Relevant moments retrieved from their sessions are below; each is tagged [[<id>@M:SS]].',
          'Rules: ground answers in the retrieved moments; cite them EXACTLY as [[<id>@M:SS]] (plain ASCII double brackets) so the app renders clickable links into those recordings. If the library does not cover something, say so.',
          'When the user asks what YOU think — an opinion, a critique, whether an idea holds up, what you would challenge or add — give a genuine, reasoned point of view drawing on your broader knowledge as well as their library. Never say you cannot have an opinion; make clear what is your assessment versus what was said.',
          'Keep answers direct; structure only when genuinely helpful.',
          `\nRetrieved moments:\n${context}`
        ].join('\n')
        const history = req.history.slice(-10).map((m) => ({ role: m.role, content: m.content }))
        let text = await aiChat(system, [...history, { role: 'user', content: req.question }])
        // expand 8-char ids back to full session ids for the citation chips
        text = text.replace(/\[\[([a-fA-F0-9]{8})@/g, (_m, short: string) => `[[${idMap.get(short.toLowerCase()) ?? short}@`)
        emitAi({ requestId: req.requestId, type: 'delta', text })
        emitAi({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        emitAi({
          requestId: req.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },

    searchLibrary: async (query: string) => rankHits(await allSessions(), query, 24),

    brainStats: async (): Promise<BrainStats> => {
      const rows = await allSessions()
      let words = 0
      let moments = 0
      let totalMs = 0
      for (const r of rows) {
        totalMs += r.meta.durationMs || 0
        for (const s of r.transcript || []) words += s.text.split(/\s+/).length
        moments += r.notes?.moments?.length ?? 0
      }
      return { sessions: rows.length, totalMs, words, moments }
    },

    listBrainChats: async () => {
      const { data } = await sb
        .from('brain_chats')
        .select('data')
        .order('updated_at', { ascending: false })
      return ((data ?? []) as { data: BrainConversation }[]).map((r) => r.data)
    },
    saveBrainChat: async (conv: BrainConversation) => {
      await sb.from('brain_chats').upsert({
        id: conv.id,
        owner: user.id,
        data: conv,
        updated_at: new Date().toISOString()
      })
    },
    deleteBrainChat: async (id: string) => {
      await sb.from('brain_chats').delete().eq('id', id)
    },

    // ---------- live audience ----------
    startConference: async (sessionId: string) => {
      try {
        const d = await loadSession(sessionId)
        if (!d) return { error: 'Session not found.' }
        let eventId = d.meta.eventId
        if (!eventId) {
          eventId = uid()
          const { error } = await sb.from('events').insert({
            id: eventId,
            owner: user.id,
            title: d.meta.title,
            status: 'live',
            agenda: d.meta.agenda ?? [],
            pre_event_chat: true,
            materials_present: false,
            live_voice: { enabled: true, languages: ALL_LANGS },
            session_id: sessionId
          })
          if (error) return { error: error.message }
          d.meta.eventId = eventId
          await patchSession(sessionId, { meta: d.meta })
        } else {
          await sb
            .from('events')
            .update({ status: 'live', session_id: sessionId, updated_at: new Date().toISOString() })
            .eq('id', eventId)
        }
        if (conf) {
          clearInterval(conf.workTimer)
          clearInterval(conf.statsTimer)
        }
        conf = {
          eventId,
          sessionId,
          url: eventUrl(eventId),
          answering: new Set(),
          attendeeLangs: new Map(),
          attendeeCount: 0,
          askCount: 0,
          questions: [],
          reactions: { landed: 0, lost: 0, recentLost: 0 },
          poll: null,
          translated: new Map(),
          frameBusy: false,
          workTimer: window.setInterval(() => void confPollWork(), 3000),
          statsTimer: window.setInterval(() => void confPollStats(), 5000)
        }
        return { url: conf.url }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    stopConference: async () => {
      if (conf) {
        clearInterval(conf.workTimer)
        clearInterval(conf.statsTimer)
        await sb
          .from('events')
          .update({ status: 'ended', updated_at: new Date().toISOString() })
          .eq('id', conf.eventId)
        conf = null
      }
    },
    conferenceStatus: async () => {
      if (conf) {
        return {
          running: true,
          url: conf.url,
          ended: false,
          eventId: conf.eventId,
          attendees: conf.attendeeCount,
          recentAsks: conf.askCount,
          questions: conf.questions,
          reactions: conf.reactions,
          poll: conf.poll ?? undefined
        }
      }
      if (armedId) {
        const { count } = await sb
          .from('attendees')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', armedId)
        return {
          running: true,
          waiting: true,
          eventId: armedId,
          url: eventUrl(armedId),
          attendees: count ?? 0
        }
      }
      return { running: false }
    },
    // ---------- memory ----------
    listMemory: async () => loadMemory(),
    updateMemory: async (id, patch) => {
      const { data } = await sb.from('memory_objects').select('data').eq('id', id).single()
      if (!data) return null
      const obj = data.data as MemoryObject
      if (patch.status) obj.status = patch.status
      obj.updatedAt = Date.now()
      await sb
        .from('memory_objects')
        .update({ data: obj, updated_at: new Date().toISOString() })
        .eq('id', id)
      return obj
    },
    deleteMemory: async (id: string) => {
      await sb.from('memory_objects').delete().eq('id', id)
    },

    // ---------- Room's Mind: what the audience is privately struggling with ----------
    roomMind: async (sessionId: string) => {
      if (!conf || conf.sessionId !== sessionId || !hasChatKey()) return { themes: [] }
      try {
        const { data: asks } = await sb
          .from('asks')
          .select('question,created_at')
          .eq('event_id', conf.eventId)
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
          'Order by count, largest first. Merge near-duplicates. No theme for a single stray question unless there are no better clusters.'
        ].join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: recent.map((a, i) => `${i + 1}. ${a.question}`).join('\n') }
        ])
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
    },
    roomRecap: async (sessionId: string, topic: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const d = await loadSession(sessionId)
        if (!d) return { error: 'Session not found.' }
        const system = [
          `A live audience is collectively struggling with: "${topic}". Using the transcript, write a crystal-clear recap of that point in 3-5 short sentences, as if explaining it fresh to someone who just got lost.`,
          'Plain text, no markdown headings, no preamble — it may be read aloud by the speaker or pushed to every attendee phone.'
        ].join('\n')
        const text = await aiChat(system, [
          { role: 'user', content: transcriptBlock(d.segments.slice(-80)) }
        ])
        return { text: text.trim() }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    pushRoomNote: async (text: string) => {
      if (!conf) return { error: 'Go live first.' }
      const { error } = await sb.from('room_notes').insert({
        id: uid(),
        event_id: conf.eventId,
        text: text.trim().slice(0, 1200)
      })
      return error ? { error: error.message } : {}
    },

    publishReplay: async (sessionId: string, enable: boolean) => {
      const d = await loadSession(sessionId)
      if (!d) return { error: 'Session not found.' }
      const evId = d.meta.eventId
      if (!evId) return { error: 'Only sessions hosted as events can be published as replays.' }
      if (!enable) {
        await sb
          .from('events')
          .update({
            replay: { enabled: false },
            updated_at: new Date().toISOString()
          })
          .eq('id', evId)
        return { enabled: false }
      }
      const video = await api.readVideo(sessionId, 'video')
      if (!video || video.byteLength < 5000) {
        return { error: 'No recording found for this session.' }
      }
      const { error } = await sb.storage
        .from('replays')
        .upload(`${evId}.webm`, new Blob([video], { type: 'video/webm' }), {
          upsert: true,
          contentType: 'video/webm'
        })
      if (error) return { error: 'Upload failed: ' + error.message }
      await sb
        .from('events')
        .update({
          replay: {
            enabled: true,
            title: d.meta.title,
            summary: d.meta.summary ?? '',
            highlights: d.meta.highlights ?? [],
            durationMs: d.meta.durationMs,
            publishedAt: Date.now()
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', evId)
      return { enabled: true, url: `${location.origin}/r/${evId}` }
    },
    launchPoll: async (question: string, options: string[]) => {
      if (!conf) return { error: 'Go live first.' }
      const cleanOpts = options.map((o) => o.trim()).filter(Boolean).slice(0, 6)
      if (!question.trim() || cleanOpts.length < 2) {
        return { error: 'A poll needs a question and at least two options.' }
      }
      // close any open poll first — one at a time keeps the room focused
      await sb.from('polls').update({ status: 'closed' }).eq('event_id', conf.eventId).eq('status', 'open')
      const { error } = await sb.from('polls').insert({
        id: uid(),
        event_id: conf.eventId,
        question: question.trim().slice(0, 200),
        options: cleanOpts,
        status: 'open'
      })
      if (error) return { error: error.message }
      void confPollStats()
      return {}
    },
    closePoll: async () => {
      if (!conf) return
      await sb.from('polls').update({ status: 'closed' }).eq('event_id', conf.eventId).eq('status', 'open')
      void confPollStats()
    },
    pushStageFrame: async (dataUrl: string) => {
      if (!conf || conf.frameBusy) return
      const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl)
      if (!m) return
      conf.frameBusy = true
      try {
        const bin = atob(m[1])
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        await sb.storage
          .from('stage')
          .upload(`${conf.eventId}.jpg`, new Blob([bytes], { type: 'image/jpeg' }), {
            upsert: true,
            contentType: 'image/jpeg'
          })
      } catch {
        /* transient */
      } finally {
        if (conf) conf.frameBusy = false
      }
    },
    onConferenceUpdate: (cb) => {
      confListeners.add(cb)
      return () => confListeners.delete(cb)
    },

    // ---------- events ----------
    listEvents: async () => {
      const { data } = await sb
        .from('events')
        .select('*')
        .eq('owner', user.id)
        .order('starts_at', { ascending: false, nullsFirst: false })
      const rows = (data ?? []) as (EvRow & { status: string })[]
      const events = rows.map(evRowToScheduled)
      // A shared link works the moment an event exists — default the armed
      // presentation to the newest event that has not ended yet.
      if (!armedId) {
        armedId = rows.find((r) => r.status !== 'ended' && !r.session_id)?.id ?? null
      }
      const status = conf
        ? { running: true, url: conf.url, waiting: false, eventId: conf.eventId }
        : armedId
          ? { running: true, waiting: true, eventId: armedId, url: eventUrl(armedId) }
          : { running: false }
      return { events, status }
    },
    createEvent: async (title, startsAt, agenda) => {
      const id = uid()
      const { error } = await sb.from('events').insert({
        id,
        owner: user.id,
        title: title.trim() || 'Live event',
        status: 'waiting',
        starts_at: startsAt ? new Date(startsAt).toISOString() : null,
        agenda: agenda.filter(Boolean).slice(0, 12),
        pre_event_chat: true,
        materials_present: false,
        live_voice: { enabled: true, languages: ALL_LANGS }
      })
      if (error) return { error: error.message }
      const { data } = await sb.from('events').select('*').eq('id', id).single()
      return { url: eventUrl(id), event: data ? evRowToScheduled(data as EvRow) : undefined }
    },
    updateEvent: async (id, patch) => {
      const upd: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (patch.title !== undefined) upd.title = patch.title
      if (patch.startsAt !== undefined)
        upd.starts_at = patch.startsAt ? new Date(patch.startsAt).toISOString() : null
      if (patch.agenda !== undefined) upd.agenda = patch.agenda.filter(Boolean).slice(0, 12)
      if (patch.preEventChat !== undefined) upd.pre_event_chat = patch.preEventChat
      if (patch.liveVoice !== undefined) upd.live_voice = patch.liveVoice
      await sb.from('events').update(upd).eq('id', id)
      const { data } = await sb.from('events').select('*').eq('id', id).single()
      return data ? evRowToScheduled(data as EvRow) : null
    },
    deleteEvent: async (id: string) => {
      await sb.from('events').delete().eq('id', id)
      if (armedId === id) armedId = null
    },
    armEvent: async (id: string) => {
      // Online events are always armed — the link works the moment it exists.
      const { data } = await sb.from('events').select('id').eq('id', id).single()
      if (!data) return { error: 'Event not found.' }
      armedId = id
      return { url: eventUrl(id) }
    },
    addMaterialFile: async (id: string) => {
      const picked = await pickTextFile()
      if (!picked) return { canceled: true }
      const { data } = await sb.from('events').select('materials').eq('id', id).single()
      const materials = ((data?.materials ?? []) as { name: string; chars: number; text: string }[]).concat({
        name: picked.name,
        chars: picked.text.length,
        text: picked.text
      })
      const event = await saveEventMaterials(id, materials)
      return event ? { event } : { error: 'Could not save material.' }
    },
    addMaterialText: async (id, name, text) => {
      const { data } = await sb.from('events').select('materials').eq('id', id).single()
      const materials = ((data?.materials ?? []) as { name: string; chars: number; text: string }[]).concat({
        name: name || 'Pasted notes',
        chars: text.length,
        text
      })
      const event = await saveEventMaterials(id, materials)
      return event ? { event } : { error: 'Could not save material.' }
    },
    removeMaterial: async (id, index) => {
      const { data } = await sb.from('events').select('materials').eq('id', id).single()
      const materials = ((data?.materials ?? []) as { name: string; chars: number; text: string }[]).filter(
        (_m, i) => i !== index
      )
      const event = await saveEventMaterials(id, materials)
      return event ? { event } : { error: 'Could not remove material.' }
    },
    saveQr: async (dataUrl: string, title: string) => {
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `${title.replace(/[^\w-]+/g, '-')}-qr.png`
      a.click()
      return { ok: true }
    },

    checkNudge: async (id, userQuestions, priorNudges) => {
      if (!hasChatKey()) return {}
      try {
        const d = await loadSession(id)
        if (!d || d.segments.length < 6) return {}
        const system = [
          'You quietly watch a live session alongside a user and occasionally surface ONE proactive nudge — something genuinely worth flagging (a term they may not know, a connection, something the speaker stressed).',
          'Return ONLY JSON: {"nudge": string | null}. Return null unless something truly earns an interruption. One short sentence, no markdown.',
          priorNudges.length ? `Already nudged (never repeat): ${priorNudges.join(' | ')}` : '',
          userQuestions.length ? `Their recent questions (their interests): ${userQuestions.join(' | ')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: transcriptBlock(d.segments.slice(-40)) }
        ])
        const parsed = extractJson<{ nudge?: string | null }>(out)
        return parsed?.nudge ? { nudge: parsed.nudge } : {}
      } catch {
        return {}
      }
    },

    updateNotes: async (id: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const d = await loadSession(id)
        if (!d || d.segments.length === 0) return { notes: d?.notes ?? null }
        const system = [
          'You maintain live, organized notes for a session (lecture, meeting, or presentation) as it happens.',
          'You are given the timestamped transcript so far, and the previous version of the notes (which may be empty).',
          'Rewrite the notes so they cover everything discussed so far. Notes are NOT a transcript copy: organize by topic with "## " headings, short "-" bullets, key definitions in **bold**, and concrete examples where given.',
          'Also detect notable moments:',
          '- kind "important": points the speaker emphasized, stressed, repeated, or flagged.',
          '- kind "question": actual questions asked aloud during the session, quoted or closely paraphrased.',
          'Each moment needs "time" copied exactly from a transcript timestamp (like "12:37") and a short "label" (max 12 words).',
          'Return ONLY a JSON object, no prose and no code fences:',
          '{"notes": "<markdown string>", "moments": [{"time": "M:SS", "label": string, "kind": "important" | "question"}]}',
          'Keep the moments list complete for the whole session so far (carry earlier moments forward, do not drop them).'
        ].join('\n')
        const out = await aiChat(system, [
          {
            role: 'user',
            content: `Previous notes:\n${d.notes?.markdown ?? '(none)'}\n\nTranscript:\n${transcriptBlock(d.segments)}`
          }
        ])
        const parsed = extractJson<{ notes?: string; moments?: SessionNotes['moments'] }>(out)
        if (!parsed?.notes) return { error: 'Could not update notes.' }
        const notes: SessionNotes = {
          markdown: parsed.notes,
          moments: Array.isArray(parsed.moments) ? parsed.moments : [],
          updatedAt: Date.now()
        }
        d.notes = notes
        await patchSession(id, { notes })
        return { notes }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    generateStudy: async (id: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const d = await loadSession(id)
        if (!d || d.segments.length < 3) return { error: 'Not enough transcript to build a study pack.' }
        const system = [
          'Build a study pack from this session transcript.',
          'Return ONLY JSON:',
          '{"concepts": [{"term": string, "definition": string}], "flashcards": [{"front": string, "back": string}], "quiz": [{"question": string, "options": [string], "answerIndex": number, "explanation": string}]}',
          '- 5-10 concepts (the ideas that matter), 6-12 flashcards, 4-8 quiz questions with exactly 4 options each.',
          '- Everything must come from the transcript content.'
        ].join('\n')
        const out = await aiChat(system, [{ role: 'user', content: transcriptBlock(d.segments) }], 3000)
        const parsed = extractJson<Omit<StudyPack, 'generatedAt'>>(out)
        if (!parsed?.concepts) return { error: 'Could not build the study pack.' }
        const study: StudyPack = {
          concepts: parsed.concepts ?? [],
          flashcards: parsed.flashcards ?? [],
          quiz: parsed.quiz ?? [],
          generatedAt: Date.now()
        }
        d.study = study
        await patchSession(id, { study })
        return { study }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    // ---------- coach ----------
    listCoachProjects: async () => {
      const { data } = await sb
        .from('coach_projects')
        .select('data')
        .order('updated_at', { ascending: false })
      return ((data ?? []) as { data: CoachProject }[]).map((r) => r.data)
    },
    createCoachProject: async (title, goal, audience, when) => {
      const project: CoachProject = {
        id: uid(),
        title,
        goal,
        audience,
        when: when ?? undefined,
        createdAt: Date.now(),
        rehearsals: []
      }
      await sb.from('coach_projects').insert({ id: project.id, owner: user.id, data: project, sim: [] })
      return project
    },
    updateCoachProject: async (id, patch) => {
      const row = await loadCoach(id)
      if (!row) return null
      if (patch.eventId !== undefined) row.data.eventId = patch.eventId ?? undefined
      if (patch.when !== undefined) row.data.when = patch.when ?? undefined
      await saveCoach(row)
      return row.data
    },
    deleteCoachProject: async (id: string) => {
      await sb.from('coach_projects').delete().eq('id', id)
    },
    coachAddMaterialFile: async (id: string) => {
      const picked = await pickTextFile()
      if (!picked) return { canceled: true }
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      row.data.materialTexts = (row.data.materialTexts ?? []).concat(picked)
      row.data.materials = row.data.materialTexts.map((m) => ({ name: m.name, chars: m.text.length }))
      await saveCoach(row)
      return { project: row.data }
    },
    coachAddMaterialText: async (id, name, text) => {
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      row.data.materialTexts = (row.data.materialTexts ?? []).concat({ name: name || 'Pasted notes', text })
      row.data.materials = row.data.materialTexts.map((m) => ({ name: m.name, chars: m.text.length }))
      await saveCoach(row)
      return { project: row.data }
    },
    coachRemoveMaterial: async (id, index) => {
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      row.data.materialTexts = (row.data.materialTexts ?? []).filter((_m, i) => i !== index)
      row.data.materials = row.data.materialTexts.map((m) => ({ name: m.name, chars: m.text.length }))
      await saveCoach(row)
      return { project: row.data }
    },
    coachBrief: async (id: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      try {
        const system = [
          'You are a world-class presentation coach preparing a speaker.',
          'From their goal, audience and materials, produce a preparation brief.',
          'Return ONLY JSON: {"structure": [string], "keyMessage": string, "weakAreas": [string], "expectedQuestions": [string]}',
          '- structure: 4-7 sections for the talk in order. - keyMessage: the ONE sentence the audience must remember.',
          '- weakAreas: 2-4 likely weak spots to rehearse. - expectedQuestions: 4-6 questions this audience will probably ask.'
        ].join('\n')
        const out = await aiChat(system, [{ role: 'user', content: coachContext(row.data) }])
        const brief = extractJson<CoachBrief>(out)
        if (!brief?.keyMessage) return { error: 'Could not build the brief.' }
        row.data.brief = brief
        await saveCoach(row)
        return { project: row.data }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    coachStt: async (chunk, offsetSec) => api.transcribeChunk('__coach__', chunk, offsetSec),
    coachScore: async (id, segments, durationSec) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      try {
        const system = [
          'You are scoring a spoken rehearsal of a presentation against its goal, audience and materials.',
          'Return ONLY JSON: {"scores": {"content": n, "clarity": n, "structure": n, "confidence": n, "timing": n, "overall": n}, "feedback": [string], "summary": string}',
          '- Every score is 0-100 (be honest, not kind). - feedback: 3-6 specific, actionable notes. - summary: 2 sentences.'
        ].join('\n')
        const out = await aiChat(system, [
          {
            role: 'user',
            content: `${coachContext(row.data)}\n\nRehearsal (${Math.round(durationSec)}s):\n${transcriptBlock(segments)}`
          }
        ])
        const parsed = extractJson<{ scores?: CoachScores; feedback?: string[]; summary?: string }>(out)
        if (!parsed?.scores) return { error: 'Could not score the rehearsal.' }
        const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))
        const scores: CoachScores = {
          content: clamp(parsed.scores.content),
          clarity: clamp(parsed.scores.clarity),
          structure: clamp(parsed.scores.structure),
          confidence: clamp(parsed.scores.confidence),
          timing: clamp(parsed.scores.timing),
          overall: clamp(parsed.scores.overall)
        }
        const rehearsal: CoachRehearsal = {
          id: uid(),
          at: Date.now(),
          durationSec,
          scores,
          feedback: parsed.feedback ?? [],
          summary: parsed.summary ?? ''
        }
        row.data.rehearsals.push(rehearsal)
        await saveCoach(row)
        return { rehearsal, project: row.data }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    coachSimAsk: async (req) => {
      try {
        const row = await loadCoach(req.projectId)
        if (!row) throw new Error('Project not found.')
        const styles: Record<SimDifficulty, string> = {
          friendly: 'You are warm and encouraging; your questions are genuine and easy.',
          professional: 'You are a sharp professional; fair but probing questions.',
          challenging: 'You are skeptical; you push on weak points and vague claims.',
          grilling: 'You are relentless; you interrogate every assumption and number.'
        }
        const system = [
          `You are simulating an audience member (${req.persona}) in a Q&A after this presentation. ${styles[req.difficulty]}`,
          'When the presenter answers, judge it before your next question, starting a line with exactly one of: "✓ Strong:", "△ Needs work:", "✗ Doesn\'t hold:" followed by one short reason.',
          'Stay in character. One question at a time. Keep everything tight.',
          coachContext(row.data)
        ].join('\n')
        const history = req.history.slice(-12).map((m) => ({ role: m.role, content: m.content }))
        const text = await aiChat(system, [...history, { role: 'user', content: req.question }])
        emitAi({ requestId: req.requestId, type: 'delta', text })
        emitAi({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        emitAi({
          requestId: req.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },
    coachHint: async (id, segments) => {
      if (!hasChatKey() || segments.length < 3) return {}
      try {
        const row = await loadCoach(id)
        if (!row) return {}
        const system = [
          'You are a silent presentation coach listening to a live rehearsal. Occasionally whisper ONE short hint (pace, filler words, missing point, energy).',
          'Return ONLY JSON: {"hint": string | null}. Usually null — only speak when it truly helps. Max 10 words.'
        ].join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: transcriptBlock(segments.slice(-20)) }
        ])
        const parsed = extractJson<{ hint?: string | null }>(out)
        return parsed?.hint ? { hint: parsed.hint } : {}
      } catch {
        return {}
      }
    },
    coachGetSim: async (id: string) => (await loadCoach(id))?.sim ?? [],
    coachSaveSim: async (id, chat) => {
      const row = await loadCoach(id)
      if (!row) return
      row.sim = chat
      await saveCoach(row)
    },

    onAiStream: (cb) => {
      aiListeners.add(cb)
      return () => aiListeners.delete(cb)
    },
    onSessionUpdated: (cb) => {
      sessListeners.add(cb)
      return () => sessListeners.delete(cb)
    }
  }

  ;(window as unknown as { sitka: SitkaApi; sitkaWeb: boolean }).sitka = api
  ;(window as unknown as { sitkaWeb: boolean }).sitkaWeb = true
}
