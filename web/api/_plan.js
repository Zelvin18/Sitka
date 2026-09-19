// What an account's plan allows, checked before the server does work for it.
//
// The app sends the person's sign-in token; this asks the database what they
// have used this month (public.my_usage, their own rows only) and compares
// it with the plan. A session already running is never cut: the hours check
// leaves room for one more to finish. The limits mirror src/shared/plans.ts;
// a change there is a change here.

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

/** hours, questions and storage a month; 0 = no limit */
const LIMITS = {
  free: { hours: 5, asks: 60, storageGb: 3 },
  plus: { hours: 40, asks: 600, storageGb: 30 },
  pro: { hours: 150, asks: 0, storageGb: 150 },
  institution: { hours: 0, asks: 0, storageGb: 0 }
}
const NAMES = { free: 'Free', plus: 'Plus', pro: 'Pro', institution: 'Institution' }
/** a running session may finish past the line */
const HOURS_GRACE = 2

const cache = new Map()

/** This month's use behind a token; null when it cannot be learned (then nothing is refused). */
export async function usageOf(token) {
  if (!token || !SUPA_URL || !SUPA_ANON) return null
  const hit = cache.get(token)
  if (hit && hit.until > Date.now()) return hit.usage
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/my_usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON, 'Content-Type': 'application/json' },
      body: '{}'
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
 * { ok: true } or { ok: false, message } to send back with status 402.
 */
export async function allow(token, meter) {
  const u = await usageOf(token)
  if (!u) return { ok: true }
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

export function tokenOf(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
}
