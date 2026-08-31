import { createClient, type User } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import './style.css'
import './host.css'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY)

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement

const ALL_LANGS = [
  'Shona', 'Ndebele', 'Swahili', 'French', 'Portuguese',
  'Spanish', 'German', 'Arabic', 'Chinese', 'Hindi'
]

interface EventRow {
  id: string
  owner: string
  title: string
  status: 'waiting' | 'live' | 'ended'
  starts_at: string | null
  agenda: string[]
  pre_event_chat: boolean
  materials_present: boolean
  materials_text: string | null
  live_voice: { enabled: boolean; languages: string[] }
}
interface Seg {
  start: number
  text: string
}

let user: User | null = null
let events: EventRow[] = []
let current: EventRow | null = null

// ---------- AI keys (this browser only) ----------
interface Keys {
  groqApiKey: string
  anthropicApiKey: string
  openaiApiKey: string
}
function getKeys(): Keys {
  try {
    return {
      groqApiKey: '',
      anthropicApiKey: '',
      openaiApiKey: '',
      ...(JSON.parse(localStorage.getItem('sitka-host-keys') || '{}') as Partial<Keys>)
    }
  } catch {
    return { groqApiKey: '', anthropicApiKey: '', openaiApiKey: '' }
  }
}
function keysReady(): boolean {
  const k = getKeys()
  return Boolean((k.anthropicApiKey || k.groqApiKey) && (k.openaiApiKey || k.groqApiKey))
}
el('keysbtn').onclick = () => {
  const k = getKeys()
  input('kgroq').value = k.groqApiKey
  input('kanthropic').value = k.anthropicApiKey
  input('kopenai').value = k.openaiApiKey
  el('keysdlg').classList.remove('hidden')
}
el('keysclose').onclick = () => el('keysdlg').classList.add('hidden')
el('keyssave').onclick = () => {
  localStorage.setItem(
    'sitka-host-keys',
    JSON.stringify({
      groqApiKey: input('kgroq').value.trim(),
      anthropicApiKey: input('kanthropic').value.trim(),
      openaiApiKey: input('kopenai').value.trim()
    })
  )
  el('keysdlg').classList.add('hidden')
}

// ---------- AI helpers (through /api proxies) ----------
async function aiChat(
  system: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens = 1600
): Promise<string> {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: getKeys(), system, messages, maxTokens })
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || 'AI error')
  return j.text || ''
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
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
function transcriptBlock(segs: Seg[]): string {
  if (segs.length === 0) return '(No speech has been transcribed yet.)'
  return segs.map((s) => `[${formatTime(s.start)}] ${s.text.trim()}`).join('\n')
}
function attendeeSystemPrompt(persona: string, lang: string, segs: Seg[], preEvent: boolean): string {
  const materials = current?.materials_text?.trim() || ''
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
    '- When you reference a specific moment of the talk, cite it inline with the exact format [[M:SS]] using a single timestamp that appears in the transcript (for example [[12:37]]). Plain ASCII double square brackets only — never fullwidth brackets like 【 】, single brackets, or parentheses. The app turns these into tappable links that jump to that moment.',
    '- Match the length of your answer to the question. A simple or specific question gets a short, direct answer of one to three sentences — no headings, no lists, no preamble. Only produce structured answers for catch-ups, summaries, or when detail is asked for.',
    '- Formatting: plain sentences, **bold** for key terms, "-" bullets for genuine lists, numbered lists for steps, and "## " headings only in long structured answers. Use a markdown table only for a comparison or when a table is asked for. This renders on a phone — keep it tight.',
    '- Do not end answers with offers like "let me know if you want more" — just answer.',
    materials ? `\nEvent materials shared by the host:\n${materials.slice(0, 14000)}` : '',
    preEvent ? '' : `\nTranscript so far:\n${transcriptBlock(segs)}`
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------- page routing ----------
const pages = ['auth', 'dash', 'eventview', 'studio', 'ended']
function show(page: string): void {
  pages.forEach((p) => el(p).classList.toggle('hidden', p !== page))
  window.scrollTo(0, 0)
}

// ---------- auth ----------
function authErr(msg: string): void {
  const e = el('autherr')
  e.textContent = msg
  e.classList.remove('hidden')
}
el('signin').onclick = async () => {
  const { data, error } = await sb.auth.signInWithPassword({
    email: input('email').value.trim(),
    password: input('password').value
  })
  if (error) {
    authErr(error.message)
    return
  }
  user = data.user
  await enterDash()
}
el('signup').onclick = async () => {
  const { data, error } = await sb.auth.signUp({
    email: input('email').value.trim(),
    password: input('password').value
  })
  if (error) {
    authErr(error.message)
    return
  }
  if (!data.session) {
    authErr('Account created — check your email to confirm, then sign in.')
    return
  }
  user = data.user
  await enterDash()
}
el('signout').onclick = async () => {
  await sb.auth.signOut()
  user = null
  el('userbox').classList.add('hidden')
  show('auth')
}

// ---------- dashboard ----------
async function enterDash(): Promise<void> {
  if (!user) return
  el('userbox').classList.remove('hidden')
  el('usermail').textContent = user.email || ''
  const { data } = await sb
    .from('events')
    .select('*')
    .eq('owner', user.id)
    .order('starts_at', { ascending: false, nullsFirst: false })
  events = (data as EventRow[]) || []
  const list = el('evlist')
  list.innerHTML = ''
  if (events.length === 0) {
    list.innerHTML = '<div class="sub">No events yet — create your first one below.</div>'
  }
  for (const ev of events) {
    const card = document.createElement('div')
    card.className = 'evcard'
    const when = ev.starts_at
      ? new Date(ev.starts_at).toLocaleString([], {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        })
      : 'No date set'
    card.innerHTML =
      '<div class="evcard-title"></div><div class="evcard-meta"></div><span class="evcard-badge"></span>'
    ;(card.children[0] as HTMLElement).textContent = ev.title
    ;(card.children[1] as HTMLElement).textContent = when
    const badge = card.children[2] as HTMLElement
    badge.textContent = ev.status.toUpperCase()
    if (ev.status === 'live') badge.classList.add('live')
    card.onclick = () => openEvent(ev)
    list.appendChild(card)
  }
  show('dash')
}
el('newbtn').onclick = async () => {
  if (!user) return
  const title = input('newtitle').value.trim()
  if (!title) return
  const whenVal = input('newwhen').value
  const row = {
    id: crypto.randomUUID(),
    owner: user.id,
    title,
    status: 'waiting',
    starts_at: whenVal ? new Date(whenVal).toISOString() : null,
    agenda: [],
    pre_event_chat: true,
    materials_present: false,
    live_voice: { enabled: true, languages: ALL_LANGS }
  }
  const { error } = await sb.from('events').insert(row)
  if (error) {
    el('newerr').textContent = error.message
    el('newerr').classList.remove('hidden')
    return
  }
  input('newtitle').value = ''
  input('newwhen').value = ''
  el('newerr').classList.add('hidden')
  openEvent(row as unknown as EventRow)
}
el('backdash').onclick = () => {
  stopPreLoop()
  void enterDash()
}

// ---------- event detail ----------
function shareUrl(id: string): string {
  return location.origin + '/e/' + id
}
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function renderLangChips(): void {
  const wrap = el('edlangs')
  wrap.innerHTML = ''
  const sel = current?.live_voice?.languages ?? []
  for (const lang of ALL_LANGS) {
    const b = document.createElement('button')
    b.className = 'chip' + (sel.includes(lang) ? ' sel' : '')
    b.textContent = lang
    b.onclick = () => {
      if (!current) return
      const langs = current.live_voice?.languages ?? []
      current.live_voice = {
        enabled: true,
        languages: langs.includes(lang) ? langs.filter((l) => l !== lang) : [...langs, lang]
      }
      renderLangChips()
    }
    wrap.appendChild(b)
  }
}
function openEvent(ev: EventRow): void {
  current = ev
  el('evtitle2').textContent = ev.title
  el('evsub').textContent =
    ev.status === 'ended' ? 'This event has ended.' : 'Attendees can join from this link right now.'
  input('edtitle').value = ev.title
  input('edwhen').value = toLocalInput(ev.starts_at)
  ;(el('edagenda') as HTMLTextAreaElement).value = (ev.agenda || []).join('\n')
  ;(el('edmaterials') as HTMLTextAreaElement).value = ev.materials_text || ''
  input('edprechat').checked = ev.pre_event_chat !== false
  renderLangChips()
  el('sharelink').textContent = shareUrl(ev.id)
  void QRCode.toCanvas(el('qrcanvas') as HTMLCanvasElement, shareUrl(ev.id), {
    width: 184,
    margin: 1,
    color: { dark: '#1a1a1c', light: '#ffffff' }
  })
  ;(el('golivebtn') as HTMLButtonElement).textContent =
    ev.status === 'ended' ? 'Event ended' : 'Go live'
  ;(el('golivebtn') as HTMLButtonElement).disabled = ev.status === 'ended'
  show('eventview')
  startPreLoop()
}
el('copylink').onclick = () => {
  if (current) void navigator.clipboard.writeText(shareUrl(current.id))
}
el('savebtn').onclick = async () => {
  if (!current) return
  const materials = (el('edmaterials') as HTMLTextAreaElement).value.trim()
  const patch = {
    title: input('edtitle').value.trim() || current.title,
    starts_at: input('edwhen').value ? new Date(input('edwhen').value).toISOString() : null,
    agenda: (el('edagenda') as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12),
    materials_text: materials || null,
    materials_present: materials.length > 0,
    pre_event_chat: input('edprechat').checked,
    live_voice: current.live_voice ?? { enabled: true, languages: ALL_LANGS },
    updated_at: new Date().toISOString()
  }
  const { error } = await sb.from('events').update(patch).eq('id', current.id)
  if (!error) {
    Object.assign(current, patch)
    el('evtitle2').textContent = current.title
    el('savednote').classList.remove('hidden')
    setTimeout(() => el('savednote').classList.add('hidden'), 2000)
  }
}
el('delbtn').onclick = async () => {
  if (!current) return
  if (!confirm('Delete this event? Attendee links will stop working.')) return
  await sb.from('events').delete().eq('id', current.id)
  current = null
  await enterDash()
}

// ---------- pre-event Q&A ----------
// While the host has an armed event open in this tab, answer early attendees'
// questions from the shared materials (the event itself has not started yet).
let preTimer: number | null = null
const preAnswering = new Set<string>()
function stopPreLoop(): void {
  if (preTimer) {
    clearInterval(preTimer)
    preTimer = null
  }
}
function startPreLoop(): void {
  stopPreLoop()
  preTimer = window.setInterval(() => void pollPreAsks(), 8000)
}
async function pollPreAsks(): Promise<void> {
  if (!current || current.status !== 'waiting' || studio) return
  if (!keysReady() || !current.materials_text || current.pre_event_chat === false) return
  const { data: asks } = await sb
    .from('asks')
    .select('id,attendee_id,kind,question')
    .eq('event_id', current.id)
    .eq('status', 'pending')
    .eq('kind', 'ask')
    .limit(3)
  for (const row of asks ?? []) {
    if (preAnswering.has(row.id) || preAnswering.size >= 2) continue
    preAnswering.add(row.id)
    void (async () => {
      try {
        const { data: att } = await sb
          .from('attendees')
          .select('persona,lang')
          .eq('id', row.attendee_id)
          .single()
        const answer = await aiChat(
          attendeeSystemPrompt(att?.persona || 'Curious attendee', att?.lang || 'English', [], true),
          [{ role: 'user', content: row.question as string }]
        )
        await sb
          .from('asks')
          .update({ status: 'answered', answer, answered_at: new Date().toISOString() })
          .eq('id', row.id)
      } catch {
        await sb
          .from('asks')
          .update({ status: 'error', answer: 'Sitka could not answer — try again.' })
          .eq('id', row.id)
      } finally {
        preAnswering.delete(row.id)
      }
    })()
  }
}

// ---------- live studio ----------
interface Studio {
  startAt: number
  micStream: MediaStream
  displayStream: MediaStream | null
  sttRecorder: MediaRecorder | null
  fullRecorder: MediaRecorder
  fullChunks: Blob[]
  sttTimer: number
  frameTimer: number
  workTimer: number
  statsTimer: number
  clockTimer: number
  segs: Seg[]
  nextIdx: number
  translated: Map<string, number>
  attendeeLangs: Map<string, string>
  answering: Set<string>
  askCount: number
  attendeeCount: number
  questionCount: number
  ending: boolean
}
let studio: Studio | null = null

el('golivebtn').onclick = async () => {
  if (!current || current.status === 'ended') return
  const err = el('goliveerr')
  err.classList.add('hidden')
  if (!keysReady()) {
    err.textContent = 'Add your AI keys first (top-right “AI keys”) — a free Groq key is enough.'
    err.classList.remove('hidden')
    el('keysbtn').click()
    return
  }
  let mic: MediaStream
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    err.textContent = 'Microphone access is required to go live.'
    err.classList.remove('hidden')
    return
  }
  const { error } = await sb
    .from('events')
    .update({ status: 'live', updated_at: new Date().toISOString() })
    .eq('id', current.id)
  if (error) {
    err.textContent = error.message
    err.classList.remove('hidden')
    return
  }
  current.status = 'live'
  const { count } = await sb
    .from('segments')
    .select('idx', { count: 'exact', head: true })
    .eq('event_id', current.id)

  const fullRecorder = new MediaRecorder(mic, { mimeType: 'audio/webm;codecs=opus' })
  const fullChunks: Blob[] = []
  fullRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) fullChunks.push(e.data)
  }
  fullRecorder.start(3000)

  studio = {
    startAt: Date.now(),
    micStream: mic,
    displayStream: null,
    sttRecorder: null,
    fullRecorder,
    fullChunks,
    segs: [],
    nextIdx: count ?? 0,
    translated: new Map(),
    attendeeLangs: new Map(),
    answering: new Set(),
    askCount: 0,
    attendeeCount: 0,
    questionCount: 0,
    ending: false,
    sttTimer: window.setInterval(rotateStt, 5000),
    frameTimer: window.setInterval(pushFrame, 2500),
    workTimer: window.setInterval(() => void pollWork(), 3000),
    statsTimer: window.setInterval(() => void pollStats(), 5000),
    clockTimer: window.setInterval(() => {
      if (studio) el('sclock').textContent = formatTime((Date.now() - studio.startAt) / 1000)
    }, 1000)
  }
  el('stitle').textContent = current.title
  el('stranscript').innerHTML = '<div class="waiting">Listening…</div>'
  el('squestions').innerHTML =
    '<div class="waiting">None yet — attendees can send questions from their phones.</div>'
  el('spreviewempty').classList.remove('hidden')
  stopPreLoop()
  startSttRecorder()
  show('studio')
}

function startSttRecorder(): void {
  if (!studio) return
  const rec = new MediaRecorder(studio.micStream, { mimeType: 'audio/webm;codecs=opus' })
  const chunkStart = Date.now()
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      void transcribeChunk(e.data, (chunkStart - (studio?.startAt ?? chunkStart)) / 1000)
    }
  }
  rec.start()
  studio.sttRecorder = rec
}
function rotateStt(): void {
  if (!studio || studio.ending) return
  const rec = studio.sttRecorder
  if (rec && rec.state !== 'inactive') {
    rec.onstop = () => {
      if (studio && !studio.ending) startSttRecorder()
    }
    rec.stop()
  } else {
    startSttRecorder()
  }
}
function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}
async function transcribeChunk(blob: Blob, offsetSec: number): Promise<void> {
  if (!studio || !current || blob.size < 2000) return
  try {
    const audioB64 = await blobToB64(blob)
    const r = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: getKeys(), audioB64, mime: blob.type, offsetSec })
    })
    const j = await r.json()
    if (!r.ok || !studio || !current) return
    const segs: Seg[] = (j.segments || []).filter((s: Seg) => s.text)
    if (segs.length === 0) return
    const rows = segs.map((s) => ({
      event_id: current!.id,
      idx: studio!.nextIdx++,
      start_sec: s.start,
      label: formatTime(s.start),
      text: s.text
    }))
    studio.segs.push(...segs)
    renderTranscript(segs)
    await sb.from('segments').insert(rows)
    void pushTranslations()
  } catch {
    /* transient — next chunk retries */
  }
}
function renderTranscript(segs: Seg[]): void {
  const wrap = el('stranscript')
  if (wrap.querySelector('.waiting')) wrap.innerHTML = ''
  for (const s of segs) {
    const d = document.createElement('div')
    d.className = 'seg'
    d.innerHTML = '<span class="ts"></span><span class="segtext"></span>'
    ;(d.children[0] as HTMLElement).textContent = formatTime(s.start)
    ;(d.children[1] as HTMLElement).textContent = s.text
    wrap.appendChild(d)
  }
  wrap.scrollTop = wrap.scrollHeight
}

async function pushTranslations(): Promise<void> {
  if (!studio || !current) return
  const vc = current.live_voice
  if (!vc?.enabled) return
  const langs = new Set<string>()
  for (const lang of studio.attendeeLangs.values()) {
    if (lang.toLowerCase() !== 'english' && vc.languages.includes(lang)) langs.add(lang)
  }
  for (const lang of langs) {
    const done = studio.translated.get(lang) ?? 0
    if (done >= studio.segs.length) continue
    const fresh = studio.segs.slice(done)
    const startIndex = studio.nextIdx - studio.segs.length + done
    studio.translated.set(lang, studio.segs.length)
    try {
      const system = [
        `Translate each numbered line of live speech into ${lang}. Natural spoken style; keep names and numbers exact.`,
        `Return ONLY JSON: {"lines": [string]} with exactly ${fresh.length} entries, in order.`
      ].join('\n')
      const out = await aiChat(system, [
        { role: 'user', content: fresh.map((s, i) => `${i + 1}. ${s.text}`).join('\n') }
      ])
      const parsed = extractJson<{ lines?: unknown[] }>(out)
      if (!parsed || !Array.isArray(parsed.lines) || !current) continue
      const rows = fresh
        .map((_s, i) => ({ line: parsed.lines![i], idx: startIndex + i }))
        .filter((r) => typeof r.line === 'string' && (r.line as string).trim())
        .map((r) => ({
          event_id: current!.id,
          lang,
          idx: r.idx,
          text: (r.line as string).trim()
        }))
      if (rows.length > 0) await sb.from('translations').insert(rows)
    } catch {
      /* skip batch */
    }
  }
}

// screen share → stage frames
el('sharescreen').onclick = async () => {
  if (!studio) return
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true })
    studio.displayStream = display
    const v = el('spreview') as HTMLVideoElement
    v.srcObject = display
    el('spreviewempty').classList.add('hidden')
    display.getVideoTracks()[0].onended = () => {
      if (studio) studio.displayStream = null
      el('spreviewempty').classList.remove('hidden')
    }
  } catch {
    /* user cancelled */
  }
}
let frameBusy = false
function pushFrame(): void {
  if (!studio || !current || !studio.displayStream || frameBusy) return
  const v = el('spreview') as HTMLVideoElement
  if (!v.videoWidth) return
  frameBusy = true
  const maxW = 1280
  const scale = Math.min(1, maxW / v.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(v.videoWidth * scale)
  canvas.height = Math.round(v.videoHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    frameBusy = false
    return
  }
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
  canvas.toBlob(
    (blob) => {
      if (!blob || !current) {
        frameBusy = false
        return
      }
      void sb.storage
        .from('stage')
        .upload(`${current.id}.jpg`, blob, { upsert: true, contentType: 'image/jpeg' })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          frameBusy = false
        })
    },
    'image/jpeg',
    0.7
  )
}

// answer attendees + review speaker questions
async function pollWork(): Promise<void> {
  if (!studio || !current) return
  const st = studio
  const [{ data: asks }, { data: qs }] = await Promise.all([
    sb.from('asks').select('id,attendee_id,kind,question').eq('event_id', current.id).eq('status', 'pending').limit(4),
    sb.from('speaker_questions').select('id,text,force').eq('event_id', current.id).eq('status', 'checking').limit(4)
  ])
  for (const row of asks ?? []) {
    if (st.answering.size >= 2 || st.answering.has(row.id)) continue
    st.answering.add(row.id)
    void answerAsk(row as { id: string; attendee_id: string; kind: string; question: string })
  }
  for (const row of qs ?? []) {
    if (st.answering.has(row.id)) continue
    st.answering.add(row.id)
    void reviewQuestion(row as { id: string; text: string; force: boolean })
  }
}
async function answerAsk(row: {
  id: string
  attendee_id: string
  kind: string
  question: string
}): Promise<void> {
  if (!studio || !current) return
  const st = studio
  try {
    const { data: att } = await sb
      .from('attendees')
      .select('persona,lang')
      .eq('id', row.attendee_id)
      .single()
    const persona = att?.persona || 'Curious attendee'
    const lang = att?.lang || 'English'
    let answer: string
    if (row.kind === 'pack') {
      const system = [
        'Create a take-home pack for an audience member from this event transcript.',
        lang.toLowerCase() !== 'english' ? `Write EVERYTHING in ${lang}.` : '',
        'Return ONLY JSON: {"summary": string, "takeaways": [string]} — summary is 3-5 sentences; takeaways are 4-7 short bullet points of the most important ideas.'
      ]
        .filter(Boolean)
        .join('\n')
      const out = await aiChat(system, [{ role: 'user', content: transcriptBlock(st.segs) }])
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
      answer = await aiChat(attendeeSystemPrompt(persona, lang, st.segs, false), [
        ...history,
        { role: 'user', content: question }
      ])
    }
    await sb
      .from('asks')
      .update({ status: 'answered', answer, answered_at: new Date().toISOString() })
      .eq('id', row.id)
    st.askCount++
    el('statasks').textContent = String(st.askCount)
  } catch {
    await sb
      .from('asks')
      .update({ status: 'error', answer: 'Sitka could not answer — try again.' })
      .eq('id', row.id)
  } finally {
    st.answering.delete(row.id)
  }
}
async function reviewQuestion(row: { id: string; text: string; force: boolean }): Promise<void> {
  if (!studio || !current) return
  const st = studio
  try {
    if (row.force) {
      await sb
        .from('speaker_questions')
        .update({ status: 'submitted', refined: row.text, topic: 'General' })
        .eq('id', row.id)
      return
    }
    const system = [
      'An audience member wants to submit a question to the speaker of a live event. You are given the transcript so far.',
      'Return ONLY JSON: {"answeredAt": "M:SS" | null, "answer": string | null, "refined": string, "topic": string}',
      '- If the speaker already clearly addressed this question, set answeredAt to the transcript timestamp where, and answer to a 1-2 sentence summary of what they said. Otherwise both null.',
      '- refined: the question rewritten to be clear and concise (keep the original language and meaning).',
      '- topic: a 2-4 word topic label for grouping similar questions.'
    ].join('\n')
    const out = await aiChat(system, [
      { role: 'user', content: `Question: ${row.text}\n\nTranscript:\n${transcriptBlock(st.segs)}` }
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
    }
  } catch {
    await sb.from('speaker_questions').update({ status: 'error' }).eq('id', row.id)
  } finally {
    st.answering.delete(row.id)
  }
}

async function pollStats(): Promise<void> {
  if (!studio || !current) return
  const st = studio
  const { data: atts } = await sb
    .from('attendees')
    .select('id,lang')
    .eq('event_id', current.id)
  st.attendeeCount = atts?.length ?? st.attendeeCount
  for (const a of atts ?? []) st.attendeeLangs.set(a.id as string, (a.lang as string) || 'English')
  el('statatt').textContent = String(st.attendeeCount)
  const { data: subs } = await sb
    .from('speaker_questions')
    .select('refined,text,topic')
    .eq('event_id', current.id)
    .eq('status', 'submitted')
    .order('created_at', { ascending: false })
  st.questionCount = subs?.length ?? 0
  el('statq').textContent = String(st.questionCount)
  const wrap = el('squestions')
  if ((subs?.length ?? 0) > 0) {
    wrap.innerHTML = ''
    for (const q of subs ?? []) {
      const d = document.createElement('div')
      d.className = 'qitem'
      d.innerHTML = '<div class="qtopic"></div><div></div>'
      ;(d.children[0] as HTMLElement).textContent = (q.topic as string) || 'General'
      ;(d.children[1] as HTMLElement).textContent = (q.refined as string) || (q.text as string)
      wrap.appendChild(d)
    }
  }
}

// end event
el('endbtn').onclick = async () => {
  if (!studio || !current) return
  const st = studio
  st.ending = true
  clearInterval(st.sttTimer)
  clearInterval(st.frameTimer)
  clearInterval(st.statsTimer)
  clearInterval(st.clockTimer)
  // st.workTimer stays running: attendees grab take-home packs after the end,
  // and this tab keeps answering them until the host leaves this screen.
  try {
    if (st.sttRecorder && st.sttRecorder.state !== 'inactive') st.sttRecorder.stop()
  } catch {
    /* noop */
  }
  const recorded = new Promise<Blob>((resolve) => {
    st.fullRecorder.onstop = () => resolve(new Blob(st.fullChunks, { type: 'audio/webm' }))
    try {
      st.fullRecorder.stop()
    } catch {
      resolve(new Blob(st.fullChunks, { type: 'audio/webm' }))
    }
  })
  st.micStream.getTracks().forEach((t) => t.stop())
  st.displayStream?.getTracks().forEach((t) => t.stop())
  await sb
    .from('events')
    .update({ status: 'ended', updated_at: new Date().toISOString() })
    .eq('id', current.id)
  current.status = 'ended'
  el('endsummary').textContent = `${st.attendeeCount} attendees · ${st.askCount} AI answers · ${st.questionCount} questions for you. Attendees can grab their take-home packs now.`
  const blob = await recorded
  if (blob.size > 5000) {
    const dl = el('dlrec') as HTMLButtonElement
    dl.classList.remove('hidden')
    dl.onclick = () => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = (current?.title || 'sitka-event').replace(/[^\w-]+/g, '-') + '.webm'
      a.click()
    }
  }
  show('ended')
}
el('backhome').onclick = () => {
  if (studio) {
    clearInterval(studio.workTimer)
    studio = null
  }
  void enterDash()
}

// ---------- boot ----------
async function boot(): Promise<void> {
  const { data } = await sb.auth.getSession()
  if (data.session?.user) {
    user = data.session.user
    await enterDash()
  } else {
    show('auth')
  }
}
void boot()
