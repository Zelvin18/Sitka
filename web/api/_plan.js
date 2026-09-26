// What an account's plan allows, checked before the server does work for it.
//
// The app sends the person's sign-in token; this asks the database what they
// have used this month (public.my_usage, their own rows only) and compares
// it with the plan. A session already running is never cut: the hours check
// leaves room for one more to finish. The limits mirror src/shared/plans.ts;
// a change there is a change here.

import { SUPA_URL, SUPA_ANON, SUPA_SERVICE } from './_auth.js'

/**
 * hours, questions and storage a month; 0 = no limit. `aiChars`: the text
 * the app may send the platform's AI in a month (a picture counts as 6,000),
 * about what a month of the plan's hours uses with room to spare. It is what
 * bounds the bill: every platform-paid AI call counts, whatever it says it is.
 */
const LIMITS = {
  free: { hours: 5, asks: 60, storageGb: 3, aiChars: 12_000_000 },
  plus: { hours: 40, asks: 600, storageGb: 30, aiChars: 90_000_000 },
  pro: { hours: 150, asks: 0, storageGb: 150, aiChars: 320_000_000 },
  institution: { hours: 0, asks: 0, storageGb: 0, aiChars: 0 }
}
const NAMES = { free: 'Free', plus: 'Plus', pro: 'Pro', institution: 'Institution' }
/** a running session may finish past the line */
const HOURS_GRACE = 2

const cache = new Map()

/** This month's use behind a token; null when it cannot be learned. */
export async function usageOf(token, fresh = false) {
  if (!token || !SUPA_URL || !SUPA_ANON) return null
  const hit = cache.get(token)
  if (!fresh && hit && hit.until > Date.now()) return hit.usage
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/my_usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000)
    })
    if (!r.ok) return null
    const usage = await r.json()
    if (!usage || typeof usage !== 'object') return null
    if (cache.size > 2000) cache.clear()
    cache.set(token, { usage, until: Date.now() + 45000 })
    return usage
  } catch {
    return null
  }
}

/** The next step up, for the message. */
function upgradeLine(plan) {
  if (plan === 'free') return 'Plus gives you 40 hours, 600 questions and a year of storage.'
  if (plan === 'plus') return 'Pro gives you 150 hours, unlimited questions and recordings kept for good.'
  return 'Talk to us about more.'
}

/**
 * May this account do one more of `meter` ('hours' | 'asks')? Answers
 * { ok: true }, or { ok: false, message } to send back with status 402, or
 * { ok: false, transient: true, message } (503) when the plan cannot be
 * checked just now.
 *
 * A question is refused when the plan cannot be checked (it can be asked
 * again in a moment). Transcription is not: a lecture's words are never
 * dropped because the database blinked, and the per-person limit on the
 * route still caps what one account can spend.
 */
export async function allow(token, meter) {
  let u = await usageOf(token)
  if (!u) u = await usageOf(token, true)
  if (!u) {
    if (meter === 'hours') return { ok: true }
    return { ok: false, transient: true, message: 'Your plan could not be checked just now. Ask again in a moment.' }
  }
  const plan = LIMITS[u.plan] ? u.plan : 'free'
  const lim = LIMITS[plan]
  if (meter === 'hours') {
    if (lim.hours > 0 && Number(u.hours) >= lim.hours + HOURS_GRACE) {
      return { ok: false, plan, message: `You’ve used your ${lim.hours} hours of recording for this month. ${upgradeLine(plan)}` }
    }
  } else if (meter === 'asks') {
    if (lim.asks > 0 && Number(u.asks) >= lim.asks) {
      return { ok: false, plan, message: `You’ve asked Sitca ${lim.asks} questions this month, the ${NAMES[plan]} plan’s share. ${upgradeLine(plan)}` }
    }
  }
  return { ok: true }
}

// ---------- the AI allowance, counted by the server ----------
// Read from usage_meter with the service key (no database change needed),
// afresh for every call: one small read beside an AI call that takes
// seconds, and no stale count for a burst of calls to slip in on.
function monthStart() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}
/** This month's count of one kind on the server's meter; null when it cannot be read. */
async function usedThisMonth(userId, kind) {
  if (!SUPA_URL || !SUPA_SERVICE) return null
  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/usage_meter?select=n&user_id=eq.${encodeURIComponent(userId)}&kind=eq.${encodeURIComponent(kind)}&day=gte.${monthStart()}`,
      { headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` }, signal: AbortSignal.timeout(4000) }
    )
    if (!r.ok) return null
    const rows = await r.json()
    return (Array.isArray(rows) ? rows : []).reduce((n, row) => n + Number(row.n || 0), 0)
  } catch {
    return null
  }
}

/**
 * May this account send `chars` more to the platform's AI this month? Every
 * platform-paid call asks, whatever kind it says it is. Refused (503) when
 * it cannot be checked: the AI is the one thing here that costs by the call.
 */
export async function allowAi(token, userId, chars) {
  let u = await usageOf(token)
  if (!u) u = await usageOf(token, true)
  const used = await usedThisMonth(userId, 'aic')
  if (!u || used === null) {
    return { ok: false, transient: true, message: 'Your plan could not be checked just now. Try again in a moment.' }
  }
  const plan = LIMITS[u.plan] ? u.plan : 'free'
  const lim = LIMITS[plan].aiChars
  if (lim > 0 && used + chars > lim) {
    return {
      ok: false,
      plan,
      message: `You’ve used this month’s AI allowance on the ${NAMES[plan]} plan. ${upgradeLine(plan)}`
    }
  }
  return { ok: true }
}

/**
 * May this account have a recording listened to again (voices told apart)?
 * The costliest thing Sitca does, so it has its own allowance: as many hours
 * a month as the plan records, counted by what the service actually heard.
 */
export async function allowListen(token, userId) {
  let u = await usageOf(token)
  if (!u) u = await usageOf(token, true)
  const used = await usedThisMonth(userId, 'dg')
  if (!u || used === null) {
    return { ok: false, transient: true, message: 'Your plan could not be checked just now. Try again in a moment.' }
  }
  const plan = LIMITS[u.plan] ? u.plan : 'free'
  const hours = LIMITS[plan].hours
  if (hours > 0 && used >= hours * 3600) {
    return { ok: false, plan, message: `You’ve had ${hours} hours of recordings listened to again this month, the ${NAMES[plan]} plan’s share. ${upgradeLine(plan)}` }
  }
  return { ok: true }
}

/**
 * The server's own count of what costs money, in a table only it writes
 * (public.usage_meter): 'ask' for a question to the AI, 'ai' for the app's
 * other AI work, 'aic' for the characters sent to the AI, 'stt' for seconds
 * of audio transcribed, 'dg' for seconds of recording listened to again. Never throws; a
 * count that cannot be written is not worth failing the request over.
 */
export async function meter(userId, kind, amount = 1) {
  if (!userId || !SUPA_URL || !SUPA_SERVICE || !(amount > 0)) return
  try {
    await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_meter`, {
      method: 'POST',
      headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: userId, p_kind: kind, p_amount: amount }),
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    /* counted next time */
  }
}

export function tokenOf(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
}
