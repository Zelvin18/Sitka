/**
 * Public page for a published event replay (recording + transcript) or a
 * shared session recap (text only). Read-only, no account needed — the owner
 * published it deliberately.
 */
import { createClient } from '@supabase/supabase-js'
import { md, parseTs as parseChipTs } from './mdlite'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const m = /\/r\/([^/?#]+)/.exec(location.pathname)
const pageId = m ? m[1] : ''

interface Replay {
  enabled: boolean
  title?: string
  summary?: string
  highlights?: { time: string; label: string }[]
  durationMs?: number
}
interface SegRow {
  idx: number
  start_sec: number
  label: string
  text: string
}
interface RecapRow {
  title: string
  summary: string
  highlights: { time: string; label: string }[]
  notes: string
  transcript: { start: number; end: number; text: string }[]
  duration_ms: number
  session_at: string | null
  enabled: boolean
}
interface Line {
  sec: number
  label: string
  text: string
}

function parseTs(ts: string): number {
  const p = ts.split(':').map(Number)
  if (p.some(isNaN)) return 0
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  if (p.length === 2) return p[0] * 60 + p[1]
  return 0
}
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0
    ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`
}
function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} hr ${min % 60} min`
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

const segEls: { sec: number; node: HTMLElement }[] = []
let hasVideo = false
let lastActive: HTMLElement | null = null

function highlightAt(sec: number): void {
  let best: HTMLElement | null = null
  for (const s of segEls) {
    if (s.sec <= sec + 0.3) best = s.node
    else break
  }
  if (best && best !== lastActive) {
    lastActive?.classList.remove('now')
    best.classList.add('now')
    lastActive = best
  }
}

function seek(sec: number): void {
  if (hasVideo) {
    const v = el('rvideo') as HTMLVideoElement
    v.currentTime = Math.max(0, sec)
    void v.play().catch(() => undefined)
    v.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  // Text recap: jump to the line and let it glow for a moment.
  highlightAt(sec)
  lastActive?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  lastActive?.classList.add('flash')
  setTimeout(() => lastActive?.classList.remove('flash'), 1400)
}

function notFound(): void {
  el('loading').style.display = 'none'
  el('notfound').style.display = 'block'
}

function renderLines(lines: Line[]): void {
  const wrap = el('rsegs')
  for (const s of lines) {
    const d = document.createElement('div')
    d.className = 'seg'
    d.innerHTML = '<span class="ts"></span><span class="segtext"></span>'
    ;(d.children[0] as HTMLElement).textContent = s.label
    ;(d.children[1] as HTMLElement).textContent = s.text
    d.onclick = () => seek(s.sec)
    wrap.appendChild(d)
    segEls.push({ sec: s.sec, node: d })
  }
  if (segEls.length === 0) {
    wrap.innerHTML = '<div class="segtext">No transcript was captured.</div>'
    ;(el('rsearch') as HTMLInputElement).style.display = 'none'
  }
  ;(el('rsearch') as HTMLInputElement).oninput = () => {
    const q = (el('rsearch') as HTMLInputElement).value.trim().toLowerCase()
    for (const s of segEls) {
      s.node.style.display =
        !q || (s.node.children[1].textContent || '').toLowerCase().includes(q) ? 'flex' : 'none'
    }
  }
}

function renderHighlights(hl: { time: string; label: string }[] | undefined): void {
  if (!hl || hl.length === 0) return
  el('momtitle').style.display = 'block'
  for (const h of hl) {
    const chip = document.createElement('button')
    chip.className = 'hchip'
    chip.innerHTML = '<span class="tt"></span><span></span>'
    ;(chip.children[0] as HTMLElement).textContent = h.time
    ;(chip.children[1] as HTMLElement).textContent = h.label
    chip.onclick = () => seek(parseTs(h.time))
    el('rchips').appendChild(chip)
  }
}

function wireAsk(title: string, transcript: string, materials: string, kindWord: string): void {
  const askSystem = [
    `You are Sitka, answering questions about a recorded ${kindWord}: "${title}".`,
    'Ground every answer in the transcript (and materials) below; if something was not covered, say so plainly.',
    'When you reference a specific moment, cite it inline as [[M:SS]] using a timestamp from the transcript — plain ASCII double square brackets. These become tap-to-jump links.',
    'If asked for your view, give a reasoned one based on what was said, and make clear it is your reading rather than something the speaker stated.',
    'Keep answers short and direct by default; use markdown structure only when it genuinely helps.',
    materials ? `\nMaterials:\n${materials}` : '',
    `\nTranscript:\n${transcript || '(no transcript captured)'}`
  ]
    .filter(Boolean)
    .join('\n')
  const history: { role: 'user' | 'assistant'; content: string }[] = []
  let asking = false

  function chatBubble(cls: string, html: string, text?: string): HTMLElement {
    const d = document.createElement('div')
    d.className = cls
    if (text !== undefined) d.textContent = text
    else d.innerHTML = html
    el('rchat').appendChild(d)
    return d
  }

  async function ask(q: string): Promise<void> {
    if (asking || !q.trim()) return
    asking = true
    chatBubble('bub-u', '', q)
    const typing = chatBubble('typing', '', 'Reading the session…')
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keys: {},
          system: askSystem,
          messages: [...history.slice(-8), { role: 'user', content: q }],
          maxTokens: 1000
        })
      })
      const j = await r.json()
      typing.remove()
      if (!r.ok) {
        chatBubble(
          'err-note',
          '',
          j.error === 'missing-key'
            ? 'Asking is not enabled on this deployment yet.'
            : j.error || 'Could not answer — try again.'
        )
      } else {
        chatBubble('bub-a md', md(j.text || ''))
        history.push({ role: 'user', content: q }, { role: 'assistant', content: j.text || '' })
      }
    } catch {
      typing.remove()
      chatBubble('err-note', '', 'Connection problem — try again.')
    } finally {
      asking = false
    }
  }
  ;(el('rasksend') as HTMLButtonElement).onclick = () => {
    const inp = el('rask') as HTMLInputElement
    const q = inp.value
    inp.value = ''
    void ask(q)
  }
  ;(el('rask') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (el('rasksend') as HTMLButtonElement).click()
  })
  el('rchat').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest?.('.tchip') as HTMLElement | null
    if (!chip) return
    const sec = parseChipTs(chip.textContent || '') ?? parseFloat(chip.dataset.s || '')
    if (Number.isFinite(sec)) seek(sec as number)
  })
}

async function bootEvent(): Promise<boolean> {
  const { data } = await sb
    .from('events')
    .select('title,replay,starts_at')
    .eq('id', pageId)
    .single()
  const replay = (data?.replay ?? null) as Replay | null
  if (!data || !replay?.enabled) return false

  hasVideo = true
  const title = replay.title || (data.title as string) || 'Event replay'
  document.title = title + ' — Sitka Replay'
  el('rtitle').textContent = title
  const bits: string[] = []
  if (data.starts_at) bits.push(fmtDate(data.starts_at as string))
  if (replay.durationMs) bits.push(fmtDuration(replay.durationMs))
  el('rmeta').textContent = bits.join(' · ')
  ;(el('rvideo') as HTMLVideoElement).src =
    `${SUPA_URL}/storage/v1/object/public/replays/${pageId}.webm`
  el('rsummary').textContent = replay.summary || ''
  renderHighlights(replay.highlights)

  const { data: segs } = await sb
    .from('segments')
    .select('idx,start_sec,label,text')
    .eq('event_id', pageId)
    .order('idx', { ascending: true })
  const rows = (segs ?? []) as SegRow[]
  renderLines(rows.map((s) => ({ sec: Number(s.start_sec), label: s.label, text: s.text })))

  const v = el('rvideo') as HTMLVideoElement
  v.ontimeupdate = () => highlightAt(v.currentTime)

  const materialsRes = await sb.from('events').select('materials_text').eq('id', pageId).single()
  const materials = ((materialsRes.data?.materials_text as string) || '').slice(0, 10000)
  const transcript = rows
    .map((s) => `[${s.label}] ${s.text}`)
    .join('\n')
    .slice(0, 90000)
  wireAsk(title, transcript, materials, 'live event')
  return true
}

async function bootRecap(): Promise<boolean> {
  const { data } = await sb.from('recaps').select('*').eq('id', pageId).single()
  const rc = (data ?? null) as RecapRow | null
  if (!rc || !rc.enabled) return false

  hasVideo = false
  el('player').style.display = 'none'
  el('htag').textContent = 'RECAP'
  const title = rc.title || 'Session recap'
  document.title = title + ' — Sitka'
  el('rtitle').textContent = title
  const bits: string[] = []
  if (rc.session_at) bits.push(fmtDate(rc.session_at))
  if (rc.duration_ms) bits.push(fmtDuration(rc.duration_ms))
  el('rmeta').textContent = bits.join(' · ')
  el('rsummary').textContent = rc.summary || ''
  el('asksub').textContent =
    'This recap answers questions — grounded in what was actually said, with tap-to-jump moments.'
  el('momtitle').textContent = 'Key moments — tap to jump'
  renderHighlights(rc.highlights)

  if (rc.notes && rc.notes.trim()) {
    el('notestitle').style.display = 'block'
    el('rnotes').innerHTML = md(rc.notes)
    el('rnotes').style.display = 'block'
  }

  const lines = (rc.transcript ?? []).map((s) => ({
    sec: Number(s.start) || 0,
    label: fmtTime(Number(s.start) || 0),
    text: s.text
  }))
  renderLines(lines)
  el('rnotes').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest?.('.tchip') as HTMLElement | null
    if (!chip) return
    const sec = parseChipTs(chip.textContent || '')
    if (sec !== null && Number.isFinite(sec)) seek(sec)
  })
  el('footnote').textContent = 'This session was captured and made searchable by Sitka.'
  el('footcta').textContent = 'Try Sitka'

  const transcript = lines
    .map((s) => `[${s.label}] ${s.text}`)
    .join('\n')
    .slice(0, 90000)
  wireAsk(title, transcript, '', 'session')
  return true
}

async function boot(): Promise<void> {
  if (!pageId) {
    notFound()
    return
  }
  let ok = false
  try {
    ok = (await bootEvent()) || (await bootRecap())
  } catch {
    ok = false
  }
  if (!ok) {
    notFound()
    return
  }
  el('loading').style.display = 'none'
  el('main').style.display = 'block'
}
void boot()
