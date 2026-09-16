/**
 * What Sitka knows about the person it is helping, for a system prompt.
 * Their first name, used sparingly and only where it is warm: a word of
 * encouragement in practice, a greeting. Never in every reply, and never
 * to a third party.
 */
export function personNote(name: string | null | undefined): string {
  const n = (name || '').trim()
  if (!n || n.includes('@')) return ''
  const first = n.split(/\s+/)[0]
  return `The person you are helping is called ${n}. Call them ${first} now and then, only where it is natural and kind — encouragement, a greeting, a well-done — never in every answer and never in documents or notes meant for others.`
}
