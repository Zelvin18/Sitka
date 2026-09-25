// A frame of the recording, as the picture a shared link shows.
//
// The library keeps one small JPEG per session, taken a second into the
// recording. When a recap is shared that picture is copied onto the recap
// (supabase/legacy/wave14.sql), and this hands it out as a plain image for the
// messaging apps that fetch a link's preview. Only shared recaps answer.

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const UUID = /^[0-9a-fA-F-]{16,64}$/

export default async function handler(req, res) {
  const id = String(req.query.id || '')
  if (!UUID.test(id) || !SUPA_URL || !SUPA_ANON) return res.status(404).end()
  try {
    // one recap, by its id (supabase/migrations/20260925_00_recap_privacy.sql); the table as it was
    // before that script has run
    const headers = { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
    let thumb = ''
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_recap?p_id=${id}`, { headers, signal: AbortSignal.timeout(6000) })
    if (r.ok) {
      const row = await r.json()
      thumb = row && typeof row === 'object' ? String(row.thumb || '') : ''
    } else if (r.status === 404) {
      const old = await fetch(`${SUPA_URL}/rest/v1/recaps?id=eq.${id}&enabled=is.true&select=thumb`, { headers, signal: AbortSignal.timeout(6000) })
      const rows = old.ok ? await old.json() : []
      thumb = Array.isArray(rows) && rows[0] ? String(rows[0].thumb || '') : ''
    }
    const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(thumb)
    if (!m) {
      res.setHeader('location', '/og-default.png')
      return res.status(302).end()
    }
    const bytes = Buffer.from(m[2], 'base64')
    res.setHeader('content-type', m[1])
    res.setHeader('content-length', String(bytes.length))
    res.setHeader('cache-control', 'public, s-maxage=600, stale-while-revalidate=86400')
    return res.status(200).end(bytes)
  } catch {
    res.setHeader('location', '/og-default.png')
    return res.status(302).end()
  }
}
