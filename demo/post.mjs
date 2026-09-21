// The cut: from the films and marks the recorder left, the story in order —
// each scene trimmed to its moment, the phone framed on a dark stage, Priya's
// voice under the meeting, music if a track is dropped in assets/music.mp3,
// and a second version with the narrator. Out: out/sitca-demo.mp4 (+ -voice).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const run = (args, quiet = true) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', quiet ? 'error' : 'info', ...args], { stdio: quiet ? 'pipe' : 'inherit' })
const duration = (file) => {
  try {
    execFileSync(ffmpeg, ['-i', file], { stdio: 'pipe' })
  } catch (e) {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr))
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return 0
}
const W = 1920
const H = 1080
const FPS = 30
const { marks, films } = JSON.parse(readFileSync(here('./out/marks.json'), 'utf8'))
mkdirSync(here('./out/cut'), { recursive: true })

// each film: its clock's offset into the file, from its close mark
const film = {}
for (const f of films) {
  const close = marks.find((m) => m.page === f.page && m.name === 'close')
  const len = duration(f.path)
  const offset = close ? len - close.t : 0
  film[f.page] = { path: f.path, len, offset }
}
const at = (page, name) => marks.find((m) => m.page === page && m.name === name)?.t
const has = (page, name) => at(page, name) !== undefined

// ---------- the story ----------
// { page, from, to } in mark names, with +/- seconds; a scene whose marks are
// missing (a shorter take) is skipped
const STORY = [
  { page: 'gate', from: ['gate', -0.2], to: ['google-end', -0.3] },
  { page: 'meet', from: ['meet', 0], to: ['meet', 2.6] },
  { page: 'app', from: ['home', 0], to: ['setup', -0.4] },
  { page: 'app', from: ['setup', 0.6], to: ['recording', 8] },
  { page: 'app', from: ['theatre', -1.2], to: ['ask', 9.5] },
  { page: 'app', from: ['ask-end', -1.5], to: ['theatre-end', 0.3] },
  { page: 'app', from: ['notes', -1.0], to: ['notes', 3.2] },
  { page: 'app', from: ['notes-later', 0], to: ['catchup', 7.5] },
  { page: 'app', from: ['catchup-end', -3], to: ['catchup-end', 0.2] },
  { page: 'app', from: ['end', -1.2], to: ['end', 3] },
  { page: 'app', from: ['session', -0.4], to: ['drive', 0] },
  { page: 'app', from: ['drive', 0], to: ['drive', 5.5] },
  { page: 'drive', from: ['drive-open', 0], to: ['drive-end', 0] },
  { page: 'app', from: ['share', -1.0], to: ['share-end', 0.2] },
  { page: 'whatsapp', from: ['whatsapp', 1.0], to: ['whatsapp-end', 0] },
  { page: 'phone', from: ['recap', -0.2], to: ['recap', 5], phone: true },
  { page: 'phone', from: ['recap-ask', -1.5], to: ['recap-ask', 10.5], phone: true }
]

const pieces = []
let storyT = 0
const timeline = [] // where each scene lands in the finished film
for (const [i, s] of STORY.entries()) {
  const f = film[s.page]
  if (!f || !has(s.page, s.from[0]) || !has(s.page, s.to[0])) {
    console.log('skip', s.page, s.from[0])
    continue
  }
  const from = Math.max(0, at(s.page, s.from[0]) + s.from[1] + f.offset)
  const to = Math.min(f.len, at(s.page, s.to[0]) + s.to[1] + f.offset)
  if (to <= from) continue
  const out = here(`./out/cut/${String(i).padStart(2, '0')}-${s.page}.mp4`)
  // the phone stands on a dark stage, its own picture blurred large behind it
  const vf = s.phone
    ? `[0:v]crop=iw:ih-84:0:0,split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:8,eq=brightness=-0.25[bg];[b]scale=-2:${H - 80}[ph];[bg][ph]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},format=yuv420p`
  run(['-y', '-ss', from.toFixed(3), '-to', to.toFixed(3), '-i', f.path, ...(s.phone ? ['-filter_complex', vf] : ['-vf', vf]), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', out])
  const len = to - from
  timeline.push({ scene: s, start: storyT, len, filmFrom: from - f.offset })
  storyT += len
  pieces.push(out)
  console.log(`cut ${s.page} ${s.from[0]} → ${s.to[0]}: ${len.toFixed(1)}s`)
}

// joined
const list = here('./out/cut/list.txt')
writeFileSync(list, pieces.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
const silent = here('./out/cut/silent.mp4')
run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent])
console.log(`joined: ${storyT.toFixed(1)}s`)

// ---------- sound ----------
// Priya's voice sits under the scenes that happen while she talks: each such
// scene shows a slice of the meeting, and the slice of her voice that matches
const rec = at('app', 'recording')
const audioInputs = []
const filters = []
let n = 0
const voice = here('./assets/priya.wav')
for (const t of timeline) {
  if (t.scene.page !== 'app' || rec === undefined) continue
  const meetingFrom = t.filmFrom - rec // seconds into Priya's talk when this scene begins
  if (meetingFrom < -2 || meetingFrom > 150) continue
  audioInputs.push('-i', voice)
  n++
  filters.push(`[${n}:a]atrim=start=${Math.max(0, meetingFrom).toFixed(3)}:end=${(Math.max(0, meetingFrom) + t.len).toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.55,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, t.len - 0.6).toFixed(3)}:d=0.6,adelay=${Math.round(t.start * 1000)}|${Math.round(t.start * 1000)}[v${n}]`)
}
const music = here('./assets/music.mp3')
let musicIdx = 0
if (existsSync(music)) {
  audioInputs.push('-stream_loop', '-1', '-i', music)
  n++
  musicIdx = n
  filters.push(`[${n}:a]atrim=end=${storyT.toFixed(2)},volume=0.16,afade=t=out:st=${(storyT - 2.5).toFixed(2)}:d=2.5[mu]`)
}
const mixIn = [...Array.from({ length: n - (musicIdx ? 1 : 0) }, (_, i) => `[v${i + 1}]`), ...(musicIdx ? ['[mu]'] : [])]
const final = here('./out/sitca-demo.mp4')
if (mixIn.length > 0) {
  // a bed of silence the whole length first: the mix then starts at zero
  // and runs to the end whatever the pieces' own timings
  audioInputs.push('-f', 'lavfi', '-t', storyT.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo')
  n++
  filters.push(`${['[' + n + ':a]', ...mixIn].join('')}amix=inputs=${mixIn.length + 1}:normalize=0:duration=first[a]`)
  run(['-y', '-i', silent, ...audioInputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', storyT.toFixed(2), final])
} else {
  run(['-y', '-i', silent, '-c', 'copy', final])
}
console.log('wrote', final)

// ---------- with the narrator ----------
// one line per scene in assets/narration.txt (scene index: text), spoken by
// gen-voice into assets/parts/narration-N.wav and laid at each scene's start
const narr = here('./assets/narration.txt')
if (existsSync(narr)) {
  const lines = readFileSync(narr, 'utf8').split('\n').filter((l) => /^\d+:/.test(l))
  const ins = []
  const fl = []
  let k = 0
  for (const l of lines) {
    const idx = Number(l.split(':')[0])
    const wav = here(`./assets/parts/narration-${idx}.wav`)
    const t = timeline.find((x) => STORY.indexOf(x.scene) === idx)
    if (!t || !existsSync(wav)) continue
    ins.push('-i', wav)
    k++
    fl.push(`[${k}:a]volume=1.0,adelay=${Math.round((t.start + 0.3) * 1000)}|${Math.round((t.start + 0.3) * 1000)}[n${k}]`)
  }
  if (k > 0) {
    fl.push(`[0:a]volume=0.6[base];[base]${Array.from({ length: k }, (_, i) => `[n${i + 1}]`).join('')}amix=inputs=${k + 1}:normalize=0[a]`)
    const out = here('./out/sitca-demo-voice.mp4')
    run(['-y', '-i', final, ...ins, '-filter_complex', fl.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', out])
    console.log('wrote', out)
  }
}
writeFileSync(here('./out/timeline.json'), JSON.stringify(timeline, null, 2))
