/**
 * Public replay page: recording + clickable transcript + key moments.
 * Read-only, no account needed — the host published it deliberately.
 */
import { createClient } from '@supabase/supabase-js'
import { md, parseTs as parseChipTs } from './mdlite'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const m = /\/r\/([^/?#]+)/.exec(location.pathname)
const eventId = m ? m[1] : ''

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

function parseTs(ts: string): number {
  const p = ts.split(':').map(Number)
  if (p.some(isNaN)) return 0
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  if (p.length === 2) return p[0] * 60 + p[1]
  return 0
}
function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} hr ${min % 60} min`
}

const segEls: { sec: number; node: HTMLElement }[] = []

function seek(sec: number): void {
  const v = el('rvideo') as HTMLVideoElement
  v.currentTime = Math.max(0, sec)
  void v.play().catch(() => undefined)
  v.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function boot(): Promise<void> {
  if (!eventId) {
    el('loading').style.display = 'none'
    el('notfound').style.display = 'block'
    return
  }
  const { data } = await sb
    .from('events')
    .select('title,replay,starts_at')
    .eq('id', eventId)
    .single()
  const replay = (data?.replay ?? null) as Replay | null
  if (!data || !replay?.enabled) {
    el('loading').style.display = 'none'
    el('notfound').style.display = 'block'
    return
  }
  const title = replay.title || (data.title as string) || 'Event replay'
  document.title = title + ' — Sitka Replay'
  el('rtitle').textContent = title
  const bits: string[] = []
  if (data.starts_at) {
    bits.push(
      new Date(data.starts_at as string).toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })
    )
  }
  if (replay.durationMs) bits.push(fmtDuration(replay.durationMs))
  el('rmeta').textContent = bits.join(' · ')
  ;(el('rvideo') as HTMLVideoElement).src =
    `${SUPA_URL}/storage/v1/object/public/replays/${eventId}.webm`
  el('rsummary').textContent = replay.summary || ''

  if (replay.highlights && replay.highlights.length > 0) {
    el('momtitle').style.display = 'block'
    for (const h of replay.highlights) {
      const chip = document.createElement('button')
      chip.className = 'hchip'
      chip.innerHTML = '<span class="tt"></span><span></span>'
      ;(chip.children[0] as HTMLElement).textContent = h.time
      ;(chip.children[1] as HTMLElement).textContent = h.label
      chip.onclick = () => seek(parseTs(h.time))
      el('rchips').appendChild(chip)
    }
  }

  const { data: segs } = await sb
    .from('segments')
    .select('idx,start_sec,label,text')
    .eq('event_id', eventId)
    .order('idx', { ascending: true })
  const wrap = el('rsegs')
  for (const s of (segs ?? []) as SegRow[]) {
    const d = document.createElement('div')
    d.className = 'seg'
    d.innerHTML = '<span class="ts"></span><span class="segtext"></span>'
    ;(d.children[0] as HTMLElement).textContent = s.label
    ;(d.children[1] as HTMLElement).textContent = s.text
    d.onclick = () => seek(Number(s.start_sec))
    wrap.appendChild(d)
    segEls.push({ sec: Number(s.start_sec), node: d })
  }
  if (segEls.length === 0) {
    wrap.innerHTML = '<div class="segtext">No transcript was captured for this event.</div>'
    ;(el('rsearch') as HTMLInputElement).style.display = 'none'
  }

  // live search filter
  ;(el('rsearch') as HTMLInputElement).oninput = () => {
    const q = (el('rsearch') as HTMLInputElement).value.trim().toLowerCase()
    for (const s of segEls) {
      s.node.style.display =
        !q || (s.node.children[1].textContent || '').toLowerCase().includes(q) ? 'flex' : 'none'
    }
  }

  // follow the playhead through the transcript
  const v = el('rvideo') as HTMLVideoElement
  let lastActive: HTMLElement | null = null
  v.ontimeupdate = () => {
    const t = v.currentTime
    let best: HTMLElement | null = null
    for (const s of segEls) {
      if (s.sec <= t + 0.3) best = s.node
      else break
    }
    if (best && best !== lastActive) {
      lastActive?.classList.remove('now')
      best.classList.add('now')
      lastActive = best
    }
  }

  // ---------- Ask this event ----------
  const materialsRes = await sb.from('events').select('materials_text').eq('id', eventId).single()
  const materials = ((materialsRes.data?.materials_text as string) || '').slice(0, 10000)
  const transcript = ((segs ?? []) as SegRow[])
    .map((s) => `[${s.label}] ${s.text}`)
    .join('\n')
    .slice(0, 90000)
  const askSystem = [
    `You are Sitka, answering questions about a recorded live event: "${title}".`,
    'Ground every answer in the transcript (and materials) below; if something was not covered, say so plainly.',
    'When you reference a specific moment, cite it inline as [[M:SS]] using a timestamp from the transcript — plain ASCII double square brackets. These become tap-to-jump links into the recording.',
    'Keep answers short and direct by default; use markdown structure only when it genuinely helps.',
    materials ? `\nEvent materials:\n${materials}` : '',
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

  async function askEvent(q: string): Promise<void> {
    if (asking || !q.trim()) return
    asking = true
    chatBubble('bub-u', '', q)
    const typing = chatBubble('typing', '', 'Reading the event…')
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
        chatBubble('err-note', '', j.error === 'missing-key'
          ? 'Asking is not enabled on this deployment yet.'
          : j.error || 'Could not answer — try again.')
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
    void askEvent(q)
  }
  ;(el('rask') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (el('rasksend') as HTMLButtonElement).click()
  })
  // citation chips inside answers seek the recording
  el('rchat').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest?.('.tchip') as HTMLElement | null
    if (!chip) return
    const sec = parseChipTs(chip.textContent || '') ?? parseFloat(chip.dataset.s || '')
    if (Number.isFinite(sec)) seek(sec as number)
  })

  el('loading').style.display = 'none'
  el('main').style.display = 'block'
}
void boot()
