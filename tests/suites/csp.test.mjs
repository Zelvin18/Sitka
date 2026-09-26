// The site's Content-Security-Policy (web/vercel.json) and the pages it
// protects. The policy lets only the site's own scripts run, so no page may
// carry an inline script or an inline event handler; and the policy itself
// must keep allowing everything the app really talks to (sign-in, the
// database, the recording store, fonts) while never allowing inline or
// evaluated script.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')
const cfg = JSON.parse(readFileSync(join(web, 'vercel.json'), 'utf8'))
const pages = readdirSync(web).filter((f) => f.endsWith('.html'))

function policy() {
  for (const h of cfg.headers) {
    if (h.source !== '/(.*)') continue
    const kv = h.headers.find((x) => x.key === 'Content-Security-Policy')
    if (kv) return kv.value
  }
  return ''
}

function directives() {
  const out = {}
  for (const part of policy().split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out[name] = values
  }
  return out
}

test('every page has no inline script', () => {
  for (const f of pages) {
    const s = readFileSync(join(web, f), 'utf8')
    const inline = [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((m) => m[1].trim())
    assert.equal(inline.length, 0, `${f} has an inline <script>`)
  }
})

test('every page has no inline event handler or javascript: link', () => {
  for (const f of pages) {
    const s = readFileSync(join(web, f), 'utf8')
    assert.doesNotMatch(s, /<[^>]+\son[a-z]+\s*=/i, `${f} has an inline on…= handler`)
    assert.doesNotMatch(s, /javascript:/i, `${f} has a javascript: link`)
  }
})

test('the policy is set on every page', () => {
  assert.ok(policy().length > 0, 'no Content-Security-Policy on /(.*)')
})

test('scripts: only the site and Google sign-in, never inline or evaluated', () => {
  const d = directives()
  assert.ok(d['script-src'], 'script-src missing')
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:', 'data:', 'blob:']) {
    assert.ok(!d['script-src'].includes(bad), `script-src allows ${bad}`)
  }
  assert.ok(d['script-src'].includes("'self'"))
  assert.ok(d['script-src'].some((v) => v.startsWith('https://accounts.google.com')), 'Google sign-in script not allowed')
  assert.ok(d['script-src'].includes('https://apis.google.com'), 'Firebase sign-in helper not allowed')
  assert.deepEqual(d['object-src'], ["'none'"])
  assert.deepEqual(d['base-uri'], ["'self'"])
  assert.deepEqual(d['default-src'], ["'self'"])
})

test('the page cannot be framed by another site', () => {
  assert.deepEqual(directives()['frame-ancestors'], ["'self'"])
})

test('connections the app needs are allowed', () => {
  const c = directives()['connect-src'] || []
  const has = (host) => c.some((v) => v === host || (v.includes('*.') && host.endsWith(v.split('*')[1]) && host.split('://')[0] === v.split('://')[0]))
  let supa = 'https://jadukkvulkxnttowxefu.supabase.co'
  try {
    const env = readFileSync(join(web, '.env.local'), 'utf8')
    const m = /VITE_SUPABASE_URL=(\S+)/.exec(env)
    if (m) supa = m[1].replace(/\/$/, '')
  } catch {}
  for (const need of [
    supa, // the database
    supa.replace('https://', 'wss://'), // live updates
    'https://abc123.r2.cloudflarestorage.com', // recordings (signed links)
    'https://accounts.google.com',
    'https://www.googleapis.com', // Drive export
    'https://identitytoolkit.googleapis.com', // Google sign-in (Firebase)
    'https://securetoken.googleapis.com'
  ]) assert.ok(has(need), `connect-src does not allow ${need}`)
})

test('recordings can play and the sign-in window can open', () => {
  const d = directives()
  assert.ok(d['media-src'].includes('blob:'), 'local recordings (blob:) cannot play')
  // Save to Drive reads a recording held in the page (re-audit N33)
  assert.ok(d['connect-src'].includes('blob:'), 'a recording held in the page cannot be read to send it on')
  assert.ok(d['media-src'].includes('https://*.r2.cloudflarestorage.com'), 'cloud recordings cannot play')
  assert.ok(d['worker-src'].includes("'self'"), 'the PDF reader worker cannot start')
  assert.ok(d['frame-src'].includes('https://accounts.google.com'))
  assert.ok(d['frame-src'].some((v) => v.endsWith('firebaseapp.com')))
  assert.ok(d['font-src'].includes('https://fonts.gstatic.com'))
  assert.ok(d['style-src'].includes('https://fonts.googleapis.com'))
})

test('the old inline jobs now live in the site script every page loads', () => {
  for (const f of ['index.html', 'event.html', 'replay2.html']) {
    const s = readFileSync(join(web, f), 'utf8')
    if (/data-(font|reveal|words)/.test(s)) {
      const entry = [...s.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
      assert.ok(entry.length > 0, `${f} uses data-font/reveal/words but loads no script`)
    }
  }
  const src = readdirSync(join(web, 'src')).filter((f) => f.endsWith('.ts'))
  const importers = src.filter((f) => /import ['"]\.\/pageboot['"]/.test(readFileSync(join(web, 'src', f), 'utf8')))
  assert.ok(importers.length >= 3, `pageboot is imported by ${importers.join(', ') || 'nothing'}`)
})
