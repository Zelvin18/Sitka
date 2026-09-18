/**
 * Voices told apart.
 *
 * A recording is listened to again, once it is whole, by a service that
 * hears which stretches were spoken by the same voice. It returns
 * utterances: who spoke, from when to when, and what they said. What is
 * done with those is here, away from any network: the session's own
 * transcript lines are given their speaker, the voices are listed with a
 * good moment to hear each one, and the prompts the AI reads carry the
 * names so "what did Mr Banda say about the budget" has an answer.
 */
import { ON_SCREEN_PREFIX, type Speaker, type TranscriptSegment } from './types'

/** What a voice heard again by a service comes back as. */
export interface Utterance {
  start: number
  end: number
  /** 0, 1, 2 … in order of first speaking */
  speaker: number
  text: string
}

/** "Mr Banda", or "Speaker 2" while nobody has said who that is. */
export function speakerName(speakers: Speaker[] | undefined, id: number | undefined): string {
  if (id === undefined || id === null) return ''
  const s = speakers?.find((x) => x.id === id)
  return (s?.name || '').trim() || `Speaker ${id + 1}`
}

/** One transcript line as the AI reads it: time, who, words. */
export function transcriptLine(seg: TranscriptSegment, speakers: Speaker[] | undefined, time: string): string {
  const who = seg.speaker !== undefined && !seg.text.startsWith(ON_SCREEN_PREFIX) ? `${speakerName(speakers, seg.speaker)}: ` : ''
  return `[${time}] ${who}${seg.text.trim()}`
}

/**
 * A short note for the AI's instructions: which voices there are, what they
 * are called, and how to read the labels. Empty when voices were not told apart.
 */
export function speakersNote(speakers: Speaker[] | undefined): string {
  if (!speakers || speakers.length === 0) return ''
  const list = speakers
    .map((s) => {
      const label = `Speaker ${s.id + 1}`
      const named = (s.name || '').trim()
      const mins = Math.max(1, Math.round(s.seconds / 60))
      return named ? `${named} (labelled "${named}", spoke about ${mins} min)` : `${label} (not yet named, spoke about ${mins} min)`
    })
    .join('; ')
  return [
    `Voices in the recording were told apart automatically. Each transcript line starts with who said it: ${list}.`,
    'When asked what a particular person said, use only the lines carrying their label, and quote or paraphrase them with the moment they were said.',
    'If a speaker is not yet named and the person asks about someone by name, say which numbered speaker you think they mean and why, from what was said.',
    'Never invent who said something: a line without a label was not attributed.'
  ].join(' ')
}

/**
 * The session's transcript lines, each given the voice that spoke it.
 *
 * The lines came from a live transcription in short pieces; the utterances
 * from listening to the whole recording again. They cover the same seconds,
 * so each line takes the voice that overlaps it most. A line no utterance
 * touches (a gap, or a word the second listening missed) takes the nearest
 * voice within a few seconds, or stays unlabelled.
 *
 * When the live transcription caught little or nothing (a phone that could
 * not keep up, a session whose captions failed), the utterances themselves
 * become the transcript: that is a better record than an empty one.
 */
export function assignSpeakers(
  segments: TranscriptSegment[],
  utterances: Utterance[]
): { segments: TranscriptSegment[]; adopted: boolean } {
  const heard = utterances.filter((u) => u.text.trim()).sort((a, b) => a.start - b.start)
  if (heard.length === 0) return { segments, adopted: false }
  const spoken = segments.filter((s) => !s.text.startsWith(ON_SCREEN_PREFIX))
  const onScreen = segments.filter((s) => s.text.startsWith(ON_SCREEN_PREFIX))
  const liveWords = spoken.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0)
  const heardWords = heard.reduce((n, u) => n + u.text.split(/\s+/).filter(Boolean).length, 0)
  // thin live captions: the second listening is the better record
  if (liveWords < Math.max(12, heardWords * 0.3)) {
    const fresh = heard.map<TranscriptSegment>((u) => ({
      start: round(u.start),
      end: round(Math.max(u.end, u.start + 0.5)),
      text: u.text.trim(),
      speaker: u.speaker
    }))
    return { segments: [...fresh, ...onScreen].sort((a, b) => a.start - b.start), adopted: true }
  }
  let i = 0
  const out = segments.map((seg) => {
    if (seg.text.startsWith(ON_SCREEN_PREFIX)) return seg
    // utterances are sorted: walk forward, never back past what this line could touch
    while (i > 0 && heard[i - 1].end > seg.start - 3) i--
    while (i < heard.length && heard[i].end < seg.start - 3) i++
    let best: Utterance | null = null
    let bestOverlap = 0
    let nearest: Utterance | null = null
    let nearestGap = Infinity
    for (let k = i; k < heard.length && heard[k].start < seg.end + 3; k++) {
      const u = heard[k]
      const overlap = Math.min(u.end, seg.end) - Math.max(u.start, seg.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = u
      }
      const gap = u.end < seg.start ? seg.start - u.end : u.start > seg.end ? u.start - seg.end : 0
      if (gap < nearestGap) {
        nearestGap = gap
        nearest = u
      }
    }
    const pick = best ?? (nearestGap <= 3 ? nearest : null)
    if (!pick) {
      const rest = { ...seg }
      delete rest.speaker
      return rest
    }
    return { ...seg, speaker: pick.speaker }
  })
  return { segments: out, adopted: false }
}

/**
 * The voices themselves: how long each spoke, and a moment to hear it. The
 * moment is the start of that voice's longest stretch, a little way in, so a
 * tap plays a clear run of that person rather than a hand-over.
 */
export function listSpeakers(utterances: Utterance[], previous: Speaker[] | undefined): Speaker[] {
  const byId = new Map<number, { seconds: number; at: number; longest: number }>()
  for (const u of utterances) {
    const len = Math.max(0, u.end - u.start)
    const cur = byId.get(u.speaker) ?? { seconds: 0, at: u.start, longest: -1 }
    cur.seconds += len
    if (len > cur.longest) {
      cur.longest = len
      cur.at = u.start + Math.min(0.4, len / 4)
    }
    byId.set(u.speaker, cur)
  }
  return [...byId.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, v]) => {
      // a name given before is kept for the same number: a second listening
      // of the same recording numbers the same voices in the same order
      const name = previous?.find((p) => p.id === id)?.name
      return { id, at: round(v.at), seconds: Math.round(v.seconds), ...(name ? { name } : {}) }
    })
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
