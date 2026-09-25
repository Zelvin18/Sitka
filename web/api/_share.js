// Whose recording may be opened by whom. Shared by the storage and Drive routes.
//
//   the owner may read and write anything under their own folder;
//   anyone may read a session whose recap its owner has shared, or whose event
//   replay is on — but only from that owner's own folder, and only when the
//   person who shared it is the person who recorded it;
//   a member of a course may watch the sessions filed in it;
//   nobody may read anything else.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { SUPA_URL, SUPA_ANON, SUPA_SERVICE } from './_auth.js'

export const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const shareCache = new Map()
/**
 * Is this owner's session shared? The database answers (sitka_shared_owner);
 * until that function exists the same two questions are asked of the tables,
 * with the owner in both.
 */
export async function isShared(ownerId, sessionId) {
  if (!UUID.test(ownerId) || !UUID.test(sessionId) || !SUPA_URL) return false
  const who = ownerId.toLowerCase()
  const cacheKey = `${who}/${sessionId}`
  const hit = shareCache.get(cacheKey)
  if (hit && hit.until > Date.now()) return hit.ok
  const headers = { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
  const any = async (path) => {
    const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: SUPA_SERVICE ? { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` } : headers, signal: AbortSignal.timeout(5000) })
    const rows = r.ok ? await r.json().catch(() => []) : []
    return Array.isArray(rows) && rows.length > 0
  }
  let ok = false
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_shared_owner?p_session=${sessionId}`, { headers, signal: AbortSignal.timeout(5000) })
    if (r.ok) {
      const sharer = await r.json().catch(() => null)
      ok = typeof sharer === 'string' && sharer.toLowerCase() === who
    } else if (r.status === 404) {
      ok =
        (await any(`recaps?id=eq.${sessionId}&owner=eq.${who}&enabled=is.true&select=id&limit=1`)) ||
        (await any(`events?session_id=eq.${sessionId}&owner=eq.${who}&replay->>enabled=eq.true&select=id&limit=1`))
    }
  } catch {
    ok = false
  }
  if (shareCache.size > 2000) shareCache.clear()
  shareCache.set(cacheKey, { ok, until: Date.now() + (ok ? 60000 : 5000) })
  return ok
}

/** Who shared this session, when it is shared (the folder to open); null otherwise. */
export async function sharerOf(sessionId) {
  if (!UUID.test(sessionId) || !SUPA_URL) return null
  const headers = { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_shared_owner?p_session=${sessionId}`, { headers, signal: AbortSignal.timeout(5000) })
    if (r.ok) {
      const sharer = await r.json().catch(() => null)
      return typeof sharer === 'string' && UUID.test(sharer) ? sharer.toLowerCase() : null
    }
  } catch {
    /* not shared as far as can be told */
  }
  return null
}

/**
 * A member of the course a session is filed in may watch it. The database
 * decides, as the person: their token, their membership. The token is passed
 * in, never kept between requests.
 */
export async function memberCanWatch(sessionId, token) {
  if (!token || !UUID.test(sessionId) || !SUPA_URL) return false
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_can_watch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: sessionId }),
      signal: AbortSignal.timeout(5000)
    })
    return r.ok && (await r.json()) === true
  } catch {
    return false
  }
}

/**
 * The files a recording may be made of, and nothing else. Keys are
 *   <owner>/<session>.webm                      the whole file
 *   <owner>/<session>/part-0000.webm            a piece
 *   <owner>/<session>/index.json                the playlist index
 *   <owner>/<session>/init.bin                  the recording's header, kept on its own
 *   <owner>/<session>/manifest.json             which pieces exist
 *   <owner>/<session>-slides/<name>             a frame read off the screen
 * Returns { owner, session, kind } or null.
 */
export function keyShape(key) {
  const k = String(key)
  let m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.webm$/i.exec(k)
  if (m && UUID.test(m[1]) && UUID.test(m[2])) return { owner: m[1].toLowerCase(), session: m[2].toLowerCase(), kind: 'whole' }
  m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/(part-\d{4,6}\.webm|index\.json|init\.bin|manifest\.json)$/i.exec(k)
  if (m && UUID.test(m[1]) && UUID.test(m[2])) return { owner: m[1].toLowerCase(), session: m[2].toLowerCase(), kind: m[3].startsWith('part-') ? 'part' : m[3].replace(/\..*$/, '') }
  m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})-slides\/[\w.-]{1,80}$/i.exec(k)
  if (m && UUID.test(m[1]) && UUID.test(m[2])) return { owner: m[1].toLowerCase(), session: m[2].toLowerCase(), kind: 'slide' }
  return null
}

// ---------- a playback ticket: a short-lived pass for one recording ----------
// A phone's own player fetches the playlist by its URL alone, so the pass
// must be in the URL. It names one recording and an expiry and is signed
// with a server secret; it is never the person's sign-in token.

const ticketKey = () => process.env.PLAYBACK_SECRET || process.env.R2_SECRET_ACCESS_KEY || process.env.SUPABASE_SERVICE_KEY || ''

export function makeTicket(owner, session, secs = 7200) {
  const key = ticketKey()
  if (!key) return ''
  const exp = Math.floor(Date.now() / 1000) + secs
  const body = `${owner.toLowerCase()}.${session.toLowerCase()}.${exp}`
  const sig = createHmac('sha256', key).update(body).digest('base64url')
  return `${exp}.${sig}`
}

export function checkTicket(ticket, owner, session) {
  const key = ticketKey()
  const [expStr, sig] = String(ticket || '').split('.')
  const exp = Number(expStr)
  if (!key || !sig || !Number.isFinite(exp) || exp * 1000 < Date.now()) return false
  const want = createHmac('sha256', key).update(`${owner.toLowerCase()}.${session.toLowerCase()}.${exp}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}
