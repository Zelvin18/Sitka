/**
 * Session materials: the slides, notes or readings a user shares so Sitka
 * knows what a session is about before and while it happens. Shared prompt
 * plumbing for desktop and web.
 */

export interface MaterialText {
  name: string
  text: string
}

export const MATERIALS_HEADER = [
  'Materials the user shared for this session (slides, notes, readings, an agenda).',
  'Use them to understand what the session is about and where it is heading, to anticipate what comes next, to get names, terms, figures and definitions exactly right, and to answer questions the spoken words alone cannot.',
  'The transcript is what was actually said. When the materials and the transcript disagree, say so rather than silently picking one.'
].join('\n')

/** Concatenated, capped material text for a prompt — '' when there are none. */
export function materialsText(materials: MaterialText[], cap = 24000): string {
  let out = ''
  for (const m of materials) {
    const chunk = `--- ${m.name} ---\n${m.text.trim()}\n\n`
    if (out.length + chunk.length > cap) {
      out += chunk.slice(0, Math.max(0, cap - out.length)) + '\n… (trimmed)'
      break
    }
    out += chunk
  }
  return out.trim()
}

/** A full prompt section, or '' when there is nothing to add. */
export function materialsBlock(materials: MaterialText[], cap = 24000): string {
  const text = materialsText(materials, cap)
  return text ? `${MATERIALS_HEADER}\n\n${text}` : ''
}

/** Join event materials (hosted events) and session materials for one prompt. */
export function joinMaterials(...parts: (string | null | undefined)[]): string | null {
  const joined = parts.filter((p): p is string => Boolean(p && p.trim())).join('\n\n')
  return joined || null
}

/** Rough size label for the materials list ("about 2,300 words"). */
export function sizeLabel(chars: number): string {
  const words = Math.max(1, Math.round(chars / 6))
  if (words < 1000) return `about ${words} words`
  return `about ${(words / 1000).toFixed(words < 10000 ? 1 : 0)}k words`
}
