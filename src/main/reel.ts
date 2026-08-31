import { spawn } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as store from './store'
import { resolveFfmpeg } from './remux'

const CLIP_LEAD_SEC = 3
const CLIP_LENGTH_SEC = 20
const MAX_CLIPS = 8

function parseTs(ts: string): number | null {
  const parts = ts.split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

function runFfmpeg(ffmpeg: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true, cwd })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
}

/** Collect key moments (user marks + AI highlights + important notes) as seconds. */
function collectMoments(id: string): number[] {
  const meta = store.getMeta(id)
  const out = new Set<number>()
  for (const t of store.getMarks(id)) out.add(t)
  for (const h of meta?.highlights ?? []) {
    const s = parseTs(h.time)
    if (s !== null) out.add(s)
  }
  const notes = store.getNotes(id)
  for (const m of notes?.moments ?? []) {
    if (m.kind === 'important') {
      const s = parseTs(m.time)
      if (s !== null) out.add(s)
    }
  }
  return [...out].sort((a, b) => a - b)
}

export async function generateReel(id: string): Promise<{ error?: string }> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) return { error: 'ffmpeg is not available — run npm install first.' }
  const src = store.videoPath(id)
  if (!existsSync(src)) return { error: 'Recording not found.' }
  const meta = store.getMeta(id)
  const durationSec = meta ? meta.durationMs / 1000 : Infinity

  const moments = collectMoments(id)
  if (moments.length === 0) {
    return { error: 'No key moments yet — mark moments or wait for the summary.' }
  }

  // Build clip windows around each moment and merge overlaps.
  const windows: { start: number; end: number }[] = []
  for (const t of moments) {
    const start = Math.max(0, t - CLIP_LEAD_SEC)
    const end = Math.min(durationSec, start + CLIP_LENGTH_SEC)
    const last = windows[windows.length - 1]
    if (last && start <= last.end + 2) {
      last.end = Math.max(last.end, end)
    } else {
      windows.push({ start, end })
    }
  }
  const clips = windows.slice(0, MAX_CLIPS).filter((w) => w.end - w.start >= 2)
  if (clips.length === 0) return { error: 'Key moments are too close to the end of the recording.' }

  const tmpDir = join(store.sessionsRoot(), id, 'reel-tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  try {
    // Re-encode each clip (stream-copy cuts glitch on non-keyframes).
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      const ok = await runFfmpeg(ffmpeg, [
        '-y',
        '-ss',
        c.start.toFixed(2),
        '-i',
        src,
        '-t',
        (c.end - c.start).toFixed(2),
        '-c:v',
        'libvpx',
        '-b:v',
        '1200k',
        '-cpu-used',
        '5',
        '-deadline',
        'realtime',
        '-c:a',
        'libvorbis',
        join(tmpDir, `clip${i}.webm`)
      ])
      if (!ok) return { error: 'Could not render one of the highlight clips.' }
    }

    const listFile = join(tmpDir, 'list.txt')
    writeFileSync(
      listFile,
      clips.map((_c, i) => `file 'clip${i}.webm'`).join('\n'),
      'utf-8'
    )
    const out = store.reelPath(id)
    const ok = await runFfmpeg(
      ffmpeg,
      ['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', out],
      tmpDir
    )
    if (!ok || !existsSync(out)) return { error: 'Could not stitch the highlight reel.' }

    if (meta) {
      meta.reelGeneratedAt = Date.now()
      store.saveMeta(meta)
    }
    return {}
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
