import './pageboot'
import { timeoutSignal } from '../../src/shared/timeout'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { patientFetch } from './patientFetch'
import { downloadBytes, fileName, notesPdf, withoutTimes } from './notesFile'
import './style.css'
import { installFocusGuard } from '../../src/shared/focusGuard'
// A refreshed page starts at its top. Browsers put a reloaded page back
// where it was scrolled, which lands people mid-section with no bearings.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
window.addEventListener('pageshow', () => window.scrollTo(0, 0))

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
// Everything the room writes (questions, messages, reactions, votes) must come
// from a real attendee: the database checks the secret this page holds, sent
// with every request. Empty until the attendee has joined.
let writeSecret = ''
const attendeeFetch: typeof fetch = (input, init) => {
  if (!writeSecret) return patientFetch(input, init)
  const headers = new Headers(init?.headers)
  headers.set('x-sitca-attendee', writeSecret)
  return patientFetch(input, { ...init, headers })
}
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false }, global: { fetch: attendeeFetch } })
// The person's own account, when they have one on this browser: the app keeps
// its session here too. Used only to say who they are and to keep the event;
// it carries the attendee secret as well, which keeping an event checks.
const sbMe = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }, global: { fetch: attendeeFetch } })
let me: { id: string; name: string } | null = null
async function whoAmI(): Promise<void> {
  try {
    const { data } = await sbMe.auth.getSession()
    const u = data.session?.user
    const meta = (u?.user_metadata ?? {}) as { full_name?: string; name?: string }
    me = u ? { id: u.id, name: (meta.full_name || meta.name || (u.email || '').split('@')[0] || 'you').trim() } : null
  } catch {
    me = null
  }
  const chip = document.getElementById('acctme')
  if (!chip) return
  chip.classList.toggle('hidden', !me)
  document.querySelectorAll('.acct.signin, .acct.create').forEach((a) => a.classList.toggle('hidden', Boolean(me)))
  if (me) {
    ;(document.getElementById('acctav') as HTMLElement).textContent = me.name.slice(0, 1).toUpperCase()
    ;(document.getElementById('acctname') as HTMLElement).textContent = me.name.split(' ')[0]
  }
}
void whoAmI()

// ---------- event id from /e/<id> or ?e=<id> ----------
const pathMatch = /\/e\/([^/?#]+)/.exec(location.pathname)
const eventId = pathMatch ? pathMatch[1] : new URLSearchParams(location.search).get('e') || ''
// ---------- keeping the event, for someone with an account ----------
const keptKey = () => 'sitca-kept-' + eventId
const askedKey = () => 'sitca-keep-asked-' + eventId
let kept = false
try {
  kept = localStorage.getItem(keptKey()) === '1'
} catch {
  kept = false
}
/** once, while it is live: keep it? */
function offerKeep(): void {
  if (!me || !attId || kept) return
  try {
    if (localStorage.getItem(askedKey()) === '1') return
    localStorage.setItem(askedKey(), '1')
  } catch {
    /* asked each time, then */
  }
  ;(document.getElementById('keepname') as HTMLElement).textContent = me.name
  document.getElementById('keepwrap')?.classList.remove('hidden')
}
async function keepNow(): Promise<void> {
  if (!me || !attId) return
  const { error } = await sbMe.rpc('sitka_attend_keep', { p_attendee: attId, p_keep: true })
  if (error) {
    alert(/does not exist|function/i.test(error.message) ? 'Keeping is not switched on yet on this server.' : error.message)
    return
  }
  kept = true
  try {
    localStorage.setItem(keptKey(), '1')
  } catch {
    /* remembered on the server anyway */
  }
  document.getElementById('keepwrap')?.classList.add('hidden')
  refreshEndCard()
}
/** at the end: into the library now (the host's recap may need a moment) */
async function keepEnded(tries = 0): Promise<void> {
  if (!me) return
  const box = document.getElementById('endkeep') as HTMLElement
  box.textContent = 'Keeping it…'
  const { data, error } = await sbMe.rpc('sitka_keep_event', { p_event: eventId })
  const r = (data ?? {}) as { ok?: boolean }
  if (!error && r.ok) {
    kept = true
    try {
      localStorage.setItem(keptKey(), '1')
    } catch {
      /* fine */
    }
    refreshEndCard()
    return
  }
  if (error) {
    box.textContent = error.message
    return
  }
  if (tries < 15) window.setTimeout(() => void keepEnded(tries + 1), 4000)
  else box.textContent = 'The recap is still being written. Open it later and press “Keep in my library”.'
}
document.getElementById('keepyes')?.addEventListener('click', () => void keepNow())
document.getElementById('keepno')?.addEventListener('click', () => document.getElementById('keepwrap')?.classList.add('hidden'))
document.getElementById('keepwrap')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('keepwrap')) document.getElementById('keepwrap')?.classList.add('hidden')
})

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

interface EventRow {
  id: string
  title: string
  status: 'waiting' | 'live' | 'ended'
  starts_at: string | null
  pre_event_chat: boolean
  materials_present: boolean
  live_voice: { enabled: boolean; languages: string[] }
  replay?: { enabled?: boolean; summary?: string; video?: boolean | 'parts' } | null
  /** the host's heartbeat, touched every few seconds while live */
  host_seen?: string | null
  /** a picture shown where the video would be, for a voice-only event */
  banner?: string | null
}
/**
 * The event's public fields. Read through sitka_event(), which answers for
 * one event at a time and never with the host's materials; a database that
 * has not had that function yet is read the older way.
 */
async function readEvent(): Promise<{ data: EventRow | null; error: string }> {
  const r = await sb.rpc('sitka_event', { p_id: eventId })
  if (!r.error) return { data: (r.data as EventRow | null) ?? null, error: '' }
  if (!/sitka_event|PGRST202|Could not find the function/i.test(`${r.error.code ?? ''} ${r.error.message}`)) {
    return { data: null, error: r.error.message || 'no reply' }
  }
  const t = await sb.from('events').select('*').eq('id', eventId).maybeSingle()
  return { data: (t.data as EventRow | null) ?? null, error: t.error ? t.error.message || 'no reply' : '' }
}
interface SegRow {
  idx: number
  start_sec: number
  label: string
  text: string
}

let ev: EventRow | null = null
let attId: string | null = null
/**
 * A secret only this page holds, made when the person joins. Its hash is on
 * their attendee row; the server shows their answers only to whoever has it.
 * Someone who joined before secrets existed has none, and is still answered.
 */
let attSecret = ''
function newSecret(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('')
}
/** An attendee row with the hash of its secret; without it on a database that has not got the column yet. */
async function insertAttendee(row: Record<string, unknown>, secret: string): Promise<{ error: { message: string } | null }> {
  const withHash = await sb.from('attendees').insert({ ...row, secret_hash: await sha256Hex(secret) })
  if (!withHash.error || !/secret_hash/i.test(withHash.error.message)) return withHash
  return sb.from('attendees').insert(row)
}
let persona: string | null = null
let myLang = 'English'
let joined = false
let listening = false
let myName = ''

// ---------- the room: who is here, and what they are saying ----------
async function refreshCount(): Promise<void> {
  // The number only, from a function that may count what the room may not
  // read (supabase/legacy/wave13.sql). Before that script runs, the badge stays away.
  const { data, error } = await sb.rpc('attendee_count', { eid: eventId })
  if (error) return
  const count = Number(data)
  if (Number.isFinite(count)) {
    el('countn').textContent = String(count)
    el('count').classList.toggle('hidden', count < 1)
  }
}

interface RoomRow {
  id: string
  /** an anonymous tag of the writer; the writer's own page knows its own */
  author?: string | null
  /** only on this page's own messages (and on databases before the tag) */
  attendee_id?: string | null
  name: string
  host: boolean
  text: string
  created_at?: string
}
const roomSeen = new Set<string>()
let roomLastAt = ''
/** this attendee's tag: the first 16 hex of the sha-256 of their id's 16 bytes */
let myAuthor = ''
async function authorTag(id: string): Promise<string> {
  const hex = id.replace(/-/g, '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
// The room is read by its anonymous tags; a database without them yet is
// read the older way.
let roomCols = 'id,author,name,host,text,created_at'
async function roomRows(since: string | null, limit: number): Promise<RoomRow[]> {
  const run = (cols: string) => {
    let q = sb.from('room_messages').select(cols).eq('event_id', eventId)
    if (since !== null) q = q.gt('created_at', since || '1970-01-01')
    return q.order('created_at', { ascending: true }).limit(limit)
  }
  let r = await run(roomCols)
  if (r.error && /author/i.test(r.error.message)) {
    roomCols = 'id,attendee_id,name,host,text,created_at'
    r = await run(roomCols)
  }
  return (r.data ?? []) as unknown as RoomRow[]
}
// Realtime delivers instantly; this quiet poll guarantees nothing is ever
// missed even when the live connection drops for a moment.
async function pollRoom(): Promise<void> {
  for (const r of await roomRows(roomLastAt, 50)) renderRoomMsg(r)
}
function renderRoomMsg(row: RoomRow): void {
  if (row.created_at && row.created_at > roomLastAt) roomLastAt = row.created_at
  if (roomSeen.has(row.id)) return
  roomSeen.add(row.id)
  el('roomwait')?.classList.add('hidden')
  const d = document.createElement('div')
  const mine = Boolean((row.attendee_id && row.attendee_id === attId) || (row.author && myAuthor && row.author === myAuthor))
  d.className = `rm${mine ? ' me' : ''}${row.host ? ' host' : ''}`
  const who = document.createElement('b')
  who.textContent = row.host ? 'Host' : mine ? 'You' : row.name || 'Guest'
  const body = document.createElement('span')
  body.textContent = row.text
  d.append(who, body)
  el('room').appendChild(d)
  const pane = el('pane-room')
  if (pane.classList.contains('sel')) pane.scrollTop = pane.scrollHeight
  else if (!mine) document.querySelector('[data-pane=room]')?.classList.add('new')
}
async function sendRoom(text: string): Promise<void> {
  const t = text.trim().slice(0, 600)
  if (!t || !attId) return
  const row: RoomRow = {
    id: crypto.randomUUID(),
    attendee_id: attId,
    name: myName || (persona ? persona : 'Guest'),
    host: false,
    text: t
  }
  renderRoomMsg(row) // instantly, then the room gets it
  const { error } = await sb.from('room_messages').insert({ ...row, event_id: eventId })
  if (error) {
    const n = document.createElement('div')
    n.className = 'notice err'
    n.textContent = /relation|does not exist/i.test(error.message)
      ? 'The room chat is not set up for this event yet.'
      : 'Could not send — check your connection.'
    el('room').appendChild(n)
  }
}

const LANG_CODES: Record<string, string> = {
  English: 'en', Shona: 'sn', Ndebele: 'nr', Nyankole: 'nyn', Swahili: 'sw', French: 'fr',
  Portuguese: 'pt', Spanish: 'es', German: 'de', Arabic: 'ar', Chinese: 'zh', Hindi: 'hi'
}

// ---------- markdown + timestamp chips (same renderer as the desktop app) ----------
const RE_FW = /【\s*((?:[a-fA-F0-9-]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\s*】/g
const RE_BR = /\[{1,2}\s*((?:[a-fA-F0-9-]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\s*\]{1,2}/g
const RE_CHIP = /\[\[((?:[a-fA-F0-9-]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\]\]/g
const RE_PAREN = /\((\d{1,2}:\d{2}(?::\d{2})?)\)/g
const normCites = (t: string): string =>
  (t || '').replace(RE_FW, '[[$1]]').replace(RE_BR, '[[$1]]').replace(RE_PAREN, '[[$1]]')
const escH = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function parseTs(ts: string): number | null {
  const p = ts.split(':').map(Number)
  if (p.some(isNaN)) return null
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  if (p.length === 2) return p[0] * 60 + p[1]
  return null
}
function inlineMd(s: string): string {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  s = s.replace(RE_CHIP, (_m, body: string) => {
    const at = body.indexOf('@')
    const label = at >= 0 ? body.slice(at + 1) : body
    const sec = parseTs(label)
    if (sec === null || at >= 0) return label
    return `<button class="tchip" data-s="${sec}">${label}</button>`
  })
  return s
}
function rowCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}
function md(src: string): string {
  const lines = escH(normCites(src)).split(/\r?\n/)
  const out: string[] = []
  let i = 0
  let inCode = false
  let codeBuf: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listBuf: string[] = []
  const flushList = (): void => {
    if (listType) {
      out.push(`<${listType}>${listBuf.join('')}</${listType}>`)
      listType = null
      listBuf = []
    }
  }
  while (i < lines.length) {
    const L = lines[i]
    if (/^```/.test(L)) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
        codeBuf = []
        inCode = false
      } else {
        flushList()
        inCode = true
      }
      i++
      continue
    }
    if (inCode) {
      codeBuf.push(L)
      i++
      continue
    }
    if (
      /^\s*\|/.test(L) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      flushList()
      const head = rowCells(L)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(rowCells(lines[i]))
        i++
      }
      out.push(
        `<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>'
      )
      continue
    }
    let m = /^(#{1,6})\s+(.*)$/.exec(L)
    if (m) {
      flushList()
      const lv = Math.min(m[1].length + 1, 4)
      out.push(`<h${lv}>${inlineMd(m[2])}</h${lv}>`)
      i++
      continue
    }
    m = /^\s*[-*+]\s+(.*)$/.exec(L)
    if (m) {
      if (listType !== 'ul') {
        flushList()
        listType = 'ul'
      }
      listBuf.push(`<li>${inlineMd(m[1])}</li>`)
      i++
      continue
    }
    m = /^\s*\d+[.)]\s+(.*)$/.exec(L)
    if (m) {
      if (listType !== 'ol') {
        flushList()
        listType = 'ol'
      }
      listBuf.push(`<li>${inlineMd(m[1])}</li>`)
      i++
      continue
    }
    if (!L.trim()) {
      flushList()
      i++
      continue
    }
    flushList()
    out.push(`<p>${inlineMd(L)}</p>`)
    i++
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
  flushList()
  return out.join('')
}
function jumpToTime(sec: number): void {
  ;(document.querySelector('[data-pane=live]') as HTMLElement).click()
  setTimeout(() => {
    const segs = el('segs').children
    let best: Element | null = null
    for (let i = 0; i < segs.length; i++) {
      const s = parseFloat((segs[i] as HTMLElement).dataset.s || '')
      if (!isNaN(s) && s <= sec + 0.5) best = segs[i]
    }
    if (!best && segs.length) best = segs[0]
    if (!best) return
    best.scrollIntoView({ block: 'center', behavior: 'smooth' })
    best.classList.remove('flash')
    void (best as HTMLElement).offsetWidth
    best.classList.add('flash')
  }, 60)
}
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest?.('.tchip') as HTMLElement | null
  if (t) jumpToTime(parseFloat(t.dataset.s || '0'))
})

// Phones: the keyboard appears only when a field is tapped, never on its own.
installFocusGuard()

// ---------- voice (Listen) ----------
// Each new line, spoken in the listener's language. The natural voice comes
// from /api/speak, the same one that reads Sitca's answers; the phone's own
// voice is only the fallback when that cannot be reached. Sound is only
// allowed after a tap, so one audio element is unlocked inside the tap and
// every line is played through it.
let voiceList: SpeechSynthesisVoice[] = []
const refreshVoices = (): void => {
  if (window.speechSynthesis) voiceList = window.speechSynthesis.getVoices() || []
}
refreshVoices()
if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = refreshVoices
// The nicest voice the phone has for the language. Natural and neural voices
// first; the old robotic ones only when nothing else is installed.
function pickVoice(): SpeechSynthesisVoice | null {
  const code = LANG_CODES[myLang] || 'en'
  if (!voiceList.length) refreshVoices()
  const match = voiceList.filter((v) => v.lang?.toLowerCase().startsWith(code))
  if (match.length === 0) return null
  const score = (v: SpeechSynthesisVoice): number => {
    const n = v.name
    let s = 0
    if (/natural|neural|premium|enhanced|wavenet|journey|studio/i.test(n)) s += 40
    if (/^google/i.test(n)) s += 30
    if (/microsoft .*online/i.test(n)) s += 25
    if (/samantha|daniel|karen|moira|siri|ava|allison/i.test(n)) s += 15
    if (/espeak|compact|robot/i.test(n)) s -= 50
    return s
  }
  return [...match].sort((a, b) => score(b) - score(a))[0] ?? null
}
/** A tenth of a second of silence as a WAV: enough to unlock playback. */
function silentWav(): string {
  const rate = 8000
  const samples = rate / 10
  const buf = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(buf)
  const str = (at: number, t: string): void => {
    for (let i = 0; i < t.length; i++) v.setUint8(at + i, t.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples * 2, true)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}
let voiceAudio: HTMLAudioElement | null = null
let voiceServerDown = 0 // when the natural voice last failed: the phone's voice stands in for a while
async function fetchVoice(text: string): Promise<Blob | null> {
  if (Date.now() - voiceServerDown < 60000) return null
  try {
    // an attendee's voice is paid for by the event: the page shows it is one
    const r = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...secretHeader(writeSecret) },
      body: JSON.stringify({ text, lang: myLang, event: eventId, attendee: attId }),
      signal: timeoutSignal(12000)
    })
    if (!r.ok || !/^audio\//i.test(r.headers.get('content-type') || '')) {
      voiceServerDown = Date.now()
      return null
    }
    const b = await r.blob()
    return b.size > 1000 ? b : null
  } catch {
    voiceServerDown = Date.now()
    return null
  }
}
function speakWithPhone(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve()
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice()
    if (v) u.voice = v
    u.lang = v?.lang || LANG_CODES[myLang] || 'en'
    u.rate = 1.05 * catchUpRate()
    u.onend = () => resolve()
    u.onerror = () => resolve()
    window.speechSynthesis.speak(u)
  })
}
function playVoice(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const a = voiceAudio
    if (!a) {
      resolve()
      return
    }
    const url = URL.createObjectURL(blob)
    const done = (): void => {
      URL.revokeObjectURL(url)
      a.onended = null
      a.onerror = null
      resolve()
    }
    a.onended = done
    a.onerror = done
    a.src = url
    a.playbackRate = catchUpRate()
    a.play().catch(done)
  })
}
interface Spoken {
  text: string
  voice: Promise<Blob | null> | null
}
/** The voice can only say a line once it has heard it, so it always runs a
 * little behind the speaker. When lines queue up it speaks a touch faster
 * and closes the gap, rather than drifting further back. */
function catchUpRate(): number {
  return speakQ.length >= 2 ? 1.25 : speakQ.length === 1 ? 1.12 : 1
}
let speakQ: Spoken[] = []
let speakingNow = false
/** bumped when the voice is reset or switched off: an older run stops at its next step */
let speakGen = 0
async function speakNext(): Promise<void> {
  if (!listening || speakQ.length === 0) {
    speakingNow = false
    return
  }
  const gen = speakGen
  speakingNow = true
  speakStartedAt = Date.now()
  const item = speakQ.shift() as Spoken
  if (!item.voice) item.voice = fetchVoice(item.text)
  // the line after this one is fetched while this one plays
  const after = speakQ[0]
  if (after && !after.voice) after.voice = fetchVoice(after.text)
  const blob = await item.voice
  if (!listening || gen !== speakGen) return
  if (blob) await playVoice(blob)
  else await speakWithPhone(item.text)
  if (gen !== speakGen) return
  void speakNext()
}
function speakText(text: string): void {
  if (!listening || !text) return
  speakQ.push({ text, voice: null })
  // a listener who fell behind hears the newest lines, not a backlog
  while (speakQ.length > 3) speakQ.shift()
  if (!speakingNow) void speakNext()
}
// A voice that never ends is reset, not endured.
let speakStartedAt = 0
window.setInterval(() => {
  if (!listening) return
  if (speakingNow && Date.now() - speakStartedAt > 40000) {
    speakGen++
    window.speechSynthesis?.cancel()
    voiceAudio?.pause()
    speakingNow = false
    void speakNext()
  }
}, 5000)
let resumeTimer: number | null = null
function listenLabel(): void {
  const b = el('listenbtn')
  b.classList.toggle('on', listening)
  const icon = listening
    ? '<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>'
    : '<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 5 7 9H3.5v6H7l4.5 4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.7 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>'
  b.innerHTML = icon + '<span>' + (listening ? 'Stop listening' : 'Listen in ' + myLang) + '</span>'
}
function setupListen(): void {
  const vc = ev?.live_voice
  const active =
    !!vc?.enabled && (myLang.toLowerCase() === 'english' || (vc.languages || []).includes(myLang))
  if (!active) return
  const b = el('listenbtn')
  b.classList.remove('hidden')
  listenLabel()
  b.onclick = () => {
    if (!listening) {
      // unlocked inside the tap: from here on the page may make sound
      if (!voiceAudio) {
        voiceAudio = new Audio(silentWav())
        voiceAudio.preload = 'auto'
      }
      void voiceAudio.play().catch(() => undefined)
      if (window.speechSynthesis) {
        const unlock = new SpeechSynthesisUtterance(' ')
        unlock.volume = 0
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(unlock)
        refreshVoices()
      }
      listening = true
      // one voice at a time: the spoken translation, or the room's own sound
      if (hearing) el('hearbtn').click()
      el('voicenote').textContent = 'Speaking each new line in ' + myLang + '.'
      el('voicenote').classList.remove('hidden')
      // say something at once, so the tap is answered by a voice, not silence
      speakQ = []
      speakingNow = false
      const last = lastCaption()
      speakText(last ? last.text : 'Listening in ' + myLang + '.')
      if (resumeTimer) clearInterval(resumeTimer)
      resumeTimer = window.setInterval(() => {
        if (listening && window.speechSynthesis) window.speechSynthesis.resume()
      }, 5000)
    } else {
      listening = false
      speakGen++
      speakQ = []
      speakingNow = false
      if (resumeTimer) {
        clearInterval(resumeTimer)
        resumeTimer = null
      }
      window.speechSynthesis?.cancel()
      voiceAudio?.pause()
      if (!hearing) el('voicenote').classList.add('hidden')
    }
    listenLabel()
  }
}

// ---------- badge / views ----------
function setBadge(mode: 'live' | 'soon' | 'ended'): void {
  const b = el('livebadge')
  if (mode === 'live') {
    b.className = 'live on'
    b.innerHTML = '<span class="ldot"></span>LIVE'
  } else if (mode === 'soon') {
    b.className = 'live soon'
    b.innerHTML = '<span class="ldot"></span>SOON'
  } else {
    b.className = 'live soon'
    b.textContent = 'ENDED'
  }
}

const translatedForMe = (): boolean => {
  const vc = ev?.live_voice
  return (
    myLang.toLowerCase() !== 'english' && !!vc?.enabled && (vc.languages || []).includes(myLang)
  )
}

// ---------- captions ----------
const segEls = new Map<number, HTMLElement>()
function upsertSeg(row: SegRow, translated?: string): void {
  // silence sometimes transcribes as a lone dot — never worth a line
  if (/^[\s.。…,\-–—]*$/.test(row.text)) return
  el('livewait').style.display = 'none'
  const existing = segEls.get(row.idx)
  if (existing) {
    if (translated) (existing.children[1] as HTMLElement).textContent = translated
    return
  }
  const d = document.createElement('div')
  d.className = 'seg'
  d.dataset.s = String(row.start_sec)
  d.innerHTML = '<span class="ts"></span><span class="segtext"></span>'
  ;(d.children[0] as HTMLElement).textContent = row.label
  ;(d.children[1] as HTMLElement).textContent = translated ?? row.text
  // keep transcript ordered by idx even when rows arrive out of order
  const wrap = el('segs')
  let before: HTMLElement | null = null
  for (const [idx, node] of segEls) {
    if (idx > row.idx && (!before || idx < Number(before.dataset.i))) before = node
  }
  d.dataset.i = String(row.idx)
  if (before) wrap.insertBefore(d, before)
  else wrap.appendChild(d)
  segEls.set(row.idx, d)
  const pane = el('pane-live')
  if (pane.classList.contains('sel')) pane.scrollTop = pane.scrollHeight
  // English listeners speak originals; translated listeners speak on translation arrival
  if (!translatedForMe()) speakText(row.text)
  else if (translated) {
    appliedTrans.add(row.idx)
    speakText(translated)
  }
}
/** lines already shown in the person's language: never spoken twice */
const appliedTrans = new Set<number>()
function applyTranslation(idx: number, text: string): void {
  if (appliedTrans.has(idx)) return
  appliedTrans.add(idx)
  const node = segEls.get(idx)
  if (node) {
    ;(node.children[1] as HTMLElement).textContent = text
    speakText(text)
  } else {
    pendingTranslations.set(idx, text)
  }
}
const pendingTranslations = new Map<number, string>()

// ---------- stage view: the host's screen, live ----------
// The host sends a fresh picture whenever their screen changes (up to once a
// second). Each new picture fades over the previous one, so slides, boards and
// demos feel live rather than like a slideshow of snapshots.
let stageTimer: number | null = null
let stageWatch: number | null = null
let stageSeen = false
let stageBusy = false
let stageLastAt = 0
let stageStartedAt = 0
let stageEtag = ''
const stageUrl = (): string =>
  `${SUPA_URL}/storage/v1/object/public/stage/${eventId}.jpg`
function showStageFrame(b: Blob): void {
  const u = URL.createObjectURL(b)
  const img = el('stageimg') as HTMLImageElement
  const back = el('stageimgb') as HTMLImageElement
  const prev = img.dataset.u
  if (prev) back.src = prev
  img.src = u
  img.classList.remove('fade')
  void img.offsetWidth
  img.classList.add('fade')
  ;(el('stagefullimg') as HTMLImageElement).src = u
  img.dataset.u = u
  if (prev) window.setTimeout(() => URL.revokeObjectURL(prev), 600)
  stageLastAt = Date.now()
  el('stagecard').classList.remove('paused')
  el('stagecard').classList.remove('banner')
  if (!stageSeen) {
    stageSeen = true
    el('stagewait').classList.add('hidden')
    el('stagecard').classList.remove('hidden')
    if (!el('stagecard').classList.contains('mini')) el('stagesplit').classList.remove('hidden')
  }
}
function pollStage(): void {
  if (stageBusy) return
  stageBusy = true
  fetch(stageUrl() + '?t=' + Date.now(), { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error('nf')
      // the same picture again costs nothing to skip
      const tag = r.headers.get('etag') || r.headers.get('last-modified') || ''
      if (tag && tag === stageEtag) return null
      stageEtag = tag
      return r.blob()
    })
    .then((b) => {
      if (b) showStageFrame(b)
    })
    .catch(() => {
      /* nothing there yet, or a blip — the watcher handles a long silence */
    })
    .then(() => {
      stageBusy = false
    })
}
function watchStage(): void {
  const now = Date.now()
  if (stageSeen) {
    // the host stopped sharing, or their connection hiccuped
    el('stagecard').classList.toggle('paused', now - stageLastAt > 8000)
  } else if (now - stageStartedAt > 30000 || bannerShown) {
    // half a minute with nothing: an audio-only talk, most likely
    el('stagewait').classList.add('hidden')
  }
}
// The banner: the host's picture where the video would be, until the host
// shares a screen and real frames take its place.
let bannerShown = ''
function showBanner(): void {
  const url = ev?.banner || ''
  if (!url || stageSeen || bannerShown === url) return
  bannerShown = url
  const img = el('stageimg') as HTMLImageElement
  img.src = url
  ;(el('stagefullimg') as HTMLImageElement).src = url
  el('stagewait').classList.add('hidden')
  el('stagecard').classList.remove('hidden')
  el('stagecard').classList.remove('paused')
  el('stagecard').classList.add('banner')
  if (!el('stagecard').classList.contains('mini')) el('stagesplit').classList.remove('hidden')
}
function startStage(): void {
  showBanner()
  if (!stageTimer) {
    stageStartedAt = Date.now()
    if (!stageSeen && !bannerShown) el('stagewait').classList.remove('hidden')
    pollStage()
    stageTimer = window.setInterval(pollStage, 1000)
    stageWatch = window.setInterval(watchStage, 2000)
  }
}
function stopStage(): void {
  if (stageTimer) {
    clearInterval(stageTimer)
    stageTimer = null
  }
  if (stageWatch) {
    clearInterval(stageWatch)
    stageWatch = null
  }
  el('stagewait').classList.add('hidden')
  el('stagecard').classList.remove('paused')
}
function leaveStageFull(): void {
  const card = el('stagecard')
  if (!card.classList.contains('full')) return
  card.classList.remove('full')
  document.documentElement.classList.remove('stage-full')
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
}
function openStageFull(): void {
  // already filling the screen: the same tap always leads out, whatever the
  // stream is doing now (it may have dropped since)
  if (el('stagecard').classList.contains('full')) {
    leaveStageFull()
    return
  }
  if (el('stagecard').classList.contains('rtc')) {
    // The whole card goes full screen, not the bare video: a video element
    // on its own grows built-in controls in fullscreen, and a tap on them
    // pauses a live stream. The card keeps its own buttons instead.
    const card = el('stagecard') as HTMLElement
    const v = el('stagevideo') as HTMLVideoElement
    // The card fills the window by its own styling rather than the browser's
    // fullscreen: that works on every phone alike (iPhones only fullscreen a
    // bare video, whose built-in controls pause a live stream), and the
    // card's own buttons stay where they are.
    const full = !card.classList.contains('full')
    card.classList.toggle('full', full)
    document.documentElement.classList.toggle('stage-full', full)
    if (full && document.fullscreenElement === null && card.requestFullscreen && !/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      // where the browser allows it, the whole screen as well
      void card.requestFullscreen().catch(() => undefined)
    } else if (!full && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    }
    void v.play().catch(() => undefined)
    return
  }
  el('stagefull').classList.remove('hidden')
}
// ---------- Ask Sitca while the stage fills the screen ----------
// The drawer borrows the Ask conversation and its input from the page (moved,
// not copied, so nothing is lost or doubled) and gives them back on close.
{
  const card = el('stagecard')
  const drawer = el('stagedrawer')
  const body = el('stagedrawerbody')
  const foot = el('stagedrawerfoot')
  const chat = el('chat')
  const row = el('askrow')
  const chatHome = { parent: chat.parentElement as HTMLElement, next: chat.nextSibling }
  const rowHome = { parent: row.parentElement as HTMLElement, next: row.nextSibling }
  let rowWas = row.style.display
  const openDrawer = (): void => {
    rowWas = row.style.display
    body.appendChild(chat)
    row.style.display = ''
    foot.appendChild(row)
    drawer.classList.remove('hidden')
    card.classList.add('asking')
    body.scrollTop = body.scrollHeight
    // the field is focused only on a laptop: a phone keeps its keyboard down until tapped
    if (!window.matchMedia('(pointer: coarse)').matches) (el('asktext') as HTMLTextAreaElement).focus()
  }
  const closeDrawer = (): void => {
    if (drawer.classList.contains('hidden')) return
    chatHome.parent.insertBefore(chat, chatHome.next)
    rowHome.parent.insertBefore(row, rowHome.next)
    row.style.display = rowWas
    drawer.classList.add('hidden')
    card.classList.remove('asking')
  }
  el('stageaskbtn').onclick = (e) => {
    e.stopPropagation()
    openDrawer()
  }
  el('stagedrawerclose').onclick = (e) => {
    e.stopPropagation()
    closeDrawer()
  }
  // taps inside the drawer are the drawer's own, not the stage's
  drawer.addEventListener('click', (e) => e.stopPropagation())
  // leaving the big view closes the drawer with it
  new MutationObserver(() => {
    if (!card.classList.contains('full')) closeDrawer()
  }).observe(card, { attributes: true, attributeFilter: ['class'] })
}

// a live picture has no pause: if anything pauses it, it plays on
{
  const v = el('stagevideo') as HTMLVideoElement
  v.addEventListener('pause', () => {
    if (el('stagecard').classList.contains('rtc') && v.srcObject) {
      window.setTimeout(() => void v.play().catch(() => undefined), 150)
    }
  })
  document.addEventListener('fullscreenchange', () => {
    // the browser's fullscreen left by other means (the Escape key): the card follows
    if (!document.fullscreenElement) {
      el('stagecard').classList.remove('full')
      document.documentElement.classList.remove('stage-full')
    }
    void v.play().catch(() => undefined)
  })
  // a black frame is not a picture: the card says "connecting" until one arrives
  v.addEventListener('playing', () => el('stagecard').classList.remove('connecting'))
  v.addEventListener('loadeddata', () => el('stagecard').classList.remove('connecting'))
}
el('stageexpbtn').onclick = (e) => {
  e.stopPropagation()
  openStageFull()
}
el('stageimg').onclick = openStageFull
el('stagevideo').onclick = openStageFull

// ---------- hide the screen when the words need the room ----------
{
  const card = el('stagecard')
  const btn = el('stageminbtn')
  const apply = (mini: boolean): void => {
    card.classList.toggle('mini', mini)
    btn.textContent = mini ? 'Show screen' : 'Hide'
    el('stagesplit').classList.toggle('hidden', mini || card.classList.contains('hidden'))
  }
  try {
    apply(localStorage.getItem('sitka-stage-mini') === '1')
  } catch {
    /* ignore */
  }
  btn.onclick = (e) => {
    e.stopPropagation()
    const mini = !card.classList.contains('mini')
    apply(mini)
    try {
      localStorage.setItem('sitka-stage-mini', mini ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
}

// ---------- the screen's height is yours: drag the handle ----------
{
  const split = el('stagesplit')
  const card = el('stagecard')
  let dragY = 0
  let startH = 0
  try {
    const saved = localStorage.getItem('sitka-stage-h')
    if (saved) card.style.setProperty('--stage-h', saved)
  } catch {
    /* ignore */
  }
  split.classList.add('hidden')
  split.addEventListener('pointerdown', (e) => {
    dragY = e.clientY
    startH = card.getBoundingClientRect().height
    split.classList.add('drag')
    split.setPointerCapture(e.pointerId)
  })
  split.addEventListener('pointermove', (e) => {
    if (!split.classList.contains('drag')) return
    const max = el('pane-live').clientHeight * 0.78
    const h = Math.max(140, Math.min(max, startH + (e.clientY - dragY)))
    card.style.setProperty('--stage-h', `${Math.round(h)}px`)
  })
  const end = (): void => {
    if (!split.classList.contains('drag')) return
    split.classList.remove('drag')
    try {
      localStorage.setItem('sitka-stage-h', card.style.getPropertyValue('--stage-h'))
    } catch {
      /* ignore */
    }
  }
  split.addEventListener('pointerup', end)
  split.addEventListener('pointercancel', end)
}

// ---------- real-time video from the host (WebRTC) ----------
// The host offers a live video track to each phone that asks; the still
// frames keep flowing underneath, so a phone that cannot connect (or a room
// too large for direct connections) still sees the screen, a second behind.
let rtcPc: RTCPeerConnection | null = null
let rtcChannel: RealtimeChannel | null = null
let rtcWantTimer: number | null = null
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
function rtcWant(): void {
  void rtcChannel?.send({ type: 'broadcast', event: 'want', payload: { id: attId } })
}
function rtcMark(on: boolean): void {
  const card = el('stagecard')
  card.classList.toggle('rtc', on)
  if (!on) {
    card.classList.remove('connecting')
    leaveStageFull()
  }
  if (on) {
    card.classList.remove('hidden')
    el('stagewait').classList.add('hidden')
    if (!card.classList.contains('mini')) el('stagesplit').classList.remove('hidden')
    stageSeen = true
  }
}
async function rtcAccept(sdp: RTCSessionDescriptionInit): Promise<void> {
  rtcPc?.close()
  const pc = new RTCPeerConnection(RTC_CONFIG)
  rtcPc = pc
  pc.onicecandidate = (e) => {
    if (e.candidate)
      void rtcChannel?.send({
        type: 'broadcast',
        event: 'ice',
        payload: { id: attId, from: 'attendee', candidate: e.candidate.toJSON() }
      })
  }
  const early: RTCIceCandidateInit[] = []
  let offered = false
  // the host sends the picture and the sound as two streams so the phone
  // never holds one back for the other; here they are put on one element
  const shown = new MediaStream()
  pc.ontrack = (e) => {
    const v = el('stagevideo') as HTMLVideoElement
    // a small buffer: enough to smooth the network's unevenness, not so
    // much that the room runs a second behind (none at all made the picture
    // arrive in pieces)
    try {
      ;(e.receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint = e.track.kind === 'video' ? 0.08 : 0.15
      ;(e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = e.track.kind === 'video' ? 80 : 150
    } catch {
      /* not every browser offers the hint */
    }
    if (!shown.getTracks().includes(e.track)) shown.addTrack(e.track)
    const stream = shown
    // the same stream, set once: setting it again restarts the element
    if (v.srcObject !== stream) v.srcObject = stream
    // muted until asked: someone in the room must not hear the host twice,
    // and browsers only allow sound after a tap anyway
    v.muted = !hearing
    keepPlaying(v)
    if (stream.getVideoTracks().length > 0) {
      el('stagecard').classList.add('connecting')
      rtcMark(true)
    }
    if (stream.getAudioTracks().length > 0) hearOffer()
  }
  pc.onconnectionstatechange = () => {
    if (rtcPc !== pc) return
    // "disconnected" often mends itself within seconds: the picture stays;
    // only a failed or closed connection takes it down
    if (pc.connectionState === 'connected') {
      rtcOfferedAt = 0
      if ((pc.getReceivers() || []).some((r) => r.track && r.track.kind === 'video')) rtcMark(true)
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      rtcMark(false)
    }
  }
  rtcOfferedAt = Date.now()
  rtcAddIce = (c) => {
    if (offered) void pc.addIceCandidate(c).catch(() => undefined)
    else early.push(c)
  }
  await pc.setRemoteDescription(sdp)
  offered = true
  // candidates that arrived before the offer was in are added now
  for (const c of early.splice(0)) void pc.addIceCandidate(c).catch(() => undefined)
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  void rtcChannel?.send({ type: 'broadcast', event: 'answer', payload: { id: attId, sdp: pc.localDescription } })
}
/** how a host candidate reaches the connection being set up (kept until the offer is in) */
let rtcAddIce: ((c: RTCIceCandidateInit) => void) | null = null
/** when the last offer arrived: a connection still being made is left to finish */
let rtcOfferedAt = 0
function startRtc(): void {
  if (rtcChannel || !attId || typeof RTCPeerConnection === 'undefined') return
  const ch = sb.channel('rtc-' + eventId, { config: { broadcast: { self: false } } })
  rtcChannel = ch
  ch.on('broadcast', { event: 'offer' }, ({ payload }) => {
    const p = payload as { id: string; sdp: RTCSessionDescriptionInit }
    if (p.id === attId) void rtcAccept(p.sdp).catch(() => rtcMark(false))
  })
  ch.on('broadcast', { event: 'ice' }, ({ payload }) => {
    const p = payload as { id: string; from: string; candidate: RTCIceCandidateInit }
    if (p.id === attId && p.from === 'host' && rtcPc) {
      if (rtcAddIce) rtcAddIce(p.candidate)
      else void rtcPc.addIceCandidate(p.candidate).catch(() => undefined)
    }
  })
  ch.on('broadcast', { event: 'bye' }, () => {
    rtcPc?.close()
    rtcPc = null
    rtcMark(false)
    hearGone()
  })
  // not connected, and not in the middle of connecting either: a connection
  // still being made (the phone's network can take ten seconds) is left to
  // finish rather than torn down by a fresh ask
  const needsAsk = (): boolean => {
    if (!rtcPc) return true
    const st = rtcPc.connectionState
    if (st === 'connected') return false
    const making = (st === 'new' || st === 'connecting') && Date.now() - rtcOfferedAt < 12000
    return !making
  }
  // the host arriving after us says "here": we ask again at once
  ch.on('broadcast', { event: 'here' }, () => {
    if (needsAsk()) rtcWant()
  })
  ch.subscribe((status) => {
    if (status !== 'SUBSCRIBED') return
    rtcWant()
    if (rtcWantTimer) clearInterval(rtcWantTimer)
    // asked again every few seconds until the picture is here
    rtcWantTimer = window.setInterval(() => {
      if (needsAsk()) rtcWant()
    }, 4000)
  })
}
// A live picture must never sit behind a play button. Some phones refuse
// autoplay (low power mode, a slow first frame), so the element is started
// again whenever it becomes able to play, and on the first tap anywhere.
let keptPlaying: HTMLVideoElement | null = null
function keepPlaying(v: HTMLVideoElement): void {
  const kick = (): void => {
    if (!v.srcObject || !v.paused) return
    void v.play().catch(() => {
      // sound refused without a tap: the picture still plays, silent
      if (!v.muted) {
        v.muted = true
        hearing = false
        hearLabel()
        void v.play().catch(() => undefined)
      }
    })
  }
  kick()
  if (keptPlaying === v) return
  keptPlaying = v
  v.addEventListener('loadedmetadata', kick)
  v.addEventListener('canplay', kick)
  v.addEventListener('pause', () => window.setTimeout(kick, 400))
  document.addEventListener('pointerdown', kick, { passive: true })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick()
  })
}

// ---------- hearing the room: the host's sound, live ----------
// Off until asked. Someone sitting in the room hears the host already, and a
// phone playing the host back would howl; someone joining from elsewhere
// taps once and hears the room as if they were in it.
let hearing = false
function hearLabel(): void {
  const b = el('hearbtn')
  b.classList.toggle('on', hearing)
  const icon = hearing
    ? '<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>'
    : '<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4a2 2 0 0 0 2 2h1l4 3.5v-15L6 8H5a2 2 0 0 0-2 2z"/><path d="M15 9.2a4 4 0 0 1 0 5.6"/></svg>'
  b.innerHTML = icon + '<span>' + (hearing ? 'Mute the room' : 'Hear the room') + '</span>'
}
function hearOffer(): void {
  const b = el('hearbtn')
  if (!b.classList.contains('hidden')) return
  b.classList.remove('hidden')
  hearLabel()
  b.onclick = () => {
    hearing = !hearing
    const v = el('stagevideo') as HTMLVideoElement
    v.muted = !hearing
    v.volume = 1
    if (hearing) {
      void v.play().catch(() => undefined)
      // one voice at a time: the room's own sound, or the spoken translation
      if (listening) el('listenbtn').click()
      el('voicenote').textContent = "You are hearing the room. In the room itself, keep this off."
      el('voicenote').classList.remove('hidden')
    } else if (!listening) {
      el('voicenote').classList.add('hidden')
    }
    hearLabel()
  }
}
function hearGone(): void {
  const was = hearing
  hearing = false
  const b = el('hearbtn')
  b.classList.add('hidden')
  hearLabel()
  const v = el('stagevideo') as HTMLVideoElement
  v.muted = true
  if (was && !listening) el('voicenote').classList.add('hidden')
}

function stopRtc(): void {
  rtcPc?.close()
  rtcPc = null
  rtcMark(false)
  hearGone()
  if (rtcWantTimer) {
    clearInterval(rtcWantTimer)
    rtcWantTimer = null
  }
  if (rtcChannel) {
    void sb.removeChannel(rtcChannel)
    rtcChannel = null
  }
}
el('stageclose').onclick = () => el('stagefull').classList.add('hidden')
el('stagefull').onclick = (e) => {
  if (e.target === el('stagefull') || e.target === el('stagefullimg'))
    el('stagefull').classList.add('hidden')
}

// ---------- save this moment (one tap: caption + slide snapshot) ----------
interface Moment {
  t: string
  text: string
  img: string | null
  at: number
}
const momKey = 'sitka-moments-' + eventId
let moments: Moment[] = []
try {
  moments = JSON.parse(localStorage.getItem(momKey) || '[]') as Moment[]
} catch {
  moments = []
}
function persistMoments(): void {
  try {
    localStorage.setItem(momKey, JSON.stringify(moments.slice(-40)))
  } catch {
    /* storage full/private mode — moments stay in memory */
  }
}
function lastCaption(): { t: string; text: string } | null {
  const w = el('segs')
  const d = w.lastElementChild as HTMLElement | null
  if (!d) return null
  return {
    t: (d.children[0] as HTMLElement).textContent || '',
    text: (d.children[1] as HTMLElement).textContent || ''
  }
}
function stageSnap(): string | null {
  if (!stageSeen) return null
  try {
    const img = el('stageimg') as HTMLImageElement
    const w = Math.min(640, img.naturalWidth || 640)
    const h = Math.round((w * (img.naturalHeight || 360)) / (img.naturalWidth || 640))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')?.drawImage(img, 0, 0, w, h)
    return c.toDataURL('image/jpeg', 0.6)
  } catch {
    return null
  }
}
el('savebtn').onclick = () => {
  const cap = lastCaption()
  moments.push({
    t: cap?.t || '',
    text: cap?.text || '(moment saved before the talk began)',
    img: stageSnap(),
    at: Date.now()
  })
  persistMoments()
  const span = el('savebtn').querySelector('span')
  if (span) {
    span.textContent = 'Saved — it will be in your pack'
    setTimeout(() => {
      span.textContent = 'Save this moment'
    }, 1600)
  }
}

// ---------- tappable captions: explain / define / why-for-me ----------
let sheetSeg: { t: string; text: string } | null = null
el('segs').addEventListener('click', (e) => {
  const d = (e.target as HTMLElement).closest?.('.seg') as HTMLElement | null
  if (!d) return
  sheetSeg = {
    t: (d.children[0] as HTMLElement).textContent || '',
    text: (d.children[1] as HTMLElement).textContent || ''
  }
  el('sheetquote').textContent = '[' + sheetSeg.t + '] ' + sheetSeg.text
  el('sheetwrap').classList.remove('hidden')
})
el('sheetwrap').onclick = (e) => {
  if (e.target === el('sheetwrap')) el('sheetwrap').classList.add('hidden')
}
function sheetAsk(prefix: string): void {
  if (!sheetSeg) return
  el('sheetwrap').classList.add('hidden')
  ;(document.querySelector('[data-pane=ask]') as HTMLElement).click()
  ask(prefix + ' — the speaker just said: "' + sheetSeg.text + '" (at ' + sheetSeg.t + ')')
}
el('sh-explain').onclick = () => sheetAsk('Explain this simply')
el('sh-define').onclick = () => sheetAsk('Define the technical terms in this')
el('sh-why').onclick = () => sheetAsk('Why does this matter for someone like me?')

// ---------- reactions: one-tap comprehension pulse to the host ----------
const reactCooldown: Record<string, number> = {}
function react(kind: 'landed' | 'lost'): void {
  if (!attId) return
  const now = Date.now()
  if (now - (reactCooldown[kind] || 0) < 20000) return
  reactCooldown[kind] = now
  void sb
    .from('reactions')
    .insert({ id: crypto.randomUUID(), event_id: eventId, attendee_id: attId, kind })
  const b = el(kind === 'landed' ? 'reactup' : 'reactlost')
  b.classList.add('sent')
  setTimeout(() => b.classList.remove('sent'), 1200)
}
el('reactup').onclick = () => react('landed')
el('reactlost').onclick = () => react('lost')

// ---------- live polls from the host ----------
interface PollRow {
  id: string
  question: string
  options: string[]
  status: string
}
let activePoll: PollRow | null = null
let pollTimer: number | null = null
let votedPolls = new Set<string>()
try {
  votedPolls = new Set(JSON.parse(localStorage.getItem('sitka-pollvotes') || '[]') as string[])
} catch {
  /* fresh */
}
function renderPoll(counts?: number[], total?: number): void {
  const card = el('pollcard')
  if (!activePoll) {
    card.classList.add('hidden')
    return
  }
  card.classList.remove('hidden')
  const voted = votedPolls.has(activePoll.id)
  const closed = activePoll.status !== 'open'
  let h = `<div class="poll-q"><span class="poll-tag">${closed ? 'POLL RESULTS' : 'LIVE POLL'}</span>${escH(activePoll.question)}</div>`
  activePoll.options.forEach((o, i) => {
    if (voted || closed) {
      const c = counts?.[i] ?? 0
      const pct = total ? Math.round((c / total) * 100) : 0
      h += `<div class="poll-row"><div class="poll-bar" style="width:${Math.max(4, pct)}%"></div><span class="poll-opt">${escH(o)}</span><span class="poll-count">${pct}%</span></div>`
    } else {
      h += `<button class="poll-vote" data-i="${i}">${escH(o)}</button>`
    }
  })
  card.innerHTML = h
  card.querySelectorAll('.poll-vote').forEach((b) => {
    ;(b as HTMLElement).onclick = () => void votePoll(Number((b as HTMLElement).dataset.i))
  })
}
async function refreshPollResults(): Promise<void> {
  if (!activePoll) return
  const { data } = await sb.from('poll_votes').select('choice').eq('poll_id', activePoll.id)
  const counts = activePoll.options.map(() => 0)
  for (const v of data ?? []) {
    const i = Number(v.choice)
    if (i >= 0 && i < counts.length) counts[i]++
  }
  renderPoll(counts, (data ?? []).length)
}
function setPoll(p: PollRow | null): void {
  activePoll = p && p.status === 'open' ? p : votedPolls.has(p?.id ?? '') ? p : null
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (!activePoll) {
    renderPoll()
    return
  }
  if (votedPolls.has(activePoll.id) || activePoll.status !== 'open') {
    void refreshPollResults()
    if (activePoll.status === 'open') {
      pollTimer = window.setInterval(() => void refreshPollResults(), 6000)
    }
  } else {
    renderPoll()
  }
}
async function votePoll(choice: number): Promise<void> {
  if (!activePoll || !attId) return
  votedPolls.add(activePoll.id)
  try {
    localStorage.setItem('sitka-pollvotes', JSON.stringify([...votedPolls].slice(-50)))
  } catch {
    /* private mode */
  }
  await sb.from('poll_votes').insert({ poll_id: activePoll.id, attendee_id: attId, choice })
  setPoll(activePoll)
}

// ---------- pushed room notes (host recap → this phone) ----------
function showRoomNote(text: string): void {
  const card = el('notecard')
  card.innerHTML = '<b>FROM THE HOST’S SITCA</b><span></span><button class="nx" aria-label="Dismiss">✕</button>'
  ;(card.children[1] as HTMLElement).textContent = text
  ;(card.querySelector('.nx') as HTMLButtonElement).onclick = () => card.classList.add('hidden')
  card.classList.remove('hidden')
  speakText(text)
}

// ---------- the room's question board (with upvotes) ----------
let votedQuestions = new Set<string>()
try {
  votedQuestions = new Set(JSON.parse(localStorage.getItem('sitka-qvotes') || '[]') as string[])
} catch {
  /* fresh */
}
async function refreshBoard(): Promise<void> {
  if (!joined) return
  const { data: qs } = await sb
    .from('speaker_questions')
    .select('id,refined,text,topic')
    .eq('event_id', eventId)
    .eq('status', 'submitted')
    .order('created_at', { ascending: false })
    .limit(30)
  const ids = (qs ?? []).map((q) => q.id as string)
  const counts = new Map<string, number>()
  if (ids.length > 0) {
    const { data: v } = await sb.from('question_votes').select('question_id').in('question_id', ids)
    for (const r of v ?? []) {
      const k = r.question_id as string
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  const list = (qs ?? [])
    .map((q) => ({
      id: q.id as string,
      text: (q.refined as string) || (q.text as string),
      votes: counts.get(q.id as string) ?? 0
    }))
    .sort((a, b) => b.votes - a.votes)
  const wrap = el('qboard')
  wrap.innerHTML = ''
  if (list.length === 0) {
    wrap.innerHTML = '<div class="waiting">No questions from the room yet.</div>'
    return
  }
  for (const q of list) {
    const d = document.createElement('div')
    d.className = 'qb-item'
    d.innerHTML = `<button class="qb-vote${votedQuestions.has(q.id) ? ' on' : ''}">▲<span>${q.votes}</span></button><div class="qb-text"></div>`
    ;(d.querySelector('.qb-text') as HTMLElement).textContent = q.text
    ;(d.querySelector('.qb-vote') as HTMLButtonElement).onclick = () => {
      if (votedQuestions.has(q.id) || !attId) return
      votedQuestions.add(q.id)
      try {
        localStorage.setItem('sitka-qvotes', JSON.stringify([...votedQuestions].slice(-100)))
      } catch {
        /* private mode */
      }
      void sb
        .from('question_votes')
        .insert({ question_id: q.id, attendee_id: attId })
        .then(() => void refreshBoard())
    }
    wrap.appendChild(d)
  }
}
window.setInterval(() => {
  if (el('pane-q').classList.contains('sel')) void refreshBoard()
}, 12000)

// ---------- wake lock (screen stays on during the live talk) ----------
let wakeLock: { release: () => Promise<void> } | null = null
async function keepAwake(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<never> } }
    if (nav.wakeLock) wakeLock = await nav.wakeLock.request('screen')
  } catch {
    /* not supported / denied — fine */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ev?.status === 'live') void keepAwake()
})

// ---------- view transitions ----------
function goLiveView(): void {
  el('wait').classList.add('hidden')
  el('main').classList.remove('hidden')
  // someone with an account is asked, once, whether to keep this
  window.setTimeout(() => void whoAmI().then(offerKeep), 2500)
  el('prenotice').classList.add('hidden')
  el('livenotice').classList.remove('hidden')
  el('catchup').classList.remove('hidden')
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('off'))
  el('savebtn').classList.remove('hidden')
  el('reactrow').classList.remove('hidden')
  startStage()
  startRtc()
  void keepAwake()
  // on a laptop the captions are always in view, so the panel opens on Ask
  if (window.matchMedia('(min-width: 900px)').matches) {
    const live = document.querySelector('[data-pane=live]')
    if (live?.classList.contains('sel')) (document.querySelector('[data-pane=ask]') as HTMLElement).click()
  }
}
function goPreView(): void {
  el('wait').classList.add('hidden')
  el('main').classList.remove('hidden')
  el('prenotice').classList.remove('hidden')
  el('livenotice').classList.add('hidden')
  el('catchup').classList.add('hidden')
  document.querySelectorAll('.tab').forEach((t) => {
    if ((t as HTMLElement).dataset.pane !== 'ask') t.classList.add('off')
  })
  ;(document.querySelector('[data-pane=ask]') as HTMLElement).click()
}
// The end card: the host has finished, and the recap is one tap away. The
// link shows as soon as the event row carries the recap flag, which the host's
// app sets in the same moment it ends the event.
function refreshEndCard(): void {
  if (!ev || ev.status !== 'ended') return
  const card = el('endcard')
  card.classList.remove('hidden')
  const link = el('endlink') as HTMLAnchorElement
  link.href = `/r/${eventId}`
  const on = Boolean(ev.replay?.enabled)
  link.classList.toggle('hidden', !on)
  el('endsub').textContent = on
    ? 'Your recap is ready: what was said, the key moments, and the recording. Ask it anything, any time.'
    : 'Thanks for being here. Your take-home pack is in the last tab.'
  // keeping it: done, one press, or a sign-in away
  const box = el('endkeep')
  if (!on) box.innerHTML = ''
  else if (kept) box.innerHTML = 'It is in your Sitca library. <a href="/app">Open Sitca</a>'
  else if (me) {
    if (!box.querySelector('button')) {
      box.innerHTML = ''
      const b = document.createElement('button')
      b.className = 'btn btn2'
      b.textContent = 'Keep in my library'
      b.onclick = () => void keepEnded()
      box.appendChild(b)
    }
  } else box.innerHTML = `Have a Sitca account? <a href="/app#keepevent=${eventId}">Sign in to keep this recap in your library</a>.`
}
let endedShown = false
function onEnded(): void {
  setBadge('ended')
  stopStage()
  stopRtc()
  el('takewait').textContent = 'The event has ended — grab your personalized pack below.'
  refreshEndCard()
  // On a phone the card sits at the top of the Live tab; bring it into view,
  // once. The row is updated several times after the end (the recap, its
  // words), and none of those should pull a person off whatever they were
  // reading.
  if (!endedShown && window.innerWidth < 900) {
    ;(document.querySelector('[data-pane=live]') as HTMLElement | null)?.click()
    el('pane-live').scrollTop = 0
  }
  endedShown = true
}
function applyEventState(): void {
  if (!ev || !joined) return
  if (ev.status === 'live') {
    setBadge('live')
    goLiveView()
  } else if (ev.status === 'ended') {
    el('wait').classList.add('hidden')
    el('main').classList.remove('hidden')
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('off'))
    onEnded()
  } else {
    setBadge('soon')
    if (ev.starts_at) {
      const dt = new Date(ev.starts_at)
      el('waitmsg').textContent =
        'Starts around ' +
        dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        ' — waiting for the host…'
    }
    if (ev.materials_present && ev.pre_event_chat) goPreView()
  }
}

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) => {
  ;(t as HTMLElement).onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('sel'))
    document.querySelectorAll('.pane').forEach((x) => x.classList.remove('sel'))
    t.classList.add('sel')
    const pane = (t as HTMLElement).dataset.pane
    el('pane-' + pane).classList.add('sel')
    el('askrow').style.display = pane === 'ask' ? 'flex' : 'none'
    el('roomrow').style.display = pane === 'room' ? 'flex' : 'none'
    if (pane === 'live') {
      const p = el('pane-live')
      p.scrollTop = p.scrollHeight
    }
    if (pane === 'room') {
      t.classList.remove('new')
      const p = el('pane-room')
      p.scrollTop = p.scrollHeight
    }
    if (pane === 'q') void refreshBoard()
  }
})

// ---------- ask / chat ----------
function bubble(cls: string, text: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  d.textContent = text
  el('askhome').classList.add('compact')
  el('chat').appendChild(d)
  el('pane-ask').scrollTop = el('pane-ask').scrollHeight
  return d
}
function aiBubble(text: string): HTMLElement {
  const d = document.createElement('div')
  d.className = 'bub-a md'
  d.innerHTML = md(text)
  el('askhome').classList.add('compact')
  el('chat').appendChild(d)
  el('pane-ask').scrollTop = el('pane-ask').scrollHeight
  return d
}

/** one of this page's own rows, read through the site's server (the rows are private in the database) */
// The secret goes in a header: a link with it in lands in server logs.
const secretHeader = (secret: string): Record<string, string> => (secret ? { 'x-sitca-attendee': secret } : {})
async function readOwn<T>(query: string, secret = ''): Promise<T | null> {
  try {
    const r = await fetch(`/api/ask?${query}`, { cache: 'no-store', headers: secretHeader(secret) })
    if (!r.ok) return null
    const j = (await r.json()) as { row?: T | null }
    return j.row ?? null
  } catch {
    return null
  }
}
async function readOwnRows<T>(query: string, secret = ''): Promise<T[]> {
  try {
    const r = await fetch(`/api/ask?${query}`, { cache: 'no-store', headers: secretHeader(secret) })
    if (!r.ok) return []
    const j = (await r.json()) as { rows?: T[] }
    return j.rows ?? []
  } catch {
    return []
  }
}

const pendingAsks = new Map<string, { typing: HTMLElement; onAnswer?: (a: string) => void }>()
// the conversation so far, so a follow-up question is understood as one
const askHistory: { role: 'user' | 'assistant'; content: string }[] = []
function resolveAsk(id: string, status: string, answer: string | null): void {
  const p = pendingAsks.get(id)
  if (!p) return
  pendingAsks.delete(id)
  p.typing.remove()
  if (p.onAnswer) {
    p.onAnswer(status === 'answered' && answer ? answer : '')
    return
  }
  if (status === 'answered' && answer) {
    aiBubble(answer)
    askHistory.push({ role: 'assistant', content: answer })
    if (askHistory.length > 12) askHistory.splice(0, askHistory.length - 12)
  } else bubble('notice err', answer || 'Something went wrong — try again.')
}
async function submitAsk(
  kind: 'ask' | 'catchup' | 'pack',
  question: string,
  typing: HTMLElement,
  onAnswer?: (a: string) => void
): Promise<void> {
  const id = crypto.randomUUID()
  pendingAsks.set(id, { typing, onAnswer })
  // The fast path: the server answers from the event's own row — the host's
  // materials, the agenda, every caption so far — in a few seconds, whether
  // or not the host's app is open. Before the event this is the only path
  // that answers at all.
  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        eventId,
        attendeeId: attId,
        secret: attSecret,
        kind,
        question,
        persona: persona || '',
        lang: myLang,
        history: kind === 'ask' ? askHistory.slice(-8) : []
      }),
      signal: timeoutSignal(55000)
    })
    const j = (await r.json().catch(() => ({}))) as { answer?: string; defer?: boolean; error?: string }
    if (r.ok && j.answer) {
      resolveAsk(id, 'answered', j.answer)
      return
    }
  } catch {
    /* the host's app is the fallback */
  }
  if (!pendingAsks.has(id)) return
  // the older path: the host's app notices the question and answers it
  const { error } = await sb.from('asks').insert({
    id,
    event_id: eventId,
    attendee_id: attId,
    kind,
    question,
    status: 'pending'
  })
  if (error) {
    resolveAsk(id, 'error', 'Connection problem — try again.')
    return
  }
  // the host's app answers it; the page asks for the answer until it comes
  let tries = 0
  const poll = window.setInterval(async () => {
    if (!pendingAsks.has(id) || ++tries > 72) {
      clearInterval(poll)
      if (pendingAsks.has(id)) resolveAsk(id, 'error', 'No answer arrived — is the host app running?')
      return
    }
    const data = await readOwn<{ status: string; answer: string | null }>(`ask=${id}`, attSecret)
    if (data && data.status !== 'pending') {
      clearInterval(poll)
      if (kind === 'ask' && data.status === 'answered' && data.answer) {
        myChat.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer })
      }
      resolveAsk(id, data.status, data.answer)
    }
  }, 2500)
}

let busy = false
function ask(q: string): void {
  if (busy || !q.trim() || !attId) return
  busy = true
  bubble('bub-u', q)
  askHistory.push({ role: 'user', content: q.slice(0, 600) })
  const typing = bubble('typing', 'Sitca is thinking…')
  void submitAsk('ask', q.slice(0, 600), typing).finally(() => {
    busy = false
  })
}
;(el('asksend') as HTMLButtonElement).onclick = () => {
  const v = (el('asktext') as HTMLTextAreaElement).value
  ;(el('asktext') as HTMLTextAreaElement).value = ''
  ask(v)
}
el('asktext').addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent
  if (ke.key === 'Enter' && !ke.shiftKey) {
    e.preventDefault()
    ;(el('asksend') as HTMLButtonElement).click()
  }
})
// leaving keeps your seat: come back through the same link and you are still you
el('leavebtn').onclick = () => {
  if (window.confirm('Leave this event? You can come back with the same link.')) location.href = '/'
}
el('joinback').onclick = () => {
  location.href = '/'
}
;(el('roomsend') as HTMLButtonElement).onclick = () => {
  const box = el('roomtext') as HTMLTextAreaElement
  const v = box.value
  box.value = ''
  void sendRoom(v)
}
el('roomtext').addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent
  if (ke.key === 'Enter' && !ke.shiftKey) {
    e.preventDefault()
    ;(el('roomsend') as HTMLButtonElement).click()
  }
})
document.querySelectorAll<HTMLElement>('.askchip[data-ask]').forEach((c) => {
  c.onclick = () => {
    ask(c.dataset.ask || '')
    ;(document.querySelector('[data-pane=ask]') as HTMLElement).click()
  }
})
el('catchup').onclick = () => {
  if (busy || !attId) return
  busy = true
  const typing = bubble('typing', 'Catching you up…')
  void submitAsk('catchup', '', typing).finally(() => {
    busy = false
  })
  ;(document.querySelector('[data-pane=ask]') as HTMLElement).click()
}

// ---------- speaker questions ----------
const pendingQs = new Set<string>()
function renderQuestionResult(row: {
  id: string
  status: string
  refined: string | null
  answered_at_label: string | null
  answer: string | null
  text: string
}): void {
  if (!pendingQs.has(row.id)) return
  if (row.status === 'checking') return
  pendingQs.delete(row.id)
  ;(el('qsend') as HTMLButtonElement).disabled = false
  el('qresult').innerHTML = ''
  if (row.status === 'already_answered' && row.answer) {
    const d = document.createElement('div')
    d.className = 'qbox'
    d.innerHTML =
      '<b>The speaker covered this at ' +
      escH(row.answered_at_label || '') +
      '</b><div class="segtext"></div><button class="btn btn2" style="margin-top:10px" id="forceq">Submit anyway</button>'
    ;(d.querySelector('.segtext') as HTMLElement).textContent = row.answer
    el('qresult').appendChild(d)
    ;(d.querySelector('#forceq') as HTMLButtonElement).onclick = () =>
      submitQuestion(row.text, true)
  } else if (row.status === 'submitted') {
    ;(el('qtext') as HTMLTextAreaElement).value = ''
    const ok = document.createElement('div')
    ok.className = 'qbox'
    ok.innerHTML =
      '<b><svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 6.5"/></svg>Sent to the host</b><div class="small"></div>'
    ;(ok.querySelector('.small') as HTMLElement).textContent =
      'Submitted as: “' + (row.refined || row.text) + '”'
    el('qresult').appendChild(ok)
  } else {
    el('qresult').innerHTML = '<div class="notice err">Could not submit — try again.</div>'
  }
}
function submitQuestion(text: string, force: boolean): void {
  if (!text.trim() || !attId) return
  ;(el('qsend') as HTMLButtonElement).disabled = true
  el('qresult').innerHTML = '<div class="waiting">Checking…</div>'
  const id = crypto.randomUUID()
  pendingQs.add(id)
  void sb
    .from('speaker_questions')
    .insert({
      id,
      event_id: eventId,
      attendee_id: attId,
      text: text.slice(0, 500),
      force,
      status: 'checking'
    })
    .then(({ error }) => {
      if (error) {
        pendingQs.delete(id)
        ;(el('qsend') as HTMLButtonElement).disabled = false
        el('qresult').innerHTML = '<div class="notice err">Connection problem — try again.</div>'
        return
      }
      let tries = 0
      const poll = window.setInterval(async () => {
        if (!pendingQs.has(id) || ++tries > 24) {
          clearInterval(poll)
          if (pendingQs.has(id)) {
            pendingQs.delete(id)
            ;(el('qsend') as HTMLButtonElement).disabled = false
            el('qresult').innerHTML =
              '<div class="notice err">No response — is the host app running?</div>'
          }
          return
        }
        const data = await readOwn<Parameters<typeof renderQuestionResult>[0]>(`question=${id}`)
        if (data && data.status !== 'checking') {
          clearInterval(poll)
          renderQuestionResult(data)
        }
      }, 5000)
    })
}
;(el('qsend') as HTMLButtonElement).onclick = () =>
  submitQuestion((el('qtext') as HTMLTextAreaElement).value, false)

// ---------- take-home pack ----------
interface Pack {
  summary?: string
  takeaways?: string[]
  moments?: string[]
}
const myChat: { role: string; content: string }[] = []
;(el('takebtn') as HTMLButtonElement).onclick = () => {
  if (!attId) return
  ;(el('takebtn') as HTMLButtonElement).disabled = true
  el('takebody').innerHTML = '<div class="waiting">Preparing your pack…</div>'
  const typing = document.createElement('div') // invisible placeholder
  void submitAsk('pack', '', typing, (answer) => {
    ;(el('takebtn') as HTMLButtonElement).disabled = false
    if (!answer) {
      el('takebody').innerHTML = '<div class="notice err">Could not build the pack — try again.</div>'
      return
    }
    let p: Pack = {}
    try {
      p = JSON.parse(answer) as Pack
    } catch {
      p = { summary: answer }
    }
    let h = ''
    if (ev?.replay?.enabled) {
      h += `<a class="btn btn2" style="margin:0 0 4px;text-decoration:none" href="/r/${eventId}">Open the event recap</a>`
    }
    if (moments.length > 0) {
      h += `<div class="tkcard"><h2>My saved moments</h2>${moments
        .map(
          (m) =>
            `<div class="mom">${m.img ? `<img src="${m.img}" alt="Saved slide">` : ''}<div><span class="ts">${escH(m.t)}</span> <span class="segtext">${escH(m.text)}</span></div></div>`
        )
        .join('')}</div>`
    }
    h += `<div class="tkcard"><h2>Summary</h2><div class="segtext md">${md(p.summary || '')}</div></div>`
    if (p.takeaways?.length)
      h += `<div class="tkcard"><h2>Key takeaways</h2><ul class="md">${p.takeaways.map((t) => `<li>${inlineMd(escH(normCites(t)))}</li>`).join('')}</ul></div>`
    if (p.moments?.length)
      h += `<div class="tkcard"><h2>Key moments</h2><ul class="md">${p.moments.map((t) => `<li>${inlineMd(escH(normCites(t)))}</li>`).join('')}</ul></div>`
    if (myChat.length)
      h += `<div class="tkcard"><h2>Your questions</h2>${myChat
        .map((m) =>
          m.role === 'user'
            ? `<div class="bub-u">${escH(m.content)}</div>`
            : `<div class="bub-a md">${md(m.content)}</div>`
        )
        .join('')}</div>`
    el('takebody').innerHTML = h
  })
}

// ---------- join + realtime ----------
// Joining asks for a language and, if they like, a name. The "I am a…" chips
// were more to read than they were worth on a phone; the persona stays in the
// data model as an optional field for hosts who ask for it later.
const storeKey = 'sitka-att-' + eventId
async function join(newJoin: boolean): Promise<void> {
  if (newJoin) {
    attId = crypto.randomUUID()
    attSecret = newSecret()
    writeSecret = attSecret
    myName = (el('name') as HTMLInputElement).value.trim().slice(0, 40)
    const { error } = await insertAttendee(
      {
        id: attId,
        event_id: eventId,
        persona: persona || 'Curious attendee',
        lang: myLang
      },
      attSecret
    )
    if (error) {
      ;(el('joinbtn') as HTMLButtonElement).disabled = false
      alert('Could not join — check your connection and try again.')
      return
    }
    try {
      localStorage.setItem(storeKey, JSON.stringify({ id: attId, persona, lang: myLang, name: myName, secret: attSecret }))
    } catch {
      /* private mode */
    }
  }
  joined = true
  // for the owners' dashboard: a join, its language, nothing else
  void sb
    .from('usage_events')
    .insert({ name: 'attendee_join', props: { lang: myLang, fresh: newJoin }, platform: 'attendee', ua: navigator.userAgent.slice(0, 200) })
    .then(() => undefined, () => undefined)
  el('join').classList.add('hidden')
  el('loading').classList.add('hidden')
  el('wait').classList.remove('hidden')
  setupListen()
  // If the talk is already on, show it now. The captions so far, the room and
  // the polls fill in behind it; none of them should keep a person waiting.
  applyEventState()

  // history: restore my previous Q&A after a refresh
  const prevAsks = await readOwnRows<{ kind: string; question: string; answer: string | null; status: string }>(`attendee=${attId}`, attSecret)
  for (const a of prevAsks) {
    if (a.status !== 'answered' || !a.answer) continue
    bubble('bub-u', a.question)
    aiBubble(a.answer)
    myChat.push({ role: 'user', content: a.question }, { role: 'assistant', content: a.answer })
  }

  // live data: subscribe first, then load the backlog (dedupe by idx).
  // One channel per table: the server refuses a whole channel when it will
  // not serve one of its tables, which once left every screen without
  // captions. The event row itself is not on the live link (visitors read it
  // through sitka_event); the page asks for it below.
  const wantTrans = translatedForMe()
  const live = <T>(table: string, event: 'INSERT' | '*', on: (row: T) => void): void => {
    sb.channel(`ev-${table}-${eventId}`)
      .on('postgres_changes', { event, schema: 'public', table, filter: 'event_id=eq.' + eventId }, (payload) => on(payload.new as T))
      .subscribe()
  }
  live<SegRow>('segments', 'INSERT', (row) => {
    upsertSeg(row, pendingTranslations.get(row.idx))
    pendingTranslations.delete(row.idx)
  })
  live<{ lang: string; idx: number; text: string }>('translations', 'INSERT', (row) => {
    if (wantTrans && row.lang === myLang) applyTranslation(row.idx, row.text)
  })
  live<PollRow | null>('polls', '*', (p) => {
    if (p && p.id) setPoll(p)
  })
  live<{ id?: string; text: string; created_at?: string }>('room_notes', 'INSERT', (note) => {
    if (note?.text && (!note.id || !notesSeen.has(note.id))) {
      if (note.id) notesSeen.add(note.id)
      showRoomNote(note.text)
    }
  })
  live<RoomRow>('room_messages', 'INSERT', (row) => renderRoomMsg(row))
  live<unknown>('attendees', 'INSERT', () => void refreshCount())
  // (an attendee's own questions and their answers are private: they are
  // not sent over the room's live link, and arrive by the page asking)

  // Realtime is the fast path; this is the safety net. A phone drops the
  // socket when its screen sleeps, and an event row that changes while the
  // socket is down never arrives, which left people on "waiting for the host"
  // after the host had started. So the page also asks on its own: the event
  // row every 3s until the event is over, plus any captions it missed while live.
  let lastSegIdx = -1
  let watching = false
  let endedTicks = 0
  let lastTransIdx = -1
  let pollTicks = 0
  // room notes seen, so one arriving both live and by asking shows once;
  // only notes written after the page opened are shown
  const notesSeen = new Set<string>()
  let notesSince = new Date().toISOString()
  const watchEvent = async (): Promise<void> => {
    if (watching || !ev) return
    // After the end, the recap flag and the recording can still change for a
    // while: keep looking, more slowly, for about ten minutes.
    if (ev.status === 'ended') {
      endedTicks++
      if (endedTicks > 200 || endedTicks % 5 !== 0) return
    }
    watching = true
    try {
      const { data: fresh } = await readEvent()
      if (fresh) {
        const before = ev.status
        const hadRecap = Boolean(ev.replay?.enabled)
        ev = fresh as EventRow
        // A host whose heartbeat has been silent for minutes is gone: the
        // phone closed, the battery died, the "ended" write never arrived.
        // The room is shown as over rather than live for ever.
        if (ev.status === 'live' && ev.host_seen && Date.now() - new Date(ev.host_seen).getTime() > 4 * 60_000) {
          ev.status = 'ended'
        }
        if (ev.status !== before) applyEventState()
        else if (ev.status === 'ended' && Boolean(ev.replay?.enabled) !== hadRecap) refreshEndCard()
        if (ev.status === 'live') showBanner()
      }
      if (ev.status === 'live') {
        const { data: rows } = await sb
          .from('segments')
          .select('idx,start_sec,label,text')
          .eq('event_id', eventId)
          .gt('idx', lastSegIdx)
          .order('idx', { ascending: true })
          .limit(60)
        for (const row of rows ?? []) {
          const r = row as SegRow
          lastSegIdx = Math.max(lastSegIdx, r.idx)
          if (!segEls.has(r.idx)) upsertSeg(r, pendingTranslations.get(r.idx))
        }
        // The same for the translations and the poll, which until now came
        // only over the live link: a phone that slept through a minute and
        // woke to captions in English gets its own language back, and a poll
        // opened while the link was down still reaches it.
        if (wantTrans) {
          const { data: tr } = await sb
            .from('translations')
            .select('idx,text')
            .eq('event_id', eventId)
            .eq('lang', myLang)
            .gt('idx', lastTransIdx)
            .order('idx', { ascending: true })
            .limit(80)
          for (const row of tr ?? []) {
            const r = row as { idx: number; text: string }
            lastTransIdx = Math.max(lastTransIdx, r.idx)
            applyTranslation(r.idx, r.text)
          }
        }
        pollTicks++
        if (pollTicks % 4 === 0) {
          const { data: pollRows } = await sb
            .from('polls')
            .select('id,question,options,status')
            .eq('event_id', eventId)
            .order('created_at', { ascending: false })
            .limit(1)
          const latest = pollRows && pollRows.length > 0 ? (pollRows[0] as PollRow) : null
          if (latest && (!activePoll || activePoll.id !== latest.id || activePoll.status !== latest.status)) setPoll(latest)
          // the host's notes to the room, which until now came only over the live link
          const { data: noteRows } = await sb
            .from('room_notes')
            .select('id,text,created_at')
            .eq('event_id', eventId)
            .gt('created_at', notesSince)
            .order('created_at', { ascending: true })
            .limit(5)
          for (const n of (noteRows ?? []) as { id: string; text: string; created_at: string }[]) {
            if (n.created_at > notesSince) notesSince = n.created_at
            if (notesSeen.has(n.id)) continue
            notesSeen.add(n.id)
            showRoomNote(n.text)
          }
        }
      }
    } catch {
      /* the next tick tries again */
    } finally {
      watching = false
    }
  }
  window.setInterval(() => void watchEvent(), 3000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void watchEvent()
  })

  const { data: segRows } = await sb
    .from('segments')
    .select('idx,start_sec,label,text')
    .eq('event_id', eventId)
    .order('idx', { ascending: true })
  let transMap = new Map<number, string>()
  if (wantTrans) {
    const { data: tr } = await sb
      .from('translations')
      .select('idx,text')
      .eq('event_id', eventId)
      .eq('lang', myLang)
    transMap = new Map((tr ?? []).map((r) => [r.idx as number, r.text as string]))
    for (const k of transMap.keys()) lastTransIdx = Math.max(lastTransIdx, k)
  }
  const wasListening = listening
  listening = false // don't speak the whole backlog
  for (const row of segRows ?? []) {
    lastSegIdx = Math.max(lastSegIdx, (row as SegRow).idx)
    upsertSeg(row as SegRow, transMap.get((row as SegRow).idx))
  }
  listening = wasListening

  // the room so far, and how many are here
  if (attId) myAuthor = await authorTag(attId).catch(() => '')
  for (const r of await roomRows(null, 150)) renderRoomMsg(r)
  document.querySelector('[data-pane=room]')?.classList.remove('new')
  window.setInterval(() => void pollRoom(), 3000)
  void refreshCount()
  window.setInterval(() => void refreshCount(), 20000)
  el('leavebtn').classList.remove('hidden')

  // pick up a poll that is already running
  const { data: pollRows } = await sb
    .from('polls')
    .select('id,question,options,status')
    .eq('event_id', eventId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  if (pollRows && pollRows.length > 0) setPoll(pollRows[0] as PollRow)

  applyEventState()
}

;(el('joinbtn') as HTMLButtonElement).onclick = () => {
  myLang = (el('lang') as HTMLSelectElement).value
  const btn = el('joinbtn') as HTMLButtonElement
  btn.disabled = true
  // a request that never answers gives the button back, with a word
  const guard = window.setTimeout(() => {
    if (!joined) {
      btn.disabled = false
      btn.textContent = 'Try again'
    }
  }, 15000)
  void join(true).finally(() => window.clearTimeout(guard))
}

// ---------- "attend for me": absent-attendee proxy ----------
const proxyKey = 'sitka-proxy-' + eventId
const proxySecretKey = 'sitka-proxy-secret-' + eventId
function proxySecret(): string {
  try {
    return localStorage.getItem(proxySecretKey) || ''
  } catch {
    return ''
  }
}
el('proxylink').onclick = () => {
  el('join').classList.add('hidden')
  el('proxy').classList.remove('hidden')
}
el('proxyback').onclick = () => {
  el('proxy').classList.add('hidden')
  el('join').classList.remove('hidden')
}
;(el('proxysend') as HTMLButtonElement).onclick = async () => {
  const request = (el('proxyreq') as HTMLTextAreaElement).value.trim()
  if (!request) return
  ;(el('proxysend') as HTMLButtonElement).disabled = true
  const proxyId = crypto.randomUUID()
  const lang = (el('lang') as HTMLSelectElement).value
  const secret = newSecret()
  const { error: aerr } = await insertAttendee(
    {
      id: proxyId,
      event_id: eventId,
      persona: 'Absent (Sitca attending as proxy)',
      lang
    },
    secret
  )
  // the request is written as the proxy's own attendee, with its secret
  if (!aerr) writeSecret = secret
  const { error: perr } = aerr
    ? { error: aerr }
    : await sb.from('proxies').insert({
        attendee_id: proxyId,
        event_id: eventId,
        request: request.slice(0, 1500),
        status: 'pending'
      })
  ;(el('proxysend') as HTMLButtonElement).disabled = false
  if (aerr || perr) {
    alert('Could not register — check your connection and try again.')
    return
  }
  try {
    localStorage.setItem(proxyKey, proxyId)
    localStorage.setItem(proxySecretKey, secret)
  } catch {
    /* private mode — the brief will still generate, but this device may not find it */
  }
  el('proxy').classList.add('hidden')
  showProxyStatus(proxyId)
}

let briefShown = false
function renderBrief(brief: string, proxyId: string): void {
  el('proxytitle').textContent = 'Your personal brief'
  el('proxystatus').textContent = ''
  el('proxybrief').innerHTML = `<div class="tkcard md" style="text-align:left">${md(withoutTimes(brief))}</div>`
  document.querySelector('.hero-art')?.classList.remove('rippling')
  if (briefShown) return
  briefShown = true
  // the brief as a file to keep
  el('proxytools').classList.remove('hidden')
  el('proxydl').onclick = () =>
    downloadBytes(
      fileName((ev?.title || 'Event') + ' brief'),
      notesPdf({
        title: ev?.title || 'Event brief',
        label: 'Your brief',
        date: ev?.starts_at ? new Date(ev.starts_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : undefined,
        kind: 'Live event',
        by: 'Sitca attended for you',
        notes: brief,
        notesLabel: 'What happened'
      })
    )
  // and Sitca, who sat through it, to ask
  el('proxychat').classList.remove('hidden')
  attId = proxyId
  const history: { role: 'user' | 'assistant'; content: string }[] = []
  let busyQ = false
  const askProxy = async (q: string): Promise<void> => {
    if (busyQ || !q.trim()) return
    busyQ = true
    const msgs = el('proxymsgs')
    const u = document.createElement('div')
    u.className = 'bub-u'
    u.textContent = q
    msgs.appendChild(u)
    const typing = document.createElement('div')
    typing.className = 'typing'
    typing.textContent = 'Sitca is thinking…'
    msgs.appendChild(typing)
    history.push({ role: 'user', content: q })
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: crypto.randomUUID(), eventId, attendeeId: proxyId, secret: proxySecret(), kind: 'ask', question: q.slice(0, 600), persona: 'Someone who could not attend and asked Sitca to attend for them', lang: myLang, history: history.slice(-8) }),
        signal: timeoutSignal(55000)
      })
      const j = (await r.json().catch(() => ({}))) as { answer?: string; error?: string }
      typing.remove()
      const a = document.createElement('div')
      if (r.ok && j.answer) {
        a.className = 'bub-a md'
        a.innerHTML = md(j.answer)
        history.push({ role: 'assistant', content: j.answer })
      } else {
        a.className = 'notice err'
        a.textContent = j.error || 'Sitca could not answer — try again.'
      }
      msgs.appendChild(a)
    } catch {
      typing.remove()
      const a = document.createElement('div')
      a.className = 'notice err'
      a.textContent = 'Connection problem — try again.'
      msgs.appendChild(a)
    } finally {
      busyQ = false
      if (history.length > 16) history.splice(0, history.length - 16)
    }
  }
  const box = el('proxytext') as HTMLTextAreaElement
  ;(el('proxysendq') as HTMLButtonElement).onclick = () => {
    const v = box.value
    box.value = ''
    void askProxy(v)
  }
  box.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent
    if (ke.key === 'Enter' && !ke.shiftKey) {
      e.preventDefault()
      ;(el('proxysendq') as HTMLButtonElement).click()
    }
  })
}

function showProxyStatus(proxyId: string): void {
  el('loading').classList.add('hidden')
  el('join').classList.add('hidden')
  el('proxywait').classList.remove('hidden')
  const check = async (): Promise<boolean> => {
    // the event itself is asked as well, so the page knows when it starts
    // and when it ends without anyone refreshing it
    const [data, { data: fresh }] = await Promise.all([
      readOwn<{ status: string; brief: string | null }>(`proxy=${proxyId}`, proxySecret()),
      readEvent()
    ])
    if (fresh) {
      ev = fresh as EventRow
      setBadge(ev.status === 'live' ? 'live' : ev.status === 'ended' ? 'ended' : 'soon')
    }
    if (data?.status === 'ready' && data.brief) {
      renderBrief(data.brief as string, proxyId)
      return true
    }
    if (data?.status === 'error') {
      el('proxystatus').textContent =
        'Something went wrong writing your brief — ask the host to reopen the event report.'
      return true
    }
    el('proxystatus').textContent =
      ev?.status === 'ended'
        ? 'The event has ended — your brief is being written. This page updates by itself.'
        : ev?.status === 'live'
          ? 'The event is happening right now — Sitca is listening for your topics. Come back here afterwards.'
          : 'Keep this link — your personal brief appears here when the event ends.'
    return false
  }
  void check()
  // every few seconds until the brief is in; a sleeping phone catches up the moment it wakes
  const t = window.setInterval(async () => {
    if (document.visibilityState !== 'visible') return
    if (await check()) clearInterval(t)
  }, 5000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  sb.channel('proxy-' + proxyId)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'proxies', filter: 'attendee_id=eq.' + proxyId },
      (payload) => {
        const row = payload.new as { status: string; brief: string | null }
        if (row.status === 'ready' && row.brief) {
          renderBrief(row.brief, proxyId)
          clearInterval(t)
        }
      }
    )
    .subscribe()
}

// ---------- boot ----------
async function boot(): Promise<void> {
  if (!eventId) {
    el('loading').classList.add('hidden')
    el('notfound').classList.remove('hidden')
    return
  }
  // A slow venue network must not leave the loader up for good: three tries,
  // a limit on each, and then an honest card that says what to do. A link
  // that really is wrong is told apart from a connection that failed.
  let row: EventRow | null = null
  let failed = ''
  for (let attempt = 0; attempt < 3 && !row; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt))
    try {
      const res = await Promise.race([
        readEvent(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 7000))
      ])
      if (res.data) row = res.data
      else if (!res.error) break // truly not there: the link is wrong, not the connection
      else failed = res.error
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err)
    }
  }
  if (!row) {
    el('loading').classList.add('hidden')
    const card = el('notfound')
    if (failed) {
      const h = card.querySelector('h1')
      const sub = card.querySelector('.sub')
      if (h) h.textContent = 'Could not reach the event'
      if (sub) {
        sub.textContent = 'Check your connection, then try again. '
        const b = document.createElement('button')
        b.className = 'btn'
        b.textContent = 'Try again'
        b.onclick = () => location.reload()
        sub.appendChild(b)
      }
    }
    card.classList.remove('hidden')
    return
  }
  ev = row
  el('evtitle').textContent = ev.title
  document.title = ev.title + ' — Sitca Live'
  setBadge(ev.status === 'live' ? 'live' : ev.status === 'ended' ? 'ended' : 'soon')

  // absent-attendee identity takes precedence: this device registered a proxy
  let proxyId: string | null = null
  try {
    proxyId = localStorage.getItem(proxyKey)
  } catch {
    /* ignore */
  }
  if (proxyId) {
    showProxyStatus(proxyId)
    return
  }

  let saved: { id: string; persona: string | null; lang: string; name?: string; secret?: string } | null = null
  try {
    saved = JSON.parse(localStorage.getItem(storeKey) || 'null')
  } catch {
    /* ignore */
  }
  if (saved?.id) {
    attId = saved.id
    attSecret = saved.secret || ''
    writeSecret = attSecret
    persona = saved.persona
    myLang = saved.lang || 'English'
    myName = saved.name || ''
    el('loading').classList.add('hidden')
    void join(false)
  } else {
    el('loading').classList.add('hidden')
    el('join').classList.remove('hidden')
  }
}
void boot()
