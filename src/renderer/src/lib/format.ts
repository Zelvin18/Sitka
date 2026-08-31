export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** "1:02:37", "12:37" or "0:41" -> seconds */
export function parseTimestamp(ts: string): number | null {
  const parts = ts.split(':').map((p) => Number(p))
  if (parts.some((n) => Number.isNaN(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

export function formatDate(epochMs: number): string {
  const d = new Date(epochMs)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today at ${time}`
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 1) return '<1 min'
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

export function videoUrl(sessionId: string): string {
  return `sitka://sessions/${sessionId}/video.webm`
}

const CITE_BODY = '((?:[a-fA-F0-9]{6,}@)?\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[-–—]\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)?)'

/**
 * Models occasionally write citations with fullwidth brackets (【…】) or single
 * brackets instead of the required [[…]]. Repair every variant so the chips
 * always render and stay clickable.
 */
export function normalizeCitations(text: string): string {
  return text
    .replace(new RegExp(`【\\s*${CITE_BODY}\\s*】`, 'g'), '[[$1]]')
    .replace(new RegExp(`(?<!\\[)\\[\\s*${CITE_BODY}\\s*\\](?!\\])`, 'g'), '[[$1]]')
}
