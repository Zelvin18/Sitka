/**
 * Generates the Sitka app icon (build/icon.ico + build/icon.png) with no
 * external dependencies: a charcoal rounded square with a white ring + dot,
 * matching the app's monochrome brand.
 */
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const SIZE = 256

// ---------- draw ----------

function smooth(edge, dist) {
  // 1 inside, 0 outside, ~1px soft edge
  return Math.max(0, Math.min(1, edge - dist + 0.5))
}

function roundedRectDist(x, y, cx, cy, half, radius) {
  const dx = Math.abs(x - cx) - (half - radius)
  const dy = Math.abs(y - cy) - (half - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - radius
}

function drawPixels() {
  const px = Buffer.alloc(SIZE * SIZE * 4)
  const c = SIZE / 2
  const bg = [26, 26, 28] // #1a1a1c
  const fg = [255, 255, 255]

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const sq = roundedRectDist(x + 0.5, y + 0.5, c, c, 118, 58)
      const alpha = smooth(0, sq)
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)

      // white ring 46..62, white dot r<=20
      const ring = Math.min(smooth(62, d), smooth(0, 46 - d))
      const dot = smooth(20, d)
      const white = Math.max(ring, dot)

      const r = bg[0] * (1 - white) + fg[0] * white
      const g = bg[1] * (1 - white) + fg[1] * white
      const b = bg[2] * (1 - white) + fg[2] * white
      px[i] = Math.round(r)
      px[i + 1] = Math.round(g)
      px[i + 2] = Math.round(b)
      px[i + 3] = Math.round(alpha * 255)
    }
  }
  return px
}

// ---------- png ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let cc = n
    for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1
    t[n] = cc
  }
  return t
})()

function crc32(buf) {
  let cc = -1
  for (let i = 0; i < buf.length; i++) cc = CRC_TABLE[(cc ^ buf[i]) & 0xff] ^ (cc >>> 8)
  return (cc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- ico (PNG-in-ICO) ----------

function encodeIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256
  entry[1] = 0 // height 256
  entry[2] = 0 // palette
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12) // offset
  return Buffer.concat([header, entry, png])
}

// ---------- main ----------

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const png = encodePng(drawPixels())
fs.writeFileSync(path.join(outDir, 'icon.png'), png)
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png))
console.log('Wrote build/icon.png and build/icon.ico')
