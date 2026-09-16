/**
 * The notes of a session or the brief of an event, as a file to keep: a PDF
 * in the Editorial style, with no timestamps in it. On screen a moment cites
 * its second so it can be jumped to; on paper a time means nothing, so the
 * words are kept and the clock is left out.
 */
import { markdownToPdf } from '../../src/renderer/src/lib/pdf'

/** the clock references Sitka's writing carries, removed */
export function withoutTimes(md: string): string {
  return md
    .replace(/\[\[(?:[a-fA-F0-9-]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?\]\]/g, '')
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '')
    .replace(/\((?:at |around )?\d{1,2}:\d{2}(?::\d{2})?\)/g, '')
    .replace(/\b(?:at|around|from|by)\s+\d{1,2}:\d{2}(?::\d{2})?(?!\s*(?:am|pm|AM|PM))\b/g, '')
    .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*[—–-]\s*/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.;:])/g, '$1')
    .replace(/\( *\)/g, '')
}

export interface NotesParts {
  title: string
  /** a date, a duration: the line under the title */
  subtitle?: string
  summary?: string
  moments?: string[]
  notes?: string
  /** the section title for the notes: "Notes", "Your brief" */
  notesLabel?: string
  /** the presenter's or the host's words, when the reader should have them too */
  extra?: { label: string; text: string }[]
}

export function notesMarkdown(p: NotesParts): string {
  const parts: string[] = []
  if (p.summary?.trim()) parts.push('## Summary', withoutTimes(p.summary.trim()))
  if (p.moments && p.moments.length) parts.push('## Key moments', ...p.moments.map((m) => `- ${withoutTimes(m)}`))
  if (p.notes?.trim()) parts.push(`## ${p.notesLabel ?? 'Notes'}`, withoutTimes(p.notes.trim()))
  for (const e of p.extra ?? []) if (e.text.trim()) parts.push(`## ${e.label}`, withoutTimes(e.text.trim()))
  return parts.join('\n\n')
}

/** the PDF bytes */
export function notesPdf(p: NotesParts): Uint8Array {
  return markdownToPdf(p.title, notesMarkdown(p), 'editorial', { subtitle: p.subtitle, byline: 'Kept with Sitka' })
}

/** hand the file to the browser to save */
export function downloadBytes(name: string, bytes: Uint8Array, type = 'application/pdf'): void {
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export const fileName = (title: string): string => (title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'notes') + '.pdf'
