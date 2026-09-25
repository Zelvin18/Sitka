// A copy of the whole database, on this computer.
//
// Supabase's Free plan keeps no backups that can be restored, so this is the
// safety net until the project moves to Pro (which has point-in-time
// recovery). Run it now and then, and before any change to the database:
//
//   node scripts/backup-db.mjs              every table, into backups/<date-time>/
//   node scripts/backup-db.mjs --check      the newest backup: are all its files whole?
//
// Each table becomes one JSON file of its rows, with a manifest.json that
// lists how many rows each had. Nothing in the database is changed.
// The recordings themselves live in Cloudflare R2 and are not copied here.
//
// Keys come from .env.migrate in the project root (never committed; the
// service key in it must never be put in a browser build). The backups
// folder is git-ignored: it holds everyone's data, keep it private.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(root, '.env.migrate'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const KEY = process.env.SUPABASE_SERVICE_KEY || ''
if (!SUPA || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are needed in .env.migrate')
  process.exit(1)
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const PAGE = 1000
const dir = join(root, 'backups')

if (process.argv.includes('--check')) {
  const runs = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'manifest.json'))).sort() : []
  if (!runs.length) {
    console.log('No backup yet.')
    process.exit(1)
  }
  const last = join(dir, runs.at(-1))
  const manifest = JSON.parse(readFileSync(join(last, 'manifest.json'), 'utf8'))
  let ok = true
  for (const [table, n] of Object.entries(manifest.tables)) {
    const rows = JSON.parse(readFileSync(join(last, `${table}.json`), 'utf8'))
    const whole = Array.isArray(rows) && rows.length === n
    if (!whole) ok = false
    console.log(`${whole ? 'ok  ' : 'BAD '} ${table.padEnd(22)} ${n} rows`)
  }
  console.log(ok ? `\n${runs.at(-1)} is whole.` : `\n${runs.at(-1)} has a damaged file.`)
  process.exit(ok ? 0 : 1)
}

// every table the database exposes, from its own description
const spec = await (await fetch(`${SUPA}/rest/v1/`, { headers: { ...H, Accept: 'application/openapi+json' } })).json()
const tables = Object.keys(spec.definitions || {})
  .filter((t) => !t.startsWith('rpc'))
  .sort()
if (!tables.length) {
  console.error('The database did not list its tables:', JSON.stringify(spec).slice(0, 300))
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const out = join(dir, stamp)
mkdirSync(out, { recursive: true })
const manifest = { at: new Date().toISOString(), database: SUPA, tables: {} }
let failed = 0

for (const table of tables) {
  const rows = []
  try {
    for (let from = 0; ; from += PAGE) {
      const r = await fetch(`${SUPA}/rest/v1/${table}?select=*`, {
        headers: { ...H, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items', Prefer: 'count=exact' }
      })
      if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const page = await r.json()
      rows.push(...page)
      if (page.length < PAGE) break
    }
    writeFileSync(join(out, `${table}.json`), JSON.stringify(rows))
    manifest.tables[table] = rows.length
    console.log(`${table.padEnd(22)} ${rows.length} rows`)
  } catch (e) {
    failed++
    console.error(`${table.padEnd(22)} FAILED: ${e.message}`)
  }
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\n${failed ? `${failed} table(s) could not be copied. ` : ''}Saved to backups/${stamp}/`)
process.exit(failed ? 1 : 0)
