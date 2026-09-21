// The hand on the mouse: glides to the real button, pauses to read, presses,
// types at a human pace. Every click lands on an element the page has, taken
// from its box — never a guessed coordinate.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const overlay = readFileSync(fileURLToPath(new URL('./overlay.js', import.meta.url)), 'utf8')
const rnd = (a, b) => a + Math.random() * (b - a)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** the marks: what happened when, per page's own clock, for the cut */
export const marks = []
export function mark(page, name, extra = {}) {
  const t = (Date.now() - page.__t0) / 1000
  marks.push({ page: page.__name, name, t, ...extra })
  console.log(`  [${page.__name} ${t.toFixed(1)}s] ${name}`)
}

/** every page filmed, with where its film lands */
export const films = []
export async function prepare(page, name) {
  page.__name = name
  const f = films.find((x) => x.p === page)
  if (f) {
    // named again by the scene: the film keeps up
    f.page = name
    return
  }
  page.__t0 = Date.now()
  const v = page.video()
  if (v) films.push({ page: name, path: await v.path(), p: page })
  await page.addInitScript(overlay)
  page.on('load', () => page.evaluate(overlay).catch(() => undefined))
  await page.evaluate(overlay).catch(() => undefined)
}
/** the films, for the record on disk */
export const filmList = () => films.map(({ page, path }) => ({ page, path }))

const demo = (page, fn, ...args) => page.evaluate(([f, a]) => window.__demo && window.__demo[f](...a), [fn, args]).catch(() => undefined)

/** where inside the element the pointer lands: not dead centre, like a hand */
async function target(loc) {
  const el = typeof loc === 'string' ? null : loc
  const box = await el.boundingBox()
  if (!box) throw new Error('nothing to press there')
  return {
    x: box.x + box.width * rnd(0.38, 0.62),
    y: box.y + box.height * rnd(0.4, 0.6)
  }
}

export async function glide(page, loc, opts = {}) {
  await loc.scrollIntoViewIfNeeded().catch(() => undefined)
  const { x, y } = await target(loc)
  const from = (await page.evaluate(() => window.__demo?.at())) || { x: 720, y: 450 }
  const dist = Math.hypot(x - from.x, y - from.y)
  const ms = opts.ms ?? Math.min(1100, Math.max(380, dist * 0.9))
  // the drawn pointer and the real one travel together, so hover states show
  const steps = Math.max(8, Math.round(ms / 40))
  const p = demo(page, 'move', x, y, ms)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e)
    await sleep(ms / steps)
  }
  await p
  await page.mouse.move(x, y)
  return { x, y }
}

export async function click(page, loc, opts = {}) {
  await glide(page, loc, opts)
  await sleep(opts.beat ?? rnd(220, 420))
  await demo(page, 'press')
  await page.mouse.down()
  await sleep(70)
  await page.mouse.up()
  await sleep(opts.after ?? rnd(320, 560))
}

/** typing with the small unevenness of real hands */
export async function type(page, text, opts = {}) {
  for (const ch of text) {
    await page.keyboard.type(ch)
    await sleep(ch === ' ' ? rnd(60, 140) : /[,.?!]/.test(ch) ? rnd(140, 260) : rnd(45, 110))
  }
  if (opts.enter) {
    await sleep(rnd(300, 520))
    await page.keyboard.press('Enter')
  }
}

export const caption = (page, text) => demo(page, 'caption', text)
export const chip = (page, text) => demo(page, 'chip', text)
export const fade = (page, on) => demo(page, 'fade', on)
export const popup = (page, src) => demo(page, 'popup', src)
export const hideCursor = (page, on) => demo(page, 'hide', on)

/** a moment of reading before the next thing */
export const read = (ms) => sleep(ms ?? rnd(900, 1500))

/** the last mark of every page in a context: how its film lines up with its clock */
export function closing(ctx) {
  for (const p of ctx.pages()) if (p.__t0 && !p.isClosed()) mark(p, 'close')
}
