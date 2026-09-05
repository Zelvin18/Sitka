/**
 * Memory engine logic shared by the desktop main process and the web app:
 * how durable facts are asked for, and how a new session's findings merge
 * into what Sitka already remembers. Pure — no platform dependencies.
 */
import type { MemoryKind, MemoryObject, SessionKind, TranscriptSegment } from './types'

export interface MemoryExtraction {
  decisions?: { title?: string; detail?: string; time?: string }[]
  commitments?: { title?: string; who?: string; due?: string | null; time?: string }[]
  people?: { title?: string; detail?: string; time?: string }[]
  concepts?: { title?: string; detail?: string; time?: string }[]
  updates?: {
    id?: string
    change?: 'reaffirmed' | 'changed' | 'done' | 'progress'
    note?: string
    time?: string
  }[]
}

function fmt(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function memoryTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${fmt(s.start)}] ${s.text.trim()}`).join('\n')
}

export function memorySystemPrompt(
  kind: SessionKind | undefined,
  existing: MemoryObject[],
  today: string
): string {
  const focus =
    kind === 'meeting'
      ? 'This was a MEETING: prioritise decisions, commitments and people.'
      : kind === 'lecture'
        ? 'This was a LECTURE: prioritise concepts; include people only when named and relevant.'
        : kind === 'presentation'
          ? 'This was a PRESENTATION: prioritise concepts, decisions and announcements.'
          : 'Extract whatever kinds genuinely apply.'
  const existingList = existing
    .filter((o) => o.status !== 'done')
    .slice(0, 120)
    .map((o) => `${o.id}: [${o.kind}] ${o.title}`)
    .join('\n')
  return [
    'You maintain a personal memory of durable facts from sessions someone attended. From this session transcript, extract:',
    '- decisions: things that were decided. title = 4-8 words naming the topic; detail = one sentence with the decision and the reason given; time = the transcript timestamp where it was decided.',
    '- commitments: promises or action items. title = what will be done; who = the person or role responsible; due = YYYY-MM-DD when a date or day was stated (resolve relative dates using today), else null; time.',
    '- people: people who matter in this session. title = their name; detail = what they care about, worry about, or asked for; time.',
    '- concepts: important ideas that were taught or explained. title = the term; detail = a one-line explanation as given; time.',
    focus,
    existingList
      ? `Existing memory items (id: [kind] title):\n${existingList}\nIf this session revisits one of them, do NOT duplicate it — put it in "updates": {"id", "change": "reaffirmed" | "changed" | "done" | "progress", "note": one sentence on what happened now, "time"}. Use "changed" when a decision now differs from before, "done" when a commitment was completed, "progress" for partial progress, "reaffirmed" when restated.`
      : '',
    `Rules: only durable facts (skip small talk and trivia); at most 8 per list; copy times exactly from the transcript; plain text, no markdown; today is ${today}.`,
    'Return ONLY JSON: {"decisions": [], "commitments": [], "people": [], "concepts": [], "updates": []}'
  ]
    .filter(Boolean)
    .join('\n')
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Merge a session's extraction into the existing memory. Returns the new full list. */
export function mergeMemory(
  existing: MemoryObject[],
  parsed: MemoryExtraction,
  session: { id: string; title: string },
  makeId: () => string
): MemoryObject[] {
  const now = Date.now()
  const list = existing.map((o) => ({ ...o, timeline: [...o.timeline] }))
  const byId = new Map(list.map((o) => [o.id, o]))
  const seen = new Set(list.map((o) => `${o.kind}:${norm(o.title)}`))

  for (const u of parsed.updates ?? []) {
    const obj = u.id ? byId.get(u.id) : undefined
    if (!obj || !u.note) continue
    obj.timeline.push({
      sessionId: session.id,
      sessionTitle: session.title,
      time: u.time || '0:00',
      note: u.note,
      at: now
    })
    if (u.change === 'changed') {
      obj.status = 'changed'
      obj.detail = u.note
    } else if (u.change === 'done') {
      obj.status = 'done'
    }
    obj.updatedAt = now
  }

  const add = (
    kind: MemoryKind,
    title: string | undefined,
    detail: string | undefined,
    time: string | undefined,
    extra: Partial<MemoryObject> = {}
  ): void => {
    const t = (title || '').trim()
    if (!t || t.length > 120) return
    const key = `${kind}:${norm(t)}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({
      id: makeId(),
      kind,
      title: t,
      detail: (detail || '').trim().slice(0, 400),
      timeline: [
        {
          sessionId: session.id,
          sessionTitle: session.title,
          time: time || '0:00',
          note: (detail || '').trim().slice(0, 400),
          at: now
        }
      ],
      createdAt: now,
      updatedAt: now,
      ...extra
    })
  }

  for (const d of (parsed.decisions ?? []).slice(0, 8)) {
    add('decision', d.title, d.detail, d.time, { status: 'open' })
  }
  for (const c of (parsed.commitments ?? []).slice(0, 8)) {
    add('commitment', c.title, c.who ? `${c.who}` : '', c.time, {
      status: 'open',
      owner: (c.who || '').trim().slice(0, 60) || undefined,
      due: c.due && /^\d{4}-\d{2}-\d{2}$/.test(c.due) ? c.due : undefined
    })
  }
  for (const p of (parsed.people ?? []).slice(0, 8)) add('person', p.title, p.detail, p.time)
  for (const k of (parsed.concepts ?? []).slice(0, 8)) add('concept', k.title, k.detail, k.time)

  return list
}
