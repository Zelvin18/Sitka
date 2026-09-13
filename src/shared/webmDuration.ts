/// <reference lib="dom" />
/**
 * MediaRecorder writes WebM files without a Duration in their header: the
 * browser had no way of knowing how long the recording would be. Players then
 * show no timeline and cannot seek until they have scanned the whole file, and
 * phones often never do. This writes the duration into the header so every
 * player shows the timeline at once. Pure bytes, runs anywhere a Blob exists.
 */

const ID_EBML = 0x1a45dfa3
const ID_SEGMENT = 0x18538067
const ID_INFO = 0x1549a966
const ID_TIMECODE_SCALE = 0x2ad7b1
const ID_DURATION = 0x4489
const ID_CLUSTER = 0x1f43b675

interface Vint {
  value: number
  length: number
  unknown: boolean
}

function readVint(b: Uint8Array, pos: number): Vint | null {
  if (pos >= b.length) return null
  const first = b[pos]
  let length = 1
  let mask = 0x80
  while (length <= 8 && !(first & mask)) {
    mask >>= 1
    length++
  }
  if (length > 8 || pos + length > b.length) return null
  let value = first & (mask - 1)
  let allOnes = value === mask - 1
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[pos + i]
    if (b[pos + i] !== 0xff) allOnes = false
  }
  return { value, length, unknown: allOnes }
}

function readId(b: Uint8Array, pos: number): { id: number; length: number } | null {
  if (pos >= b.length) return null
  const first = b[pos]
  let length = 1
  let mask = 0x80
  while (length <= 4 && !(first & mask)) {
    mask >>= 1
    length++
  }
  if (length > 4 || pos + length > b.length) return null
  let id = 0
  for (let i = 0; i < length; i++) id = id * 256 + b[pos + i]
  return { id, length }
}

function encodeSize(n: number): Uint8Array {
  // shortest vint that holds n (1..8 bytes)
  let length = 1
  while (length < 8 && n >= Math.pow(2, 7 * length) - 1) length++
  const out = new Uint8Array(length)
  let v = n
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  out[0] |= 0x80 >> (length - 1)
  return out
}

function durationElement(value: number): Uint8Array {
  const out = new Uint8Array(2 + 1 + 8)
  out[0] = 0x44
  out[1] = 0x89
  out[2] = 0x88
  new DataView(out.buffer).setFloat64(3, value, false)
  return out
}

/**
 * Returns a new Blob with the duration written into the header, or the same
 * Blob when the file already has one or is not a WebM this understands.
 */
export async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return blob
  const headLen = Math.min(blob.size, 256 * 1024)
  const head = new Uint8Array(await blob.slice(0, headLen).arrayBuffer())

  // EBML header
  const ebml = readId(head, 0)
  if (!ebml || ebml.id !== ID_EBML) return blob
  const ebmlSize = readVint(head, ebml.length)
  if (!ebmlSize) return blob
  let pos = ebml.length + ebmlSize.length + ebmlSize.value

  // Segment
  const seg = readId(head, pos)
  if (!seg || seg.id !== ID_SEGMENT) return blob
  const segSize = readVint(head, pos + seg.length)
  if (!segSize) return blob
  const segSizePos = pos + seg.length
  pos = segSizePos + segSize.length

  // Children of Segment until Info (or the first Cluster: then there is no Info)
  while (pos < head.length) {
    const child = readId(head, pos)
    if (!child) return blob
    const size = readVint(head, pos + child.length)
    if (!size) return blob
    const dataStart = pos + child.length + size.length
    if (child.id === ID_CLUSTER) return blob
    if (child.id === ID_INFO) {
      if (size.unknown || dataStart + size.value > head.length) return blob
      const infoEnd = dataStart + size.value
      let timecodeScale = 1_000_000
      let p = dataStart
      while (p < infoEnd) {
        const e = readId(head, p)
        if (!e) break
        const s = readVint(head, p + e.length)
        if (!s) break
        const d = p + e.length + s.length
        if (e.id === ID_TIMECODE_SCALE) {
          let v = 0
          for (let i = 0; i < s.value; i++) v = v * 256 + head[d + i]
          if (v > 0) timecodeScale = v
        }
        if (e.id === ID_DURATION) return blob // already has one
        p = d + s.value
      }
      const value = (durationMs * 1_000_000) / timecodeScale
      const extra = durationElement(value)
      const newInfoSize = size.value + extra.length
      const newSizeBytes = encodeSize(newInfoSize)
      const infoIdBytes = head.slice(pos, pos + child.length)
      const infoBody = head.slice(dataStart, infoEnd)
      const grown = newSizeBytes.length - size.length + extra.length

      // Segment size, when known, grows by the same amount
      const before = head.slice(0, pos)
      if (!segSize.unknown) {
        const newSeg = encodeSize(segSize.value + grown)
        if (newSeg.length === segSize.length) before.set(newSeg, segSizePos)
        else return blob // would shift everything: leave the file as it is
      }
      // plain ArrayBuffers: a typed array over a shared buffer is not a BlobPart
      const buf = (u: Uint8Array): ArrayBuffer =>
        u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
      const parts: BlobPart[] = [
        buf(before),
        buf(infoIdBytes),
        buf(newSizeBytes),
        buf(infoBody),
        buf(extra),
        blob.slice(infoEnd)
      ]
      return new Blob(parts, { type: blob.type || 'video/webm' })
    }
    if (size.unknown) return blob
    pos = dataStart + size.value
  }
  return blob
}
