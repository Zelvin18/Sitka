// One live event's room, as its visitors' pages read it: the captions and
// their translations, the room chat, the host's notes, the poll and the
// questions put to the speaker.
//
// Everything is read through functions that take this event's id
// (sitka_feed, sitka_room, ...), so a visitor can read a room only by having
// its link; the tables themselves are closed to visitors. New lines arrive
// on the event's private channel (event:<id>), which only the database sends
// on. A database without those yet (the migration not run) is read the older
// way, table by table, so the pages work before and after it.

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

export interface Seg {
  idx: number
  start_sec?: number
  label?: string
  text: string
}
export interface Line {
  idx: number
  text: string
}
export interface Poll {
  id: string
  question: string
  options: string[]
  status: string
  /** votes per choice, by its index */
  tally?: Record<string, number>
}
export interface RoomMsg {
  id: string
  author?: string
  attendee_id?: string
  name: string
  host: boolean
  text: string
  created_at: string
}
export interface Note {
  id: string
  text: string
  created_at: string
}
export interface SharedQuestion {
  id: string
  refined: string | null
  text: string
  topic?: string | null
  votes: number
}

const missing = (e: { code?: string; message?: string } | null): boolean =>
  Boolean(e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|does not exist/i.test(e.message ?? '')))

export function roomReader(sb: SupabaseClient, eventId: string) {
  /** whether the database has the room's functions (unknown until it answers) */
  let fns: boolean | null = null
  async function call<T>(fn: string, args: Record<string, unknown>, older: () => Promise<T>, empty: T): Promise<T> {
    if (fns !== false) {
      const r = await sb.rpc(fn, args)
      if (!r.error) {
        fns = true
        return (r.data as T | null) ?? empty
      }
      if (!missing(r.error)) return empty
      fns = false
    }
    try {
      return await older()
    } catch {
      return empty
    }
  }

  return {
    /** captions after a line (and one language's translations after another); `tail`: the last few instead */
    async feed(o: { after?: number; lang?: string | null; afterTr?: number; limit?: number; tail?: number } = {}): Promise<{ segments: Seg[]; translations: Line[] }> {
      const empty = { segments: [] as Seg[], translations: [] as Line[] }
      return call(
        'sitka_feed',
        { p_event: eventId, p_after: o.after ?? -1, p_lang: o.lang ?? null, p_after_tr: o.afterTr ?? null, p_limit: o.limit ?? 200, p_tail: o.tail ?? null },
        async () => {
          let q = sb.from('segments').select('idx,start_sec,label,text').eq('event_id', eventId)
          const segs = o.tail
            ? ((await q.order('idx', { ascending: false }).limit(o.tail)).data ?? []).reverse()
            : ((await (q = q.gt('idx', o.after ?? -1)).order('idx', { ascending: true }).limit(o.limit ?? 200)).data ?? [])
          let trs: Line[] = []
          if (o.lang) {
            const { data } = await sb
              .from('translations')
              .select('idx,text')
              .eq('event_id', eventId)
              .eq('lang', o.lang)
              .gt('idx', o.afterTr ?? o.after ?? -1)
              .order('idx', { ascending: true })
              .limit(o.limit ?? 200)
            trs = (data ?? []) as Line[]
          }
          return { segments: segs as Seg[], translations: trs }
        },
        empty
      )
    },

    /** the room chat after a moment, by its anonymous tags */
    async room(since: string | null, limit: number): Promise<RoomMsg[]> {
      return call(
        'sitka_room',
        { p_event: eventId, p_since: since || null, p_limit: limit },
        async () => {
          const run = (cols: string) => {
            let q = sb.from('room_messages').select(cols).eq('event_id', eventId)
            if (since !== null) q = q.gt('created_at', since || '1970-01-01')
            return q.order('created_at', { ascending: true }).limit(limit)
          }
          let r = await run('id,author,name,host,text,created_at')
          if (r.error && /author/i.test(r.error.message)) r = await run('id,attendee_id,name,host,text,created_at')
          return (r.data ?? []) as unknown as RoomMsg[]
        },
        []
      )
    },

    /** the host's notes to the room after a moment */
    async notes(since: string): Promise<Note[]> {
      return call(
        'sitka_room_notes',
        { p_event: eventId, p_since: since },
        async () =>
          ((
            await sb
              .from('room_notes')
              .select('id,text,created_at')
              .eq('event_id', eventId)
              .gt('created_at', since)
              .order('created_at', { ascending: true })
              .limit(5)
          ).data ?? []) as Note[],
        []
      )
    },

    /** the latest poll (or the latest open one), with its votes */
    async poll(openOnly = false): Promise<Poll | null> {
      return call(
        'sitka_poll',
        { p_event: eventId, p_open_only: openOnly },
        async () => {
          let q = sb.from('polls').select('id,question,options,status').eq('event_id', eventId)
          if (openOnly) q = q.eq('status', 'open')
          const { data } = await q.order('created_at', { ascending: false }).limit(1)
          const p = (data && data[0]) as Poll | undefined
          if (!p) return null
          const { data: votes } = await sb.from('poll_votes').select('choice').eq('poll_id', p.id)
          const tally: Record<string, number> = {}
          for (const v of votes ?? []) tally[String(v.choice)] = (tally[String(v.choice)] ?? 0) + 1
          return { ...p, tally }
        },
        null
      )
    },

    /** the questions put to the speaker, as the room sees them, with their votes */
    async questions(limit = 30): Promise<SharedQuestion[]> {
      return call(
        'sitka_shared_questions',
        { p_event: eventId, p_limit: limit },
        async () => {
          const { data: qs } = await sb
            .from('speaker_questions')
            .select('id,refined,text,topic')
            .eq('event_id', eventId)
            .eq('status', 'submitted')
            .order('created_at', { ascending: false })
            .limit(limit)
          const ids = (qs ?? []).map((q) => q.id as string)
          const counts = new Map<string, number>()
          if (ids.length > 0) {
            const { data: v } = await sb.from('question_votes').select('question_id').in('question_id', ids)
            for (const r of v ?? []) counts.set(r.question_id as string, (counts.get(r.question_id as string) ?? 0) + 1)
          }
          return (qs ?? []).map((q) => ({ ...(q as Omit<SharedQuestion, 'votes'>), votes: counts.get(q.id as string) ?? 0 }))
        },
        []
      )
    }
  }
}

export interface LiveHandlers {
  segments?: (row: Seg) => void
  translations?: (row: Line & { lang: string }) => void
  polls?: (row: Poll) => void
  room_notes?: (row: Note) => void
  room_messages?: (row: RoomMsg) => void
}

/**
 * New lines as they are written: the event's private channel, or (where it
 * is refused: the database has not the rules yet) the older per-table feeds.
 * Missing either way is not fatal: the pages also ask on their own.
 */
export function liveRoom(sb: SupabaseClient, eventId: string, name: string, on: LiveHandlers): () => void {
  const channels: RealtimeChannel[] = []
  let fellBack = false
  const older = (): void => {
    if (fellBack) return
    fellBack = true
    for (const ch of channels.splice(0)) void sb.removeChannel(ch)
    for (const [table, fn] of Object.entries(on) as [keyof LiveHandlers, (row: never) => void][]) {
      if (!fn) continue
      const ch = sb
        .channel(`${name}-${table}-${eventId}`)
        .on('postgres_changes', { event: table === 'polls' ? '*' : 'INSERT', schema: 'public', table, filter: 'event_id=eq.' + eventId }, (p) =>
          fn(p.new as never)
        )
        .subscribe()
      channels.push(ch)
    }
  }
  const ch = sb.channel('event:' + eventId, { config: { private: true } })
  for (const [table, fn] of Object.entries(on) as [keyof LiveHandlers, (row: never) => void][]) {
    if (fn) ch.on('broadcast', { event: table }, ({ payload }) => fn(payload as never))
  }
  let joined = false
  ch.subscribe((status) => {
    if (status === 'SUBSCRIBED') joined = true
    else if (!joined && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')) older()
  })
  channels.push(ch)
  const giveUp = setTimeout(() => {
    if (!joined) older()
  }, 12000)
  return () => {
    clearTimeout(giveUp)
    for (const c of channels.splice(0)) void sb.removeChannel(c)
  }
}
