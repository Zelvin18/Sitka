// What is in a recap's recording, from its first bytes: the boxes of the
// joined file and of the first part, the codecs named in them, and what
// ffmpeg makes of each head. Prints a short report to paste back.
//   node inspect.mjs <recap id>
import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const SITE = 'https://sitcaai.vercel.app'
const recapId = process.argv[2]
if (!recapId) throw new Error('give the recap id (the part after /r/)')
const env = Object.fromEntries(
  readFileSync(new URL('../web/.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
const U = env.VITE_SUPABASE_URL
const K = env.VITE_SUPABASE_ANON_KEY
// a recap's id is its session's id; the row names the owner
const rows = await (await fetch(`${U}/rest/v1/recaps?id=eq.${recapId}&select=*`, { headers: { apikey: K, Authorization: `Bearer ${K}` } })).json()
const rc = Array.isArray(rows) ? rows[0] : null
if (!rc) throw new Error('no such recap: ' + JSON.stringify(rows).slice(0, 200))
console.log('recap', rc.id, 'owner', rc.owner, 'enabled', rc.enabled, 'recording', rc.has_recording)
const media = await (await fetch(`${SITE}/api/storage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'media', owner: rc.owner, session: rc.id }) })).json()
if (media.error) throw new Error('media: ' + media.error)
console.log('whole', media.whole ? `${(media.wholeSize / 1e6).toFixed(1)} MB` : 'none', '| parts', media.parts?.length, (media.parts || []).map((p) => (p.size / 1e6).toFixed(1) + 'MB').join(' '))

const rd32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const name = (b, i) => String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
function walk(b, from, to, depth, out) {
  let i = from
  while (i + 8 <= to) {
    let size = rd32(b, i)
    const n = name(b, i)
    let hdr = 8
    if (size === 1) {
      size = Number((BigInt(rd32(b, i + 8)) << 32n) | BigInt(rd32(b, i + 12)))
      hdr = 16
    }
    if (size === 0) size = to - i
    if (!/^[a-zA-Z0-9 ]{4}$/.test(n) || size < 8) break
    out.push('  '.repeat(depth) + n + ':' + size)
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf'].includes(n) && depth < 5) walk(b, i + hdr, Math.min(to, i + size), depth + 1, out)
    if (n === 'stsd') out.push('  '.repeat(depth + 1) + 'codec ' + String.fromCharCode(b[i + 20], b[i + 21], b[i + 22], b[i + 23]))
    i += size
  }
}
async function head(url, bytes) {
  const r = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } })
  return new Uint8Array(await r.arrayBuffer())
}
async function report(label, url, bytes) {
  const b = await head(url, bytes)
  const out = []
  walk(b, 0, b.length, 0, out)
  const txt = Buffer.from(b.subarray(0, Math.min(b.length, 4000000))).toString('latin1')
  console.log(`\n== ${label} (first ${(b.length / 1e6).toFixed(1)} MB)`)
  console.log(out.filter((l) => !/^\s{6,}/.test(l) || /codec|stss|ctts|stco|co64|stsz|stts|elst|avcC|esds|dOps/.test(l)).slice(0, 60).join('\n'))
  console.log('mentions:', ['avc1', 'avc3', 'avcC', 'mp4a', 'esds', 'Opus', 'dOps', 'stss', 'ctts', 'co64', 'stco', 'mvex', 'moof', 'sidx'].filter((k) => txt.includes(k)).join(' '))
  const f = fileURLToPath(new URL(`./out/head-${label}.mp4`, import.meta.url))
  try {
    writeFileSync(f, b)
    const probe = execFileSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(probe)
  } catch (e) {
    console.log(String(e.stderr || e.message).split('\n').filter((l) => /Stream|Duration|Input|error|Error|Invalid|moov|missing/.test(l)).join('\n'))
  }
}
if (media.whole) await report('whole', media.whole, 4 * 1024 * 1024)
if (media.parts?.[0]) await report('part0', media.parts[0].url, 2 * 1024 * 1024)
