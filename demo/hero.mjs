// The 40-second advert, from the last take's films plus title cards: a hook,
// the product in six beats, the close — a narrator over it, Priya faint
// under the meeting, and a music bed. Out: out/sitca-hero.mp4 (+ poster).
//   node hero.mjs            (needs out/marks.json from a full take)
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const SITE = process.env.SITE || 'https://sitcaai.vercel.app'
const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' })
const duration = (file) => {
  try {
    execFileSync(ffmpeg, ['-i', file], { stdio: 'pipe' })
  } catch (e) {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr))
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return 0
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const W = 1920
const H = 1080
const FPS = 30
const XF = 0.45
const OUT = here('./out/hero')
mkdirSync(OUT, { recursive: true })
const { marks, films } = JSON.parse(readFileSync(here('./out/marks.json'), 'utf8'))

// ---------- the words ----------
// each beat: what the narrator says, and which picture is under it
const BEATS = [
  { card: { t: 'Still taking notes|in every meeting?', s: 'And still forgetting what it was all about.' }, len: 4.6,
    say: 'Tired of taking notes in every meeting and lecture — and still forgetting what it was all about?' },
  { film: ['gate', 'call', 0.2, null, 'call', 3.2], say: '' },
  { card: { m: 1, k: 'Introducing', t: 'Sitca.|It attends with you.' }, len: 4.0, say: 'Introducing Sitca. It attends with you.' },
  { film: ['app', 'setup', 3.4, null, 'recording', 5.0], say: 'Share the call. Sitca listens, and every word lands as it is said.' },
  { film: ['app', 'ask', -2.6, null, 'ask', 6.0], say: 'Ask anything, mid-meeting. The answer is yours alone.' },
  { film: ['app', 'catchup', -0.6, null, 'catchup', 4.9], say: 'Stepped away? Catch me up — in seconds.' },
  { film: ['app', 'session', 0.4, null, 'session', 5.0], say: 'Notes, key moments and the recording, kept forever.' },
  { film: ['whatsapp', 'sent', -2.0, null, 'sent', 2.8], say: 'Share a recap with your team —' },
  { film: ['phone', 'recap-ask', 1.5, null, 'recap-ask', 7.6], phone: true, say: 'and they can ask it questions too.' },
  { card: { m: 1, t: 'Attend once.|Keep it forever.', u: 'sitcaai.vercel.app' }, len: 7.2, say: 'Sitca. Attend once. Keep it forever. Try it free at sitca a i dot vercel dot app.' }
]

// ---------- the cards, filmed ----------
const SET = 4799
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const f = join(here('./set'), p.replace(/^\//, ''))
  if (!existsSync(f)) return res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8' }[extname(f)] || 'application/octet-stream' })
  res.end(readFileSync(f))
}).listen(SET)
{
  const ctx = await chromium.launchPersistentContext(here('./profile-fresh'), {
    headless: false,
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    args: ['--disable-blink-features=AutomationControlled']
  })
  for (const [i, b] of BEATS.entries()) {
    if (!b.card) continue
    const page = await ctx.newPage()
    // the page is given its full size and a moment before the card is shown:
    // a film that starts while the window is still settling has a grey edge
    await page.setViewportSize({ width: W, height: H })
    await sleep(700)
    const q = new URLSearchParams(Object.entries(b.card).map(([k, v]) => [k, String(v)]))
    await page.goto(`http://localhost:${SET}/card.html?${q}`)
    await sleep(b.len * 1000 + 1200)
    const path = await page.video().path()
    await page.close()
    b.src = path
    b.from = 1.1
    b.to = 1.1 + b.len
    console.log('card', i, 'filmed')
  }
  await ctx.close()
}
server.close()

// ---------- the pieces from the take ----------
const film = {}
for (const f of films) {
  const close = marks.find((m) => m.page === f.page && m.name === 'close')
  const len = duration(f.path)
  film[f.page] = { path: f.path, len, offset: close ? len - close.t : 0 }
}
const at = (page, name) => marks.find((m) => m.page === page && m.name === name)?.t
for (const b of BEATS) {
  if (!b.film) continue
  const [page, m1, d1, _m2, m2, d2] = b.film
  const f = film[page]
  const a = at(page, m1)
  const z = at(page, m2 || m1)
  if (!f || a === undefined || z === undefined) throw new Error(`no footage for ${page} ${m1}`)
  b.src = f.path
  b.from = Math.max(0, a + d1 + f.offset)
  b.to = Math.min(f.len, z + d2 + f.offset)
}

// each beat becomes a clip at 1080p
const clips = []
for (const [i, b] of BEATS.entries()) {
  const out = join(OUT, `beat-${String(i).padStart(2, '0')}.mp4`)
  const vf = b.phone
    ? `[0:v]crop=iw:ih-84:0:0,split[a][c];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:8,eq=brightness=-0.25[bg];[c]scale=-2:${H - 80}[ph];[bg][ph]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},format=yuv420p`
  run(['-y', '-ss', b.from.toFixed(3), '-to', b.to.toFixed(3), '-i', b.src, ...(b.phone ? ['-filter_complex', vf] : ['-vf', vf]), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out])
  b.len = b.to - b.from
  clips.push({ out, len: b.len })
  console.log(`beat ${i}: ${b.len.toFixed(1)}s`)
}
// where each beat starts in the finished film (the melts overlap)
let t = 0
for (const [i, b] of BEATS.entries()) {
  b.start = t
  t += b.len - (i < BEATS.length - 1 ? XF : 0)
}
const total = t
console.log('length', total.toFixed(1), 's')

// joined with melts
const silent = join(OUT, 'silent.mp4')
{
  const ins = clips.flatMap((c) => ['-i', c.out])
  const chain = []
  let acc = clips[0].len
  let prev = '[0:v]'
  for (let i = 1; i < clips.length; i++) {
    const lab = i === clips.length - 1 ? '[v]' : `[x${i}]`
    chain.push(`${prev}[${i}:v]xfade=transition=fade:duration=${XF}:offset=${(acc - XF).toFixed(3)}${lab}`)
    acc = acc - XF + clips[i].len
    prev = lab
  }
  run(['-y', ...ins, '-filter_complex', chain.join(';'), '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-r', String(FPS), silent])
}

// ---------- the narrator ----------
// each line spoken by the site's natural voice, laid at its beat's start
const voices = []
for (const [i, b] of BEATS.entries()) {
  if (!b.say) continue
  const wav = join(OUT, `say-${i}.wav`)
  if (!existsSync(wav)) {
    const r = await fetch(`${SITE}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: b.say, lang: 'English', who: 'demo-hero' })
    })
    if (!r.ok) throw new Error(`speak ${i}: ${r.status}`)
    writeFileSync(wav, Buffer.from(await r.arrayBuffer()))
    await sleep(900)
  }
  voices.push({ wav, at: b.start + 0.25, len: duration(wav) })
  console.log(`said ${i}: ${duration(wav).toFixed(1)}s for a beat of ${b.len.toFixed(1)}s`)
}

// ---------- the music bed: a soft, modern pad, made here ----------
// (swap in a licensed track at assets/music.mp3 and it is used instead)
const music = existsSync(here('./assets/music.mp3')) ? here('./assets/music.mp3') : join(OUT, 'bed.wav')
if (!existsSync(here('./assets/music.mp3'))) {
  // three slow chords of soft tones with a gentle pulse, lowpassed and quiet
  const chord = (f1, f2, f3, start) =>
    `sine=frequency=${f1}:duration=${total}:sample_rate=48000,volume=0.16[a${start}];sine=frequency=${f2}:duration=${total}:sample_rate=48000,volume=0.12[b${start}];sine=frequency=${f3}:duration=${total}:sample_rate=48000,volume=0.10[c${start}]`
  run([
    '-y',
    '-filter_complex',
    [
      chord(130.81, 196.0, 261.63, 1),
      chord(146.83, 220.0, 293.66, 2),
      chord(174.61, 261.63, 349.23, 3),
      `[a1][b1][c1]amix=inputs=3:normalize=0,volume=1[ch1]`,
      `[a2][b2][c2]amix=inputs=3:normalize=0,volume=1[ch2]`,
      `[a3][b3][c3]amix=inputs=3:normalize=0,volume=1[ch3]`,
      // the chords take turns, eight seconds each, with soft edges
      `[ch1]volume='if(lt(mod(t,24),8),1,0)':eval=frame[g1]`,
      `[ch2]volume='if(between(mod(t,24),8,16),1,0)':eval=frame[g2]`,
      `[ch3]volume='if(gte(mod(t,24),16),1,0)':eval=frame[g3]`,
      `[g1][g2][g3]amix=inputs=3:normalize=0,lowpass=f=900,tremolo=f=0.9:d=0.25,afade=t=in:d=2,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,aformat=channel_layouts=stereo[bed]`
    ].join(';'),
    '-map', '[bed]', '-t', total.toFixed(2), music
  ])
}

// ---------- the mix ----------
// the narrator on top; the meeting's own sound faint under its beats; music under everything
const rec = at('app', 'recording')
const ins = ['-i', silent]
const fl = []
let n = 0
const layers = []
for (const b of BEATS) {
  if (!b.film || b.film[0] !== 'app' || rec === undefined) continue
  const from = b.from - film.app.offset - rec
  if (from < -1 || from > 150) continue
  ins.push('-i', here('./assets/priya.wav'))
  n++
  fl.push(`[${n}:a]atrim=start=${Math.max(0, from).toFixed(3)}:end=${(Math.max(0, from) + b.len).toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.22,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, b.len - 0.6).toFixed(3)}:d=0.6,adelay=${Math.round(b.start * 1000)}|${Math.round(b.start * 1000)}[m${n}]`)
  layers.push(`[m${n}]`)
}
for (const v of voices) {
  ins.push('-i', v.wav)
  n++
  fl.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1.15,adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)}[s${n}]`)
  layers.push(`[s${n}]`)
}
ins.push('-stream_loop', '-1', '-i', music)
n++
fl.push(`[${n}:a]atrim=end=${total.toFixed(2)},aformat=sample_rates=48000:channel_layouts=stereo,volume=${existsSync(here('./assets/music.mp3')) ? 0.14 : 0.5},afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[mu]`)
layers.push('[mu]')
ins.push('-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo')
n++
fl.push(`[${n}:a]${layers.join('')}amix=inputs=${layers.length + 1}:normalize=0:duration=first,alimiter=limit=0.95[a]`)
const final = here('./out/sitca-hero.mp4')
run(['-y', ...ins, '-filter_complex', fl.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', total.toFixed(2), final])
// the poster: the "Introducing" card
run(['-y', '-ss', (BEATS[2].start + 2.2).toFixed(2), '-i', final, '-frames:v', '1', '-q:v', '3', here('./out/sitca-hero.jpg')])
console.log('wrote', final)
