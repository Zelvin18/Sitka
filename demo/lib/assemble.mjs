// The assembly line for a short film: title cards filmed on the spot, the
// beats cut at 1080p and melted into one another, a narrator's lines spoken
// by the site's own voice, an optional sound under a beat, and a music bed
// (a licensed track at assets/music.mp3 when there is one, a soft pad made
// here otherwise). Shared by the advert and the extension film.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const ffmpeg = require('ffmpeg-static')
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const SITE = process.env.SITE || 'https://sitcaai.vercel.app'
export const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' })
export const duration = (file) => {
  try {
    execFileSync(ffmpeg, ['-i', file], { stdio: 'pipe' })
  } catch (e) {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr))
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return 0
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const W = 1920
const H = 1080
const FPS = 30
const XF = 0.45

/** a static server for the set pages, on a spare port */
export function serveSet(port) {
  const root = here('../set')
  return createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const f = join(root, p.replace(/^\//, ''))
    if (!existsSync(f)) return res.writeHead(404).end()
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.wav': 'audio/wav' }[extname(f)] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(readFileSync(f))
  }).listen(port)
}

/**
 * beats: [{ card:{...}, len }] or [{ src, from, to, phone?, under?:{wav, from} }], each with `say`.
 * Films the cards, cuts and joins the beats, lays the narration and music,
 * writes `final` (and a poster from `posterBeat`).
 */
export async function assemble(beats, { outDir, final, posterBeat = 0, posterAt = 2.0, setPort = 4799 }) {
  mkdirSync(outDir, { recursive: true })
  // ---------- the cards ----------
  if (beats.some((b) => b.card)) {
    const server = serveSet(setPort)
    const ctx = await chromium.launchPersistentContext(here('../profile-fresh'), {
      headless: false,
      viewport: { width: W, height: H },
      recordVideo: { dir: outDir, size: { width: W, height: H } },
      args: ['--disable-blink-features=AutomationControlled']
    })
    for (const [i, b] of beats.entries()) {
      if (!b.card) continue
      const page = await ctx.newPage()
      await page.setViewportSize({ width: W, height: H })
      await sleep(700)
      const q = new URLSearchParams(Object.entries(b.card).map(([k, v]) => [k, String(v)]))
      await page.goto(`http://localhost:${setPort}/card.html?${q}`)
      await sleep(b.len * 1000 + 1200)
      b.src = await page.video().path()
      await page.close()
      b.from = 1.1
      b.to = 1.1 + b.len
      console.log('card', i, 'filmed')
    }
    await ctx.close()
    server.close()
  }
  // ---------- the clips ----------
  const clips = []
  for (const [i, b] of beats.entries()) {
    const out = join(outDir, `beat-${String(i).padStart(2, '0')}.mp4`)
    const vf = b.phone
      ? `[0:v]crop=iw:ih-84:0:0,split[a][c];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:8,eq=brightness=-0.25[bg];[c]scale=-2:${H - 80}[ph];[bg][ph]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},format=yuv420p`
    run(['-y', '-ss', b.from.toFixed(3), '-to', b.to.toFixed(3), '-i', b.src, ...(b.phone ? ['-filter_complex', vf] : ['-vf', vf]), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out])
    b.len = b.to - b.from
    clips.push({ out, len: b.len })
    console.log(`beat ${i}: ${b.len.toFixed(1)}s`)
  }
  let t = 0
  for (const [i, b] of beats.entries()) {
    b.start = t
    t += b.len - (i < beats.length - 1 ? XF : 0)
  }
  const total = t
  console.log('length', total.toFixed(1), 's')
  // ---------- joined with melts ----------
  const silent = join(outDir, 'silent.mp4')
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
  const voices = []
  for (const [i, b] of beats.entries()) {
    if (!b.say) continue
    const wav = join(outDir, `say-${i}.wav`)
    if (!existsSync(wav)) {
      const r = await fetch(`${SITE}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: b.say, lang: 'English', who: 'demo-film' })
      })
      if (!r.ok) throw new Error(`speak ${i}: ${r.status}`)
      writeFileSync(wav, Buffer.from(await r.arrayBuffer()))
      await sleep(900)
    }
    const len = duration(wav)
    voices.push({ wav, at: b.start + (b.sayAt ?? 0.25) })
    console.log(`said ${i}: ${len.toFixed(1)}s for a beat of ${b.len.toFixed(1)}s${len > b.len + 1.5 ? '  (runs past the beat)' : ''}`)
  }
  // ---------- the music bed ----------
  const licensed = here('../assets/music.mp3')
  const music = existsSync(licensed) ? licensed : join(outDir, 'bed.wav')
  if (!existsSync(licensed)) {
    const chord = (f1, f2, f3, k) =>
      `sine=frequency=${f1}:duration=${total}:sample_rate=48000,volume=0.16[a${k}];sine=frequency=${f2}:duration=${total}:sample_rate=48000,volume=0.12[b${k}];sine=frequency=${f3}:duration=${total}:sample_rate=48000,volume=0.10[c${k}]`
    run([
      '-y', '-filter_complex',
      [
        chord(130.81, 196.0, 261.63, 1), chord(146.83, 220.0, 293.66, 2), chord(174.61, 261.63, 349.23, 3),
        '[a1][b1][c1]amix=inputs=3:normalize=0[ch1]', '[a2][b2][c2]amix=inputs=3:normalize=0[ch2]', '[a3][b3][c3]amix=inputs=3:normalize=0[ch3]',
        `[ch1]volume='if(lt(mod(t,24),8),1,0)':eval=frame[g1]`, `[ch2]volume='if(between(mod(t,24),8,16),1,0)':eval=frame[g2]`, `[ch3]volume='if(gte(mod(t,24),16),1,0)':eval=frame[g3]`,
        `[g1][g2][g3]amix=inputs=3:normalize=0,lowpass=f=900,tremolo=f=0.9:d=0.25,afade=t=in:d=2,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,aformat=channel_layouts=stereo[bed]`
      ].join(';'),
      '-map', '[bed]', '-t', total.toFixed(2), music
    ])
  }
  // ---------- the mix ----------
  const ins = ['-i', silent]
  const fl = []
  let n = 0
  const layers = []
  for (const b of beats) {
    if (!b.under) continue
    ins.push('-i', b.under.wav)
    n++
    const from = Math.max(0, b.under.from)
    fl.push(`[${n}:a]atrim=start=${from.toFixed(3)}:end=${(from + b.len).toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${b.under.volume ?? 0.22},afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, b.len - 0.6).toFixed(3)}:d=0.6,adelay=${Math.round(b.start * 1000)}|${Math.round(b.start * 1000)}[m${n}]`)
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
  fl.push(`[${n}:a]atrim=end=${total.toFixed(2)},aformat=sample_rates=48000:channel_layouts=stereo,volume=${existsSync(licensed) ? 0.14 : 0.5},afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[mu]`)
  layers.push('[mu]')
  ins.push('-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo')
  n++
  fl.push(`[${n}:a]${layers.join('')}amix=inputs=${layers.length + 1}:normalize=0:duration=first,alimiter=limit=0.95[a]`)
  run(['-y', ...ins, '-filter_complex', fl.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', total.toFixed(2), final])
  run(['-y', '-ss', (beats[posterBeat].start + posterAt).toFixed(2), '-i', final, '-frames:v', '1', '-q:v', '3', final.replace(/\.mp4$/, '.jpg')])
  console.log('wrote', final)
  return { total }
}
