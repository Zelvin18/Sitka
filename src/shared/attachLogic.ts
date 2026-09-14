import type { ChatAttachment } from './types'

/** What the + button accepts: pictures, and the document types Materials already reads. */
export const ATTACH_ACCEPT = 'image/*,.pdf,.txt,.md,.csv,.json,.vtt,.srt'
export const MAX_ATTACHMENTS = 6
export const MAX_DOC_CHARS = 60000

/**
 * Fold a question's attachments into what the model receives: documents go in
 * as text ahead of the question, images are returned to be sent as pictures
 * with a note that says where they came from.
 */
export function foldAttachments(
  question: string,
  attachments?: ChatAttachment[]
): { question: string; images: string[]; imageNote: string } {
  const all = attachments ?? []
  const docs = all.filter((a) => a.kind === 'document' && a.text)
  const images = all
    .filter((a) => a.kind === 'image' && a.dataUrl)
    .map((a) => a.dataUrl as string)
  const docBlock = docs
    .map((d) => `Attached document "${d.name}":\n${(d.text ?? '').slice(0, MAX_DOC_CHARS)}`)
    .join('\n\n')
  const screenFrames = all.filter((a) => a.kind === 'image' && a.dataUrl && a.from === 'screen')
  const imageNote =
    images.length === 0
      ? ''
      : screenFrames.length === images.length
        ? `(The attached ${images.length === 1 ? 'image is' : 'images are'} what was on screen earlier in this session, at ${screenFrames.map((a) => a.name.replace(/^On screen at /, '')).join(' and ')}. ${images.length === 1 ? 'It was' : 'They were'} fetched back because the question refers to that moment. Read ${images.length === 1 ? 'it' : 'them'} carefully: quote text, tables, lists and figures exactly as they appear, and say which moment each comes from.)`
        : `(The user attached ${images.length === 1 ? 'an image' : `${images.length} images`} to this question. Read what is in ${images.length === 1 ? 'it' : 'them'} carefully and use it in the answer.)`
  return {
    question: docBlock ? `${docBlock}\n\n${question}` : question,
    images,
    imageNote
  }
}

/** The line added under the user's bubble so the conversation shows what was attached. */
export function attachedLine(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return ''
  const files = attachments.filter((a) => a.from !== 'screen')
  const frames = attachments.filter((a) => a.from === 'screen')
  const parts: string[] = []
  if (files.length) parts.push(`Attached: ${files.map((a) => a.name).join(', ')}`)
  if (frames.length) {
    parts.push(`Looked back at the screen: ${frames.map((a) => a.name.replace(/^On screen at /, '')).join(', ')}`)
  }
  return `\n\n${parts.join(' · ')}`
}
