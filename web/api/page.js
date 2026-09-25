// The recap and event pages, served with the session written into them.
//
// A link pasted into WhatsApp, iMessage, Slack or a mail is fetched before it
// is shown, by something that runs no code and reads only the page's own
// title, description and preview image. The recap page is one file for every
// session, so on its own it could only ever say "Sitca". This serves that same
// file with the session's title, a line of its summary and a frame of its
// recording written into the head, so a link says where it goes.
//
// Nothing else changes: the page's own code still runs and draws the recap.

import { SUPA_URL, SUPA_ANON, SUPA_SERVICE, SITE_ORIGIN } from './_auth.js'

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
  const file = kind === 'event' ? '/event.html' : '/replay2.html'
  // the site's own address, never the Host header a caller can set
  const origin = SITE_ORIGIN

  // the page itself, from this same deployment
  let html = ''
  try {
    const r = await fetch(origin + file, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`page ${r.status}`)
    html = await r.text()
  } catch (err) {
    console.error('[page]', String((err && err.message) || err))
    res.status(502).setHeader('content-type', 'text/plain')
    return res.end('The page could not be loaded. Try again in a moment.')
  }

  const info = UUID.test(id) ? await describe(kind, id) : null
  const title = info?.title || (kind === 'event' ? 'A live event on Sitca' : 'A session recap on Sitca')
  const description =
    info?.description ||
    (kind === 'event'
      ? 'Join live: captions in your language, ask questions privately, and keep the recap.'
      : 'The recording, the moments that mattered, and Sitca to ask about any of it.')
  const image = info?.hasThumb
    ? `${origin}/api/thumb?id=${encodeURIComponent(id)}`
    : info?.image
      ? info.image.startsWith('/')
        ? `${origin}${info.image}`
        : info.image
      : `${origin}/og-default.png`
  const url = `${origin}/${kind === 'event' ? 'e' : 'r'}/${encodeURIComponent(id)}`

  const meta = [
    `<title>${esc(title)} — Sitca</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:type" content="${kind === 'event' ? 'website' : 'video.other'}">`,
    `<meta property="og:site_name" content="Sitca">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    // a host's banner is whatever size they chose: its size is not claimed
    ...(info?.image && !info.image.startsWith('/')
      ? []
      : [
          `<meta property="og:image:width" content="${info?.hasThumb ? 480 : 1200}">`,
          `<meta property="og:image:height" content="${info?.hasThumb ? 270 : 630}">`
        ]),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`
  ].join('\n')

  // the page's own title and any earlier description give way, and the
  // rest goes straight after <head>, where the fetchers look first
  html = html.replace(/<title>[^<]*<\/title>/i, '')
  html = html.replace(/<meta\s+(?:name="description"|property="og:[^"]*"|name="twitter:[^"]*")[^>]*>\s*/gi, '')
  html = html.replace(/<head>/i, () => '<head>\n' + meta)

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
  const svc = SUPA_SERVICE ? { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` } : headers
  const get = async (path) => {
    try {
      // the events table is read with the server's key: its public fields only are used here
      const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: path.startsWith('events?') ? svc : headers, signal: AbortSignal.timeout(6000) })
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
    const ev =
      (await get(`events?id=eq.${id}&select=title,status,starts_at,replay,banner`)) ||
      (await get(`events?id=eq.${id}&select=title,status,starts_at,replay`))
    if (!ev) return null
    const rp = ev.replay || {}
    if (rp.enabled) {
      return {
        title: rp.title || ev.title,
        description: line(rp.summary) || 'The recording and recap of this event, with Sitca to ask.',
        hasThumb: false
      }
    }
    // An invitation, not a recap: the words and the picture both say "come".
    // The host's banner is the picture when there is one.
    const when = ev.starts_at
      ? new Date(ev.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : ''
    return {
      title: `${ev.title} — live on Sitca`,
      description:
        ev.status === 'live'
          ? "Live now — tap to join. Every word in your language, the speaker's screen, and your own questions answered privately."
          : when
            ? `${when} — tap to join. Every word in your language, the speaker's screen, and your own questions answered privately.`
            : "Tap to join. Every word in your language, the speaker's screen, and your own questions answered privately.",
      hasThumb: false,
      image: typeof ev.banner === 'string' && /^https:\/\//.test(ev.banner) ? ev.banner : '/og-event.png'
    }
  }
  // One recap, by its id (supabase/recap-privacy.sql: the table itself can
  // no longer be listed). Before that script has run, the table is read as
  // it was; the picture column arrives with wave14.sql, and before that the
  // words are still served, without a picture.
  let rc = await recapById(id, headers)
  if (rc === undefined) {
    rc =
      (await get(`recaps?id=eq.${id}&enabled=is.true&select=title,summary,duration_ms,thumb`)) ||
      (await get(`recaps?id=eq.${id}&enabled=is.true&select=title,summary,duration_ms`))
  }
  if (!rc) return null
  const len = minutes(rc.duration_ms)
  return {
    title: rc.title || 'Session recap',
    description: line(rc.summary) || (len ? `A ${len} session, with the recording and Sitca to ask.` : 'The recording and recap, with Sitca to ask.'),
    hasThumb: Boolean(rc.thumb && String(rc.thumb).startsWith('data:image/'))
  }
}

/**
 * A shared recap, one at a time: the row, null when it is not shared, or
 * undefined when the database does not have sitka_recap yet.
 */
async function recapById(id, headers) {
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_recap?p_id=${id}`, { headers, signal: AbortSignal.timeout(6000) })
    if (r.status === 404) return undefined
    if (!r.ok) return null
    const row = await r.json()
    return row && typeof row === 'object' ? row : null
  } catch {
    return null
  }
}
