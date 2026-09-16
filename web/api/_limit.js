// A small per-address limiter for the routes anyone can call without a key
// (speech, transcription): a burst is allowed, a flood is not. Memory only,
// per function instance, which is enough to blunt abuse without a store.
const log = new Map()

export function overLimit(req, perMinute, perHour) {
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim()
  const now = Date.now()
  const hits = (log.get(ip) || []).filter((t) => now - t < 3600000)
  hits.push(now)
  log.set(ip, hits)
  if (log.size > 5000) log.clear()
  const lastMinute = hits.filter((t) => now - t < 60000).length
  return hits.length > perHour || lastMinute > perMinute
}
