/**
 * Sitca · Operations. The owners' view of the whole system: who is using it,
 * how that is growing, what they do with it, what is live this minute, and
 * what has gone wrong. Every number comes from an admin-only function in the
 * database (supabase/admin.sql); this page only draws.
 */
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY)

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// ---------- shapes ----------
interface Overview {
  days: number
  users_total: number
  users_new: number
  users_new_prev: number
  users_active: number
  users_active_prev: number
  sessions_total: number
  sessions_new: number
  sessions_new_prev: number
  hours_total: number
  hours_new: number
  hours_new_prev: number
  events_total: number
  events_new: number
  events_new_prev: number
  events_live: number
  attendees_total: number
  attendees_new: number
  attendees_new_prev: number
  asks_new: number
  asks_new_prev: number
  storage_gb: number
  errors_24h: number
  errors_7d: number
  stt_errors: number
  db_errors: number
  voice_errors: number
  kinds: { name: string; count: number }[]
  capture: { audio: number; screen: number; hosted: number }
  languages: { name: string; count: number }[]
  features: { name: string; count: number; people: number }[]
  platforms: { name: string; count: number }[]
}
interface DayRow {
  day: string
  signups: number
  active: number
  sessions: number
  hours: number
  events: number
  attendees: number
  asks: number
  errors: number
}
interface Cohort {
  week: string
  size: number
  keep: { offset: number; users: number }[]
}
interface Person {
  id: string
  email: string
  joined: string
  last_seen: string
  sessions: number
  hours: number
  hosted: number
  asks: number
  admin: boolean
}
interface ErrRow {
  at: string
  page: string | null
  message: string
  ua: string | null
  user: string | null
}
interface Live {
  events: { id: string; title: string; since: string; host: string | null; attendees: number; captions: number; asks: number }[]
  people_15m: number
  joins_15m: number
  recording_now: number
}

// ---------- formatting ----------
const fmtInt = (n: number): string => Math.round(n).toLocaleString()
const fmtHours = (h: number): string => (h >= 100 ? fmtInt(h) : h >= 10 ? h.toFixed(1) : h.toFixed(2)).replace(/\.0+$/, '')
const fmtDay = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function delta(cur: number, prev: number, days: number): string {
  if (!prev && !cur) return `<span class="k-delta">No change · prior ${days} days</span>`
  if (!prev) return `<span class="k-delta"><b>New</b> in the last ${days} days</span>`
  const pct = Math.round(((cur - prev) / prev) * 100)
  const sign = pct > 0 ? '+' : ''
  return `<span class="k-delta${pct < 0 ? ' down' : ''}"><b>${sign}${pct}%</b> vs prior ${days} days</span>`
}

// ---------- charts ----------
function sparkline(values: number[]): string {
  const w = 76
  const h = 26
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`)
  return `<svg class="k-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polygon points="0,${h} ${pts.join(' ')} ${w},${h}"/><polyline points="${pts.join(' ')}"/></svg>`
}

interface SeriesSpec {
  key: keyof DayRow
  label: string
  kind: 'area' | 'line' | 'bar'
  format?: (v: number) => string
}

/** A responsive SVG chart with up to two series and a hover readout. */
function drawChart(container: HTMLElement, rows: DayRow[], specs: SeriesSpec[]): void {
  const W = 720
  const H = 220
  const padL = 34
  const padR = 10
  const padT = 10
  const padB = 24
  const iw = W - padL - padR
  const ih = H - padT - padB
  const n = rows.length
  const x = (i: number): number => padL + (n > 1 ? (i / (n - 1)) * iw : iw / 2)
  const maxOf = (k: keyof DayRow): number => Math.max(1, ...rows.map((r) => Number(r[k]) || 0))
  // the first series sets the left axis; a second line series gets its own scale
  const primary = specs[0]
  const maxP = maxOf(primary.key)
  const yP = (v: number): number => padT + ih - (v / maxP) * ih
  const parts: string[] = []
  // grid + axis labels
  for (let g = 0; g <= 4; g++) {
    const yy = padT + (ih * g) / 4
    const val = maxP * (1 - g / 4)
    parts.push(`<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/>`)
    parts.push(`<text class="axis" x="${padL - 6}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${val >= 10 ? fmtInt(val) : val.toFixed(val >= 1 ? 0 : 1)}</text>`)
  }
  const tickEvery = n > 45 ? 14 : n > 20 ? 7 : n > 10 ? 3 : 1
  rows.forEach((r, i) => {
    if (i % tickEvery === 0 || i === n - 1) {
      parts.push(`<text class="axis" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtDay(r.day)}</text>`)
    }
  })
  specs.forEach((s, si) => {
    const max = si === 0 ? maxP : maxOf(s.key)
    const y = (v: number): number => padT + ih - (v / max) * ih
    const vals = rows.map((r) => Number(r[s.key]) || 0)
    if (s.kind === 'bar') {
      const bw = Math.max(2, (iw / Math.max(n, 1)) * 0.5)
      vals.forEach((v, i) => {
        if (v <= 0) return
        parts.push(`<rect class="bar" x="${(x(i) - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + ih - y(v)).toFixed(1)}" rx="1.5"/>`)
      })
      return
    }
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    if (s.kind === 'area') {
      parts.push(`<polygon class="area" points="${x(0).toFixed(1)},${padT + ih} ${pts} ${x(n - 1).toFixed(1)},${padT + ih}"/>`)
    }
    parts.push(`<polyline class="line${si > 0 ? ' second' : ''}" points="${pts}"/>`)
  })
  parts.push(`<line class="hover-line" id="hl" x1="0" x2="0" y1="${padT}" y2="${padT + ih}"/>`)
  parts.push(`<circle class="hover-dot" id="hd" r="3.5"/>`)
  parts.push(`<rect class="hit" x="${padL}" y="${padT}" width="${iw}" height="${ih}"/>`)
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${parts.join('')}</svg><div class="tip"></div>`
  const svg = container.querySelector('svg') as SVGSVGElement
  const tip = container.querySelector('.tip') as HTMLElement
  const hl = svg.querySelector('#hl') as SVGLineElement
  const hd = svg.querySelector('#hd') as SVGCircleElement
  const move = (ev: MouseEvent | TouchEvent): void => {
    const rect = svg.getBoundingClientRect()
    const cx = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
    const px = ((cx - rect.left) / rect.width) * W
    let i = Math.round(((px - padL) / iw) * (n - 1))
    i = Math.max(0, Math.min(n - 1, i))
    const r = rows[i]
    const xx = x(i)
    hl.setAttribute('x1', String(xx))
    hl.setAttribute('x2', String(xx))
    hl.style.opacity = '1'
    hd.setAttribute('cx', String(xx))
    hd.setAttribute('cy', String(yP(Number(r[primary.key]) || 0)))
    hd.style.opacity = '1'
    tip.innerHTML = `<b>${fmtDay(r.day)}</b> · ${specs
      .map((s) => `${s.label} ${s.format ? s.format(Number(r[s.key]) || 0) : fmtInt(Number(r[s.key]) || 0)}`)
      .join(' · ')}`
    tip.style.left = `${(xx / W) * rect.width}px`
    tip.style.top = `${(yP(Number(r[primary.key]) || 0) / H) * rect.height}px`
    tip.style.opacity = '1'
  }
  const leave = (): void => {
    hl.style.opacity = '0'
    hd.style.opacity = '0'
    tip.style.opacity = '0'
  }
  svg.addEventListener('mousemove', move)
  svg.addEventListener('touchmove', move, { passive: true })
  svg.addEventListener('mouseleave', leave)
  svg.addEventListener('touchend', leave)
}

function hbars(container: HTMLElement, items: { name: string; count: number; extra?: string }[], empty: string): void {
  if (!items.length) {
    container.innerHTML = `<div class="calm">${empty}</div>`
    return
  }
  const max = Math.max(1, ...items.map((i) => i.count))
  container.innerHTML = items
    .map(
      (i) =>
        `<div class="hbar"><span class="n" title="${esc(i.name)}">${esc(i.name)}</span><span class="t"><i style="width:${((i.count / max) * 100).toFixed(1)}%"></i></span><span class="v">${fmtInt(i.count)}${i.extra ? `<small> ${esc(i.extra)}</small>` : ''}</span></div>`
    )
    .join('')
}

// ---------- state ----------
let days = 30
let loading = false
let liveTimer = 0

const FEATURE_NAMES: Record<string, string> = {
  ask: 'Ask Sitca',
  ask_overview: 'Ask across sessions',
  listen: 'Read aloud',
  attach: 'Attached a file',
  recap_open: 'Opened a recap',
  document: 'Document written',
  catchup: 'Catch me up',
  attendee_join: 'Joined an event',
  session_start: 'Started a session'
}
const KIND_NAMES: Record<string, string> = {
  lecture: 'Lectures',
  meeting: 'Meetings',
  presentation: 'Presentations',
  event: 'Events',
  other: 'Other'
}

// ---------- rendering ----------
function renderKpis(o: Overview, series: DayRow[]): void {
  const spark = (k: keyof DayRow): string => sparkline(series.map((r) => Number(r[k]) || 0))
  const tiles = [
    { label: 'Active people', value: fmtInt(o.users_active), d: delta(o.users_active, o.users_active_prev, days), s: spark('active') },
    { label: 'New sign-ups', value: fmtInt(o.users_new), d: delta(o.users_new, o.users_new_prev, days), s: spark('signups') },
    { label: 'Sessions captured', value: fmtInt(o.sessions_new), d: delta(o.sessions_new, o.sessions_new_prev, days), s: spark('sessions') },
    { label: 'Hours captured', value: fmtHours(o.hours_new), d: delta(o.hours_new, o.hours_new_prev, days), s: spark('hours') },
    { label: 'Attendees reached', value: fmtInt(o.attendees_new), d: delta(o.attendees_new, o.attendees_new_prev, days), s: spark('attendees') },
    { label: 'Questions answered', value: fmtInt(o.asks_new), d: delta(o.asks_new, o.asks_new_prev, days), s: spark('asks') }
  ]
  el('kpis').innerHTML = tiles
    .map((t) => `<div class="card kpi"><span class="k-label">${t.label}</span><span class="k-value">${t.value}</span>${t.d}${t.s}</div>`)
    .join('')
  el('overview-sub').textContent = `${fmtInt(o.users_total)} people all time · ${fmtInt(o.sessions_total)} sessions · ${fmtHours(o.hours_total)} hours · ${fmtInt(o.events_total)} events hosted · ${o.storage_gb} GB of recordings`
}

function renderCohorts(cs: Cohort[]): void {
  const box = el('cohorts')
  if (!cs.length) {
    box.innerHTML = '<div class="calm">Cohorts appear once a few weeks of sign-ups exist.</div>'
    return
  }
  const cols = Math.max(...cs.map((c) => c.keep.length))
  const head = `<tr><th>Week of</th><th class="c">People</th>${Array.from({ length: cols }, (_, i) => `<th class="c">+${i}</th>`).join('')}</tr>`
  const rows = cs
    .map((c) => {
      const cells = Array.from({ length: cols }, (_, i) => {
        const k = c.keep.find((x) => x.offset === i)
        const weekStart = new Date(c.week + 'T00:00:00').getTime() + i * 7 * 86400000
        if (!k || weekStart > Date.now()) return '<td class="empty">·</td>'
        const pct = c.size ? Math.round((k.users / c.size) * 100) : 0
        const alpha = 0.06 + (pct / 100) * 0.6
        return `<td style="background:color-mix(in srgb, var(--text) ${Math.round(alpha * 100)}%, var(--bg));color:${pct > 55 ? 'var(--bg)' : 'var(--text)'}" title="${k.users} of ${c.size}">${pct}%</td>`
      }).join('')
      return `<tr><td class="w">${fmtDay(c.week)}</td><td class="s">${c.size}</td>${cells}</tr>`
    })
    .join('')
  box.innerHTML = `<table class="cohort">${head}${rows}</table>`
}

function renderUsage(o: Overview): void {
  hbars(
    el('kinds'),
    o.kinds.map((k) => ({ name: KIND_NAMES[k.name] || k.name, count: k.count })),
    'No sessions in this period.'
  )
  const c = o.capture
  const total = Math.max(1, c.audio + c.screen)
  el('capture').innerHTML = `
    <div class="split"><i style="width:${((c.screen / total) * 100).toFixed(1)}%;background:var(--text)"></i><i style="width:${((c.audio / total) * 100).toFixed(1)}%;background:var(--ink-mid)"></i></div>
    <div class="split-legend"><span><em style="background:var(--text)"></em><b>${fmtInt(c.screen)}</b> with a picture</span><span><em style="background:var(--ink-mid)"></em><b>${fmtInt(c.audio)}</b> audio only</span><span><b>${fmtInt(c.hosted)}</b> hosted for a room</span></div>`
  hbars(
    el('features'),
    o.features.map((f) => ({ name: FEATURE_NAMES[f.name] || f.name, count: f.count, extra: f.people ? `· ${f.people} people` : '' })),
    'Feature counts start once the new build has been used.'
  )
  hbars(el('languages'), o.languages, 'No attendees joined an event in this period.')
  el('platforms').textContent = o.platforms.length
    ? 'Where people open Sitca: ' + o.platforms.map((p) => `${p.name} ${fmtInt(p.count)}`).join(' · ')
    : ''
}

function renderLive(l: Live): void {
  el('live-sub').textContent = `${fmtInt(l.people_15m)} people active in the last 15 minutes · ${fmtInt(l.joins_15m)} joined an event · ${fmtInt(l.recording_now)} recording`
  if (!l.events.length) {
    el('live-body').innerHTML = '<div class="calm">Nothing is being broadcast right now. Live events appear here the moment a host goes live.</div>'
    return
  }
  el('live-body').innerHTML = `<div class="live-row">${l.events
    .map(
      (e) =>
        `<div class="live-card"><div class="t"><span class="ldot"></span>${esc(e.title || 'Untitled event')}</div><div class="m"><span><b>${fmtInt(e.attendees)}</b> in the room</span><span><b>${fmtInt(e.captions)}</b> captions</span><span><b>${fmtInt(e.asks)}</b> questions</span><span>live ${ago(e.since)}</span></div>${e.host ? `<div class="m" style="margin-top:6px"><span>host ${esc(e.host)}</span></div>` : ''}</div>`
    )
    .join('')}</div>`
}

function renderReliability(o: Overview, errs: ErrRow[]): void {
  el('rel-kpis').innerHTML = [
    { l: 'Errors in the last 24 hours', v: fmtInt(o.errors_24h), n: `${fmtInt(o.errors_7d)} in 7 days` },
    { l: 'Captions that failed to upload', v: fmtInt(o.stt_errors), n: `in ${days} days, after retries` },
    { l: 'Saves that failed', v: fmtInt(o.db_errors), n: `${fmtInt(o.voice_errors)} voice failures` }
  ]
    .map((k) => `<div class="card kpi"><span class="k-label">${k.l}</span><span class="k-value">${k.v}</span><span class="k-delta">${k.n}</span></div>`)
    .join('')
  el('errors').innerHTML = errs.length
    ? errs
        .slice(0, 30)
        .map(
          (e) =>
            `<div class="err"><span class="when" title="${esc(e.at)}">${ago(e.at)}</span><div><div class="msg">${esc(e.message)}</div><div class="meta">${esc(e.page || '')}${e.user ? ` · ${esc(e.user)}` : ''}${e.ua ? ` · ${esc(shortUa(e.ua))}` : ''}</div></div></div>`
        )
        .join('')
    : '<div class="calm">No errors reported. The crash guard and the save banner report here when something goes wrong for someone.</div>'
}

function shortUa(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Electron/.test(ua)) return 'Desktop app'
  return 'Browser'
}

async function renderHealth(): Promise<void> {
  const rows: { label: string; ok: boolean | null; val: string }[] = []
  try {
    const r = await fetch('/api/health')
    const j = (await r.json()) as { chat?: boolean; stt?: boolean }
    rows.push({ label: 'AI answers (chat keys)', ok: Boolean(j.chat), val: j.chat ? 'keys present' : 'no keys' })
    rows.push({ label: 'Captions (speech-to-text keys)', ok: Boolean(j.stt), val: j.stt ? 'keys present' : 'no keys' })
  } catch {
    rows.push({ label: 'API', ok: false, val: 'not reachable' })
  }
  try {
    const t0 = performance.now()
    const r = await fetch('/api/speak')
    const j = (await r.json()) as { ok?: boolean; provider?: string; errors?: string[] }
    const ms = Math.round(performance.now() - t0)
    rows.push({ label: 'Natural voice', ok: Boolean(j.ok), val: j.ok ? `${j.provider} · ${ms} ms` : (j.errors || [])[0] || 'no voice' })
  } catch {
    rows.push({ label: 'Natural voice', ok: false, val: 'not reachable' })
  }
  try {
    const t0 = performance.now()
    const { error } = await sb.from('events').select('id', { count: 'exact', head: true })
    const ms = Math.round(performance.now() - t0)
    rows.push({ label: 'Database', ok: !error, val: error ? error.message : `${ms} ms` })
  } catch {
    rows.push({ label: 'Database', ok: false, val: 'not reachable' })
  }
  el('health').innerHTML = rows
    .map((r) => `<div class="hrow"><span class="dot ${r.ok === null ? '' : r.ok ? 'ok' : 'bad'}"></span><span class="lbl">${esc(r.label)}</span><span class="val">${esc(r.val)}</span></div>`)
    .join('')
  el('health-note').textContent = 'Checked from this browser just now. The voice check makes one real request.'
}

let people: Person[] = []
function renderPeople(): void {
  const q = (el('people-search') as HTMLInputElement).value.trim().toLowerCase()
  const list = q ? people.filter((p) => (p.email || '').toLowerCase().includes(q)) : people
  const rows = list
    .map((p) => {
      const initial = (p.email || '?').slice(0, 1).toUpperCase()
      return `<tr><td><div class="who"><span class="av">${esc(initial)}</span><span class="em" title="${esc(p.email)}">${esc(p.email || '—')}</span>${p.admin ? '<span class="chip">TEAM</span>' : ''}</div></td><td>${ago(p.joined)}</td><td>${ago(p.last_seen)}</td><td class="num">${fmtInt(p.sessions)}</td><td class="num">${fmtHours(p.hours)}</td><td class="num">${fmtInt(p.hosted)}</td><td class="num">${fmtInt(p.asks)}</td></tr>`
    })
    .join('')
  el('people-table').innerHTML = `<thead><tr><th>Person</th><th>Joined</th><th>Last seen</th><th class="num">Sessions</th><th class="num">Hours</th><th class="num">Hosted</th><th class="num">Questions</th></tr></thead><tbody>${rows || '<tr><td colspan="7" style="color:var(--t3);text-align:center;padding:20px">Nobody matches.</td></tr>'}</tbody>`
}

// ---------- loading ----------
async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(name, args ?? {})
  if (error) throw new Error(error.message)
  return data as T
}

async function loadAll(): Promise<void> {
  if (loading) return
  loading = true
  el('refresh').classList.add('busy')
  try {
    const [o, series, cohorts, errs, live, ppl] = await Promise.all([
      rpc<Overview>('admin_overview', { days }),
      rpc<DayRow[]>('admin_series', { days }),
      rpc<Cohort[]>('admin_retention', { weeks: 8 }),
      rpc<ErrRow[]>('admin_errors', { lim: 50 }),
      rpc<Live>('admin_live'),
      rpc<Person[]>('admin_people', { lim: 200 })
    ])
    renderKpis(o, series)
    drawChart(el('chart-people'), series, [
      { key: 'active', label: 'Active', kind: 'area' },
      { key: 'signups', label: 'Sign-ups', kind: 'bar' }
    ])
    renderCohorts(cohorts)
    drawChart(el('chart-sessions'), series, [
      { key: 'sessions', label: 'Sessions', kind: 'area' },
      { key: 'hours', label: 'Hours', kind: 'line', format: (v) => fmtHours(v) }
    ])
    drawChart(el('chart-asks'), series, [
      { key: 'asks', label: 'Questions', kind: 'area' },
      { key: 'attendees', label: 'Attendees', kind: 'line' }
    ])
    renderUsage(o)
    renderLive(live)
    renderReliability(o, errs)
    people = ppl
    renderPeople()
    void renderHealth()
    el('updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch (err) {
    el('overview-sub').textContent = 'Could not load: ' + (err instanceof Error ? err.message : String(err))
  } finally {
    loading = false
    el('refresh').classList.remove('busy')
  }
}

async function refreshLive(): Promise<void> {
  try {
    renderLive(await rpc<Live>('admin_live'))
  } catch {
    /* next tick */
  }
}

function wire(): void {
  el('range').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
    if (!b) return
    days = Number(b.dataset.days) || 30
    el('range').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
    void loadAll()
  })
  el('refresh').addEventListener('click', () => void loadAll())
  el('people-search').addEventListener('input', renderPeople)
  // the rail follows the section in view
  const links = Array.from(el('rail').querySelectorAll('a'))
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id))
      }
    },
    { rootMargin: '-40% 0px -55% 0px' }
  )
  document.querySelectorAll('section').forEach((s) => io.observe(s))
  liveTimer = window.setInterval(() => void refreshLive(), 30000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshLive()
    else clearInterval(liveTimer)
    if (document.visibilityState === 'visible') liveTimer = window.setInterval(() => void refreshLive(), 30000)
  })
}

async function boot(): Promise<void> {
  const { data } = await sb.auth.getSession()
  el('loading').classList.add('hidden')
  if (!data.session) {
    el('gate').classList.remove('hidden')
    return
  }
  let admin = false
  try {
    admin = (await rpc<boolean>('is_admin')) === true
  } catch {
    admin = false
  }
  if (!admin) {
    el('gate-title').textContent = 'This page is for the Sitca team'
    el('gate-text').textContent = `You are signed in as ${data.session.user.email}. Ask an owner to add you, or run supabase/admin.sql if the dashboard has not been set up yet.`
    el('gate-btn').textContent = 'Back to Sitca'
    el('gate').classList.remove('hidden')
    return
  }
  el('app').classList.remove('hidden')
  el('railfoot').textContent = `Signed in as ${data.session.user.email}. Numbers are computed in the database and cover everyone.`
  wire()
  await loadAll()
}
void boot()
