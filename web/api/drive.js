// Moving a recording from Sitca's store into someone's Google Drive.
//
// The person's browser asks Google for leave (the drive.file scope) and
// hands the short-lived token here, with the session's id. This server
// finds the recording itself — the caller's own, or one shared with them —
// reads it from the store and sends it to Drive in pieces: what took minutes
// over a phone's connection takes seconds. No address from the caller is
// ever fetched; the Google token is used for the transfer and forgotten.
//
// One call moves as much as fits in its time; the browser calls again with
// where it got to, until Drive says the file is whole.

import { r2Config, presign, r2List } from './_r2.js'
import { SUPA_URL, SUPA_ANON, requireUser, failSafely } from './_auth.js'
import { UUID, sharerOf, keyShape } from './_share.js'
import { overLimitKey } from './_limit.js'
/** a piece sent to Drive: a multiple of 256 KB, as Drive requires */
const PIECE = 32 * 1024 * 1024
/** how long one call may work before handing back to the browser */
const BUDGET_MS = 48000

export const config = { maxDuration: 60 }

/**
 * The recording's pieces, found here: the caller's own session first, then a
 * session someone shared, from the sharer's own folder. Links are made here.
 */
async function sourcesFor(cfg, me, session) {
  for (const owner of [me.toLowerCase(), await sharerOf(session)]) {
    if (!owner) continue
    const objects = await r2List(cfg, `${owner}/${session}`)
    const whole = objects.find((o) => o.key === `${owner}/${session}.webm`)
    if (whole && whole.size > 0) return [{ url: presign(cfg, 'GET', whole.key, 3600), size: whole.size }]
    const parts = objects
      .filter((o) => {
        const s = keyShape(o.key)
        return s && s.kind === 'part' && s.session === session
      })
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((o) => ({ url: presign(cfg, 'GET', o.key, 3600), size: o.size }))
    if (parts.length) return parts
  }
  return []
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const cfg = r2Config()
  if (!SUPA_URL || !SUPA_ANON || !cfg) return res.status(503).json({ error: 'not-configured' })
  const who = await requireUser(req, res)
  if (!who) return
  if (await overLimitKey(`drive:user:${who.id}`, 20, 200)) return res.status(429).json({ error: 'Slow down a little.' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }
  const google = String(body?.google || '')
  if (!google || google.length > 4096) return res.status(400).json({ error: 'No Google token.' })
  const session = String(body?.session || '').toLowerCase()
  if (!UUID.test(session)) return res.status(400).json({ error: 'Which recording?' })
  const sources = await sourcesFor(cfg, who.id, session)
  if (sources.length === 0) return res.status(404).json({ error: 'That recording is not in the store.' })
  const total = sources.reduce((n, s) => n + Number(s.size), 0)
  if (total <= 0) return res.status(400).json({ error: 'Nothing to send.' })

  try {
    // ---- start: Drive opens a resumable upload; its address is handed back ----
    let uploadUrl = typeof body.uploadUrl === 'string' ? body.uploadUrl : ''
    if (!uploadUrl) {
      const name = String(body.name || 'recording').slice(0, 200)
      const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(body.mime || '')) ? String(body.mime) : 'video/mp4'
      const folder = String(body.folderId || '')
      const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${google}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(total)
        },
        body: JSON.stringify({ name, ...(folder ? { parents: [folder] } : {}) })
      })
      if (!start.ok) return res.status(502).json({ error: `Drive would not start the upload (${start.status}).` })
      uploadUrl = start.headers.get('location') || ''
      if (!/^https:\/\/www\.googleapis\.com\//.test(uploadUrl)) return res.status(502).json({ error: 'Drive gave no upload address.' })
    } else if (!/^https:\/\/www\.googleapis\.com\//.test(uploadUrl)) {
      return res.status(400).json({ error: 'Not a Drive upload address.' })
    }

    // ---- move: pieces from the store to Drive, until time is up or the file is whole ----
    let sent = Math.max(0, Math.floor(Number(body.from) || 0))
    const began = Date.now()
    let fileId = ''
    while (sent < total && Date.now() - began < BUDGET_MS) {
      const take = Math.min(PIECE, total - sent)
      const piece = await readRange(sources, sent, take)
      if (!piece || piece.byteLength !== take) return res.status(502).json({ error: 'The recording could not be read from the store.', sent })
      const last = sent + take >= total
      const r = await fetch(uploadUrl, {
        method: 'PUT',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(5000, BUDGET_MS - (Date.now() - began))),
        headers: { 'Content-Range': `bytes ${sent}-${sent + take - 1}/${total}`, 'Content-Length': String(take) },
        body: piece
      })
      if (r.status === 308) {
        sent += take
        continue
      }
      if (r.ok) {
        const j = await r.json().catch(() => ({}))
        fileId = j?.id || ''
        sent += take
        break
      }
      if (r.status === 401) return res.status(401).json({ error: 'Google no longer accepts the token. Try again.', sent })
      return res.status(502).json({ error: `Drive refused a piece (${r.status}).`, sent, last })
    }
    const done = sent >= total
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ uploadUrl, sent, total, done, fileId, url: fileId ? `https://drive.google.com/file/d/${fileId}/view` : '' })
  } catch (err) {
    return failSafely(res, err, 'drive')
  }
}

/** Bytes [from, from+len) of the recording, across its parts. */
async function readRange(sources, from, len) {
  const out = Buffer.alloc(len)
  let filled = 0
  let base = 0
  for (const s of sources) {
    const size = Number(s.size)
    const start = from + filled
    if (start >= base + size) {
      base += size
      continue
    }
    const off = start - base
    const want = Math.min(len - filled, size - off)
    const r = await fetch(s.url, { headers: { Range: `bytes=${off}-${off + want - 1}` }, redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!r.ok) return null
    let buf = Buffer.from(await r.arrayBuffer())
    // a store that ignores the range hands back the whole part
    if (r.status === 200 && buf.byteLength > want) buf = buf.subarray(off, off + want)
    if (buf.byteLength !== want) return null
    buf.copy(out, filled)
    filled += want
    if (filled >= len) break
    base += size
  }
  return filled === len ? out : null
}
