// Records "Daniel's meeting": the real Sitca, driven by a hand that behaves
// like a person, with the world around it (the call, the messenger, the
// drive) built as a set. Each page's film lands in out/raw with a list of
// marks; post.mjs cuts the story from them.
//
//   npm run record            the whole story
//   npm run record -- --until live   stop after a scene (for checking)
import { chromium, devices } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'
import { prepare, glide, click, type, caption, chip, fade, read, sleep, mark, marks, films, closing } from './lib/actor.mjs'

const SITE = process.env.SITE || 'https://sitcaai.vercel.app'
const AUDIO = process.env.AUDIO || 'tab' // tab: the call's sound; mic: Priya through a fake microphone
const until = process.argv.includes('--until') ? process.argv[process.argv.indexOf('--until') + 1] : ''
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const OUT = here('./out/raw')
rmSync(here('./out'), { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---------- the set, served locally ----------
const SET = 4799
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const f = join(here('./set'), p === '/' ? 'meet.html' : p)
  if (!existsSync(f)) {
    res.writeHead(404).end()
    return
  }
  const mime = { '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(f)] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' })
  res.end(readFileSync(f))
}).listen(SET)
const set = (name) => `http://localhost:${SET}/${name}`
// Priya's voice is served beside the set so the call page can play it
const assetsServer = createServer((req, res) => {
  const f = here('./assets/priya.wav')
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*' })
  res.end(readFileSync(f))
}).listen(SET + 1)

const done = (scene) => {
  if (until && until === scene) {
    writeFileSync(here('./out/marks.json'), JSON.stringify({ marks, films, recapUrl, sessionTitle }, null, 2))
    console.log(`stopped after "${scene}"`)
    return true
  }
  return false
}

// ---------- what Google's script becomes on the set ----------
const GSI_STUB = `window.google={accounts:{oauth2:{initTokenClient:(o)=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:'demo-token',expires_in:3600}),900)})},id:{initialize(){},prompt(){},renderButton(){},disableAutoSelect(){}}}};`
async function mockGoogle(ctx) {
  await ctx.route('https://accounts.google.com/gsi/client*', (r) => r.fulfill({ contentType: 'application/javascript', body: GSI_STUB }))
}
/** Drive on the set: a folder that is found, an upload that lands, a doc that is written */
async function mockDrive(ctx, title) {
  await ctx.route('https://www.googleapis.com/drive/v3/files?*', (r) => r.fulfill({ json: { files: [{ id: 'sitca-folder' }] } }))
  await ctx.route('https://www.googleapis.com/drive/v3/files', (r) => r.fulfill({ json: { id: 'sitca-folder' } }))
  await ctx.route('https://www.googleapis.com/upload/drive/v3/files?*', (r) => r.fulfill({ json: { id: 'doc-1' } }))
  await ctx.route(`${SITE}/api/drive`, async (r) => {
    const body = JSON.parse(r.request().postData() || '{}')
    const total = (body.sources || []).reduce((n, s) => n + Number(s.size || 0), 0)
    const from = Number(body.from || 0)
    const sent = Math.min(total, from + Math.max(1, Math.ceil(total / 4)))
    await sleep(650)
    await r.fulfill({ json: { uploadUrl: 'https://www.googleapis.com/upload/demo', sent, total, done: sent >= total, fileId: sent >= total ? 'vid-1' : '', url: sent >= total ? 'https://drive.google.com/file/d/vid-1/view' : '' } })
  })
  await ctx.route('https://drive.google.com/**', (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: readFileSync(here('./set/drive.html'), 'utf8').replace('</script>', `document.getElementById('vname').textContent=${JSON.stringify(title + '.webm')};document.getElementById('dname').textContent=${JSON.stringify(title + ' — brief')};</script>`) })
  )
}

const VIEW = { width: 1600, height: 900 }
let recapUrl = ''
let sessionTitle = 'Q3 planning with Priya'

// =====================================================================
// Scene A — the way in: Sitca's door, Google's account, Daniel chosen
// =====================================================================
{
  const ctx = await chromium.launchPersistentContext(here('./profile-fresh'), {
    headless: false,
    viewport: VIEW,
    recordVideo: { dir: OUT, size: VIEW },
    args: ['--disable-blink-features=AutomationControlled']
  })
  await mockGoogle(ctx)
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await prepare(page, 'gate')
  await page.goto(`${SITE}/app`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#ggoogle', { timeout: 30000 })
  await sleep(600)
  mark(page, 'gate')
  await caption(page, 'Sign in — it takes one tap')
  await read(1400)
  await click(page, page.locator('#ggoogle'))
  await caption(page, '')
  await sleep(400)
  await fade(page, true)
  await sleep(380)
  await page.goto(set('google.html?next=' + encodeURIComponent(SITE + '/app')))
  await sleep(300)
  mark(page, 'google')
  await read(1100)
  await click(page, page.locator('#daniel'))
  await sleep(900)
  mark(page, 'google-end')
  closing(ctx)
  await ctx.close()
  if (done('gate')) process.exit(0)
}

// =====================================================================
// Scene B — the meeting, and everything Daniel does with it
// =====================================================================
const args = [
  '--disable-blink-features=AutomationControlled',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--auto-select-tab-capture-source-by-title=Meet',
  ...(AUDIO === 'mic' ? ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${here('./assets/priya.wav')}%noloop`] : [])
]
const ctx = await chromium.launchPersistentContext(here('./profile'), {
  headless: false,
  viewport: VIEW,
  recordVideo: { dir: OUT, size: VIEW },
  permissions: ['clipboard-read', 'clipboard-write', 'microphone'],
  args
})
await mockGoogle(ctx)
await mockDrive(ctx, sessionTitle)
// every page the context opens gets the hand and the captions
ctx.on('page', (p) => void prepare(p, 'p' + ctx.pages().length))

// -- the call, in its own tab: Priya is talking --
const meet = ctx.pages()[0] ?? (await ctx.newPage())
await prepare(meet, 'meet')
await meet.goto(set('meet.html#talk'))
if (AUDIO === 'tab') {
  // the call's sound, playing in the tab the share will take
  await meet.evaluate((src) => {
    const a = new Audio(src)
    a.id = 'priya'
    a.volume = 0.9
    document.body.appendChild(a)
    window.__priya = a
  }, `http://localhost:${SET + 1}/priya.wav`)
}
await sleep(500)
mark(meet, 'meet')
await read(2600)

// -- Sitca, in a second tab --
const app = await ctx.newPage()
await prepare(app, 'app')
await app.goto(`${SITE}/app`, { waitUntil: 'networkidle' })
await app.waitForSelector('.home-action', { timeout: 60000 })
await sleep(500)
mark(app, 'home')
await caption(app, 'A meeting is on. Daniel opens Sitca.')
await read(1600)
await caption(app, '')
await click(app, app.locator('.home-action').first())
await app.waitForSelector('.setup2-kind', { timeout: 30000 })
await read(900)
mark(app, 'setup')
await click(app, app.locator('.setup2-kind', { hasText: 'Meeting' }))
await read(700)
if (AUDIO === 'mic') {
  // Priya comes through the microphone on this take: it is switched on
  const mic = app.locator('button', { hasText: /microphone|^mic/i }).first()
  if (await mic.count()) await click(app, mic)
}
await caption(app, 'Share the call’s tab — picture and sound')
await click(app, app.locator('.act-tile', { hasText: 'Share my screen' }))
// the picker chooses the call by itself on the set; the session begins
if (AUDIO === 'tab') await meet.evaluate(() => window.__priya && window.__priya.play())
await app.waitForSelector('.live-badge', { timeout: 60000 })
mark(app, 'recording')
await caption(app, '')
await sleep(1200)
await caption(app, 'Sitca listens: the words arrive as they are said')
await app.waitForSelector('.transcript-line, .seg, .tline', { timeout: 60000 }).catch(() => undefined)
await read(6500)
await caption(app, '')
if (done('live')) {
  await sleep(1500)
  closing(ctx)
  await ctx.close()
  process.exit(0)
}

// -- the picture fills the screen; Sitca floats beside it --
await click(app, app.locator('.video-expand'))
await sleep(1200)
mark(app, 'theatre')
await read(1200)
await click(app, app.locator('.theatre-fab'))
await app.waitForSelector('.session-right.theatre-open .chat-input', { timeout: 15000 })
await read(600)
await click(app, app.locator('.session-right.theatre-open .chat-input'))
await caption(app, 'Ask about what is being said — the answer is his alone')
await type(app, 'what did she mean by the Q3 shortfall?', { enter: true })
mark(app, 'ask')
// the answer streams in; it ends with Sitca's own follow-up
await sleep(14000)
await caption(app, '')
await read(1800)
mark(app, 'ask-end')
await click(app, app.locator('.theatre-close'))
await sleep(500)
await app.keyboard.press('Escape')
await sleep(900)
mark(app, 'theatre-end')

// -- notes write themselves; then what he missed --
await click(app, app.locator('button', { hasText: 'Notes' }).first())
await caption(app, 'Notes write themselves as the meeting goes on')
mark(app, 'notes')
// the notes need a couple of minutes of meeting behind them: the rest of
// Priya's talk runs here (cut in post, marked "later")
await sleep(75000)
await caption(app, '')
await app.evaluate(() => window.scrollTo(0, 0))
await read(1200)
mark(app, 'notes-later')
await read(2400)
await chip(app, 'A little later — Daniel stepped away for a moment')
await sleep(1800)
await chip(app, '')
await click(app, app.locator('button', { hasText: 'Catch me up' }))
await caption(app, 'Catch me up: what he missed, in a few lines')
mark(app, 'catchup')
await sleep(13000)
await caption(app, '')
await read(1500)
mark(app, 'catchup-end')

// -- the meeting ends; so does the session --
await meet.evaluate(() => window.meet && window.meet.talk(false))
await click(app, app.locator('button', { hasText: 'End session' }))
mark(app, 'end')
await caption(app, 'Meeting over. One press.')
await app.waitForSelector('.tab-row', { timeout: 120000 })
await sleep(1500)
await caption(app, '')
mark(app, 'session')
sessionTitle = (await app.locator('.page-title, h1').first().textContent().catch(() => '')) || sessionTitle
await read(1600)
// the recording, on a tap
const video = app.locator('video').first()
if (await video.count()) {
  await click(app, video)
  await read(2600)
  await click(app, video)
}
if (done('session')) {
  closing(ctx)
  await ctx.close()
  process.exit(0)
}

// -- to Drive: notes written, the file sent, the folder opened --
await caption(app, 'Save to Drive: the recording and a written brief')
const [drivePage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 120000 }),
  (async () => {
    await click(app, app.locator('.video-drive'))
    mark(app, 'drive')
    await app.waitForSelector('.video-drive.done', { timeout: 120000 })
    await read(1000)
    await caption(app, '')
    await click(app, app.locator('.video-drive'))
  })()
])
await prepare(drivePage, 'drive')
await drivePage.waitForLoadState()
await sleep(400)
mark(drivePage, 'drive-open')
await read(2600)
mark(drivePage, 'drive-end')
mark(drivePage, 'close')
await drivePage.close()
await app.bringToFront()

// -- the recap link, for the ones who missed it --
await read(800)
await click(app, app.locator('button', { hasText: /^Share$|^Shared$/ }))
await caption(app, 'Share a recap: summary, moments, notes — and it answers questions')
mark(app, 'share')
const create = app.locator('button', { hasText: 'Create link' })
if (await create.count()) {
  await click(app, create)
  await app.waitForSelector('.share-card-link', { timeout: 60000 })
}
recapUrl = ((await app.locator('.share-card-link span').first().textContent()) || '').trim()
await read(900)
await click(app, app.locator('button', { hasText: /Copy link|Copied/ }))
await caption(app, '')
await read(700)
mark(app, 'share-end')
if (done('share')) {
  closing(ctx)
  await ctx.close()
  process.exit(0)
}

// -- the messenger: the link goes to the group --
const wa = await ctx.newPage()
await prepare(wa, 'whatsapp')
await wa.goto(set('whatsapp.html'))
await sleep(400)
mark(wa, 'whatsapp')
await read(1400)
await click(wa, wa.locator('#box'))
await wa.keyboard.press('Control+V')
await sleep(200)
// the clipboard on the set may be shy: the link is typed in if it did not paste
if (!(await wa.inputValue('#box')).includes('http')) await type(wa, recapUrl)
await type(wa, ' — recap of the Q3 call, ask it anything', { enter: true })
mark(wa, 'sent')
await sleep(4800)
mark(wa, 'whatsapp-end')
closing(ctx)
  await ctx.close()
writeFileSync(here('./out/recap.txt'), recapUrl)
if (done('whatsapp')) process.exit(0)

// =====================================================================
// Scene C — Grace, on her phone, opens the link
// =====================================================================
{
  const phone = devices['Pixel 7']
  const pctx = await chromium.launchPersistentContext(here('./profile-phone'), {
    ...phone,
    headless: false,
    recordVideo: { dir: OUT, size: { width: 412, height: 915 } },
    args: ['--disable-blink-features=AutomationControlled']
  })
  const page = pctx.pages()[0] ?? (await pctx.newPage())
  await prepare(page, 'phone')
  await page.goto(recapUrl, { waitUntil: 'networkidle' })
  await sleep(600)
  mark(page, 'recap')
  await read(2200)
  await page.mouse.wheel(0, 500)
  await sleep(1200)
  await page.mouse.wheel(0, 500)
  await read(1400)
  await click(page, page.locator('#ask'))
  await type(page, 'what was decided about the launch date?', { enter: true })
  mark(page, 'recap-ask')
  await sleep(12000)
  mark(page, 'recap-end')
  await read(1500)
  closing(pctx)
  await pctx.close()
}

server.close()
assetsServer.close()
writeFileSync(here('./out/marks.json'), JSON.stringify({ marks, films, recapUrl, sessionTitle }, null, 2))
console.log('recorded. marks in out/marks.json')
process.exit(0)
