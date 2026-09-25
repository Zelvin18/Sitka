// Who is asking, where the site is, and how long a request may take.
//
// Every route that spends money or reads someone's data starts here. The
// sign-in token is checked with the account service (never just decoded), a
// token that could not be checked at all is told apart from a bad one, and
// nothing about the request is kept between requests: one function instance
// serves several people at once.

export const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
export const SUPA_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
export const SUPA_SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * The site's own address, for links and for a route that calls another.
 * Never taken from the request's Host header, which a caller can set.
 * A preview deployment knows its own address from Vercel.
 */
export const SITE_ORIGIN = (
  process.env.SITE_ORIGIN ||
  (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
  'https://sitcaai.vercel.app'
).replace(/\/+$/, '')

/** The origins allowed to call the routes from a browser: the site, and the extension. */
export const ALLOWED_ORIGINS = new Set(
  [SITE_ORIGIN, 'https://sitcaai.vercel.app', 'chrome-extension://hgpdgndcbiecihpbobnapoeiboceejjb', ...(process.env.EXTRA_ORIGINS || '').split(/[,\s]+/)]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
)

/** the answer when the account service itself could not be asked */
export const UNCHECKED = Symbol('unchecked')

export function tokenOf(req) {
  return String((req.headers && req.headers.authorization) || '')
    .replace(/^Bearer\s+/i, '')
    .trim()
}

/**
 * The signed-in person behind a token: { id, email }, null for a token that
 * is no good, or UNCHECKED when the account service could not be reached
 * (asked twice first). A route answers UNCHECKED with 503, never with "no".
 */
export async function userOf(token) {
  if (!token || !SUPA_URL || !SUPA_ANON) return null
  let reached = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON },
        signal: AbortSignal.timeout(6000)
      })
      reached = true
      if (r.status >= 500) {
        reached = false
        continue
      }
      if (!r.ok) return null
      const j = await r.json().catch(() => null)
      return j && typeof j.id === 'string' ? { id: j.id, email: typeof j.email === 'string' ? j.email : '' } : null
    } catch {
      /* could not be reached: once more */
    }
  }
  return reached ? null : UNCHECKED
}

/**
 * The signed-in person, or an answer already sent: 401 for no or a bad
 * sign-in, 503 when it could not be checked. Use: `const me = await
 * requireUser(req, res); if (!me) return`.
 */
export async function requireUser(req, res) {
  const u = await userOf(tokenOf(req))
  if (u === UNCHECKED) {
    res.status(503).json({ error: 'Could not check who you are just now. Try again in a moment.' })
    return null
  }
  if (!u) {
    res.status(401).json({ error: 'Sign in first.' })
    return null
  }
  return u
}

/** The caller's address, for limits on what anyone may call. */
export function ipOf(req) {
  return String((req.headers && req.headers['x-forwarded-for']) || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 64)
}

/**
 * One deadline for the whole request, inside the function's 60 seconds.
 * `left()` is what remains; `signal(cap)` aborts at the deadline or after
 * `cap` ms, whichever is first, so a chain of calls can never outrun it.
 */
export function deadline(totalMs = 55000) {
  const until = Date.now() + totalMs
  return {
    left: () => Math.max(0, until - Date.now()),
    expired: () => Date.now() >= until,
    signal: (cap = Infinity) => AbortSignal.timeout(Math.max(1, Math.min(cap, until - Date.now())))
  }
}

/** A short random id for a request, sent with a generic error so a report can be matched to the logs. */
export function requestId() {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * A failure said generically to the caller, and in full to the logs and the
 * operations view. Provider errors, bucket names and stack traces stay here.
 */
export function failSafely(res, err, where, status = 500) {
  const id = requestId()
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[${where}] ${id}`, detail)
  void reportServerError(where, `${id} ${detail}`)
  if (!res.headersSent) res.status(status).json({ error: 'Something went wrong on our side. Try again in a moment.', ref: id })
}

/**
 * A server fault, written where the app's own faults go (client_errors), so
 * the operations view and the alert see it. Best effort; never throws.
 */
export async function reportServerError(where, message) {
  if (!SUPA_URL || !SUPA_SERVICE) return
  try {
    await fetch(`${SUPA_URL}/rest/v1/client_errors`, {
      method: 'POST',
      headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ page: `server:${String(where).slice(0, 40)}`, message: String(message).slice(0, 2000), ua: 'server' }),
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    /* the log line above is the record */
  }
}

/** CORS for the routes a browser on another origin may call: only the site and the extension. */
export function allowOrigin(req, res) {
  const origin = String((req.headers && req.headers.origin) || '')
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }
}

/** A key the caller supplied that looks like a real one: never a placeholder, never a stray word. */
export function realKey(v) {
  const s = String(v || '').replace(/[^\x21-\x7e]/g, '')
  if (s.length < 20 || s === 'platform-managed') return ''
  return s
}
