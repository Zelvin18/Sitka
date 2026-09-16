import { spawn } from 'child_process'
import { createRequire } from 'module'
import { closeSync, existsSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'fs'
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

/** The container a recording is in, from its first bytes: MP4 (sound alone is recorded as AAC in MP4) or WebM. */
export function containerOf(file: string): 'mp4' | 'webm' {
  try {
    const fd = openSync(file, 'r')
    const head = Buffer.alloc(12)
    readSync(fd, head, 0, 12, 0)
    closeSync(fd)
    return head.subarray(4, 8).toString('latin1') === 'ftyp' ? 'mp4' : 'webm'
  } catch {
    return 'webm'
  }
}

/**
 * Rewrite a session's MediaRecorder file with a proper seek index (duration +
 * cues, or the MP4 index moved to the front). Stream copy only — no
 * re-encoding, so it takes seconds. Returns true when the file was replaced.
 */
export async function remuxSession(id: string): Promise<boolean> {
  const ffmpeg = resolveFfmpeg()
  const src = videoPath(id)
  if (!ffmpeg || !existsSync(src)) return false
  // the output keeps the recording's own container: AAC cannot go into WebM
  const kind = containerOf(src)
  const tmp = join(dirname(src), kind === 'mp4' ? 'video.remux.mp4' : 'video.remux.webm')

  const ok = await new Promise<boolean>((resolve) => {
    const args = kind === 'mp4' ? ['-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', tmp] : ['-y', '-i', src, '-c', 'copy', tmp]
    const proc = spawn(ffmpeg, args, {
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
