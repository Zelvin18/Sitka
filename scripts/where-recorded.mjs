// Where was a session recorded? The pages that reported on it — the browser,
// the page (the website's /app or the extension's /app.html) and when — so a
// recording that never reached the cloud can be found on the device that
// holds it.
//
//   node scripts/where-recorded.mjs <session id, or the start of one>
//
// Keys come from .env.migrate in the project root.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(root, '.env.migrate'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const H = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
const want = process.argv[2]
if (!want) throw new Error('give the session id (or the start of it)')
const rows = await (await fetch(`${SUPA}/rest/v1/client_errors?message=ilike.*${encodeURIComponent(want)}*&select=at,page,message,ua&order=at.asc&limit=200`, { headers: H })).json()
if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows))
const browsers = new Map()
for (const r of rows) {
  const b = `${r.page} · ${String(r.ua || '').slice(0, 110)}`
  const k = browsers.get(b) ?? { n: 0, first: r.at, last: r.at, sample: r.message }
  k.n++
  k.last = r.at
  browsers.set(b, k)
}
console.log(`${rows.length} reports mention ${want}`)
for (const [b, k] of browsers) {
  console.log('—'.repeat(60))
  console.log(b)
  console.log(`  ${k.n} reports, ${new Date(k.first).toLocaleString()} → ${new Date(k.last).toLocaleString()}`)
  console.log(`  e.g. ${String(k.sample).slice(0, 160)}`)
}
