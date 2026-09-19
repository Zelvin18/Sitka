/**
 * Sitca · Operations. The owners' view of the whole system: who is using it,
 * how that is growing, what they do with it, what is live this minute, and
 * what has gone wrong. Every number comes from an admin-only function in the
 * database (supabase/admin.sql); this page only draws.
 */
import { createClient } from '@supabase/supabase-js'
import { PLANS, formatMoney, planOf, priceIn, type PlanId } from '../../src/shared/plans'

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
  name: string
  joined: string
  last_seen: string
  sessions: number
  hours: number
  hours_month: number
  hosted: number
  asks: number
  asks_month: number
  plan: PlanId
  plan_ends: string | null
  admin: boolean
}
interface PaidRow {
  id: string
  email: string | null
  plan: PlanId
  status: string
  since: string
  ends: string | null
  source: string
  note: string | null
  active: boolean
}
interface PlansData {
  counts: Record<PlanId, number>
  paid: PaidRow[]
  lapsing: number
  new_30d: number
}
interface TeamRow {
  id: string
  email: string | null
  since: string
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

/** A month's revenue in US dollars from the plans in force, at list price. */
function mrr(pd: PlansData): number {
  let total = 0
  for (const r of pd.paid) {
    if (!r.active) continue
    const p = planOf(r.plan)
    if (p.usd > 0) total += p.usd
  }
  return total
}
function renderOverviewCards(pd: PlansData | null, l: Live, o: Overview): void {
  const line = (k: string, v: string): string => `<div class="ov-line"><span>${k}</span><b>${v}</b></div>`
  el('ov-money').innerHTML = pd
    ? `<div class="big">${formatMoney(mrr(pd), 'USD')}<small style="font-size:13px;font-weight:500;color:var(--t2)"> a month</small></div>` +
      line('Paying accounts', fmtInt(pd.counts.plus + pd.counts.pro + pd.counts.institution)) +
      line('New in 30 days', fmtInt(pd.new_30d)) +
      line('Lapsing this week', fmtInt(pd.lapsing)) +
      `<div class="note"><a href="#plans">Plans &amp; revenue →</a></div>`
    : '<div class="calm">Run supabase/plans.sql to see money here.</div>'
  el('ov-live').innerHTML =
    `<div class="big">${fmtInt(l.people_15m)}<small style="font-size:13px;font-weight:500;color:var(--t2)"> people in the last 15 min</small></div>` +
    line('Recording now', fmtInt(l.recording_now)) +
    line('Events live', fmtInt(l.events.length)) +
    line('Joined an event', fmtInt(l.joins_15m)) +
    `<div class="note"><a href="#live">Live now →</a></div>`
  el('ov-faults').innerHTML =
    `<div class="big" style="color:${o.errors_24h > 0 ? 'var(--danger)' : 'inherit'}">${fmtInt(o.errors_24h)}<small style="font-size:13px;font-weight:500;color:var(--t2)"> in 24 hours</small></div>` +
    line('In 7 days', fmtInt(o.errors_7d)) +
    line('Captions that failed', fmtInt(o.stt_errors)) +
    line('Saves that failed', fmtInt(o.db_errors)) +
    `<div class="note"><a href="#reliability">Reliability →</a></div>`
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

// The bell counts faults reported since the owner last looked at the list;
// looking (the bell, or scrolling to Reliability) marks them seen.
const SEEN_KEY = 'sitka.adminSeenErrors'
let latestErrors: ErrRow[] = []
function seenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) || 0)
  } catch {
    return 0
  }
}
function markErrorsSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
  renderBell()
}
function renderBell(): void {
  const count = latestErrors.filter((e) => new Date(e.at).getTime() > seenAt()).length
  const badge = document.getElementById('bellcount')
  const bell = document.getElementById('bell')
  if (!badge || !bell) return
  badge.hidden = count === 0
  badge.textContent = count > 99 ? '99+' : String(count)
  bell.title = count === 0 ? 'No new faults since you last looked' : `${count} new ${count === 1 ? 'fault' : 'faults'} since you last looked`
  if (count > 0 && !bell.classList.contains('ring')) {
    bell.classList.add('ring')
    window.setTimeout(() => bell.classList.remove('ring'), 700)
  }
}
function renderReliability(o: Overview, errs: ErrRow[]): void {
  latestErrors = errs
  renderBell()
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
  paintStorage()
}

// ---------- what the recordings take in Cloudflare ----------
// R2's free allowance is 10 GB; the card shows how much of it is used, and
// says so in colour as it fills. Beyond the allowance R2 charges by the GB.
const R2_FREE_GB = 10
interface StorageUsage {
  bytes: number
  objects: number
  files: number
  accounts: number
  owners: { owner: string; bytes: number }[]
}
let storageUsage: StorageUsage | null = null
let storageError = ''
const fmtBytes = (b: number): string => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} KB`)
async function renderStorage(): Promise<void> {
  try {
    const { data } = await sb.auth.getSession()
    const token = data.session?.access_token
    if (!token) return
    const r = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ op: 'usage' })
    })
    if (!r.ok) {
      storageError = r.status === 501 ? 'Cloudflare is not set up on this deployment' : `could not be read (${r.status})`
      storageUsage = null
    } else {
      storageUsage = (await r.json()) as StorageUsage
      storageError = ''
    }
  } catch {
    storageError = 'could not be read'
  }
  paintStorage()
}
function paintStorage(): void {
  const body = document.getElementById('storage-body')
  const owners = document.getElementById('storage-owners')
  if (!body || !owners) return
  if (!storageUsage) {
    body.innerHTML = `<div class="calm">${esc(storageError || 'Counting…')}</div>`
    owners.innerHTML = ''
    return
  }
  const u = storageUsage
  const pct = Math.min(999, Math.round((u.bytes / (R2_FREE_GB * 1e9)) * 100))
  const tone = pct >= 90 ? 'var(--danger)' : 'inherit'
  body.innerHTML =
    `<div class="big" style="color:${tone}">${fmtBytes(u.bytes)}</div>` +
    `<div class="gauge"><i style="width:${Math.min(100, pct)}%"></i></div>` +
    `<div class="note">${pct}% of the free ${R2_FREE_GB} GB. Beyond it Cloudflare charges about $0.015 per GB a month; nothing for people watching.</div>` +
    `<div class="ov-line" style="margin-top:10px"><span>Recordings</span><b>${fmtInt(u.files)}</b></div>` +
    `<div class="ov-line"><span>Files of every kind</span><b>${fmtInt(u.objects)}</b></div>` +
    `<div class="ov-line"><span>Accounts with recordings</span><b>${fmtInt(u.accounts)}</b></div>` +
    `<div class="ov-line"><span>Average per account</span><b>${fmtBytes(u.accounts ? u.bytes / u.accounts : 0)}</b></div>`
  const max = Math.max(1, ...u.owners.map((o) => o.bytes))
  owners.innerHTML = u.owners.length
    ? u.owners
        .map((o) => {
          const who = people.find((p) => p.id === o.owner)
          const label = who ? who.email : o.owner.slice(0, 8) + '…'
          const plan = who ? `<span class="plan-chip${who.plan === 'free' ? '' : ' paid'}" style="margin-left:6px">${esc(who.plan)}</span>` : ''
          return `<div class="owner-bar"><span class="em" title="${esc(o.owner)}">${esc(label)}${plan}</span><span class="v">${fmtBytes(o.bytes)}</span><span class="t"><i style="width:${((o.bytes / max) * 100).toFixed(1)}%"></i></span></div>`
        })
        .join('')
    : '<div class="calm">No recordings yet.</div>'
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
let plansData: PlansData | null = null
const planChip = (plan: PlanId, ends?: string | null): string => {
  const lapsed = ends ? new Date(ends).getTime() < Date.now() : false
  return `<span class="plan-chip${plan !== 'free' ? ' paid' : ''}${lapsed ? ' lapsed' : ''}">${esc(planOf(plan).name)}</span>`
}
function renderPeople(): void {
  const q = (el('people-search') as HTMLInputElement).value.trim().toLowerCase()
  const list = q ? people.filter((p) => `${p.email || ''} ${p.name || ''}`.toLowerCase().includes(q)) : people
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const active7 = people.filter((p) => Date.now() - new Date(p.last_seen).getTime() < 7 * 86400000).length
  const paying = people.filter((p) => p.plan !== 'free').length
  const newMonth = people.filter((p) => new Date(p.joined) >= monthStart).length
  el('people-kpis').innerHTML = [
    { l: 'People', v: fmtInt(people.length), n: 'accounts, newest 200 shown' },
    { l: 'Seen this week', v: fmtInt(active7), n: 'opened Sitca in 7 days' },
    { l: 'On a paid plan', v: fmtInt(paying), n: `${people.length ? Math.round((paying / people.length) * 100) : 0}% of accounts` },
    { l: 'Joined this month', v: fmtInt(newMonth), n: `since ${monthStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` }
  ]
    .map((k) => `<div class="card kpi"><span class="k-label">${k.l}</span><span class="k-value">${k.v}</span><span class="k-delta">${k.n}</span></div>`)
    .join('')
  const rows = list
    .map((p) => {
      const initial = (p.name || p.email || '?').slice(0, 1).toUpperCase()
      return `<tr class="row" data-id="${esc(p.id)}"><td><div class="who"><span class="av">${esc(initial)}</span><span class="em" title="${esc(p.email)}">${esc(p.email || '—')}</span>${p.name ? `<span class="name">${esc(p.name)}</span>` : ''}${p.admin ? '<span class="chip">TEAM</span>' : ''}</div></td><td>${planChip(p.plan, p.plan_ends)}</td><td>${ago(p.joined)}</td><td>${ago(p.last_seen)}</td><td class="num">${fmtInt(p.sessions)}</td><td class="num">${fmtHours(p.hours_month)}<small style="color:var(--t3)"> / ${fmtHours(p.hours)}</small></td><td class="num">${fmtInt(p.asks_month)}<small style="color:var(--t3)"> / ${fmtInt(p.asks)}</small></td><td class="num">${fmtInt(p.hosted)}</td></tr>`
    })
    .join('')
  el('people-table').innerHTML = `<thead><tr><th>Person</th><th>Plan</th><th>Joined</th><th>Last seen</th><th class="num">Sessions</th><th class="num">Hours · month / all</th><th class="num">Questions · month / all</th><th class="num">Hosted</th></tr></thead><tbody>${rows || '<tr><td colspan="8" style="color:var(--t3);text-align:center;padding:20px">Nobody matches.</td></tr>'}</tbody>`
}

// ---------- one person, in the drawer ----------
function openPerson(id: string): void {
  const p = people.find((x) => x.id === id)
  if (!p) return
  const plan = planOf(p.plan)
  const ends = p.plan_ends ? new Date(p.plan_ends) : null
  const fact = (l: string, v: string, small = ''): string => `<div class="fact"><div class="l">${l}</div><div class="v">${v}${small ? `<small> ${small}</small>` : ''}</div></div>`
  el('drawer-body').innerHTML = `
    <h2>${esc(p.email || '—')}</h2>
    <div class="sub">${p.name ? esc(p.name) + ' · ' : ''}joined ${ago(p.joined)} · last seen ${ago(p.last_seen)}${p.admin ? ' · team' : ''}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${planChip(p.plan, p.plan_ends)}<span style="font-size:12.5px;color:var(--t2)">${ends ? (ends.getTime() < Date.now() ? 'lapsed ' : 'until ') + ends.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : p.plan === 'free' ? 'no paid plan' : 'open-ended'}</span></div>
    <h3>This month</h3>
    <div class="facts">
      ${fact('Hours recorded', fmtHours(p.hours_month), plan.limits.hours ? `of ${plan.limits.hours}` : 'no limit')}
      ${fact('Questions', fmtInt(p.asks_month), plan.limits.asks ? `of ${plan.limits.asks}` : 'no limit')}
    </div>
    <h3>All time</h3>
    <div class="facts">
      ${fact('Sessions', fmtInt(p.sessions))}
      ${fact('Hours', fmtHours(p.hours))}
      ${fact('Hosted', fmtInt(p.hosted))}
      ${fact('Questions', fmtInt(p.asks))}
    </div>
    <h3>Plan</h3>
    <div class="form">
      <label>Plan<select id="pl-plan">${PLANS.map((x) => `<option value="${x.id}"${x.id === p.plan ? ' selected' : ''}>${x.name}${x.usd > 0 ? ` · ${formatMoney(x.usd, 'USD')} a month` : ''}</option>`).join('')}</select></label>
      <label>For how long<select id="pl-months"><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option><option value="0">Open-ended</option></select></label>
      <label>Note (who paid, how much, how)<input id="pl-note" placeholder="MTN MoMo 15,000 on 3 Oct" value="${esc(plansData?.paid.find((r) => r.id === p.id)?.note || '')}"></label>
      <div class="row"><button class="btn sm" id="pl-save">Set plan</button><span class="ok-note" id="pl-note-out"></span></div>
    </div>
    <h3>Team</h3>
    <div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn sm${p.admin ? ' danger' : ' ghost'}" id="pl-team">${p.admin ? 'Remove from team' : 'Add to team'}</button>
      <span class="ok-note" id="pl-team-out"></span>
    </div>`
  el('drawer').classList.add('on')
  el('veil').classList.add('on')
  el('drawer').setAttribute('aria-hidden', 'false')
  el('pl-save').addEventListener('click', () => {
    void (async () => {
      const out = el('pl-note-out')
      out.textContent = 'Saving…'
      try {
        await rpc('admin_set_plan', {
          p_user: p.id,
          p_plan: (el('pl-plan') as HTMLSelectElement).value,
          p_months: Number((el('pl-months') as HTMLSelectElement).value),
          p_note: (el('pl-note') as HTMLInputElement).value.trim() || null
        })
        out.textContent = 'Done. The person sees it the next time Settings opens.'
        await reloadPeople()
        openPerson(p.id)
      } catch (err) {
        out.textContent = 'Could not: ' + (err instanceof Error ? err.message : String(err))
      }
    })()
  })
  el('pl-team').addEventListener('click', () => {
    void (async () => {
      const out = el('pl-team-out')
      out.textContent = '…'
      try {
        await rpc('admin_grant', { p_email: p.email, p_on: !p.admin })
        await reloadPeople()
        void renderTeam()
        openPerson(p.id)
      } catch (err) {
        out.textContent = 'Could not: ' + (err instanceof Error ? err.message : String(err))
      }
    })()
  })
}
function closeDrawer(): void {
  el('drawer').classList.remove('on')
  el('veil').classList.remove('on')
  el('drawer').setAttribute('aria-hidden', 'true')
}
async function reloadPeople(): Promise<void> {
  const [ppl, pd] = await Promise.all([rpc<Person[]>('admin_people', { lim: 200 }), rpc<PlansData>('admin_plans').catch(() => null)])
  people = ppl
  plansData = pd
  renderPeople()
  renderPlans()
  paintStorage()
}

// ---------- plans & revenue ----------
function renderPlans(): void {
  const pd = plansData
  if (!pd) {
    el('plan-kpis').innerHTML = '<div class="card kpi" style="grid-column:1/-1"><span class="k-label">Plans</span><span class="k-value">—</span><span class="k-delta">Run supabase/plans.sql in the Supabase SQL editor, then refresh.</span></div>'
    el('paid-table').innerHTML = ''
    el('plan-split').innerHTML = ''
  } else {
    const paying = pd.counts.plus + pd.counts.pro + pd.counts.institution
    el('plan-kpis').innerHTML = [
      { l: 'A month, at list price', v: formatMoney(mrr(pd), 'USD'), n: 'from the plans in force' },
      { l: 'Paying accounts', v: fmtInt(paying), n: `${fmtInt(pd.counts.free)} on Free` },
      { l: 'New in 30 days', v: fmtInt(pd.new_30d), n: 'plans switched on' },
      { l: 'Lapsing this week', v: fmtInt(pd.lapsing), n: 'worth a message' }
    ]
      .map((k) => `<div class="card kpi"><span class="k-label">${k.l}</span><span class="k-value">${k.v}</span><span class="k-delta">${k.n}</span></div>`)
      .join('')
    const rows = pd.paid
      .map(
        (r) =>
          `<tr class="row" data-id="${esc(r.id)}"><td><span class="em" title="${esc(r.email || '')}">${esc(r.email || r.id.slice(0, 8))}</span></td><td>${planChip(r.plan, r.active ? r.ends : new Date(0).toISOString())}</td><td>${ago(r.since)}</td><td>${r.ends ? new Date(r.ends).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'open'}</td><td>${esc(r.source)}</td><td style="color:var(--t2)">${esc(r.note || '')}</td></tr>`
      )
      .join('')
    el('paid-table').innerHTML = `<thead><tr><th>Person</th><th>Plan</th><th>Since</th><th>Ends</th><th>Paid via</th><th>Note</th></tr></thead><tbody>${rows || '<tr><td colspan="6" style="color:var(--t3);text-align:center;padding:20px">Nobody is on a paid plan yet. Set one from People.</td></tr>'}</tbody>`
    hbars(
      el('plan-split'),
      PLANS.map((p) => ({ name: p.name, count: pd.counts[p.id] || 0 })),
      'No accounts yet.'
    )
  }
  el('pricelist').innerHTML = PLANS.map((p) => {
    const usd = p.usd < 0 ? 'Quoted' : p.usd === 0 ? 'Free' : `${formatMoney(p.usd, 'USD')}<small>a month</small>`
    const ugx = priceIn(p, 'UGX')
    const st = p.usdStudent !== undefined ? ` · students ${formatMoney(priceIn(p, 'UGX', true) || 0, 'UGX')}` : ''
    return `<div class="price"><div class="n">${esc(p.name)}</div><div class="p">${usd}</div><div class="l">${ugx ? formatMoney(ugx, 'UGX') + ' a month' + st : p.usd < 0 ? 'per seat, by conversation' : 'no charge'}<br>${p.limits.hours || '∞'} h · ${p.limits.asks || '∞'} questions · ${p.limits.storageGb || '∞'} GB · ${p.limits.attendees} people</div></div>`
  }).join('')
}

// ---------- the team ----------
async function renderTeam(): Promise<void> {
  try {
    const team = await rpc<TeamRow[]>('admin_list')
    el('team-list').innerHTML = team.length
      ? team.map((t) => `<div class="team-row"><span class="av" style="width:26px;height:26px;border-radius:50%;background:var(--text);color:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex:none">${esc((t.email || '?').slice(0, 1).toUpperCase())}</span><span class="em">${esc(t.email || t.id)}</span><span class="when">since ${ago(t.since)}</span></div>`).join('')
      : '<div class="calm">Nobody yet.</div>'
  } catch {
    el('team-list').innerHTML = '<div class="calm">Run supabase/plans.sql to manage the team from here.</div>'
  }
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
    void renderStorage()
    const [o, series, cohorts, errs, live, ppl, pd] = await Promise.all([
      rpc<Overview>('admin_overview', { days }),
      rpc<DayRow[]>('admin_series', { days }),
      rpc<Cohort[]>('admin_retention', { weeks: 8 }),
      rpc<ErrRow[]>('admin_errors', { lim: 50 }),
      rpc<Live>('admin_live'),
      rpc<Person[]>('admin_people', { lim: 200 }),
      rpc<PlansData>('admin_plans').catch(() => null)
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
    plansData = pd
    renderPeople()
    renderPlans()
    renderOverviewCards(pd, live, o)
    paintStorage()
    void renderHealth()
    void renderTeam()
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
  // the bell takes the owner to the faults and marks them seen
  const bell = document.getElementById('bell')
  if (bell) {
    bell.addEventListener('click', () => {
      location.hash = '#reliability'
      markErrorsSeen()
    })
  }
  el('people-search').addEventListener('input', renderPeople)
  // one page at a time: the address says which
  const showPage = (): void => {
    const id = (location.hash || '#overview').slice(1)
    const known = Array.from(document.querySelectorAll('main section')).some((x) => x.id === id)
    const page = known ? id : 'overview'
    document.querySelectorAll('main section').forEach((x) => x.classList.toggle('on', x.id === page))
    el('rail').querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + page))
    window.scrollTo({ top: 0 })
    if (page === 'reliability') markErrorsSeen()
  }
  window.addEventListener('hashchange', showPage)
  showPage()
  // a person, in the drawer
  document.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('tr.row') as HTMLElement | null
    if (row && row.dataset.id) openPerson(row.dataset.id)
  })
  el('drawer-x').addEventListener('click', closeDrawer)
  el('veil').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer()
  })
  el('team-add').addEventListener('click', () => {
    void (async () => {
      const email = (el('team-email') as HTMLInputElement).value.trim()
      const out = el('team-note')
      if (!email) return
      out.textContent = '…'
      try {
        await rpc('admin_grant', { p_email: email, p_on: true })
        out.textContent = 'Done.'
        ;(el('team-email') as HTMLInputElement).value = ''
        void renderTeam()
        await reloadPeople()
      } catch (err) {
        out.textContent = 'Could not: ' + (err instanceof Error ? err.message : String(err))
      }
    })()
  })
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
