// Saving a session to the person's own Google Drive.
//
// Google is asked for leave to write files this app made (the drive.file
// scope: nothing else in their Drive is visible to Sitca), a "Sitca" folder
// is found or made, the recording goes up in pieces straight from the
// store that holds it, and a Google Doc is written with the overview, the
// notes and the transcript. Nothing passes through Sitca's server.

import { GOOGLE_CLIENT_ID } from './googleSignIn'

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const FOLDER = 'Sitca'
/** each piece sent to Drive: a multiple of 256 KB, as Drive requires */
const PIECE = 8 * 1024 * 1024

interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void
}
type OAuthWindow = Window & {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient(o: {
          client_id: string
          scope: string
          callback: (r: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => void
          error_callback?: (e: { type?: string; message?: string }) => void
        }): TokenClient
      }
    }
  }
}

let token: { value: string; until: number } | null = null

function script(): Promise<void> {
  const w = window as OAuthWindow
  if (w.google?.accounts?.oauth2) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => ((window as OAuthWindow).google?.accounts?.oauth2 ? resolve() : reject(new Error('Google did not load.')))
    s.onerror = () => reject(new Error('Google did not load. Check the connection.'))
    document.head.appendChild(s)
  })
}

/** Leave to write to Drive, asked once per visit (Google shows its own window). */
export async function driveToken(): Promise<string> {
  if (token && token.until > Date.now() + 60000) return token.value
  await script()
  const oauth2 = (window as OAuthWindow).google?.accounts?.oauth2
  if (!oauth2) throw new Error('Google did not load.')
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.access_token) {
          token = { value: r.access_token, until: Date.now() + (r.expires_in ?? 3600) * 1000 }
          resolve(r.access_token)
        } else reject(new Error(r.error_description || r.error || 'Google did not allow it.'))
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'The Google window was closed.' : e.message || 'Google did not allow it.'))
    })
    client.requestAccessToken({ prompt: '' })
  })
}

async function api(t: string, path: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, ...(init.headers as Record<string, string> | undefined) }
  })
  if (r.status === 401) token = null
  return r
}

/** The "Sitca" folder in the person's Drive: found, or made. */
export async function sitcaFolder(t: string): Promise<{ id: string; url: string }> {
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`)
  const found = await api(t, `files?q=${q}&fields=files(id)&pageSize=1`)
  if (!found.ok) throw new Error(`Drive said ${found.status}.`)
  const j = (await found.json()) as { files?: { id: string }[] }
  let id = j.files?.[0]?.id
  if (!id) {
    const made = await api(t, 'files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' })
    })
    if (!made.ok) throw new Error(`Drive would not make the folder (${made.status}).`)
    id = ((await made.json()) as { id: string }).id
  }
  return { id, url: `https://drive.google.com/drive/folders/${id}` }
}

/** One source of bytes: a whole file by its link, or parts in order. */
export interface Source {
  url: string
  size: number
}

/**
 * The recording, sent up in pieces as it is read from its store. Drive's
 * resumable upload takes the pieces one after another and joins them; a
 * piece that fails is sent again.
 */
export async function uploadRecording(
  t: string,
  folderId: string,
  name: string,
  mime: string,
  sources: Source[],
  onProgress: (sentBytes: number, totalBytes: number) => void
): Promise<{ id: string; url: string }> {
  const total = sources.reduce((n, s) => n + s.size, 0)
  if (total <= 0) throw new Error('There is no recording to send.')
  const start = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(total)
    },
    body: JSON.stringify({ name, parents: [folderId] })
  })
  if (!start.ok) throw new Error(`Drive would not start the upload (${start.status}).`)
  const session = start.headers.get('Location')
  if (!session) throw new Error('Drive gave no upload address.')

  let sent = 0
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let fileId = ''
  const put = async (bytes: Uint8Array, last: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(session, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${sent}-${sent + bytes.byteLength - 1}/${total}` },
        body: new Blob([bytes.slice().buffer as ArrayBuffer])
      }).catch(() => null)
      if (r && (r.status === 308 || r.ok)) {
        if (r.ok) fileId = ((await r.json().catch(() => ({}))) as { id?: string }).id ?? ''
        sent += bytes.byteLength
        onProgress(sent, total)
        return
      }
      if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new Error(`Drive refused a piece (${r.status}).`)
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)))
    }
    throw new Error(last ? 'The last piece could not be sent.' : 'A piece could not be sent. Check the connection and try again.')
  }
  const flush = async (all: boolean): Promise<void> => {
    while (pendingBytes >= PIECE || (all && pendingBytes > 0)) {
      const take = all && pendingBytes < PIECE ? pendingBytes : PIECE
      const out = new Uint8Array(take)
      let at = 0
      while (at < take) {
        const head = pending[0]
        const n = Math.min(head.byteLength, take - at)
        out.set(head.subarray(0, n), at)
        at += n
        if (n === head.byteLength) pending.shift()
        else pending[0] = head.subarray(n)
      }
      pendingBytes -= take
      await put(out, all && pendingBytes === 0)
    }
  }
  for (const s of sources) {
    // one part at a time, in slices, so a long recording never sits whole in memory
    const SLICE = 16 * 1024 * 1024
    for (let from = 0; from < s.size; from += SLICE) {
      const to = Math.min(s.size, from + SLICE) - 1
      const r = await fetch(s.url, { headers: { Range: `bytes=${from}-${to}` }, cache: 'no-store' })
      if (!r.ok) throw new Error(`The recording could not be read (${r.status}).`)
      const buf = new Uint8Array(await r.arrayBuffer())
      // a store that ignores the range hands back everything: take only this slice
      const piece = r.status === 200 && buf.byteLength > to - from + 1 ? buf.subarray(from, to + 1) : buf
      pending.push(piece)
      pendingBytes += piece.byteLength
      await flush(false)
    }
  }
  await flush(true)
  pending = []
  return { id: fileId, url: fileId ? `https://drive.google.com/file/d/${fileId}/view` : '' }
}

/** A Google Doc from HTML, in the folder. */
export async function createDoc(t: string, folderId: string, name: string, html: string): Promise<{ id: string; url: string }> {
  const boundary = 'sitca' + Math.random().toString(36).slice(2)
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/vnd.google-apps.document' })
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  })
  if (!r.ok) throw new Error(`Drive would not write the document (${r.status}).`)
  const id = ((await r.json()) as { id: string }).id
  return { id, url: `https://docs.google.com/document/d/${id}/edit` }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Markdown of the simple kind Sitca writes, as HTML a Doc keeps the shape of. */
export function simpleHtml(md: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const inline = (t: string): string => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[\[(\d+:\d{2}(?::\d{2})?)\]\]/g, '($1)')
  const close = (): void => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line) {
      close()
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/)
    const ul = line.match(/^[-*•]\s+(.+)$/)
    const ol = line.match(/^\d+[.)]\s+(.+)$/)
    if (h) {
      close()
      const n = Math.min(4, h[1].length + 1)
      out.push(`<h${n}>${inline(h[2])}</h${n}>`)
    } else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        close()
        list = kind
        out.push(`<${kind}>`)
      }
      out.push(`<li>${inline((ul || ol)![1])}</li>`)
    } else {
      close()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  close()
  return out.join('\n')
}

export const fmtClock = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
