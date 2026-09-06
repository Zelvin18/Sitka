// Renders the Sitka "Spire" mark to PNG/ICO with no native deps (pngjs only).
// Usage: node scripts/make-icons.js
// Writes web/public/{apple-touch-icon,icon-192,icon-512,icon-512-maskable}.png
// and build/icon.png (1024) + build/icon.ico (16..256) for the desktop app.
const fs = require('fs')
const path = require('path')
const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'))

// Geometry in the 64-unit design grid.
const BARS = [
  [11, 39, 6, 14],
  [20, 27, 6, 26],
  [29, 11, 6, 42],
  [38, 27, 6, 26],
  [47, 39, 6, 14]
]
const RX = 3
const TILE_R = 14.4

// Signed distance to a rounded rectangle (x,y,w,h,r) in grid units.
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2
  const cy = y + h / 2
  const qx = Math.abs(px - cx) - (w / 2 - r)
  const qy = Math.abs(py - cy) - (h / 2 - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

// Tile gradient: #2c2c31 → #0f0f11 → #050506 along the diagonal.
function tileColor(t) {
  const stops = [
    [0, [0x2c, 0x2c, 0x31]],
    [0.62, [0x0f, 0x0f, 0x11]],
    [1, [0x05, 0x05, 0x06]]
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const k = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])
      return stops[i - 1][1].map((c, j) => lerp(c, stops[i][1][j], k))
    }
  }
  return stops[stops.length - 1][1]
}

/**
 * Render the mark.
 * @param size output pixel size
 * @param opts { tile: boolean, pad: number (grid units of extra padding, maskable safe zone), ss: supersample }
 */
function render(size, opts = {}) {
  const ss = opts.ss || 4
  const pad = opts.pad || 0
  const png = new PNG({ width: size, height: size })
  const scale = (64 + pad * 2) / size // grid units per pixel
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const gx = (px + (sx + 0.5) / ss) * scale - pad
          const gy = (py + (sy + 0.5) / ss) * scale - pad
          let cr = 0
          let cg = 0
          let cb = 0
          let ca = 0
          if (opts.tile) {
            const d = opts.pad
              ? -1 // maskable: fill the whole square, the platform masks it
              : sdRoundRect(gx, gy, 0, 0, 64, 64, TILE_R)
            if (d <= 0) {
              const t = Math.min(1, Math.max(0, ((gx + pad) + (gy + pad)) / (2 * (64 + pad * 2))))
              ;[cr, cg, cb] = tileColor(t)
              ca = 1
            }
          }
          let inBar = false
          for (const [x, y, w, h] of BARS) {
            if (sdRoundRect(gx, gy, x, y, w, h, RX) <= 0) {
              inBar = true
              break
            }
          }
          if (inBar) {
            const ink = opts.tile ? [255, 255, 255] : [0x14, 0x14, 0x16]
            ;[cr, cg, cb] = ink
            ca = 1
          }
          r += cr * ca
          g += cg * ca
          b += cb * ca
          a += ca
        }
      }
      const n = ss * ss
      const i = (py * size + px) * 4
      if (a > 0) {
        png.data[i] = Math.round(r / a)
        png.data[i + 1] = Math.round(g / a)
        png.data[i + 2] = Math.round(b / a)
      } else {
        png.data[i] = png.data[i + 1] = png.data[i + 2] = 0
      }
      png.data[i + 3] = Math.round((a / n) * 255)
    }
  }
  return PNG.sync.write(png)
}

// ICO container holding PNG-compressed images (supported since Windows Vista).
function ico(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const dir = []
  let offset = 6 + 16 * count
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += buf.length
    dir.push(e)
  }
  return Buffer.concat([header, ...dir, ...pngs.map((p) => p.buf)])
}

const root = path.join(__dirname, '..')
const pub = path.join(root, 'web', 'public')
const build = path.join(root, 'build')
fs.mkdirSync(pub, { recursive: true })
fs.mkdirSync(build, { recursive: true })

fs.writeFileSync(path.join(pub, 'apple-touch-icon.png'), render(180, { tile: true, pad: 4, ss: 4 }))
fs.writeFileSync(path.join(pub, 'icon-192.png'), render(192, { tile: true, ss: 4 }))
fs.writeFileSync(path.join(pub, 'icon-512.png'), render(512, { tile: true, ss: 3 }))
fs.writeFileSync(path.join(pub, 'icon-512-maskable.png'), render(512, { tile: true, pad: 10, ss: 3 }))
fs.writeFileSync(path.join(build, 'icon.png'), render(1024, { tile: true, ss: 2 }))
fs.writeFileSync(
  path.join(build, 'icon.ico'),
  ico([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, buf: render(s, { tile: true, ss: 6 }) })))
)
console.log('icons written to web/public and build/')
