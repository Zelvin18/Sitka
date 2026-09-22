// The Chrome Web Store pictures from the photographs in store/photos: five
// listing pictures (1280×800), the small tile (440×280) and the marquee
// (1400×560), typeset by set/store-photo.html. Out: extension/store/
//   node store-photos.mjs
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { serveSet, sleep } from './lib/assemble.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const OUT = here('../extension/store')
const PUB = here('../extension/store/photos')
mkdirSync(OUT, { recursive: true })
const PHOTO = (k) => `${k}.jpg`
const PORT = 4806
const server = serveSet(PORT)
const browser = await chromium.launch({ headless: true })
const shot = async (s, w, h, file) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.route('**/photo/*', (route) => {
    const key = decodeURIComponent(route.request().url().split('/photo/')[1])
    route.fulfill({ body: readFileSync(join(PUB, PHOTO(key))), contentType: 'image/jpeg' })
  })
  await page.goto(`http://localhost:${PORT}/store-photo.html?s=${s}`)
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await sleep(400)
  await page.screenshot({ path: join(OUT, file), type: 'png' })
  await page.close()
  console.log('wrote', file)
}
for (const n of [1, 2, 3, 4, 5]) await shot(String(n), 1280, 800, `screenshot-${n}.png`)
await shot('tile', 440, 280, 'promo-small-440x280.png')
await shot('marquee', 1400, 560, 'promo-marquee-1400x560.png')
await browser.close()
server.close()
console.log('kit in', OUT)
