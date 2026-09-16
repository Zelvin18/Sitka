/**
 * The notes of a session or the brief of an event, as a file to keep: a PDF
 * in the Editorial style, with no timestamps in it. On screen a moment cites
 * its second so it can be jumped to; on paper a time means nothing, so the
 * words are kept and the clock is left out.
 */
import { briefToPdf } from '../../src/renderer/src/lib/pdf'

import { withoutTimes } from '../../src/shared/timesLogic'
export { withoutTimes }

export interface NotesParts {
  title: string
  /** a date, a duration: the line under the title */
  subtitle?: string
  /** what the document is: "Session notes", "Your brief" */
  label?: string
  /** the facts on the cover */
  date?: string
  length?: string
  kind?: string
  by?: string
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

/** the PDF bytes: the title exactly as the session has it, the summary set large, the moments numbered, the notes in full */
export function notesPdf(p: NotesParts): Uint8Array {
  const NL = String.fromCharCode(10)
  const body = [p.notes?.trim() ? withoutTimes(p.notes.trim()) : '', ...(p.extra ?? []).filter((e) => e.text.trim()).map((e) => `## ${e.label}${NL}${NL}${withoutTimes(e.text.trim())}`)]
    .filter(Boolean)
    .join(NL + NL)
  return briefToPdf({
    title: p.title,
    label: p.label ?? 'Session notes',
    facts: { date: p.date, length: p.length, kind: p.kind, by: p.by },
    summary: p.summary ? withoutTimes(p.summary) : undefined,
    moments: p.moments?.map(withoutTimes),
    body,
    bodyLabel: p.notesLabel ?? 'Notes',
    closing: 'Written by Sitka from what was said and shown. Nothing here was invented; where something was not covered, it says so.'
  })
}

/** the same as markdown, for a plain-text copy */
export function notesText(p: NotesParts): string {
  return `# ${p.title}${String.fromCharCode(10)}${String.fromCharCode(10)}${notesMarkdown(p)}`
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
