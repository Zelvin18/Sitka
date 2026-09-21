// Opens the recording browser on Sitca's sign-in page. Sign in as the person
// the video shows (Daniel), then close the window: the profile remembers,
// and the recorder uses it. No password ever passes through a script.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const SITE = process.env.SITE || 'https://sitcaai.vercel.app'
const profile = fileURLToPath(new URL('./profile', import.meta.url))
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(`${SITE}/app`)
console.log('In the window: sign in (Continue with Google, or the Create account tab as "Daniel Mwangi"). When the home page shows, close the window.')
await new Promise((resolve) => ctx.on('close', resolve))
console.log('Profile saved. Now run: npm run record')
