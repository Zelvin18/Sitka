// Faults, by email, to the owner.
//
// The app gathers what went wrong for someone and sends it here; this route
// mails it to the address in ADMIN_EMAIL through Resend (RESEND_API_KEY).
// Without those two settings it answers quietly and the operations view
// remains the record. Nothing here is stored.
//
// A signed-in page may send its own lines. A public recap page may report
// one thing only — that a recording was slow to start — and the words of
// that report are written here, not taken from the caller, so the route
// cannot be used to send anyone's text to the owner's inbox.

import { overLimitKey } from './_limit.js'
import { UNCHECKED, userOf, tokenOf, ipOf, SUPA_URL, SUPA_ANON } from './_auth.js'

const RESEND_KEY = process.env.RESEND_API_KEY || ''
const TO = process.env.ADMIN_EMAIL || ''
// Resend lets a new account send from this address to its own inbox before a domain is verified
const FROM = process.env.NOTIFY_FROM || 'Sitca <onboarding@resend.dev>'
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Is this a recap that exists and is shared? (sitka_recap answers for shared ones only) */
async function recapShared(id) {
  if (!SUPA_URL || !SUPA_ANON) return false
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_recap?p_id=${encodeURIComponent(id)}`, {
      headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` },
      signal: AbortSignal.timeout(4000)
    })
    const rc = r.ok ? await r.json().catch(() => null) : null
    return Boolean(rc && rc.enabled !== false)
  } catch {
    return false
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }
  body = body && typeof body === 'object' ? body : {}

  let user = ''
  let lines = []
  let page = ''
  const token = tokenOf(req)
  const me = token ? await userOf(token) : null
  if (me === UNCHECKED) return res.status(503).json({ error: 'Try again in a moment.' })
  if (me) {
    if (await overLimitKey(`notify:user:${me.id}`, 6, 60)) return res.status(429).json({ error: 'Slow down a little.' })
    user = me.email || me.id
    lines = Array.isArray(body.lines) ? body.lines.map((l) => String(l).slice(0, 500)).slice(0, 40) : []
    page = String(body.page || '').slice(0, 120)
  } else if (body.kind === 'recap-slow' && UUID.test(String(body.recap || ''))) {
    // the one report an anonymous page may make, in words chosen here
    if (await overLimitKey(`notify:ip:${ipOf(req)}`, 2, 6)) return res.status(429).json({ error: 'Slow down a little.' })
    if (await overLimitKey(`notify:recap:${body.recap}`, 2, 6)) return res.status(429).json({ error: 'Slow down a little.' })
    // only about a recap that exists and is shared: a made-up id sends nothing
    if (!(await recapShared(String(body.recap)))) return res.status(404).json({ error: 'No such recap.' })
    user = 'a recap visitor'
    const detail = /^[\w .:\-[\]()/]{0,160}$/.test(String(body.detail || '')) ? String(body.detail) : ''
    lines = [`A shared recap was slow to start: /r/${body.recap}${detail ? ` (${detail})` : ''}`]
    page = `/r/${body.recap}`
  } else {
    return res.status(401).json({ error: 'Sign in first.' })
  }
  if (lines.length === 0) return res.status(400).json({ error: 'nothing to say' })
  if (!RESEND_KEY || !TO) return res.status(200).json({ ok: false, reason: 'not-configured' })
  // the browser as the request says it, never words the caller chose for the mail
  const ua = String(req.headers['user-agent'] || '').replace(/[^ -~]/g, '').slice(0, 160)

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const subject = `Sitca: ${lines.length === 1 ? 'a fault' : `${lines.length} faults`} for ${user}`
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#141416;max-width:640px">
      <p style="font-size:15px;margin:0 0 6px"><b>${esc(user)}</b> met ${lines.length === 1 ? 'a fault' : `${lines.length} faults`} on ${esc(page || 'the site')}.</p>
      <p style="font-size:12px;color:#6a6a72;margin:0 0 16px">${esc(ua)}</p>
      ${lines.map((l) => `<pre style="white-space:pre-wrap;font:12.5px ui-monospace,Menlo,Consolas,monospace;background:#f4f4f6;border-radius:8px;padding:10px 12px;margin:0 0 8px">${esc(l)}</pre>`).join('')}
      <p style="font-size:12px;color:#6a6a72;margin:16px 0 0">The full list, with everyone's, is in the operations view under Reliability.</p>
    </div>`

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [TO], subject, html }),
      signal: AbortSignal.timeout(10000)
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      console.error('notify', r.status, t.slice(0, 200))
      return res.status(200).json({ ok: false })
    }
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('notify', err)
    return res.status(200).json({ ok: false })
  }
}
