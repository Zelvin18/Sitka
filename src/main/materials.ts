import { createRequire } from 'module'
import { promises as fsp } from 'fs'
import { basename, extname } from 'path'

/** Extract plain text from an event material file. */
export async function extractMaterialText(
  filePath: string
): Promise<{ name: string; text: string } | { error: string }> {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  try {
    if (['.txt', '.md', '.csv', '.json', '.vtt', '.srt'].includes(ext)) {
      const text = await fsp.readFile(filePath, 'utf-8')
      return { name, text: text.slice(0, 200000) }
    }
    if (ext === '.pdf') {
      try {
        const req = createRequire(__filename)
        const pdfParse = req('pdf-parse') as (b: Buffer) => Promise<{ text: string }>
        const buf = await fsp.readFile(filePath)
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
