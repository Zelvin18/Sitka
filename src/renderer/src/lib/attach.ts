import type { ChatAttachment } from '@shared/types'

const MAX_IMAGE_SIDE = 1600

/** A picture, downsized so it travels quickly and still reads clearly. */
async function shrinkImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not read the image.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.85)
}

/**
 * Turn a chosen file into something Sitka can read with the question: images
 * become pictures, documents become text through the same reader Materials
 * uses (PDF, text, notes, captions).
 */
export async function fileToAttachment(file: File): Promise<ChatAttachment | { error: string }> {
  const id = crypto.randomUUID()
  if (file.type.startsWith('image/')) {
    try {
      return { id, name: file.name, kind: 'image', dataUrl: await shrinkImage(file) }
    } catch {
      return { error: `${file.name} could not be read as an image.` }
    }
  }
  try {
    const res = await window.sitka.extractMaterial(file.name, await file.arrayBuffer())
    if ('error' in res) return { error: res.error }
    if (!res.text.trim()) return { error: `${file.name} has no readable text.` }
    return { id, name: res.name, kind: 'document', text: res.text }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
