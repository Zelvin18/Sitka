// Moves every recording from Supabase Storage to Cloudflare R2, all at once.
//
// The app does this quietly in the background, one file at a time, through
// the browser. This does the same job from your own computer, server to
// server, several files at a time, and is the way to move a whole library in
// one sitting. Each file is copied, the copy's size is checked against the
// original, and only then is the original removed. Run it again any time: it
// only touches what is still in Supabase.
//
//   node scripts/move-recordings.mjs            move everything
//   node scripts/move-recordings.mjs --dry-run  only say what would move
//
// It reads its keys from a file named .env.migrate in the project root, which
// git ignores. Put these six lines in it, with your own values:
//
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY=...        (Supabase → Settings → API → service_role)
//   R2_ACCOUNT_ID=...
//   R2_ACCESS_KEY_ID=...
//   R2_SECRET_ACCESS_KEY=...
//   R2_BUCKET=sitka
//
// Do not record a session while it runs.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dry = process.argv.includes('--dry-run')
const PARALLEL = 4
const BUCKET = 'recordings'

// ---------- settings ----------
try {
  for (const line of readFileSync(join(root, '.env.migrate'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  console.error('No .env.migrate found in the project root. See the top of this script.')
  process.exit(1)
}
const SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const KEY = process.env.SUPABASE_SERVICE_KEY || ''
if (!SUPA || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are needed in .env.migrate')
  process.exit(1)
}
const { r2Config, presign, r2Fetch } = await import(pathToFileURL(join(root, 'web/api/_r2.js')).href)
const cfg = r2Config()
if (!cfg) {
  console.error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are needed in .env.migrate')
  process.exit(1)
}
const auth = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// ---------- what is in Supabase ----------
async function listFolder(prefix) {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SUPA}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
    })
    if (!r.ok) throw new Error(`list ${prefix || '/'}: ${r.status} ${await r.text()}`)
    const rows = await r.json()
    for (const row of rows) {
      const key = prefix ? `${prefix}/${row.name}` : row.name
      if (row.id) out.push({ key, size: Number(row.metadata?.size ?? 0) })
      else out.push(...(await listFolder(key)))
    }
    if (rows.length < 1000) break
  }
  return out
}

// ---------- one file ----------
async function move(obj) {
  const { key, size } = obj
  const got = await fetch(`${SUPA}/storage/v1/object/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: auth })
  if (!got.ok) throw new Error(`download ${key}: ${got.status}`)
  const bytes = Buffer.from(await got.arrayBuffer())
  if (size && bytes.length !== size) throw new Error(`download ${key}: got ${bytes.length} of ${size} bytes`)
  const type = key.endsWith('.jpg') ? 'image/jpeg' : sniff(bytes)
  const put = await fetch(presign(cfg, 'PUT', key, 900), { method: 'PUT', body: bytes, headers: { 'content-type': type } })
  if (!put.ok) throw new Error(`upload ${key}: ${put.status} ${await put.text()}`)
  const head = await r2Fetch(cfg, 'HEAD', key)
  const there = Number(head.headers.get('content-length') || -1)
  if (!head.ok || there !== bytes.length) throw new Error(`verify ${key}: R2 has ${there}, expected ${bytes.length}`)
  const del = await fetch(`${SUPA}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ prefixes: [key] })
  })
  if (!del.ok) throw new Error(`remove ${key} from Supabase: ${del.status}`)
  return bytes.length
}
function sniff(b) {
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  return 'application/octet-stream'
}

// ---------- the session knows where it is ----------
async function markSession(id) {
  const r = await fetch(`${SUPA}/rest/v1/sessions?id=eq.${id}&select=id,meta`, { headers: auth })
  const rows = r.ok ? await r.json() : []
  if (!rows.length) return
  const meta = { ...(rows[0].meta || {}), store: 'r2' }
  await fetch(`${SUPA}/rest/v1/sessions?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ meta })
  })
}
const sessionOf = (key) => {
  const p = key.split('/')
  return p.length >= 2 ? p[1].replace(/\.[a-z0-9]{2,5}$/i, '').replace(/-slides$/, '') : null
}

// ---------- go ----------
const fmt = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB')
console.log('Looking through Supabase…')
const all = await listFolder('')
const total = all.reduce((n, o) => n + o.size, 0)
console.log(`${all.length} files, ${fmt(total)}, across ${new Set(all.map((o) => sessionOf(o.key))).size} sessions`)
if (all.length === 0) process.exit(0)
if (dry) {
  for (const o of all) console.log('  ' + fmt(o.size).padStart(9) + '  ' + o.key)
  process.exit(0)
}

let done = 0, moved = 0, failed = 0
const touched = new Set(), broken = new Set()
const queue = [...all]
async function worker() {
  for (;;) {
    const o = queue.shift()
    if (!o) return
    try {
      moved += await move(o)
      touched.add(sessionOf(o.key))
    } catch (err) {
      failed++
      broken.add(sessionOf(o.key))
      console.error('  failed:', err.message)
    }
    done++
    process.stdout.write(`\r  ${done}/${all.length} files, ${fmt(moved)} moved${failed ? `, ${failed} failed` : ''}   `)
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker))
console.log()
for (const id of touched) if (id && !broken.has(id)) await markSession(id)
console.log(`Done. ${touched.size - [...broken].filter(Boolean).length} sessions now live in Cloudflare.`)
if (failed) console.log(`${failed} files failed; run it again and they will be tried again.`)
