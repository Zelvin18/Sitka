// Where recordings live.
//
// Sitca keeps its accounts, sessions and everything the AI writes in Supabase,
// and keeps the recordings themselves in Cloudflare R2. This is the one place
// the two meet: it checks with Supabase who is asking and what they are
// allowed to see, then hands back links that talk to R2 directly. No video
// passes through this server in either direction, so a two-hour lecture costs
// the same here as a two-minute one.
//
// Who may read what follows the same rule the database uses:
//   the owner may read and write anything under their own folder;
//   anyone at all may read a session whose recap the owner has shared, or
//   whose event replay is switched on, and nothing else.

import { r2Config, presign, r2Fetch, r2List } from './_r2.js'

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

const UUID = /^[0-9a-fA-F-]{16,64}$/
/** How long a link lives. Long enough to watch a lecture without re-asking. */
const READ_SECS = 6 * 3600
const WRITE_SECS = 900

export default async function handler(req, res) {
  const cfg = r2Config()

  if (req.method === 'GET') {
    // The recording as a playlist for a phone's own player lives here too
    // (one function fewer: the deployment's plan allows only so many).
    const q = new URL(req.url, 'http://x').searchParams
    if (q.get('op') === 'hls') return await playlist(req, res, cfg, q)
    // A quick look at whether this deployment is wired up, safe to open in a
    // browser. Nothing secret is reported, only whether each piece is set.
    return res.status(200).json({
      configured: Boolean(cfg),
      bucket: cfg ? cfg.bucket : null,
      supabase: Boolean(SUPA_URL && SUPA_ANON),
      publicBase: (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '') || null
    })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!cfg) return res.status(501).json({ error: 'not-configured' })
  if (!SUPA_URL || !SUPA_ANON) return res.status(501).json({ error: 'not-configured' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }
  if (!body || typeof body !== 'object') body = {}

  const op = String(body.op || '')
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  const owner = token ? await userOf(token) : null
  askerToken = token
  // A token that could not be checked at all (the account service was
  // unreachable for a moment) must not read as "not your file": that turned
  // a blip into a refused recording upload. The page is told to try again.
  if (token && owner === UNCHECKED) {
    return res.status(503).json({ error: 'Could not check who you are just now. Try again in a moment.' })
  }

  try {
    if (op === 'put') return await putLinks(res, cfg, owner, body)
    if (op === 'grant') return await grantLinks(res, cfg, owner, body)
    if (op === 'get') return await getLinks(res, cfg, owner, body)
    if (op === 'list') return await listFolder(res, cfg, owner, body)
    if (op === 'media') return await mediaLinks(res, cfg, owner, body)
    if (op === 'del') return await removeKeys(res, cfg, owner, body)
    if (op === 'usage') return await usage(res, cfg, token)
    if (op === 'mine') return await mine(res, cfg, owner)
    return res.status(400).json({ error: 'Unknown operation.' })
  } catch (err) {
    console.error('storage', op, err)
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------- who is asking ----------

/** the answer when the account service itself could not be asked */
const UNCHECKED = Symbol('unchecked')
async function userOf(token) {
  let reached = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON }
      })
      reached = true
      // 401/403: the token is no good, and saying so is the answer.
      // 5xx: the service is unwell; asked once more, then reported as such.
      if (r.status >= 500) {
        reached = false
        continue
      }
      if (!r.ok) return null
      const j = await r.json()
      return typeof j?.id === 'string' ? j.id : null
    } catch {
      /* could not be reached: once more */
    }
  }
  return reached ? null : UNCHECKED
}

/**
 * Is this session shared with the world? True when its recap is on, or when
 * it was hosted as an event whose replay is on. The same two conditions the
 * database policy used when the recordings lived in Supabase.
 */
const shareCache = new Map()
async function isShared(sessionId) {
  if (!UUID.test(sessionId)) return false
  const hit = shareCache.get(sessionId)
  if (hit && hit.until > Date.now()) return hit.ok
  const headers = { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
  let ok = false
  try {
    const recap = await fetch(
      `${SUPA_URL}/rest/v1/recaps?id=eq.${sessionId}&enabled=is.true&select=id&limit=1`,
      { headers }
    )
    const shared = recap.ok ? await recap.json().catch(() => []) : []
    ok = Array.isArray(shared) && shared.length > 0
    if (!ok) {
      const ev = await fetch(
        `${SUPA_URL}/rest/v1/events?session_id=eq.${sessionId}&replay->>enabled=eq.true&select=id&limit=1`,
        { headers }
      )
      const rows = ev.ok ? await ev.json().catch(() => []) : []
      ok = Array.isArray(rows) && rows.length > 0
    }
  } catch {
    ok = false
  }
  // Remembered briefly so a page of parts asks once, not once per part.
  shareCache.set(sessionId, { ok, until: Date.now() + (ok ? 60000 : 5000) })
  return ok
}

// Keys are <owner>/<session>.<ext> or <owner>/<session>/<name>, and slide
// frames sit in <owner>/<session>-slides/<name>. A shared session opens
// exactly those and nothing else in the owner's folder.
function sessionOfKey(key) {
  const parts = String(key).split('/')
  if (parts.length < 2) return null
  const second = parts[1].replace(/\.[a-z0-9]{2,5}$/i, '').replace(/-slides$/, '')
  return UUID.test(second) ? second : null
}

/** the token of the person asking, for the course check (set per request) */
let askerToken = ''

/**
 * A member of the course a session is filed in may watch it. The database
 * decides, as the person: their token, their membership.
 */
async function memberCanWatch(sessionId) {
  if (!askerToken || !UUID.test(sessionId)) return false
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_can_watch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${askerToken}`, apikey: SUPA_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: sessionId })
    })
    return r.ok && (await r.json()) === true
  } catch {
    return false
  }
}

async function allow(owner, keys, write) {
  const list = (Array.isArray(keys) ? keys : []).map(String)
  if (list.length === 0 || list.length > 1200) return false
  if (list.some((k) => k.includes('..') || k.startsWith('/'))) return false
  if (owner && list.every((k) => k.startsWith(owner + '/'))) return true
  if (write) return false
  const sessions = new Set(list.map(sessionOfKey))
  if (sessions.has(null) || sessions.size > 4) return false
  for (const s of sessions) if (!(await isShared(s)) && !(await memberCanWatch(s))) return false
  return true
}

// ---------- the four things the app asks for ----------

async function putLinks(res, cfg, owner, body) {
  const items = Array.isArray(body.keys) ? body.keys : []
  const keys = items.map((i) => (typeof i === 'string' ? i : i?.key)).filter(Boolean)
  if (!(await allow(owner, keys, true))) return res.status(403).json({ error: 'Not allowed.' })
  const links = items.map((i) => {
    const key = typeof i === 'string' ? i : i.key
    return { key, url: presign(cfg, 'PUT', key, WRITE_SECS) }
  })
  return res.status(200).json({ links, expiresIn: WRITE_SECS })
}

/**
 * A recording's upload links, all at once, at the start: one per piece for
 * the next hour or so, good for twelve hours. The page then sends every
 * piece straight to storage without asking anyone again, so nothing between
 * the recorder and the cloud (this server, the account service, a slow
 * network to either) can hold a recording back once it has begun. Only the
 * owner's own session folder is ever granted.
 */
const GRANT_SECS = 12 * 3600
async function grantLinks(res, cfg, owner, body) {
  if (!owner) return res.status(401).json({ error: 'Sign in first.' })
  const session = String(body.session || '')
  if (!UUID.test(session)) return res.status(400).json({ error: 'Bad session.' })
  const from = Math.max(0, Math.min(99999, Math.floor(Number(body.from) || 0)))
  const count = Math.max(1, Math.min(400, Math.floor(Number(body.count) || 180)))
  const links = []
  for (let n = from; n < from + count; n++) {
    const key = `${owner}/${session}/part-${String(n).padStart(4, '0')}.webm`
    links.push({ n, url: presign(cfg, 'PUT', key, GRANT_SECS) })
  }
  return res.status(200).json({ links, expiresAt: Date.now() + GRANT_SECS * 1000 })
}

async function getLinks(res, cfg, owner, body) {
  const keys = (Array.isArray(body.keys) ? body.keys : []).map(String)
  if (!(await allow(owner, keys, false))) return res.status(403).json({ error: 'Not allowed.' })
  const links = keys.map((key) => ({ key, url: presign(cfg, 'GET', key, READ_SECS) }))
  return res.status(200).json({ links, expiresIn: READ_SECS })
}

async function listFolder(res, cfg, owner, body) {
  const prefix = String(body.prefix || '')
  if (!prefix || prefix.includes('..')) return res.status(400).json({ error: 'Bad prefix.' })
  if (!(await allow(owner, [prefix.replace(/\/$/, '') + '/x'], false))) {
    return res.status(403).json({ error: 'Not allowed.' })
  }
  const objects = await r2List(cfg, prefix.endsWith('/') ? prefix : prefix + '/')
  return res.status(200).json({
    objects: objects.map((o) => ({ name: o.key.slice(prefix.replace(/\/$/, '').length + 1), size: o.size }))
  })
}

/**
 * Everything needed to play one recording, in a single request: whether the
 * whole file exists, the parts in order, and a link to each. A recap page
 * opened by a student who is not signed in asks this once and starts playing.
 */
async function mediaLinks(res, cfg, owner, body) {
  const ownerId = String(body.owner || '')
  const sessionId = String(body.session || '')
  if (!UUID.test(ownerId) || !UUID.test(sessionId)) {
    return res.status(400).json({ error: 'Bad session.' })
  }
  const mine = owner && owner === ownerId
  if (!mine && !(await isShared(sessionId)) && !(await memberCanWatch(sessionId))) return res.status(403).json({ error: 'Not allowed.' })

  // One listing catches both shapes, because the whole file and the folder of
  // parts share a prefix: <owner>/<session>.webm and <owner>/<session>/part-*
  const objects = await r2List(cfg, `${ownerId}/${sessionId}`)
  const wholeKey = `${ownerId}/${sessionId}.webm`
  const wholeObj = objects.find((o) => o.key === wholeKey)
  const whole = wholeObj ? presign(cfg, 'GET', wholeKey, READ_SECS) : null
  const parts = objects
    .filter((o) => /\/part-\d+\.webm$/.test(o.key))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((o) => ({ url: presign(cfg, 'GET', o.key, READ_SECS), size: o.size }))
  // a recording with its fragment index beside it can be handed to a phone
  // as a playlist (see hls.js): piece by piece, starting at once
  const indexed = objects.some((o) => o.key === `${ownerId}/${sessionId}/index.json`)
  return res.status(200).json({
    where: whole || parts.length > 0 ? 'r2' : 'none',
    whole,
    wholeSize: wholeObj ? wholeObj.size : undefined,
    parts,
    hls: indexed && parts.length > 0 ? `/api/storage?op=hls&owner=${ownerId}&session=${sessionId}` : null,
    expiresIn: READ_SECS
  })
}

/** May this asker (by token) watch this session? The rule the links follow. */
async function mayWatch(token, ownerId, sessionId) {
  askerToken = token || ''
  const owner = token ? await userOf(token) : null
  if (owner && owner === ownerId) return true
  return (await isShared(sessionId)) || (await memberCanWatch(sessionId))
}

/**
 * A recording as a playlist, for phones.
 *
 * Safari (every browser on an iPhone or iPad) plays HLS natively and starts
 * within a second or two: it fetches a small playlist, then the recording
 * piece by piece. The pieces are the recorder's own fragments, addressed by
 * byte range inside the parts already in R2 — nothing is copied or
 * rewritten, and no video passes through this server. The fragment index
 * beside the parts (index.json, written by the app after a session) says
 * where each piece is and when it plays.
 *
 *   GET /api/storage?op=hls&owner=<uuid>&session=<uuid>[&t=<token>]
 */
async function playlist(req, res, cfg, q) {
  if (!cfg) return res.status(501).json({ error: 'not-configured' })
  const owner = String(q.get('owner') || '')
  const session = String(q.get('session') || '')
  if (!UUID.test(owner) || !UUID.test(session)) return res.status(400).json({ error: 'Bad session.' })
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || String(q.get('t') || '')
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
    if (within + size > (Number(parts[i].size) || 0)) return null // straddles two parts: not addressable
    return { i, within }
  }
  const initAt = locate(0, index.init)
  if (!initAt) return res.status(500).json({ error: 'The header straddles parts.' })

  const body = []
  let target = 1
  for (let k = 0; k < frags.length; k++) {
    const [offset, size, start] = frags[k]
    const next = k + 1 < frags.length ? frags[k + 1][2] : Number(index.duration) || start + 3
    const dur = Math.max(0.05, next - start)
    if (dur > target) target = dur
    const where = locate(offset, size)
    if (!where) return res.status(500).json({ error: `Fragment ${k} straddles parts.` })
    body.push(`#EXTINF:${dur.toFixed(3)},`, `#EXT-X-BYTERANGE:${size}@${where.within}`, links[where.i])
  }
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-TARGETDURATION:${Math.ceil(target)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="${links[initAt.i]}",BYTERANGE="${index.init}@${initAt.within}"`,
    ...body,
    '#EXT-X-ENDLIST'
  ]
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Cache-Control', 'private, max-age=600')
  return res.status(200).send(lines.join('\n') + '\n')
}

/**
 * How much of Cloudflare the recordings take, for the owners' dashboard:
 * everything in the bucket, and the largest folders (one per account). Only
 * someone the database lists as an admin is answered.
 */
async function usage(res, cfg, token) {
  if (!token) return res.status(401).json({ error: 'Sign in first.' })
  let admin = false
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/is_admin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON, 'Content-Type': 'application/json' },
      body: '{}'
    })
    admin = r.ok && (await r.json()) === true
  } catch {
    admin = false
  }
  if (!admin) return res.status(403).json({ error: 'Not allowed.' })
  const objects = await r2List(cfg, '')
  let total = 0
  let recordings = 0
  const byOwner = new Map()
  for (const o of objects) {
    total += o.size
    const owner = o.key.split('/')[0]
    if (UUID.test(owner)) {
      byOwner.set(owner, (byOwner.get(owner) || 0) + o.size)
      if (/\.webm$/.test(o.key) && !/-slides\//.test(o.key)) recordings++
    }
  }
  const owners = [...byOwner.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([owner, bytes]) => ({ owner, bytes }))
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ bytes: total, objects: objects.length, files: recordings, accounts: byOwner.size, owners })
}

/** How much of Cloudflare one person's recordings take, for their Settings. */
const mineCache = new Map()
async function mine(res, cfg, owner) {
  if (!owner) return res.status(401).json({ error: 'Sign in first.' })
  const hit = mineCache.get(owner)
  res.setHeader('Cache-Control', 'no-store')
  if (hit && hit.until > Date.now()) return res.status(200).json(hit.body)
  const objects = await r2List(cfg, `${owner}/`)
  let bytes = 0
  let files = 0
  for (const o of objects) {
    bytes += o.size
    if (/\.webm$/.test(o.key) && !/-slides\//.test(o.key)) files++
  }
  const body = { bytes, files, objects: objects.length }
  if (mineCache.size > 500) mineCache.clear()
  mineCache.set(owner, { body, until: Date.now() + 120000 })
  return res.status(200).json(body)
}

async function removeKeys(res, cfg, owner, body) {
  const keys = (Array.isArray(body.keys) ? body.keys : []).map(String)
  if (!(await allow(owner, keys, true))) return res.status(403).json({ error: 'Not allowed.' })
  for (let i = 0; i < keys.length; i += 20) {
    await Promise.all(
      keys.slice(i, i + 20).map((k) => r2Fetch(cfg, 'DELETE', k).catch(() => undefined))
    )
  }
  return res.status(200).json({ removed: keys.length })
}
