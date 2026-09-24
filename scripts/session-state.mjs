// What a session's row actually says: its state, how many lines of
// transcript it has, whether it has been analysed, and the last analysis
// error if there was one.
//
//   node scripts/session-state.mjs                 the ten newest sessions
//   node scripts/session-state.mjs <id or start>   one session, in full
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
const q = want
  ? `sessions?id=like.${encodeURIComponent(want)}*&select=id,meta,transcript,created_at,updated_at`
  : 'sessions?select=id,meta,transcript,created_at,updated_at&order=created_at.desc&limit=10'
const rows = await (await fetch(`${SUPA}/rest/v1/${q}`, { headers: H })).json()
if (!Array.isArray(rows)) {
  console.error(rows)
  process.exit(1)
}
for (const r of rows) {
  const m = r.meta || {}
  const lines = Array.isArray(r.transcript) ? r.transcript.length : 0
  const words = Array.isArray(r.transcript) ? r.transcript.reduce((n, s) => n + String(s.text || '').split(/\s+/).length, 0) : 0
  console.log('—'.repeat(70))
  console.log(r.id.slice(0, 8), '·', (m.title || '(untitled)').slice(0, 44))
  console.log('  status', m.status, '· length', Math.round((m.durationMs || 0) / 1000) + 's', '· ended', new Date(r.created_at).toLocaleString())
  console.log('  transcript', lines, 'lines /', words, 'words · analysed', Boolean(m.analyzed), '· summary', m.summary ? `${String(m.summary).length} chars` : 'NONE', '· moments', (m.highlights || []).length)
  console.log('  filed under', m.space || 'you', m.spaceId ? `· space ${String(m.spaceId).slice(0, 8)}` : '', '· whole file', Boolean(m.whole), m.recordingPending ? '· UPLOAD PENDING' : '', m.uploadError ? `· ${String(m.uploadError).slice(0, 120)}` : '')
  if (m.analysisError) console.log('  LAST ERROR:', String(m.analysisError).slice(0, 220))
  if (want && m.summary) console.log('\n  ' + String(m.summary).slice(0, 600))
}
