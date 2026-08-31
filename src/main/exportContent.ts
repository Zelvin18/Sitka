import type { SessionData } from '@shared/types'
import { formatTime } from './ai'

export type ExportKind = 'transcript' | 'notes' | 'study' | 'overview'

export function buildExport(data: SessionData, kind: ExportKind): string | null {
  const title = data.meta.title
  const dateLine = new Date(data.meta.createdAt).toLocaleString()

  if (kind === 'overview') {
    if (!data.meta.summary) return null
    const lines = [`# ${title}`, ``, `Recorded ${dateLine} with Sitka.`, ``, `## Summary`, ``, data.meta.summary]
    const highlights = data.meta.highlights ?? []
    if (highlights.length > 0) {
      lines.push(``, `## Key moments`, ``)
      lines.push(...highlights.map((h) => `- [${h.time}] ${h.label}`))
    }
    return lines.join('\n')
  }

  if (kind === 'transcript') {
    if (data.segments.length === 0) return null
    return [
      `# ${title} — Transcript`,
      ``,
      `Recorded ${dateLine} with Sitka.`,
      ``,
      ...data.segments.map((s) => `[${formatTime(s.start)}] ${s.text}`)
    ].join('\n')
  }

  if (kind === 'notes') {
    if (!data.notes || !data.notes.markdown) return null
    const important = data.notes.moments.filter((m) => m.kind === 'important')
    const questions = data.notes.moments.filter((m) => m.kind === 'question')
    const lines = [`# ${title} — Notes`, ``, `Recorded ${dateLine} with Sitka.`, ``]
    if (important.length > 0) {
      lines.push(`## Important points`, ``)
      lines.push(...important.map((m) => `- ⭐ [${m.time}] ${m.label}`), ``)
    }
    if (questions.length > 0) {
      lines.push(`## Questions asked`, ``)
      lines.push(...questions.map((m) => `- ❓ [${m.time}] ${m.label}`), ``)
    }
    lines.push(data.notes.markdown)
    return lines.join('\n')
  }

  if (kind === 'study') {
    const study = data.study
    if (!study) return null
    const lines = [`# ${title} — Study Pack`, ``, `Generated ${dateLine} with Sitka.`, ``]
    if (study.concepts.length > 0) {
      lines.push(`## Key concepts`, ``)
      lines.push(...study.concepts.map((c) => `- **${c.term}** — ${c.definition}`), ``)
    }
    if (study.flashcards.length > 0) {
      lines.push(`## Flashcards`, ``)
      study.flashcards.forEach((f, i) => {
        lines.push(`${i + 1}. **Q:** ${f.front}`, `   **A:** ${f.back}`, ``)
      })
    }
    if (study.quiz.length > 0) {
      lines.push(`## Quiz`, ``)
      study.quiz.forEach((q, i) => {
        lines.push(`${i + 1}. ${q.question}`)
        q.options.forEach((opt, oi) => {
          const letter = String.fromCharCode(65 + oi)
          lines.push(`   ${letter}. ${opt}`)
        })
        lines.push(
          `   Answer: ${String.fromCharCode(65 + q.answerIndex)}. ${q.explanation}`,
          ``
        )
      })
    }
    return lines.join('\n')
  }

  return null
}
