/**
 * Public replay page: recording + clickable transcript + key moments.
 * Read-only, no account needed — the host published it deliberately.
 */
import { createClient } from '@supabase/supabase-js'

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

  el('loading').style.display = 'none'
  el('main').style.display = 'block'
}
void boot()
