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
import { prepare, glide, click, type, caption, chip, fade, popup, read, sleep, mark, marks, filmList, closing } from './lib/actor.mjs'

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

const save = () => writeFileSync(here('./out/marks.json'), JSON.stringify({ marks, films: filmList(), recapUrl, sessionTitle }, null, 2))
const done = (scene) => {
  if (until && until === scene) {
    save()
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

const VIEW = { width: 1920, height: 1080 }
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
  // the opening card
  await page.goto(set('title.html'))
  await sleep(300)
  mark(page, 'title')
  await sleep(3600)
  mark(page, 'title-end')
  // the call, as the story opens: Priya talking, Daniel in the corner
  await page.goto(set('meet.html#talk'))
  await sleep(400)
  mark(page, 'call')
  await caption(page, 'Daniel is in a call with Priya. The rest of the team could not make it.')
  await sleep(3600)
  await caption(page, '')
  await read(500)
  mark(page, 'call-end')
  await page.goto(`${SITE}/app`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#ggoogle', { timeout: 30000 })
  await sleep(600)
  mark(page, 'gate')
  await caption(page, 'He opens Sitca. Signing in is one tap.')
  await read(1400)
  await click(page, page.locator('#ggoogle'))
  await caption(page, '')
  await sleep(500)
  // Google's window opens over the page, Daniel's account in it
  await popup(page, true)
  await sleep(500)
  mark(page, 'google')
  await read(1300)
  const chosen = page.evaluate(() => new Promise((r) => window.addEventListener('message', (e) => e.data === 'sitca-demo:chosen' && r(true), { once: true })))
  await click(page, page.locator('#__demo #daniel'))
  await chosen
  await popup(page, false)
  // the workspace opening: the door's own loader, then the home page (next scene)
  await page.evaluate(() => {
    document.getElementById('gatecard')?.classList.add('hidden')
    document.getElementById('gateload')?.classList.remove('hidden')
  })
  await sleep(1500)
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
  '--autoplay-policy=no-user-gesture-required',
  '--auto-select-tab-capture-source-by-title=Video call',
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
ctx.on('page', (p) => {
  console.log('  (new page)', p.url())
  void prepare(p, 'p' + ctx.pages().length)
})

// a clean slate: the demo account's library holds nothing from earlier takes
if (!process.argv.includes('--keep')) {
  const p = await ctx.newPage()
  await p.goto(`${SITE}/app`, { waitUntil: 'networkidle' })
  await p.waitForSelector('.home-action', { timeout: 60000 })
  const n = await p.evaluate(async () => {
    const list = await window.sitka.listSessions()
    for (const m of list) await window.sitka.deleteSession(m.id)
    return list.length
  })
  console.log('cleaned', n, 'sessions')
  await p.close()
}

// -- the call, in its own tab: Priya is talking --
// The share takes what the window shows of the tab: the call page is sized
// to fit inside this screen's window, so the whole room is in the picture.
const meet = ctx.pages()[0] ?? (await ctx.newPage())
// sized to what this screen's window shows, so the share (which takes the
// visible tab) gets the whole room
await meet.setViewportSize({ width: 1280, height: 640 })
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
await read(1500)

// -- Sitca, in a second tab --
const app = await ctx.newPage()
await prepare(app, 'app')
await app.goto(`${SITE}/app`, { waitUntil: 'networkidle' })
await sleep(2500)
await app.screenshot({ path: here('./out/debug-home.png') })
await app.waitForSelector('.home-action', { timeout: 60000 })
await sleep(500)
mark(app, 'home')
await caption(app, 'A meeting is on. Daniel opens Sitca.')
await read(1600)
await caption(app, '')
await click(app, app.locator('.home-action').first())
// what today is: a session of his own
await app.waitForSelector('text=Just for me', { timeout: 30000 })
await read(1000)
await click(app, app.locator('button, .intent-card', { hasText: 'Just for me' }).first())
await sleep(2000)
await app.screenshot({ path: here('./out/debug-setup.png') })
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
await read(9000)
await caption(app, '')
if (until === 'live') {
  await sleep(1500)
  closing(ctx)
  await ctx.close()
  done('live')
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
await sleep(60000)
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
await app.waitForSelector('.tab-row:has-text("Overview")', { timeout: 180000 })
// the recording itself, on screen, before this scene counts
await app.waitForFunction(() => {
  const v = document.querySelector('video')
  return Boolean(v && v.readyState >= 2)
}, null, { timeout: 40000 }).catch(() => undefined)
await sleep(800)
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
if (until === 'session') {
  closing(ctx)
  await ctx.close()
  done('session')
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
if (until === 'share') {
  closing(ctx)
  await ctx.close()
  done('share')
  process.exit(0)
}

// -- the messenger: the link goes to the group --
const wa = await ctx.newPage()
await prepare(wa, 'whatsapp')
await wa.goto(set('whatsapp.html'))
// the link's preview carries the session's real name
await wa.evaluate((t) => {
  window.previewTitle = t + ' — recap'
}, sessionTitle)
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
  // the closing card, at full size
  const ectx = await chromium.launchPersistentContext(here('./profile-fresh'), {
    headless: false,
    viewport: VIEW,
    recordVideo: { dir: OUT, size: VIEW },
    args: ['--disable-blink-features=AutomationControlled']
  })
  const epage = ectx.pages()[0] ?? (await ectx.newPage())
  await prepare(epage, 'endcard')
  await epage.goto(set('end.html'))
  await sleep(300)
  mark(epage, 'endcard')
  await sleep(4200)
  mark(epage, 'endcard-end')
  closing(ectx)
  await ectx.close()

}

server.close()
assetsServer.close()
save()
console.log('recorded. marks in out/marks.json')
process.exit(0)
