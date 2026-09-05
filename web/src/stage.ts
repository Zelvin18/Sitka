/**
 * The Stage Screen: Sitka's face for the room itself — projector / venue TV.
 * Public and read-only: giant live captions, join QR, poll takeovers,
 * pushed recaps, and the replay QR when the event ends.
 * URL: /s/<eventId>  (optional ?lang=French for translated captions)
 */
import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const m = /\/s\/([^/?#]+)/.exec(location.pathname)
const eventId = m ? m[1] : ''
const capLang = new URLSearchParams(location.search).get('lang')

interface EventRow {
  id: string
  title: string
  status: 'waiting' | 'live' | 'ended'
  starts_at: string | null
  replay?: { enabled?: boolean } | null
}
interface SegRow {
  idx: number
  text: string
}
interface PollRow {
  id: string
  question: string
  options: string[]
  status: string
}

let ev: EventRow | null = null
const joinUrl = (): string => `${location.origin}/e/${eventId}`

function setBadge(mode: 'live' | 'soon' | 'ended'): void {
  const b = el('sbadge')
  b.className = 'live' + (mode === 'live' ? '' : ' soon')
  el('sbadgetext').textContent = mode === 'live' ? 'LIVE' : mode === 'soon' ? 'SOON' : 'ENDED'
}

// ---------- captions (last three lines, big) ----------
const capLines: string[] = []
const translations = new Map<number, string>()
const originals = new Map<number, string>()
let shownIdx = -1

function renderCaps(): void {
  const wrap = el('scaps')
  wrap.innerHTML = ''
  if (capLines.length === 0) {
    wrap.innerHTML = '<div class="capwait">Listening…</div>'
    return
  }
  // oldest at the top (faded, smaller), newest large at the bottom
  const last = capLines.slice(-3)
  last.forEach((text, i) => {
    const d = document.createElement('div')
    const age = last.length - 1 - i
    d.className = 'cap' + (age === 1 ? ' old1' : age === 2 ? ' old2' : '')
    d.textContent = text
    wrap.appendChild(d)
  })
}

function pushCaption(idx: number, text: string): void {
  if (idx <= shownIdx) return
  shownIdx = idx
  capLines.push(text)
  if (capLines.length > 6) capLines.shift()
  renderCaps()
}
function considerSeg(idx: number): void {
  const text = capLang ? (translations.get(idx) ?? originals.get(idx)) : originals.get(idx)
  if (text) pushCaption(idx, text)
}

// ---------- views ----------
function applyState(): void {
  if (!ev) return
  el('sttl').textContent = ev.title
  el('swait').classList.toggle('hidden', ev.status !== 'waiting')
  el('slive').classList.toggle('hidden', ev.status !== 'live')
  el('sended').classList.toggle('hidden', ev.status !== 'ended')
  setBadge(ev.status === 'live' ? 'live' : ev.status === 'ended' ? 'ended' : 'soon')
  if (ev.status === 'ended') {
    if (ev.replay?.enabled) {
      el('endsub').textContent = 'Watch the replay — every moment, searchable.'
      el('endqr').classList.remove('hidden')
      el('endurl').classList.remove('hidden')
      el('endurl').textContent = `${location.origin}/r/${eventId}`
      void QRCode.toCanvas(el('endqr') as HTMLCanvasElement, `${location.origin}/r/${eventId}`, {
        width: 220,
        margin: 1,
        color: { dark: '#0d0d0f', light: '#ffffff' }
      })
    }
  }
}

// countdown to start
function tickCountdown(): void {
  if (!ev || ev.status !== 'waiting' || !ev.starts_at) {
    el('wcount').classList.add('hidden')
    return
  }
  const diff = new Date(ev.starts_at).getTime() - Date.now()
  if (diff <= 0) {
    el('wcount').classList.add('hidden')
    return
  }
  const h = Math.floor(diff / 3600000)
  const mn = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  el('wcount').textContent =
    (h > 0 ? `${h}:` : '') + `${String(mn).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  el('wcount').classList.remove('hidden')
}
setInterval(tickCountdown, 1000)

// ---------- attendee count ----------
async function refreshCount(): Promise<void> {
  const { count } = await sb
    .from('attendees')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
  if (count && count > 0) {
    el('scount').textContent = `${count} joined`
  }
}
setInterval(() => void refreshCount(), 8000)

// ---------- poll takeover ----------
let activePoll: PollRow | null = null
let pollTimer: number | null = null
let pollCloseTimer: number | null = null
async function refreshPollBars(): Promise<void> {
  if (!activePoll) return
  const { data } = await sb.from('poll_votes').select('choice').eq('poll_id', activePoll.id)
  const counts = activePoll.options.map(() => 0)
  for (const v of data ?? []) {
    const i = Number(v.choice)
    if (i >= 0 && i < counts.length) counts[i]++
  }
  const total = (data ?? []).length
  const wrap = el('tkopts')
  if (wrap.children.length !== activePoll.options.length) {
    wrap.innerHTML = ''
    for (const o of activePoll.options) {
      const d = document.createElement('div')
      d.className = 'tk-row'
      d.innerHTML = '<div class="tk-bar"></div><span class="tk-opt"></span><span class="tk-pct"></span>'
      ;(d.querySelector('.tk-opt') as HTMLElement).textContent = o
      wrap.appendChild(d)
    }
  }
  activePoll.options.forEach((_o, i) => {
    const row = wrap.children[i]
    const pct = total > 0 ? Math.round((counts[i] / total) * 100) : 0
    ;(row.querySelector('.tk-bar') as HTMLElement).style.width = `${Math.max(3, pct)}%`
    ;(row.querySelector('.tk-pct') as HTMLElement).textContent = `${pct}%`
  })
  el('tkfoot').textContent = `${total} vote${total === 1 ? '' : 's'} so far`
}
function setStagePoll(p: PollRow | null): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (pollCloseTimer) {
    clearTimeout(pollCloseTimer)
    pollCloseTimer = null
  }
  if (!p || (p.status !== 'open' && activePoll?.id !== p.id)) {
    activePoll = null
    el('tkpoll').classList.add('hidden')
    return
  }
  activePoll = p
  el('tkq').textContent = p.question
  el('tkopts').innerHTML = ''
  el('tkpoll').classList.remove('hidden')
  void refreshPollBars()
  if (p.status === 'open') {
    pollTimer = window.setInterval(() => void refreshPollBars(), 3000)
  } else {
    // closed: show final numbers for a while, then return to captions
    el('tkfoot').textContent = 'Final results'
    pollCloseTimer = window.setTimeout(() => setStagePoll(null), 15000)
  }
}

// ---------- pushed recap takeover ----------
let noteTimer: number | null = null
function showStageNote(text: string): void {
  el('tknotetext').textContent = text
  el('tknote').classList.remove('hidden')
  if (noteTimer) clearTimeout(noteTimer)
  noteTimer = window.setTimeout(() => el('tknote').classList.add('hidden'), 30000)
}

// ---------- boot ----------
async function boot(): Promise<void> {
  if (!eventId) return
  const { data } = await sb.from('events').select('*').eq('id', eventId).single()
  if (!data) {
    el('wtitle').textContent = 'Event not found'
    return
  }
  ev = data as EventRow
  el('wtitle').textContent = ev.title
  document.title = ev.title + ' — Sitka Stage'
  el('wurl').textContent = joinUrl().replace(/^https?:\/\//, '')
  void QRCode.toCanvas(el('wqr') as HTMLCanvasElement, joinUrl(), {
    width: Math.min(300, Math.round(window.innerHeight * 0.3)),
    margin: 1,
    color: { dark: '#0d0d0f', light: '#ffffff' }
  })
  void QRCode.toCanvas(el('mqr') as HTMLCanvasElement, joinUrl(), {
    width: 96,
    margin: 1,
    color: { dark: '#0d0d0f', light: '#ffffff' }
  })
  applyState()
  tickCountdown()
  void refreshCount()

  // caption backlog: only the tail — the stage shows "now", not history
  const { data: segs } = await sb
    .from('segments')
    .select('idx,text')
    .eq('event_id', eventId)
    .order('idx', { ascending: false })
    .limit(3)
  for (const s of ((segs ?? []) as SegRow[]).reverse()) {
    originals.set(s.idx, s.text)
    considerSeg(s.idx)
  }
  if (capLang) {
    const { data: tr } = await sb
      .from('translations')
      .select('idx,text')
      .eq('event_id', eventId)
      .eq('lang', capLang)
    for (const t of tr ?? []) translations.set(t.idx as number, t.text as string)
  }
  const { data: openPoll } = await sb
    .from('polls')
    .select('id,question,options,status')
    .eq('event_id', eventId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  if (openPoll && openPoll.length > 0 && ev.status === 'live') {
    setStagePoll(openPoll[0] as PollRow)
  }

  sb.channel('stage-' + eventId)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'segments', filter: 'event_id=eq.' + eventId },
      (payload) => {
        const s = payload.new as SegRow
        originals.set(s.idx, s.text)
        if (!capLang) considerSeg(s.idx)
        // translated stages wait briefly for the translation, then fall back
        else setTimeout(() => considerSeg(s.idx), 9000)
      }
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'translations', filter: 'event_id=eq.' + eventId },
      (payload) => {
        const t = payload.new as { lang: string; idx: number; text: string }
        if (capLang && t.lang === capLang) {
          translations.set(t.idx, t.text)
          considerSeg(t.idx)
        }
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'events', filter: 'id=eq.' + eventId },
      (payload) => {
        ev = payload.new as EventRow
        applyState()
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'polls', filter: 'event_id=eq.' + eventId },
      (payload) => {
        const p = payload.new as PollRow | null
        if (p && p.id) setStagePoll(p)
      }
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'room_notes', filter: 'event_id=eq.' + eventId },
      (payload) => {
        const n = payload.new as { text: string }
        if (n?.text) showStageNote(n.text)
      }
    )
    .subscribe()

  // fullscreen on any click (projector-friendly), cursor already hidden
  document.body.addEventListener('click', () => {
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
  })
}
void boot()
