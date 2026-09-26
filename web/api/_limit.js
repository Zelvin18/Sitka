// Limits on what one caller may do in a minute and an hour.
//
// The count lives in the database (public.sitka_rate_hit, written only with
// the service key), so it holds across function instances and cold starts.
// When the database cannot be asked, a per-instance count in memory stands
// in, so a blip never switches limits off entirely.
//
// The key is always chosen here, never by the caller: a route, then a
// signed-in user's id, an event's id, or the caller's address.

import { SUPA_URL, SUPA_SERVICE, ipOf } from './_auth.js'

const memory = new Map()

function memoryHit(key, perMinute, perHour) {
  const now = Date.now()
  const hits = (memory.get(key) || []).filter((t) => now - t < 3600000)
  hits.push(now)
  memory.delete(key)
  memory.set(key, hits)
  // Past 5,000 keys the oldest go, not all of them: clearing everything let
  // a flood of made-up keys wipe every count on the instance.
  if (memory.size > 5000) {
    let n = 1000
    for (const k of memory.keys()) {
      if (n-- <= 0) break
      memory.delete(k)
    }
  }
  const lastMinute = hits.filter((t) => now - t < 60000).length
  return hits.length > perHour || lastMinute > perMinute
}

const hasDb = Boolean(SUPA_URL && SUPA_SERVICE)
/** when the database last said it has no counter: asked again after five minutes, not never */
let noCounterSince = 0

/**
 * True when `key` is over its limit. Counts this call either way.
 * perMinute / perHour: how many calls are allowed in each window.
 */
export async function overLimitKey(key, perMinute, perHour) {
  const k = String(key).slice(0, 160)
  if (hasDb && Date.now() - noCounterSince > 300000) {
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_rate_hit`, {
        method: 'POST',
        headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_key: k, p_minute: perMinute, p_hour: perHour }),
        signal: AbortSignal.timeout(2500)
      })
      if (r.status === 404) {
        // the database has not got the function yet: memory for a while
        noCounterSince = Date.now()
      } else if (r.ok) {
        const over = await r.json().catch(() => null)
        // the memory count is kept too, so an instance that loses the database mid-flood still holds
        const local = memoryHit(k, perMinute, perHour)
        // an answer that is not a plain yes or no is not taken as "no": memory decides
        return over === true || (over !== false && local)
      }
    } catch {
      /* the database blinked: memory for this one */
    }
  }
  return memoryHit(k, perMinute, perHour)
}

/** The old per-address form, for routes anyone may call. The key is the address alone. */
export async function overLimit(req, perMinute, perHour, route = 'any') {
  return overLimitKey(`${route}:ip:${ipOf(req)}`, perMinute, perHour)
}
