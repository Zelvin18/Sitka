// A recording as a playlist, for phones.
//
// Safari (every browser on an iPhone or iPad) plays HLS natively and starts
// within a second or two: it fetches a small playlist, then the recording
// piece by piece. The pieces are the recorder's own fragments, addressed by
// byte range inside the parts already in R2 — nothing is copied or rewritten,
// and no video passes through this server. The fragment index beside the
// parts (index.json, written by the app after a session) says where each
// piece is and when it plays.
//
//   GET /api/hls?owner=<uuid>&session=<uuid>
//
// Who may fetch it follows the same rule as the links to the files.

import { r2Config, presign, r2Fetch } from './_r2.js'
import { mayWatch } from './storage.js'

const UUID = /^[0-9a-fA-F-]{16,64}$/
const READ_SECS = 6 * 3600

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const cfg = r2Config()
  if (!cfg) return res.status(501).json({ error: 'not-configured' })
  const url = new URL(req.url, 'http://x')
  const owner = String(url.searchParams.get('owner') || '')
  const session = String(url.searchParams.get('session') || '')
  if (!UUID.test(owner) || !UUID.test(session)) return res.status(400).json({ error: 'Bad session.' })
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || String(url.searchParams.get('t') || '')
  if (!(await mayWatch(token, owner, session))) return res.status(403).json({ error: 'Not allowed.' })

  const prefix = `${owner}/${session}`
  const ix = await r2Fetch(cfg, 'GET', `${prefix}/index.json`)
  if (!ix.ok) return res.status(404).json({ error: 'No index for this recording yet.' })
  let index
  try {
    index = await ix.json()
  } catch {
    return res.status(500).json({ error: 'The index could not be read.' })
  }
  const parts = Array.isArray(index.parts) ? index.parts : []
  const frags = Array.isArray(index.frags) ? index.frags : []
  if (parts.length === 0 || frags.length === 0 || typeof index.init !== 'number') return res.status(500).json({ error: 'The index is incomplete.' })

  // the parts, each by its link; a fragment is a byte range of the part it sits in
  const links = parts.map((p) => presign(cfg, 'GET', `${prefix}/${p.name}`, READ_SECS))
  const starts = []
  let at = 0
  for (const p of parts) {
    starts.push(at)
    at += Number(p.size) || 0
  }
  const locate = (offset, size) => {
    let i = starts.length - 1
    while (i > 0 && starts[i] > offset) i--
    const within = offset - starts[i]
    const partSize = Number(parts[i].size) || 0
    if (within + size > partSize) return null // straddles two parts: not addressable
    return { i, within }
  }
  const initAt = locate(0, index.init)
  if (!initAt) return res.status(500).json({ error: 'The header straddles parts.' })

  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS']
  let target = 1
  const body = []
  for (let k = 0; k < frags.length; k++) {
    const [offset, size, start] = frags[k]
    const next = k + 1 < frags.length ? frags[k + 1][2] : Number(index.duration) || start + 3
    const dur = Math.max(0.05, next - start)
    if (dur > target) target = dur
    const where = locate(offset, size)
    if (!where) return res.status(500).json({ error: `Fragment ${k} straddles parts.` })
    body.push(`#EXTINF:${dur.toFixed(3)},`)
    body.push(`#EXT-X-BYTERANGE:${size}@${where.within}`)
    // every piece names its file, as the format requires, even when it is the same one
    body.push(links[where.i])
  }
  lines.push(`#EXT-X-TARGETDURATION:${Math.ceil(target)}`)
  lines.push('#EXT-X-MEDIA-SEQUENCE:0')
  lines.push(`#EXT-X-MAP:URI="${links[initAt.i]}",BYTERANGE="${index.init}@${initAt.within}"`)
  lines.push(...body, '#EXT-X-ENDLIST')
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Cache-Control', 'private, max-age=600')
  return res.status(200).send(lines.join('\n') + '\n')
}
