import { createRequire } from 'module'
import { promises as fsp } from 'fs'
import { basename, extname } from 'path'

const TEXT_EXTS = ['.txt', '.md', '.csv', '.json', '.vtt', '.srt']

/** Extract plain text from material bytes (used for files picked in the renderer). */
export async function extractMaterialFromBuffer(
  name: string,
  buf: Buffer
): Promise<{ name: string; text: string } | { error: string }> {
  const ext = extname(name).toLowerCase()
  try {
    if (TEXT_EXTS.includes(ext)) {
      return { name, text: buf.toString('utf-8').slice(0, 200000) }
    }
    if (ext === '.pdf') {
      try {
        const req = createRequire(__filename)
        const pdfParse = req('pdf-parse') as (b: Buffer) => Promise<{ text: string }>
        const parsed = await pdfParse(buf)
        const text = (parsed.text ?? '').trim()
        if (!text) return { error: `No extractable text in ${name} (scanned PDF?).` }
        return { name, text: text.slice(0, 200000) }
      } catch {
        return {
          error: 'PDF support needs a fresh "npm install" — or paste the text instead.'
        }
      }
    }
    return {
      error: `Unsupported file type ${ext || '(none)'} — use PDF, TXT, or MD, or paste the text.`
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Extract plain text from an event material file on disk. */
export async function extractMaterialText(
  filePath: string
): Promise<{ name: string; text: string } | { error: string }> {
  try {
    return await extractMaterialFromBuffer(basename(filePath), await fsp.readFile(filePath))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
