// The recap and event pages, served with the session written into them.
//
// A link pasted into WhatsApp, iMessage, Slack or a mail is fetched before it
// is shown, by something that runs no code and reads only the page's own
// title, description and preview image. The recap page is one file for every
// session, so on its own it could only ever say "Sitka". This serves that same
// file with the session's title, a line of its summary and a frame of its
// recording written into the head, so a link says where it goes.
//
// Nothing else changes: the page's own code still runs and draws the recap.

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

const UUID = /^[0-9a-fA-F-]{16,64}$/
const esc = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export default async function handler(req, res) {
  const kind = String(req.query.kind || 'recap')
  const id = String(req.query.id || '')
  const file = kind === 'event' ? '/event.html' : kind === 'recap1' ? '/replay.html' : '/replay2.html'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const origin = `${proto}://${host}`

  // the page itself, from this same deployment
  let html = ''
  try {
    const r = await fetch(origin + file, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`page ${r.status}`)
    html = await r.text()
  } catch (err) {
    res.status(502).setHeader('content-type', 'text/plain')
    return res.end('The page could not be fetched: ' + String((err && err.message) || err))
  }

  const info = UUID.test(id) ? await describe(kind, id) : null
  const title = info?.title || (kind === 'event' ? 'A live event on Sitka' : 'A session recap on Sitka')
  const description =
    info?.description ||
    (kind === 'event'
      ? 'Join live: captions in your language, ask questions privately, and keep the recap.'
      : 'The recording, the moments that mattered, and Sitka to ask about any of it.')
  const image = info?.hasThumb ? `${origin}/api/thumb?id=${encodeURIComponent(id)}` : `${origin}/og-default.png`
  const url = `${origin}/${kind === 'event' ? 'e' : 'r'}/${encodeURIComponent(id)}`

  const meta = [
    `<title>${esc(title)} — Sitka</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:type" content="${kind === 'event' ? 'website' : 'video.other'}">`,
    `<meta property="og:site_name" content="Sitka">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="${info?.hasThumb ? 480 : 1200}">`,
    `<meta property="og:image:height" content="${info?.hasThumb ? 270 : 630}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`
  ].join('\n')

  // the page's own title and any earlier description give way, and the
  // rest goes straight after <head>, where the fetchers look first
  html = html.replace(/<title>[^<]*<\/title>/i, '')
  html = html.replace(/<meta\s+(?:name="description"|property="og:[^"]*"|name="twitter:[^"]*")[^>]*>\s*/gi, '')
  html = html.replace(/<head>/i, '<head>\n' + meta)

  res.setHeader('content-type', 'text/html; charset=utf-8')
  // shared links are fetched by many phones at once: the edge keeps a copy for
  // a couple of minutes, then quietly refreshes it
  res.setHeader('cache-control', 'public, s-maxage=120, stale-while-revalidate=600')
  res.status(200).end(html)
}

/** The words for one link: title, a line, and whether a picture exists. */
async function describe(kind, id) {
  if (!SUPA_URL || !SUPA_ANON) return null
  const headers = { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` }
  const get = async (path) => {
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers, signal: AbortSignal.timeout(6000) })
      if (!r.ok) return null
      const rows = await r.json()
      return Array.isArray(rows) && rows.length ? rows[0] : null
    } catch {
      return null
    }
  }
  const line = (s) => {
    const t = String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
    return t.length > 180 ? t.slice(0, 177).replace(/\s+\S*$/, '') + '…' : t
  }
  const minutes = (ms) => {
    const m = Math.round(Number(ms || 0) / 60000)
    return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : m > 0 ? `${m} min` : ''
  }
  if (kind === 'event') {
    const ev = await get(`events?id=eq.${id}&select=title,status,starts_at,replay`)
    if (!ev) return null
    const rp = ev.replay || {}
    if (rp.enabled) {
      return {
        title: rp.title || ev.title,
        description: line(rp.summary) || 'The recording and recap of this event, with Sitka to ask.',
        hasThumb: false
      }
    }
    const when = ev.starts_at
      ? new Date(ev.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : ''
    return {
      title: ev.title,
      description:
        ev.status === 'live'
          ? 'Live now on Sitka. Tap to join: captions in your language, questions answered privately.'
          : when
            ? `${when}. Join on Sitka for live captions and your own questions.`
            : 'Join on Sitka for live captions and your own questions.',
      hasThumb: false
    }
  }
  // the picture column arrives with supabase/wave14.sql; before that script
  // has run the words are still served, without a picture
  const rc =
    (await get(`recaps?id=eq.${id}&enabled=is.true&select=title,summary,duration_ms,thumb`)) ||
    (await get(`recaps?id=eq.${id}&enabled=is.true&select=title,summary,duration_ms`))
  if (!rc) return null
  const len = minutes(rc.duration_ms)
  return {
    title: rc.title || 'Session recap',
    description: line(rc.summary) || (len ? `A ${len} session, with the recording and Sitka to ask.` : 'The recording and recap, with Sitka to ask.'),
    hasThumb: Boolean(rc.thumb && String(rc.thumb).startsWith('data:image/'))
  }
}
