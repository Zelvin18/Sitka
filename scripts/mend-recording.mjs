// Mends a recording whose recorder never finished its work: the page that
// recorded it closed (or the extension was reloaded) while the last parts
// were going up, so the session was left "recording", with no whole file.
//
// From your own computer, server to server: the parts the cloud does hold
// are fetched in order, joined and rewritten by ffmpeg into one clean MP4
// with its index first (plays and seeks anywhere, starts at once), put up
// as the session's whole file, and the session row is set right: complete,
// its true length, the recording no longer pending.
//
//   node scripts/mend-recording.mjs <session id, or the start of one>
//   node scripts/mend-recording.mjs <id> --look     only say what is there
//
// Keys come from .env.migrate in the project root (see move-recordings.mjs).
// The demo folder's ffmpeg (ffmpeg-static) does the rewrite.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const want = process.argv[2]
const look = process.argv.includes('--look')
if (!want) {
  console.error('give the session id (or the start of it)')
  process.exit(1)
}
for (const line of readFileSync(join(root, '.env.migrate'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const KEY = process.env.SUPABASE_SERVICE_KEY || ''
const auth = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const { r2Config, presign, r2Fetch, r2List } = await import(pathToFileURL(join(root, 'web/api/_r2.js')).href)
const cfg = r2Config()
if (!SUPA || !KEY || !cfg) {
  console.error('.env.migrate needs the Supabase and R2 keys')
  process.exit(1)
}
const ffmpeg = createRequire(join(root, 'demo/package.json'))('ffmpeg-static')

// ---------- the session ----------
const rows = await (await fetch(`${SUPA}/rest/v1/sessions?id=like.${encodeURIComponent(want)}*&select=id,owner,meta,created_at`, { headers: auth })).json()
if (!Array.isArray(rows) || rows.length !== 1) {
  console.error('sessions found:', Array.isArray(rows) ? rows.map((r) => r.id) : rows)
  process.exit(1)
}
const { id, owner, meta } = rows[0]
console.log('session', id, '·', meta.title || '(untitled)', '·', meta.status, '· length', meta.durationMs ? Math.round(meta.durationMs / 1000) + ' s' : 'unknown', '· whole', Boolean(meta.whole), '· pending', Boolean(meta.recordingPending))

// ---------- what the cloud holds: R2 first, then Supabase's own storage ----------
// (a page whose reach to R2 failed at the time falls back to Supabase storage)
const BUCKET = 'recordings'
async function sbList(prefix) {
  const r = await fetch(`${SUPA}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } })
  })
  if (!r.ok) throw new Error(`supabase list ${prefix}: ${r.status}`)
  return (await r.json()).filter((row) => row.id).map((row) => ({ key: `${prefix}/${row.name}`, size: Number(row.metadata?.size ?? 0), from: 'sb' }))
}
const inR2 = (await r2List(cfg, `${owner}/${id}/`)).map((o) => ({ ...o, from: 'r2' }))
const inSb = await sbList(`${owner}/${id}`).catch(() => [])
const objs = inR2.length > 0 ? inR2 : inSb
const parts = objs.filter((o) => /\/part-\d+\.webm$/.test(o.key)).sort((a, b) => (a.key < b.key ? -1 : 1))
const whole = (await r2List(cfg, `${owner}/${id}.webm`)).find((o) => o.key === `${owner}/${id}.webm`)
console.log('parts:', parts.length, parts.length ? `in ${parts[0].from === 'r2' ? 'R2' : 'Supabase storage'}:` : '', parts.map((p) => (p.size / 1e6).toFixed(1) + 'MB').join(' '), '· whole file in R2:', whole ? (whole.size / 1e6).toFixed(1) + ' MB' : 'none')
if (look) process.exit(0)
if (parts.length === 0) {
  console.error('no parts in the cloud: nothing to mend from')
  process.exit(1)
}
async function fetchPart(p) {
  if (p.from === 'sb') return fetch(`${SUPA}/storage/v1/object/${BUCKET}/${p.key.split('/').map(encodeURIComponent).join('/')}`, { headers: auth })
  return r2Fetch(cfg, 'GET', p.key)
}
// the parts must be an unbroken run from the first: a gap would splice
// the picture across missing minutes
for (const [i, p] of parts.entries()) {
  const n = Number(/part-(\d+)\.webm$/.exec(p.key)[1])
  if (n !== i) {
    console.error(`part ${i} is missing (found ${p.key}); the run stops there`)
    parts.length = i
    break
  }
}

// ---------- fetch and join ----------
const work = join(root, 'demo/out/mend', id)
mkdirSync(work, { recursive: true })
const joined = join(work, 'parts.bin')
const bufs = []
for (const p of parts) {
  const r = await fetchPart(p)
  if (!r.ok) throw new Error(`fetch ${p.key}: ${r.status}`)
  const b = Buffer.from(await r.arrayBuffer())
  if (b.length !== p.size) throw new Error(`${p.key}: got ${b.length} of ${p.size}`)
  bufs.push(b)
  process.stdout.write(`  ${p.key.split('/').pop()} ${(b.length / 1e6).toFixed(1)} MB\n`)
}
writeFileSync(joined, Buffer.concat(bufs))
const isMp4 = bufs[0].toString('ascii', 4, 8) === 'ftyp'
const kind = isMp4 ? 'video/mp4' : 'video/webm'
const out = join(work, isMp4 ? 'whole.mp4' : 'whole.webm')

// ---------- rewrite: one clean file, index first ----------
// `-fflags +genpts` and `-c copy`: the fragments are kept as they are, only
// re-boxed with a proper header; a stream that stopped mid-fragment is
// truncated cleanly rather than refused.
let log = ''
try {
  execFileSync(ffmpeg, ['-y', '-loglevel', 'warning', '-fflags', '+genpts+discardcorrupt', '-i', joined, '-c', 'copy', ...(isMp4 ? ['-movflags', '+faststart'] : []), out], { stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  log = String(e.stderr || e.message)
  console.error('ffmpeg:', log.slice(0, 800))
  process.exit(1)
}
// its length, from ffmpeg's own reading of the result
let durationMs = 0
try {
  execFileSync(ffmpeg, ['-i', out], { stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  const m = /Duration: (\d+):(\d+):(\d+)\.(\d+)/.exec(String(e.stderr))
  if (m) durationMs = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10
}
const size = statSync(out).size
console.log('rewritten:', (size / 1e6).toFixed(1), 'MB ·', Math.round(durationMs / 1000), 's')
if (size < 5000 || durationMs < 1000) {
  console.error('the rewrite is too small to be a recording; not uploaded')
  process.exit(1)
}

// ---------- up, as the whole file ----------
const key = `${owner}/${id}.webm`
const put = await fetch(presign(cfg, 'PUT', key, 900), { method: 'PUT', body: readFileSync(out), headers: { 'content-type': kind } })
if (!put.ok) throw new Error(`upload: ${put.status} ${await put.text()}`)
const head = await r2Fetch(cfg, 'HEAD', key)
if (!head.ok || Number(head.headers.get('content-length')) !== size) throw new Error('upload did not verify')
console.log('uploaded', key)

// ---------- the row, set right ----------
const next = { ...meta, whole: true, flat: true, store: 'r2', rewrite: 2, mime: kind, status: 'complete' }
if (!next.durationMs || next.durationMs < durationMs) next.durationMs = durationMs
delete next.recordingPending
delete next.uploadError
const patch = await fetch(`${SUPA}/rest/v1/sessions?id=eq.${id}`, {
  method: 'PATCH',
  headers: { ...auth, 'content-type': 'application/json', Prefer: 'return=minimal' },
  body: JSON.stringify({ meta: next })
})
if (!patch.ok) throw new Error(`session row: ${patch.status} ${await patch.text()}`)
// the shared recap, when there is one, knows the recording is there
await fetch(`${SUPA}/rest/v1/recaps?id=eq.${id}`, {
  method: 'PATCH',
  headers: { ...auth, 'content-type': 'application/json', Prefer: 'return=minimal' },
  body: JSON.stringify({ has_recording: true, duration_ms: next.durationMs, updated_at: new Date().toISOString() })
}).catch(() => undefined)
console.log('done: the session is complete,', Math.round(next.durationMs / 60000), 'min, whole file in place')
