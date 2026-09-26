/**
 * A signal that aborts after `ms`. AbortSignal.timeout does this, but iPhones
 * before iOS 16 lack it, and calling it there throws before the request is
 * even made: every call that used it failed on those phones.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const c = new AbortController()
  setTimeout(() => c.abort(), ms)
  return c.signal
}
