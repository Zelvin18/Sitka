// The Chrome Web Store kit: five listing pictures (1280×800), the small
// promo tile (440×280), the marquee (1400×560) and the icons (16/48/128),
// rendered from set/store.html. Out: extension/store/
//   node store.mjs
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { serveSet, sleep } from './lib/assemble.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const OUT = here('../extension/store')
mkdirSync(OUT, { recursive: true })
const PORT = 4805
const server = serveSet(PORT)
const browser = await chromium.launch({ headless: true })
const shot = async (s, w, h, file, scale = 1) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale })
  await page.goto(`http://localhost:${PORT}/store.html?s=${s}`)
  await page.waitForLoadState('networkidle')
  await sleep(500)
  await page.screenshot({ path: join(OUT, file), type: file.endsWith('.jpg') ? 'jpeg' : 'png', quality: file.endsWith('.jpg') ? 92 : undefined, omitBackground: s === 'icon' })
  await page.close()
  console.log('wrote', file)
}
for (const n of [1, 2, 3, 4, 5]) await shot(String(n), 1280, 800, `screenshot-${n}.png`)
await shot('tile', 440, 280, 'promo-small-440x280.png')
await shot('marquee', 1400, 560, 'promo-marquee-1400x560.png')
for (const size of [16, 32, 48, 128]) await shot('icon', size, size, `icon-${size}.png`)
await browser.close()
server.close()
console.log('kit in', OUT)
