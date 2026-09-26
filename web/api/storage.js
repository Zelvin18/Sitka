// Where recordings live.
//
// Sitca keeps its accounts, sessions and everything the AI writes in Supabase,
// and keeps the recordings themselves in Cloudflare R2. This is the one place
// the two meet: it checks with Supabase who is asking and what they are
// allowed to see, then hands back links that talk to R2 directly. No video
// passes through this server in either direction.
//
// Who may read what is decided in _share.js. Every key is checked against the
// few shapes a recording is made of; anything else is refused.

import { r2Config, presign, r2Fetch, r2List } from './_r2.js'
import { SUPA_URL, SUPA_ANON, SUPA_SERVICE, UNCHECKED, userOf, tokenOf, failSafely } from './_auth.js'
import { UUID, isShared, memberCanWatch, keyShape, makeTicket, checkTicket } from './_share.js'
import { usageOf } from './_plan.js'
import { overLimitKey } from './_limit.js'

/** How long a read link lives: long enough for a lecture; the player renews it. */
const READ_SECS = 2 * 3600
/** A single upload link (the whole file, the index, a slide). */
const WRITE_SECS = 900
/** A recording's own upload links: a batch at a time, renewed well before they lapse. */
const GRANT_SECS = 3 * 3600
const GRANT_MAX = 60

/** the plans' storage, mirrored from src/shared/plans.ts (GB; 0 = no limit) */
const STORAGE_GB = { free: 3, plus: 30, pro: 150, institution: 0 }

export default async function handler(req, res) {
  const cfg = r2Config()

  if (req.method === 'GET') {
    // The recording as a playlist for a phone's own player lives here too
    // (one function fewer: the deployment's plan allows only so many).
    const q = new URL(req.url, 'http://x').searchParams
    if (q.get('op') === 'hls') {
      try {
        return await playlist(req, res, cfg, q)
      } catch (err) {
        return failSafely(res, err, 'storage-hls')
      }
    }
    // Whether this deployment is wired up. Nothing about the bucket is named.
    return res.status(200).json({ configured: Boolean(cfg), supabase: Boolean(SUPA_URL && SUPA_ANON) })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!cfg || !SUPA_URL || !SUPA_ANON) return res.status(501).json({ error: 'not-configured' })

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
  const token = tokenOf(req)
  const who = token ? await userOf(token) : null
  // A token that could not be checked at all (the account service was
  // unreachable for a moment) must not read as "not your file": the page is
  // told to try again.
  if (who === UNCHECKED) {
    return res.status(503).json({ error: 'Could not check who you are just now. Try again in a moment.' })
  }
  const owner = who ? who.id.toLowerCase() : null

  try {
    if (op === 'put') return await putLinks(res, cfg, owner, body, token)
    if (op === 'grant') return await grantLinks(res, cfg, owner, body, token)
    if (op === 'get') return await getLinks(res, cfg, owner, body, token)
    if (op === 'list') return await listFolder(res, cfg, owner, body, token)
    if (op === 'media') return await mediaLinks(res, cfg, owner, body, token)
    if (op === 'del') return await removeKeys(res, cfg, owner, body)
    if (op === 'usage') return await usage(res, cfg, token)
    if (op === 'mine') return await mine(res, cfg, owner)
    return res.status(400).json({ error: 'Unknown operation.' })
  } catch (err) {
    return failSafely(res, err, `storage-${op}`)
  }
}

// ---------- who may do what ----------

/**
 * May `owner` read (or write) these keys? Every key must have one of a
 * recording's shapes. Writes: only the caller's own folder. Reads: the
 * caller's own, or a shared session from its sharer's folder, or a course
 * session for a member.
 */
async function allow(owner, keys, write, token) {
  const list = (Array.isArray(keys) ? keys : []).map(String)
  if (list.length === 0 || list.length > 1200) return false
  const shapes = list.map(keyShape)
  if (shapes.some((s) => !s)) return false
  if (owner && shapes.every((s) => s.owner === owner)) return true
  if (write) return false
  const folders = new Map()
  for (const s of shapes) folders.set(`${s.owner}/${s.session}`, s)
  if (folders.size > 4) return false
  for (const f of folders.values()) {
    if (!(await isShared(f.owner, f.session)) && !(await memberCanWatch(f.session, token))) return false
  }
  return true
}

// ---------- the storage a plan allows ----------

const mineCache = new Map()
/** One person's recordings in R2: bytes and files, counted once per recording. */
async function footprint(cfg, owner) {
  const hit = mineCache.get(owner)
  if (hit && hit.until > Date.now()) return hit.body
  const objects = await r2List(cfg, `${owner}/`)
  // a recording is either its whole file or its pieces: when both are there
  // (the pieces are kept until the whole is checked) only the whole counts
  const wholes = new Set()
  for (const o of objects) {
    const s = keyShape(o.key)
    if (s && s.kind === 'whole') wholes.add(s.session)
  }
  let bytes = 0
  let files = 0
  for (const o of objects) {
    const s = keyShape(o.key)
    if (s && s.kind === 'part' && wholes.has(s.session)) continue
    bytes += o.size
    if (s && s.kind === 'whole') files++
  }
  for (const o of objects) {
    const s = keyShape(o.key)
    if (s && s.kind === 'part' && !wholes.has(s.session) && /part-0+\.webm$/.test(o.key)) files++
  }
  const body = { bytes, files, objects: objects.length }
  if (mineCache.size > 500) mineCache.clear()
  mineCache.set(owner, { body, until: Date.now() + 120000 })
  return body
}

/**
 * Has this account room for more? 'yes', 'no', or 'unknown' when the plan or
 * the footprint cannot be learned just now (the upload waits on the device
 * and is asked again; it is never let through unchecked). A recording
 * already under way is given `graceGb` past the line, so a lecture is not cut
 * in the middle; a new one gets none.
 */
async function roomFor(cfg, owner, token, graceGb = 0) {
  const u = await usageOf(token)
  if (!u) return 'unknown'
  const gb = STORAGE_GB[u.plan] ?? STORAGE_GB.free
  if (!gb) return 'yes'
  let bytes
  try {
    ;({ bytes } = await footprint(cfg, owner))
  } catch {
    return 'unknown'
  }
  return bytes < (gb + graceGb) * 1024 ** 3 ? 'yes' : 'no'
}
const STORAGE_FULL = 'Your plan’s storage is full. Delete a recording or move up a plan to record more.'

/**
 * Whose session this is, by the database's own record: 'ours', 'other',
 * 'deleted' (it was, and stays so), 'missing' (no row yet), or null when the
 * database could not be asked. Uploads go only to a session that is ours.
 */
async function sessionState(owner, session) {
  if (!SUPA_SERVICE) return null
  const headers = { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` }
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/sessions?id=eq.${encodeURIComponent(session)}&select=owner`, {
      headers,
      signal: AbortSignal.timeout(5000)
    })
    if (!r.ok) return null
    const rows = await r.json()
    const row = Array.isArray(rows) ? rows[0] : null
    if (row) return String(row.owner).toLowerCase() === owner ? 'ours' : 'other'
    // no row: deleted, or not written yet (a database without the record of
    // deleted sessions yet answers "missing")
    const d = await fetch(`${SUPA_URL}/rest/v1/deleted_sessions?id=eq.${encodeURIComponent(session)}&select=id`, {
      headers,
      signal: AbortSignal.timeout(5000)
    })
    if (d.ok) {
      const gone = await d.json()
      if (Array.isArray(gone) && gone.length > 0) return 'deleted'
    }
    return 'missing'
  } catch {
    return null
  }
}
/** The answer to an upload for a session that is not ours to upload to; null when it is. */
function refuseSession(res, state) {
  if (state === 'ours') return null
  if (state === 'other') return res.status(403).json({ error: 'This recording belongs to another account.' })
  if (state === 'deleted') return res.status(410).json({ error: 'This session was deleted.', deleted: true })
  if (state === 'missing') return res.status(409).json({ error: 'This session is not saved yet. It will be tried again.', missing: true })
  return res.status(503).json({ error: 'Could not check this session just now. It will be tried again.' })
}

// ---------- the links ----------

async function putLinks(res, cfg, owner, body, token) {
  if (!owner) return res.status(401).json({ error: 'Sign in first.' })
  const items = Array.isArray(body.keys) ? body.keys : []
  const keys = items.map((i) => (typeof i === 'string' ? i : i?.key)).filter(Boolean)
  if (keys.length > 50 || !(await allow(owner, keys, true))) return res.status(403).json({ error: 'Not allowed.' })
  // Only into a session that is ours and still there: a whole file or index
  // finishing after its session was deleted is refused, not left behind.
  const sessions = new Set(keys.map((k) => keyShape(k)?.session).filter(Boolean))
  if (sessions.size > 4) return res.status(403).json({ error: 'Not allowed.' })
  for (const session of sessions) {
    const refused = refuseSession(res, await sessionState(owner, String(session).toLowerCase()))
    if (refused) return refused
  }
  // the whole file replaces its pieces in the count, so a recording already
  // held is given room to be joined
  const room = await roomFor(cfg, owner, token, 2)
  if (room === 'unknown') return res.status(503).json({ error: 'Could not check your storage just now. It will be tried again.' })
  if (room === 'no') return res.status(402).json({ error: STORAGE_FULL, limit: 'storage' })
  const links = keys.map((key) => ({ key, url: presign(cfg, 'PUT', key, WRITE_SECS) }))
  return res.status(200).json({ links, expiresIn: WRITE_SECS })
}

/**
 * A recording's upload links, a batch at a time: one per piece, good for a
 * few hours, so the page sends each piece straight to storage without asking
 * anyone again mid-session. Only the caller's own session is granted: a
 * session id that belongs to someone else is refused (the shared-computer
 * case). A new recording is refused when the plan's storage is full; one
 * already running never is.
 */
async function grantLinks(res, cfg, owner, body, token) {
  if (!owner) return res.status(401).json({ error: 'Sign in first.' })
  const session = String(body.session || '').toLowerCase()
  if (!UUID.test(session)) return res.status(400).json({ error: 'Bad session.' })
  const from = Math.max(0, Math.min(99999, Math.floor(Number(body.from) || 0)))
  const count = Math.max(1, Math.min(GRANT_MAX, Math.floor(Number(body.count) || GRANT_MAX)))
  if (await overLimitKey(`grant:user:${owner}`, 30, 400)) return res.status(429).json({ error: 'Slow down a little.' })
  // Only the caller's own session, whose row is written and not deleted: a
  // deleted session gets no more links from any tab or device, and pieces
  // with no session behind them are not taken in.
  const refused = refuseSession(res, await sessionState(owner, session))
  if (refused) return refused
  // Numbers that already hold a piece are not handed out again: the recorder
  // is told they are taken, with their sizes, so a piece that already landed
  // (same size) counts as sent and a different one is given a new number.
  // Nothing already in the cloud is ever written over. A listing that fails
  // leaves the answer as it was (every number), never blocks the upload.
  const taken = []
  const held = new Map()
  try {
    for (const o of await r2List(cfg, `${owner}/${session}/`)) {
      const m = /\/part-(\d+)\.webm$/.exec(o.key)
      if (m) held.set(Number(m[1]), o.size)
    }
  } catch {
    /* unknown: every number is offered, as before */
  }
  // The plan's storage, on every batch (starting part-way through once
  // skipped it). A recording already in the cloud may finish a little past
  // the line; a new one may not start past it.
  const room = await roomFor(cfg, owner, token, held.size > 0 ? 1 : 0)
  if (room === 'unknown') return res.status(503).json({ error: 'Could not check your storage just now. It will be tried again.' })
  if (room === 'no') return res.status(402).json({ error: STORAGE_FULL, limit: 'storage' })
  const links = []
  for (let n = from; n < from + count; n++) {
    if (held.has(n)) {
      taken.push({ n, size: held.get(n) })
      continue
    }
    const key = `${owner}/${session}/part-${String(n).padStart(4, '0')}.webm`
    links.push({ n, url: presign(cfg, 'PUT', key, GRANT_SECS) })
  }
  return res.status(200).json({ links, taken, expiresAt: Date.now() + GRANT_SECS * 1000 })
}

async function getLinks(res, cfg, owner, body, token) {
  const keys = (Array.isArray(body.keys) ? body.keys : []).map(String)
  if (!(await allow(owner, keys, false, token))) return res.status(403).json({ error: 'Not allowed.' })
  const links = keys.map((key) => ({ key, url: presign(cfg, 'GET', key, READ_SECS) }))
  return res.status(200).json({ links, expiresIn: READ_SECS })
}

async function listFolder(res, cfg, owner, body, token) {
  const prefix = String(body.prefix || '').replace(/\/$/, '')
  // a folder is a session's (<owner>/<session>) or its frames (<owner>/<session>-slides)
  const m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})(-slides)?$/i.exec(prefix)
  if (!m || !UUID.test(m[1]) || !UUID.test(m[2])) return res.status(400).json({ error: 'Bad prefix.' })
  const probe = m[3] ? `${prefix}/x.jpg` : `${prefix}/index.json`
  if (!(await allow(owner, [probe], false, token))) return res.status(403).json({ error: 'Not allowed.' })
  const objects = await r2List(cfg, prefix + '/')
  return res.status(200).json({
    objects: objects.map((o) => ({ name: o.key.slice(prefix.length + 1), size: o.size }))
  })
}

/** May this asker watch this owner's session? The rule every read follows. */
async function mayWatch(owner, token, ownerId, sessionId) {
  if (owner && owner === ownerId.toLowerCase()) return true
  return (await isShared(ownerId, sessionId)) || (await memberCanWatch(sessionId, token))
}

/**
 * Everything needed to play one recording, in a single request: whether the
 * whole file exists, the parts in order, a link to each, and (for phones) a
 * playlist address carrying a short-lived ticket rather than a sign-in token.
 */
async function mediaLinks(res, cfg, owner, body, token) {
  const ownerId = String(body.owner || '').toLowerCase()
  const sessionId = String(body.session || '').toLowerCase()
  if (!UUID.test(ownerId) || !UUID.test(sessionId)) return res.status(400).json({ error: 'Bad session.' })
  if (!(await mayWatch(owner, token, ownerId, sessionId))) return res.status(403).json({ error: 'Not allowed.' })

  // One listing catches both shapes, because the whole file and the folder of
  // parts share a prefix: <owner>/<session>.webm and <owner>/<session>/part-*
  const objects = await r2List(cfg, `${ownerId}/${sessionId}`)
  const wholeKey = `${ownerId}/${sessionId}.webm`
  const wholeObj = objects.find((o) => o.key === wholeKey)
  const whole = wholeObj ? presign(cfg, 'GET', wholeKey, READ_SECS) : null
  const parts = objects
    .filter((o) => o.key.startsWith(`${ownerId}/${sessionId}/`) && /\/part-\d+\.webm$/.test(o.key))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((o) => ({ url: presign(cfg, 'GET', o.key, READ_SECS), size: o.size, n: Number(/part-(\d+)\.webm$/.exec(o.key)[1]) }))
  const indexed = objects.some((o) => o.key === `${ownerId}/${sessionId}/index.json`)
  const ticket = makeTicket(ownerId, sessionId, READ_SECS)
  return res.status(200).json({
    where: whole || parts.length > 0 ? 'r2' : 'none',
    whole,
    wholeSize: wholeObj ? wholeObj.size : undefined,
    parts: parts.map(({ url, size }) => ({ url, size })),
    // the piece numbers, so a player can see a gap rather than skip over it
    partNumbers: parts.map((p) => p.n),
    hls: indexed && parts.length > 0 && ticket ? `/api/storage?op=hls&owner=${ownerId}&session=${sessionId}&ticket=${encodeURIComponent(ticket)}` : null,
    expiresIn: READ_SECS
  })
}

/**
 * A recording as a playlist, for phones.
 *
 * Safari plays HLS natively and starts within a second or two: it fetches a
 * small playlist, then the recording piece by piece. The pieces are the
 * recorder's own fragments, addressed by byte range inside the parts already
 * in R2 — nothing is copied, and no video passes through here.
 *
 *   GET /api/storage?op=hls&owner=<uuid>&session=<uuid>&ticket=<ticket>
 *
 * The ticket comes from `media`, which has already decided the asker may
 * watch. A signed-in page may send its token in the Authorization header
 * instead; a token in the URL is no longer accepted.
 */
async function playlist(req, res, cfg, q) {
  if (!cfg) return res.status(501).json({ error: 'not-configured' })
  const owner = String(q.get('owner') || '').toLowerCase()
  const session = String(q.get('session') || '').toLowerCase()
  if (!UUID.test(owner) || !UUID.test(session)) return res.status(400).json({ error: 'Bad session.' })
  let ok = checkTicket(String(q.get('ticket') || ''), owner, session)
  if (!ok) {
    const token = tokenOf(req)
    const who = token ? await userOf(token) : null
    if (who === UNCHECKED) return res.status(503).json({ error: 'Try again in a moment.' })
    ok = await mayWatch(who ? who.id.toLowerCase() : null, token, owner, session)
  }
  if (!ok) return res.status(403).json({ error: 'Not allowed.' })

  const prefix = `${owner}/${session}`
  const ix = await r2Fetch(cfg, 'GET', `${prefix}/index.json`)
  if (!ix.ok) return res.status(404).json({ error: 'No index for this recording yet.' })
  let index
  try {
    index = await ix.json()
  } catch {
    return res.status(500).json({ error: 'The index could not be read.' })
  }
  // The index is written by the owner's browser: every name and number in it
  // is checked before it goes into a playlist anyone might receive.
  const parts = Array.isArray(index.parts) ? index.parts : []
  const frags = Array.isArray(index.frags) ? index.frags : []
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (
    parts.length === 0 ||
    parts.length > 20000 ||
    frags.length === 0 ||
    frags.length > 200000 ||
    !num(index.init) ||
    !parts.every((p) => p && typeof p.name === 'string' && /^part-\d{4,6}\.webm$/.test(p.name) && num(p.size)) ||
    !frags.every((f) => Array.isArray(f) && f.length >= 3 && num(f[0]) && num(f[1]) && num(f[2]))
  ) {
    return res.status(500).json({ error: 'The index is incomplete.' })
  }
  // the index must describe the parts as they are now
  const listed = new Map((await r2List(cfg, `${prefix}/`)).map((o) => [o.key.slice(prefix.length + 1), o.size]))
  if (!parts.every((p) => listed.get(p.name) === Number(p.size))) return res.status(409).json({ error: 'The recording changed since it was indexed.' })

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

  const lines = []
  let target = 1
  for (let k = 0; k < frags.length; k++) {
    const [offset, size, start] = frags[k]
    const next = k + 1 < frags.length ? frags[k + 1][2] : num(index.duration) ? index.duration : start + 3
    const dur = Math.max(0.05, next - start)
    if (dur > target) target = dur
    const where = locate(offset, size)
    if (!where) return res.status(500).json({ error: 'A fragment straddles parts.' })
    lines.push(`#EXTINF:${dur.toFixed(3)},`, `#EXT-X-BYTERANGE:${Math.floor(size)}@${Math.floor(where.within)}`, links[where.i])
  }
  const out = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-TARGETDURATION:${Math.ceil(target)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="${links[initAt.i]}",BYTERANGE="${Math.floor(index.init)}@${Math.floor(initAt.within)}"`,
    ...lines,
    '#EXT-X-ENDLIST'
  ]
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Cache-Control', 'private, max-age=600')
  return res.status(200).send(out.join('\n') + '\n')
}

/**
 * How much of Cloudflare the recordings take, for the owners' dashboard.
 * Only someone the database lists as an admin is answered.
 */
async function usage(res, cfg, token) {
  if (!token) return res.status(401).json({ error: 'Sign in first.' })
  let admin = false
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/is_admin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000)
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
      const s = keyShape(o.key)
      if (s && s.kind === 'whole') recordings++
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
async function mine(res, cfg, owner) {
  if (!owner) return res.status(401).json({ error: 'Sign in first.' })
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json(await footprint(cfg, owner))
}

async function removeKeys(res, cfg, owner, body) {
  if (!owner) return res.status(401).json({ error: 'Sign in first.' })
  const keys = (Array.isArray(body.keys) ? body.keys : []).map(String)
  if (!(await allow(owner, keys, true))) return res.status(403).json({ error: 'Not allowed.' })
  const failed = []
  for (let i = 0; i < keys.length; i += 20) {
    await Promise.all(
      keys.slice(i, i + 20).map(async (k) => {
        const r = await r2Fetch(cfg, 'DELETE', k).catch(() => null)
        // R2 answers 204 for a delete, and for a key that was already gone
        if (!r || (!r.ok && r.status !== 404)) failed.push(k)
      })
    )
  }
  mineCache.delete(owner)
  return res.status(failed.length ? 207 : 200).json({ removed: keys.length - failed.length, failed })
}
