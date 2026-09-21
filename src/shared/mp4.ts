/// <reference lib="dom" />
/**
 * Fragmented MP4 in, plain MP4 out.
 *
 * A browser's recorder writes MP4 in fragments: a small header with an empty
 * sample table, then a run of (moof, mdat) pairs, one every few seconds. That
 * is right for a file being written live, and wrong for a file being watched:
 * the header says the duration is zero and there is no index of fragments, so
 * a player has to read the whole file before it can show a frame or draw a
 * timeline. On a phone, an hour of lecture meant close to a minute of waiting.
 *
 * This walks the fragments once, gathers every sample's place, size, timing
 * and kind, and writes the same media back as a conventional file: a complete
 * header first (with the full sample tables and the true duration), then all
 * the media data. A player reads the header, knows everything, and starts.
 *
 * Nothing is decoded or re-encoded; the bytes of every frame are copied as
 * they were. The result plays wherever MP4 plays, and seeks exactly.
 */

interface Box {
  type: string
  start: number
  size: number
  head: number
}

interface Sample {
  offset: number
  size: number
  duration: number
  cts: number
  sync: boolean
}

interface Track {
  id: number
  timescale: number
  /** the trak box in the header, with its stbl to be replaced */
  trak: Box
  samples: Sample[]
  /** one chunk per fragment: how many samples it holds */
  chunks: number[]
  defaultDuration: number
  defaultSize: number
  defaultFlags: number
}

const td = new TextDecoder('ascii')
const type4 = (b: Uint8Array, at: number): string => td.decode(b.subarray(at, at + 4))
const u32 = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const i32 = (b: Uint8Array, at: number): number => u32(b, at) | 0
const u64 = (b: Uint8Array, at: number): number => u32(b, at) * 4294967296 + u32(b, at + 4)

/** the boxes laid side by side between two offsets */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  let at = from
  while (at + 8 <= to) {
    let size = u32(b, at)
    let head = 8
    const type = type4(b, at + 4)
    if (size === 1) {
      size = u64(b, at + 8)
      head = 16
    } else if (size === 0) size = to - at
    if (size < head || at + size > to) break
    out.push({ type, start: at, size, head })
    at += size
  }
  return out
}
const child = (b: Uint8Array, box: Box, type: string): Box | undefined =>
  boxes(b, box.start + box.head, box.start + box.size).find((c) => c.type === type)
const children = (b: Uint8Array, box: Box, type: string): Box[] =>
  boxes(b, box.start + box.head, box.start + box.size).filter((c) => c.type === type)

/** Is this a fragmented file with an empty header? Cheap, from the first bytes. */
export function isFragmentedMp4(b: Uint8Array): boolean {
  if (b.length < 16 || type4(b, 4) !== 'ftyp') return false
  const top = boxes(b, 0, Math.min(b.length, 4 * 1024 * 1024))
  const moov = top.find((x) => x.type === 'moov')
  if (!moov) return false
  return Boolean(child(b, moov, 'mvex')) && top.some((x) => x.type === 'moof')
}

/**
 * Where every fragment of a fragmented MP4 sits, and when it plays: the
 * index a playlist needs to hand a phone the recording piece by piece,
 * each piece a byte range of the file it is in. Read from the recording's
 * bytes once, kept beside the parts.
 */
export interface FragIndex {
  v: 1
  /** bytes of the header before the first fragment (ftyp, moov, …) */
  init: number
  /** seconds, for the last fragment's length when nothing follows it */
  duration: number
  /** [offset in the whole stream, size, start seconds] per fragment, in order */
  frags: [number, number, number][]
}
export function fragmentIndex(b: Uint8Array, durationSec?: number): FragIndex | null {
  const top = boxes(b, 0, b.length)
  const moov = top.find((x) => x.type === 'moov')
  const firstMoof = top.find((x) => x.type === 'moof')
  if (!moov || !firstMoof || !child(b, moov, 'mvex')) return null
  // the video track's clock, or the first track's when there is no picture
  let videoId = 0
  let videoScale = 0
  let anyId = 0
  let anyScale = 0
  for (const trak of children(b, moov, 'trak')) {
    const tkhd = child(b, trak, 'tkhd')
    const mdia = child(b, trak, 'mdia')
    const mdhd = mdia && child(b, mdia, 'mdhd')
    const hdlr = mdia && child(b, mdia, 'hdlr')
    if (!tkhd || !mdia || !mdhd) continue
    const tv = b[tkhd.start + tkhd.head]
    const id = tv === 1 ? u32(b, tkhd.start + tkhd.head + 20) : u32(b, tkhd.start + tkhd.head + 12)
    const mv = b[mdhd.start + mdhd.head]
    const scale = mv === 1 ? u32(b, mdhd.start + mdhd.head + 20) : u32(b, mdhd.start + mdhd.head + 12)
    if (!anyId) {
      anyId = id
      anyScale = scale
    }
    if (hdlr && type4(b, hdlr.start + hdlr.head + 8) === 'vide') {
      videoId = id
      videoScale = scale
    }
  }
  const trackId = videoId || anyId
  const scale = videoId ? videoScale : anyScale
  if (!trackId || !scale) return null
  const frags: [number, number, number][] = []
  for (let i = 0; i < top.length; i++) {
    const moof = top[i]
    if (moof.type !== 'moof') continue
    // the fragment is the moof and the mdat(s) that follow it, up to the next moof
    let end = moof.start + moof.size
    for (let j = i + 1; j < top.length && top[j].type !== 'moof'; j++) end = top[j].start + top[j].size
    let start = -1
    for (const traf of children(b, moof, 'traf')) {
      const tfhd = child(b, traf, 'tfhd')
      const tfdt = child(b, traf, 'tfdt')
      if (!tfhd || !tfdt) continue
      if (u32(b, tfhd.start + tfhd.head + 4) !== trackId) continue
      const ver = b[tfdt.start + tfdt.head]
      const t = ver === 1 ? u64(b, tfdt.start + tfdt.head + 4) : u32(b, tfdt.start + tfdt.head + 4)
      start = t / scale
    }
    if (start < 0) {
      // a fragment with no sample of the clock track: it goes with the one before
      if (frags.length) frags[frags.length - 1][1] = end - frags[frags.length - 1][0]
      continue
    }
    frags.push([moof.start, end - moof.start, Math.round(start * 1000) / 1000])
  }
  if (frags.length === 0) return null
  return { v: 1, init: firstMoof.start, duration: durationSec && durationSec > 0 ? durationSec : frags[frags.length - 1][2] + 3, frags }
}

/**
 * The plain file, or null when the input is not a fragmented MP4 this can
 * handle. A null means "leave the file as it is", never a broken file.
 */
export function defragmentMp4(b: Uint8Array): Uint8Array | null {
  try {
    return convert(b)
  } catch (err) {
    console.warn('[mp4] could not rewrite', err)
    return null
  }
}

function convert(b: Uint8Array): Uint8Array | null {
  const top = boxes(b, 0, b.length)
  const ftyp = top.find((x) => x.type === 'ftyp')
  const moov = top.find((x) => x.type === 'moov')
  if (!ftyp || !moov) return null
  const mvex = child(b, moov, 'mvex')
  if (!mvex) return null
  const mvhd = child(b, moov, 'mvhd')
  if (!mvhd) return null
  const movieTimescale = b[mvhd.start + mvhd.head] === 1 ? u32(b, mvhd.start + mvhd.head + 20) : u32(b, mvhd.start + mvhd.head + 12)

  // the tracks, with the defaults their fragments fall back on
  const tracks = new Map<number, Track>()
  for (const trak of children(b, moov, 'trak')) {
    const tkhd = child(b, trak, 'tkhd')
    const mdia = child(b, trak, 'mdia')
    const mdhd = mdia && child(b, mdia, 'mdhd')
    if (!tkhd || !mdia || !mdhd) return null
    const tv = b[tkhd.start + tkhd.head]
    const id = tv === 1 ? u32(b, tkhd.start + tkhd.head + 20) : u32(b, tkhd.start + tkhd.head + 12)
    const mv = b[mdhd.start + mdhd.head]
    const timescale = mv === 1 ? u32(b, mdhd.start + mdhd.head + 20) : u32(b, mdhd.start + mdhd.head + 12)
    tracks.set(id, { id, timescale, trak, samples: [], chunks: [], defaultDuration: 0, defaultSize: 0, defaultFlags: 0 })
  }
  for (const trex of children(b, mvex, 'trex')) {
    const p = trex.start + trex.head + 4
    const t = tracks.get(u32(b, p))
    if (!t) continue
    t.defaultDuration = u32(b, p + 8)
    t.defaultSize = u32(b, p + 12)
    t.defaultFlags = u32(b, p + 16)
  }
  if (tracks.size === 0) return null

  // every fragment: where each sample sits and how long it lasts
  let sawFragment = false
  for (const moof of top) {
    if (moof.type !== 'moof') continue
    sawFragment = true
    let lastEnd = moof.start
    for (const traf of children(b, moof, 'traf')) {
      const tfhd = child(b, traf, 'tfhd')
      if (!tfhd) return null
      const flags = u32(b, tfhd.start + tfhd.head) & 0xffffff
      let p = tfhd.start + tfhd.head + 4
      const track = tracks.get(u32(b, p))
      p += 4
      if (!track) return null
      let base = flags & 0x20000 ? moof.start : lastEnd
      if (flags & 0x1) {
        base = u64(b, p)
        p += 8
      }
      if (flags & 0x2) p += 4
      let dDur = track.defaultDuration
      let dSize = track.defaultSize
      let dFlags = track.defaultFlags
      if (flags & 0x8) {
        dDur = u32(b, p)
        p += 4
      }
      if (flags & 0x10) {
        dSize = u32(b, p)
        p += 4
      }
      if (flags & 0x20) {
        dFlags = u32(b, p)
        p += 4
      }
      let count = 0
      let cursor = base
      for (const trun of children(b, traf, 'trun')) {
        const ver = b[trun.start + trun.head]
        const tf = u32(b, trun.start + trun.head) & 0xffffff
        let q = trun.start + trun.head + 4
        const n = u32(b, q)
        q += 4
        let dataStart = cursor
        if (tf & 0x1) {
          dataStart = base + i32(b, q)
          q += 4
        }
        let firstFlags: number | null = null
        if (tf & 0x4) {
          firstFlags = u32(b, q)
          q += 4
        }
        let at = dataStart
        for (let i = 0; i < n; i++) {
          let dur = dDur
          let size = dSize
          let sflags = i === 0 && firstFlags !== null ? firstFlags : dFlags
          let cts = 0
          if (tf & 0x100) {
            dur = u32(b, q)
            q += 4
          }
          if (tf & 0x200) {
            size = u32(b, q)
            q += 4
          }
          if (tf & 0x400) {
            sflags = u32(b, q)
            q += 4
          }
          if (tf & 0x800) {
            cts = ver === 0 ? u32(b, q) : i32(b, q)
            q += 4
          }
          if (at + size > b.length) return null
          track.samples.push({ offset: at, size, duration: dur, cts, sync: (sflags & 0x10000) === 0 })
          at += size
          count++
        }
        cursor = at
      }
      if (count > 0) track.chunks.push(count)
      lastEnd = cursor
    }
  }
  if (!sawFragment) return null
  const live = [...tracks.values()].filter((t) => t.samples.length > 0)
  if (live.length === 0) return null

  // ---------- the new header ----------
  const w = new Writer()
  // ftyp: the same brands, so nothing downstream is surprised
  w.raw(b.subarray(ftyp.start, ftyp.start + ftyp.size))

  // the media data goes in fragment order, each track's run of a fragment
  // being one chunk; chunk offsets need the header's size, so the header is
  // laid out twice: once to measure, once for real
  const chunkOrder: { track: Track; from: number; to: number }[] = []
  {
    // rebuild the order the samples appeared in the file
    const cursors = new Map<Track, number>(live.map((t) => [t, 0]))
    const chunkIdx = new Map<Track, number>(live.map((t) => [t, 0]))
    let placed = 0
    const total = live.reduce((n, t) => n + t.chunks.length, 0)
    while (placed < total) {
      // the next chunk is the one whose first sample sits earliest in the file
      let best: Track | null = null
      let bestOff = Infinity
      for (const t of live) {
        const ci = chunkIdx.get(t)!
        if (ci >= t.chunks.length) continue
        const off = t.samples[cursors.get(t)!].offset
        if (off < bestOff) {
          bestOff = off
          best = t
        }
      }
      if (!best) break
      const from = cursors.get(best)!
      const n = best.chunks[chunkIdx.get(best)!]
      chunkOrder.push({ track: best, from, to: from + n })
      cursors.set(best, from + n)
      chunkIdx.set(best, chunkIdx.get(best)! + 1)
      placed++
    }
  }
  const dataSize = live.reduce((n, t) => n + t.samples.reduce((m, s) => m + s.size, 0), 0)
  const durations = new Map<Track, number>(live.map((t) => [t, t.samples.reduce((n, s) => n + s.duration, 0)]))
  const movieDuration = Math.max(...live.map((t) => Math.round((durations.get(t)! / t.timescale) * movieTimescale)))

  const buildMoov = (chunkOffsets: Map<Track, number[]>, wide: boolean): Uint8Array => {
    const m = new Writer()
    m.box('moov', () => {
      // mvhd with the real duration
      m.raw(patchDuration(b.subarray(mvhd.start, mvhd.start + mvhd.size), movieDuration, 'mvhd'))
      for (const t of live) {
        m.box('trak', () => {
          for (const c of boxes(b, t.trak.start + t.trak.head, t.trak.start + t.trak.size)) {
            if (c.type === 'tkhd') {
              m.raw(patchDuration(b.subarray(c.start, c.start + c.size), Math.round((durations.get(t)! / t.timescale) * movieTimescale), 'tkhd'))
            } else if (c.type === 'edts') {
              // An iPhone writes an edit list whose length is 0, which in a
              // recording of unknown length means "to the end". Once the
              // length is known, a 0 here reads as an empty edit: the player
              // sees no sound and no end. The edit gets its real length.
              m.raw(patchEditList(b.subarray(c.start, c.start + c.size), durations.get(t)!, t.timescale, movieTimescale))
            } else if (c.type === 'mdia') {
              m.box('mdia', () => {
                for (const d of boxes(b, c.start + c.head, c.start + c.size)) {
                  if (d.type === 'mdhd') m.raw(patchDuration(b.subarray(d.start, d.start + d.size), durations.get(t)!, 'mdhd'))
                  else if (d.type === 'minf') {
                    m.box('minf', () => {
                      for (const e of boxes(b, d.start + d.head, d.start + d.size)) {
                        if (e.type === 'stbl') {
                          m.box('stbl', () => {
                            const stsd = child(b, e, 'stsd')
                            if (stsd) m.raw(b.subarray(stsd.start, stsd.start + stsd.size))
                            writeTables(m, t, chunkOffsets.get(t)!, wide)
                          })
                        } else m.raw(b.subarray(e.start, e.start + e.size))
                      }
                    })
                  } else m.raw(b.subarray(d.start, d.start + d.size))
                }
              })
            } else m.raw(b.subarray(c.start, c.start + c.size))
          }
        })
      }
      // no mvex: there are no fragments any more
    })
    return m.bytes()
  }

  // measure with placeholder offsets, then lay out for real
  const zero = new Map<Track, number[]>(live.map((t) => [t, t.chunks.map(() => 0)]))
  const wide = ftyp.size + buildMoov(zero, false).length + 16 + dataSize > 0xfffffff0
  const moovSize = buildMoov(zero, wide).length
  const mdatHead = dataSize + 8 > 0xffffffff ? 16 : 8
  let dataAt = ftyp.size + moovSize + mdatHead
  const offsets = new Map<Track, number[]>(live.map((t) => [t, []]))
  for (const c of chunkOrder) {
    offsets.get(c.track)!.push(dataAt)
    for (let i = c.from; i < c.to; i++) dataAt += c.track.samples[i].size
  }
  const moovBytes = buildMoov(offsets, wide)
  if (moovBytes.length !== moovSize) return null
  w.raw(moovBytes)

  // mdat: the samples, copied in their new order
  if (mdatHead === 16) {
    w.u32(1)
    w.str('mdat')
    w.u64(dataSize + 16)
  } else {
    w.u32(dataSize + 8)
    w.str('mdat')
  }
  for (const c of chunkOrder) {
    for (let i = c.from; i < c.to; i++) {
      const s = c.track.samples[i]
      w.raw(b.subarray(s.offset, s.offset + s.size))
    }
  }
  return w.bytes()
}

/** the stts, ctts, stss, stsc, stsz and stco/co64 of one track */
function writeTables(m: Writer, t: Track, chunkOffsets: number[], wide: boolean): void {
  const s = t.samples
  // stts: runs of equal durations
  const runs: [number, number][] = []
  for (const x of s) {
    const last = runs[runs.length - 1]
    if (last && last[1] === x.duration) last[0]++
    else runs.push([1, x.duration])
  }
  m.full('stts', 0, 0, () => {
    m.u32(runs.length)
    for (const [n, d] of runs) {
      m.u32(n)
      m.u32(d)
    }
  })
  // ctts only when any sample is presented out of decode order
  if (s.some((x) => x.cts !== 0)) {
    const cruns: [number, number][] = []
    for (const x of s) {
      const last = cruns[cruns.length - 1]
      if (last && last[1] === x.cts) last[0]++
      else cruns.push([1, x.cts])
    }
    const negative = s.some((x) => x.cts < 0)
    m.full('ctts', negative ? 1 : 0, 0, () => {
      m.u32(cruns.length)
      for (const [n, c] of cruns) {
        m.u32(n)
        m.u32(c >>> 0)
      }
    })
  }
  // stss only when some samples are not sync samples (video)
  if (s.some((x) => !x.sync)) {
    const syncs: number[] = []
    s.forEach((x, i) => {
      if (x.sync) syncs.push(i + 1)
    })
    m.full('stss', 0, 0, () => {
      m.u32(syncs.length)
      for (const n of syncs) m.u32(n)
    })
  }
  // stsc: runs of chunks holding the same number of samples
  const sruns: [number, number][] = []
  t.chunks.forEach((n, i) => {
    const last = sruns[sruns.length - 1]
    if (last && last[1] === n) return
    sruns.push([i + 1, n])
  })
  m.full('stsc', 0, 0, () => {
    m.u32(sruns.length)
    for (const [first, n] of sruns) {
      m.u32(first)
      m.u32(n)
      m.u32(1)
    }
  })
  m.full('stsz', 0, 0, () => {
    m.u32(0)
    m.u32(s.length)
    for (const x of s) m.u32(x.size)
  })
  m.full(wide ? 'co64' : 'stco', 0, 0, () => {
    m.u32(chunkOffsets.length)
    for (const o of chunkOffsets) {
      if (wide) m.u64(o)
      else m.u32(o)
    }
  })
}

/** a copy of a header box with its duration field set */
/**
 * An edts box with each elst entry of length 0 given the track's real
 * length (less the part the entry skips), in the movie's timescale.
 */
function patchEditList(edts: Uint8Array, mediaDuration: number, mediaTimescale: number, movieTimescale: number): Uint8Array {
  const out = edts.slice()
  const elst = boxes(out, 8, out.length).find((x) => x.type === 'elst')
  if (!elst) return out
  const ver = out[elst.start + elst.head]
  let p = elst.start + elst.head + 4
  const n = u32(out, p)
  p += 4
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  for (let i = 0; i < n; i++) {
    const segment = ver === 1 ? Number(view.getBigUint64(p)) : u32(out, p)
    const mediaTime = ver === 1 ? Number(view.getBigInt64(p + 8)) : i32(out, p + 4)
    if (segment === 0 && mediaTime >= 0) {
      const length = Math.max(0, Math.round(((mediaDuration - mediaTime) / mediaTimescale) * movieTimescale))
      if (ver === 1) view.setBigUint64(p, BigInt(length))
      else view.setUint32(p, length)
    }
    p += ver === 1 ? 20 : 12
  }
  return out
}

function patchDuration(src: Uint8Array, duration: number, kind: 'mvhd' | 'tkhd' | 'mdhd'): Uint8Array {
  const out = src.slice()
  const head = u32(out, 0) === 1 ? 16 : 8
  const ver = out[head]
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  // where the duration sits after version+flags: (creation, modification[, timescale | track_id, reserved])
  if (kind === 'mvhd' || kind === 'mdhd') {
    if (ver === 1) dv.setBigUint64(head + 4 + 8 + 8 + 4, BigInt(duration))
    else dv.setUint32(head + 4 + 4 + 4 + 4, duration >>> 0)
  } else if (ver === 1) dv.setBigUint64(head + 4 + 8 + 8 + 4 + 4, BigInt(duration))
  else dv.setUint32(head + 4 + 4 + 4 + 4 + 4, duration >>> 0)
  return out
}

/** bytes, written in order, with boxes that learn their own size when closed */
class Writer {
  private parts: Uint8Array[] = []
  private length = 0
  private stack: { at: number; index: number }[] = []
  raw(b: Uint8Array): void {
    this.parts.push(b)
    this.length += b.length
  }
  u32(n: number): void {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, n >>> 0)
    this.raw(b)
  }
  u64(n: number): void {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, BigInt(n))
    this.raw(b)
  }
  str(s: string): void {
    this.raw(new TextEncoder().encode(s))
  }
  box(type: string, body: () => void): void {
    const size = new Uint8Array(4)
    this.stack.push({ at: this.length, index: this.parts.length })
    this.raw(size)
    this.str(type)
    body()
    const open = this.stack.pop()!
    new DataView(size.buffer).setUint32(0, this.length - open.at)
  }
  full(type: string, version: number, flags: number, body: () => void): void {
    this.box(type, () => {
      this.u32(((version & 0xff) << 24) | (flags & 0xffffff))
      body()
    })
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}
