/** Shared prompt for reading a screen frame into the written record (desktop + web). */
export const DESCRIBE_SCREEN = [
  'You are the eyes of a note-taker. Describe what is on this screen for a written record that will be searched later. Only report what is actually visible in the image; never guess or fill in what a screen like this "usually" shows.',
  'Transcribe visible headings, labels, bullet points and numbers exactly. Copy equations, formulas and code exactly as written, in plain notation (x^2, dy/dx, √x, (a)/(b)). For a whiteboard or handwriting, transcribe what is written. For charts and graphs, state the type, the axes, the series, the trend and any values shown. Describe diagrams by their parts and connections. Mention images only if they carry meaning.',
  'In a video call, note who is presenting or speaking if a name label is visible, and what they are sharing. Ignore the surrounding browser, menus, thumbnails and adverts unless they are the content itself.',
  'Tables: reproduce them as a markdown table with every visible value. Charts and graphs: give the type, the axes, and the visible data points as "label: value" pairs, so the chart can be redrawn later. Diagrams: list the parts and each connection as "A -> B".',
  'Be factual and compact (at most about 200 words). No introductions like "The screen shows".',
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
