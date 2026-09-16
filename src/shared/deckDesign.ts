/**
 * The graphic design of each deck style, described once: the shapes that
 * sit behind the words on a title slide and on a content slide. The
 * PowerPoint writer, the PDF writer and the on-screen preview each draw the
 * same list, so a deck looks the same wherever it is opened.
 *
 * Positions are fractions of the slide: x and w of its width, y and h of
 * its height; a circle's centre is (x, y) and its radius r is a fraction of
 * the height. Colours name the style's palette; alpha is the shape's opacity
 * over the slide's background.
 */
export type Paint = 'accent' | 'ink' | 'bg' | 'titleBg' | 'titleInk' | 'muted' | 'white' | 'black'

export interface Shape {
  kind: 'rect' | 'circle'
  x: number
  y: number
  /** rect only */
  w?: number
  h?: number
  /** circle only */
  r?: number
  paint: Paint
  alpha: number
}

/** how a content slide's points are marked */
export type Marker = 'bullet' | 'number' | 'square'

export interface Design {
  /** behind a title slide */
  title: Shape[]
  /** behind a content slide */
  content: Shape[]
  /** the points' marks */
  marker: Marker
  /** a filled square top-left carrying the slide number (Studio) */
  numberTile: boolean
  /** a running line at the foot with the deck's name */
  footer: boolean
}

const R = (x: number, y: number, w: number, h: number, paint: Paint, alpha = 1): Shape => ({ kind: 'rect', x, y, w, h, paint, alpha })
const C = (x: number, y: number, r: number, paint: Paint, alpha = 1): Shape => ({ kind: 'circle', x, y, r, paint, alpha })

const DESIGNS: Record<string, Design> = {
  // Studio: black and white, a square carrying the number, a footer line
  mono: {
    title: [C(0.93, 0.5, 0.62, 'white', 0.07), C(0.93, 0.5, 0.42, 'white', 0.06)],
    content: [R(0, 0.985, 1, 0.015, 'ink'), R(0.07, 0.88, 0.86, 0.0018, 'ink', 0.25)],
    marker: 'square',
    numberTile: true,
    footer: true
  },
  // Midnight: dark, a glow in the corner, the giant faint number
  midnight: {
    title: [C(0.86, 0.18, 0.5, 'accent', 0.1), C(0.86, 0.18, 0.28, 'accent', 0.08), C(0.1, 0.95, 0.3, 'white', 0.04)],
    content: [C(0.06, 1.02, 0.34, 'white', 0.035), R(0, 0.94, 1, 0.06, 'white', 0.04)],
    marker: 'bullet',
    numberTile: false,
    footer: false
  },
  // Ocean: a navy band at the head, bubbles in the corner
  ocean: {
    title: [C(0.9, 0.86, 0.48, 'white', 0.14), C(0.72, 1.02, 0.3, 'white', 0.1), C(0.96, 0.4, 0.14, 'white', 0.2)],
    content: [R(0, 0, 1, 0.2, 'titleBg'), C(0.95, 0.96, 0.16, 'accent', 0.12), C(0.88, 1.03, 0.1, 'accent', 0.16)],
    marker: 'bullet',
    numberTile: false,
    footer: false
  },
  // Warm: cream, one great sun, small ones at the corners
  warm: {
    title: [C(0.88, 0.22, 0.58, 'bg', 0.28), C(0.88, 0.22, 0.34, 'bg', 0.22), C(0.12, 0.88, 0.05, 'bg', 0.9)],
    content: [C(0.05, 0.06, 0.22, 'accent', 0.08), C(0.97, 0.94, 0.3, 'accent', 0.08), C(0.5, 0.0, 0.02, 'accent', 0.9)],
    marker: 'bullet',
    numberTile: false,
    footer: false
  },
  // Bold: the panel, a black foot on it, numbered points
  bold: {
    title: [R(0, 0, 0.45, 1, 'accent'), R(0, 0.82, 0.45, 0.18, 'black'), C(0.45, 0.5, 0.06, 'white'), R(0.45, 0, 0.012, 1, 'black')],
    content: [R(0, 0, 0.36, 1, 'accent'), R(0, 0.86, 0.36, 0.14, 'black'), R(0.36, 0, 0.008, 1, 'black')],
    marker: 'number',
    numberTile: false,
    footer: false
  }
}

export function deckDesign(id: string | null | undefined): Design {
  return DESIGNS[id ?? 'mono'] ?? DESIGNS.mono
}

/** the marker in front of the k-th point */
export function pointMark(marker: Marker, k: number, bullet: string): string {
  if (marker === 'number') return String(k + 1).padStart(2, '0')
  if (marker === 'square') return '▪'
  return bullet
}

/** a colour blended over a background at an opacity, for a renderer that cannot paint translucently */
export function blend(top: [number, number, number], under: [number, number, number], alpha: number): [number, number, number] {
  return [
    under[0] + (top[0] - under[0]) * alpha,
    under[1] + (top[1] - under[1]) * alpha,
    under[2] + (top[2] - under[2]) * alpha
  ]
}
