import { shrinkImageFile } from './attach'

/**
 * Any chosen file, read into text Sitca can use: documents through the
 * reader Materials has always used, pictures (a slide, a page, a whiteboard,
 * a poster) through the vision model, which writes down what they say.
 */
export async function readFileToText(file: File): Promise<{ name: string; text: string } | { error: string }> {
  if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name)) {
    let dataUrl: string
    try {
      dataUrl = await shrinkImageFile(file, 1600, 0.85)
    } catch {
      return { error: `${file.name} could not be read as a picture.` }
    }
    const res = await window.sitka.readImage(dataUrl)
    if (res.error) return { error: res.error }
    if (!res.text.trim()) return { error: `Nothing readable was found in ${file.name}.` }
    const name = /^image\.|^blob$|^capture/i.test(file.name) || !file.name ? `Photo · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : file.name
    return { name, text: res.text }
  }
  const res = await window.sitka.extractMaterial(file.name, await file.arrayBuffer())
  if ('error' in res) return { error: res.error }
  if (!res.text.trim()) return { error: `${file.name} has no readable text.` }
  return { name: res.name, text: res.text }
}

/** A name for pasted text: its first line, or the first few words. */
export function nameForPaste(text: string): string {
  const first = text.trim().split(/\n/)[0]?.replace(/^[#*\-\s]+/, '').trim() ?? ''
  const short = first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, '') + '…' : first
  return short || 'Pasted notes'
}
