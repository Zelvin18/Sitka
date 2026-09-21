// Speech for the set: Priya's talk in the meeting, and the narrator's lines,
// spoken by the same natural voice Sitca uses (its /api/speak). Each
// paragraph is one request; the pieces are joined into one WAV with a short
// breath between them.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const SITE = process.env.SITE || 'https://sitcaai.vercel.app'
const which = process.argv[2] || 'priya'
const src = readFileSync(new URL(`./assets/${which}.txt`, import.meta.url), 'utf8')
const paras = src.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
mkdirSync(new URL('./assets/parts', import.meta.url), { recursive: true })

const wavs = []
for (let i = 0; i < paras.length; i++) {
  const out = new URL(`./assets/parts/${which}-${i}.wav`, import.meta.url)
  if (!existsSync(out)) {
    const r = await fetch(`${SITE}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: paras[i], lang: 'English', who: 'demo-' + which })
    })
    if (!r.ok) throw new Error(`speak ${i}: ${r.status} ${await r.text()}`)
    writeFileSync(out, Buffer.from(await r.arrayBuffer()))
    console.log('spoke', i, paras[i].slice(0, 50))
    // the voice service allows a steady pace, not a flood
    await new Promise((res) => setTimeout(res, 1200))
  }
  wavs.push(fileURLToPath(out))
}
// joined with 0.7 s of quiet between paragraphs, resampled to what a fake
// microphone expects (16-bit PCM, 48 kHz mono)
const list = fileURLToPath(new URL('./assets/parts/list.txt', import.meta.url))
const silence = fileURLToPath(new URL('./assets/parts/silence.wav', import.meta.url))
execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.7', silence], { stdio: 'ignore' })
writeFileSync(list, wavs.flatMap((w) => [`file '${w.replace(/\\/g, '/')}'`, `file '${silence.replace(/\\/g, '/')}'`]).join('\n'))
const final = fileURLToPath(new URL(`./assets/${which}.wav`, import.meta.url))
execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', final], { stdio: 'inherit' })
console.log('wrote', final)
