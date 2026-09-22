// The extension film: how Sitca gets into the browser and what it does on a
// call — the real extension page, then a drawn browser window walked through
// adding, pinning, pressing, and the card doing its work over the call.
// Out: out/sitca-extension.mp4 (+ poster).   node ext.mjs
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepare, click, type, caption, read, sleep, mark } from './lib/actor.mjs'
import { assemble, serveSet, duration } from './lib/assemble.mjs'

const SITE = process.env.SITE || 'https://sitcaai.vercel.app'
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const OUT = here('./out/ext')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const W = 1920
const H = 1080
const PORT = 4801
const server = serveSet(PORT)
const set = (p) => `http://localhost:${PORT}/${p}`

const ctx = await chromium.launchPersistentContext(here('./profile-fresh'), {
  headless: false,
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  args: ['--disable-blink-features=AutomationControlled']
})
const page = await ctx.newPage()
await page.setViewportSize({ width: W, height: H })
await sleep(600)
await prepare(page, 'ext')
const t0 = Date.now()
const now = () => (Date.now() - t0) / 1000
const m = {}
const at = (name) => {
  m[name] = now()
  mark(page, name)
}
const go = (fn, ...args) => page.evaluate(([f, a]) => window.go[f](...a), [fn, args])
// a click on the drawn window's own elements, with the hand
const press = async (sel) => click(page, page.locator(sel))

// ---- 1. the extension page, real ----
// (the press downloads the extension; on the set that download is not taken)
await ctx.route('**/*.zip', (r) => r.abort())
await page.goto(`${SITE}/extension`, { waitUntil: 'networkidle' })
await page.locator('#add').waitFor({ timeout: 30000 })
await sleep(800)
at('extpage')
await caption(page, 'sitcaai.vercel.app/extension — one press to add it')
await read(5200)
await click(page, page.locator('#add'))
await caption(page, '')
await sleep(900)
at('extpage-end')
// ---- 2. the browser asks once; then the toast ----
await page.goto(set('browser.html'))
await go('extpage')
await sleep(600)
await go('dialog')
await sleep(400)
at('dialog')
await read(1500)
await press('#addyes')
await go('added')
at('added')
await read(2400)
// ---- 3. pin it: the puzzle piece, then the pin ----
await press('#puzzle')
await go('menu', true)
at('menu')
await read(1300)
await press('#pin')
await go('pin')
at('pinned')
await read(2200)
// ---- 4. on a call: press the icon, choose, record ----
await go('call')
await sleep(500)
at('call')
await caption(page, 'On a call: press the Sitca icon')
await read(1400)
await go('press')
await press('#sitcaicon')
await sleep(500)
await go('choose')
at('choose')
await caption(page, '')
await read(1600)
await press('#optrecord')
await go('start')
at('recording')
await caption(page, 'It records, and captions the call as it happens')
await read(7000)
await caption(page, '')
// ---- 5. ask, privately ----
await click(page, page.locator('#askin'))
const q = 'what did she say about the shortfall?'
await type(page, q)
await go('ask', q)
at('ask')
await caption(page, 'Ask anything — nobody in the call sees this')
await sleep(1800)
await go('answer', 'She said Q3 closed at <b>$412k</b> against a <b>$480k</b> target — a shortfall of about <b>$68k</b>, roughly <b>14%</b> under plan. It is timing, not demand: three enterprise deals slipped into October and two are already signed. Want the action items she gave?')
await read(5500)
await caption(page, '')
at('answered')
// ---- 6. stop: saved, with the link ----
await press('#stopbtn')
await go('stop')
at('stop')
await caption(page, 'Stop — it is in your library, with a link to share')
await read(4200)
await caption(page, '')
at('end')
await sleep(600)
mark(page, 'close')
const film = await page.video().path()
await ctx.close()
server.close()

// ---- the cut ----
const len = duration(film)
const off = len - m.end - 0.6
const clip = (a, da, b, db) => ({ src: film, from: Math.max(0, m[a] + da + off), to: Math.min(len, m[b] + db + off) })
const beats = [
  { card: { m: 1, k: 'Sitca in your browser', t: 'Any call.|One press.' }, len: 4.2,
    say: 'Sitca also lives in your browser — for calls on Google Meet, Zoom, and Teams.' },
  { ...clip('extpage', -0.3, 'extpage-end', 0), say: 'Go to sitca a i dot vercel dot app slash extension, and add it to your browser.' },
  { ...clip('dialog', -0.2, 'added', 2.4), say: 'Confirm once.' },
  { ...clip('menu', -1.2, 'pinned', 2.2), say: 'Then pin it, so it is always one press away.' },
  { ...clip('call', 0, 'recording', 6.5), say: 'On a call, press the icon. Sitca records, and captions every word as it is said.' },
  { ...clip('ask', -2.2, 'answered', 0.2), say: 'Ask anything about what was said. The answer is yours alone — nobody in the call sees it.' },
  { ...clip('stop', -1.0, 'end', 0.3), say: 'When it ends, it is in your library — with a recap link to share.' },
  { card: { m: 1, t: 'Attend once.|Keep it forever.', u: 'sitcaai.vercel.app/extension' }, len: 11.0,
    say: 'Sitca. Attend once. Keep it forever. Get the extension at sitca a i dot vercel dot app slash extension.' }
]
await assemble(beats, { outDir: OUT, final: here('./out/sitca-extension.mp4'), posterBeat: 4, posterAt: 5, setPort: PORT + 1 })
process.exit(0)
