/** Shared prompt for reading a screen frame into the written record (desktop + web). */
export const DESCRIBE_SCREEN = [
  'You are the eyes of a note-taker. Describe what is on this screen for a written record that will be searched later.',
  'Transcribe visible headings, labels, bullet points and numbers exactly. For charts and graphs, state the type, the axes, the series, the trend and any values shown. Describe diagrams by their parts and connections. Mention images only if they carry meaning.',
  'Be factual and compact (at most about 120 words). No introductions like "The screen shows".',
  'If the screen holds nothing informative (a plain video call grid, a desktop, a blank page), reply with exactly: NONE'
].join('\n')

export const DESCRIBE_ASK = 'Describe this screen for the record.'

/** '' when the model saw nothing worth keeping. */
export function cleanDescription(out: string): string {
  const text = out.trim()
  return /^none\.?$/i.test(text) ? '' : text
}

/**
 * Cheap change detector for key frames: a tiny grayscale thumbnail compared
 * pixel by pixel. Returns the fraction of pixels that changed noticeably.
 */
export function frameDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) return 1
  let changed = 0
  const n = a.length / 4
  for (let i = 0; i < a.length; i += 4) {
    const ga = (a[i] + a[i + 1] + a[i + 2]) / 3
    const gb = (b[i] + b[i + 1] + b[i + 2]) / 3
    if (Math.abs(ga - gb) > 28) changed++
  }
  return changed / n
}
