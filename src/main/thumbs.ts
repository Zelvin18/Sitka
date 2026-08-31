import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import * as store from './store'
import { resolveFfmpeg } from './remux'

export const thumbPath = (id: string): string =>
  join(store.sessionsRoot(), id, 'thumb.jpg')

const inFlight = new Map<string, Promise<string | null>>()

/** Extracts a representative frame from the recording (once, cached on disk). */
export function ensureThumb(id: string): Promise<string | null> {
  const existing = inFlight.get(id)
  if (existing) return existing
  const task = generate(id).finally(() => inFlight.delete(id))
  inFlight.set(id, task)
  return task
}

async function generate(id: string): Promise<string | null> {
  const out = thumbPath(id)
  if (existsSync(out)) return out
  const ffmpeg = resolveFfmpeg()
  const src = store.videoPath(id)
  if (!ffmpeg || !existsSync(src)) return null
  const meta = store.getMeta(id)
  const durationSec = (meta?.durationMs ?? 0) / 1000
  // A few seconds in (or the midpoint of very short clips) avoids black frames.
  const at = durationSec > 8 ? 4 : Math.max(0.3, durationSec / 2)

  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      const proc = spawn(
        ffmpeg,
        ['-y', '-ss', at.toFixed(1), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', out],
        { windowsHide: true }
      )
      proc.on('error', () => resolve(false))
      proc.on('close', (code) => resolve(code === 0))
    })

  // A freshly finalized recording can still be settling on disk — retry once.
  let ok = await attempt()
  if (!ok || !existsSync(out)) {
    await new Promise((r) => setTimeout(r, 1500))
    ok = await attempt()
  }
  return ok && existsSync(out) ? out : null
}
