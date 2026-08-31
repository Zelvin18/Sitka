import { spawn } from 'child_process'
import { createRequire } from 'module'
import { existsSync, renameSync, statSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { videoPath } from './store'

/**
 * Resolve the bundled ffmpeg binary. Returns null when ffmpeg-static is not
 * installed (the app then simply keeps the un-remuxed recording).
 */
export function resolveFfmpeg(): string | null {
  try {
    const req = createRequire(__filename)
    let p = req('ffmpeg-static') as string | null
    if (!p) return null
    // Inside a packaged app the binary lives outside the asar archive.
    p = p.replace('app.asar', 'app.asar.unpacked')
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * Rewrite a session's MediaRecorder webm with a proper seek index (duration +
 * cues). Stream copy only — no re-encoding, so it takes seconds. Returns true
 * when the file was replaced.
 */
export async function remuxSession(id: string): Promise<boolean> {
  const ffmpeg = resolveFfmpeg()
  const src = videoPath(id)
  if (!ffmpeg || !existsSync(src)) return false
  const tmp = join(dirname(src), 'video.remux.webm')

  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpeg, ['-y', '-i', src, '-c', 'copy', tmp], {
      windowsHide: true
    })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })

  try {
    if (!ok || !existsSync(tmp) || statSync(tmp).size === 0) {
      if (existsSync(tmp)) unlinkSync(tmp)
      return false
    }
    renameSync(tmp, src)
    return true
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* noop */
    }
    return false
  }
}
