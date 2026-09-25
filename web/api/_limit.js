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
  memory.set(key, hits)
  if (memory.size > 5000) memory.clear()
  const lastMinute = hits.filter((t) => now - t < 60000).length
  return hits.length > perHour || lastMinute > perMinute
}

let durable = Boolean(SUPA_URL && SUPA_SERVICE)

/**
 * True when `key` is over its limit. Counts this call either way.
 * perMinute / perHour: how many calls are allowed in each window.
 */
export async function overLimitKey(key, perMinute, perHour) {
  const k = String(key).slice(0, 160)
  if (durable) {
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_rate_hit`, {
        method: 'POST',
        headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_key: k, p_minute: perMinute, p_hour: perHour }),
        signal: AbortSignal.timeout(2500)
      })
      if (r.status === 404) {
        // the database has not got the function yet: memory from now on
        durable = false
      } else if (r.ok) {
        const over = await r.json()
        // the memory count is kept too, so an instance that loses the database mid-flood still holds
        memoryHit(k, perMinute, perHour)
        return over === true
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
