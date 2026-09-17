// Faults, by email, to the owner.
//
// The app gathers what went wrong for someone and sends it here; this route
// mails it to the address in ADMIN_EMAIL through Resend (RESEND_API_KEY).
// Without those two settings it answers quietly and the ops view remains the
// record. A flood from one address is cut short; nothing here is stored.

import { overLimit } from './_limit.js'

const RESEND_KEY = process.env.RESEND_API_KEY || ''
const TO = process.env.ADMIN_EMAIL || ''
// Resend lets a new account send from this address to its own inbox before a domain is verified
const FROM = process.env.NOTIFY_FROM || 'Sitca <onboarding@resend.dev>'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!RESEND_KEY || !TO) return res.status(200).json({ ok: false, reason: 'not-configured' })
  if (overLimit(req, 6, 60)) return res.status(429).json({ error: 'Slow down a little.' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }
  const lines = Array.isArray(body?.lines) ? body.lines.map((l) => String(l).slice(0, 500)).slice(0, 40) : []
  if (lines.length === 0) return res.status(400).json({ error: 'nothing to say' })
  const user = String(body?.user || 'someone').slice(0, 120)
  const ua = String(body?.ua || '').slice(0, 160)
  const page = String(body?.page || '').slice(0, 120)

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
      return res.status(200).json({ ok: false, reason: `mail ${r.status}` })
    }
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('notify', err)
    return res.status(200).json({ ok: false, reason: String((err && err.message) || err) })
  }
}
