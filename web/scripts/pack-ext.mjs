// Packs the built extension (extension/dist) into the zip the Chrome Web
// Store takes: extension/sitca-extension.zip.
//
// Two things the older PowerShell line got wrong:
//  * Windows PowerShell 5 writes paths with backslashes, which the store can
//    refuse or unpack as flat names. Here every path uses forward slashes.
//  * The manifest's "key" pins the extension's id for unpacked copies; the
//    store gives the published extension its own id and refuses a package
//    that carries one. The store's copy leaves it out; extension/dist keeps
//    it for loading unpacked.
//
//   node scripts/pack-ext.mjs      (run by `npm run pack:ext`, after the build)

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, crc32 } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', '..', 'extension', 'dist')
const out = join(here, '..', '..', 'extension', 'sitca-extension.zip')

function files(dir) {
  const list = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) list.push(...files(p))
    else list.push(p)
  }
  return list.sort()
}

// DOS date and time for the zip headers (the build's own moment)
const now = new Date()
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

const locals = []
const centrals = []
let offset = 0
for (const path of files(dist)) {
  const name = relative(dist, path).split(sep).join('/')
  let data = readFileSync(path)
  if (name === 'manifest.json') {
    const manifest = JSON.parse(data.toString('utf8'))
    delete manifest.key
    data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }
  const packed = deflateRawSync(data, { level: 9 })
  const useDeflate = packed.length < data.length
  const body = useDeflate ? packed : data
  const nameBuf = Buffer.from(name, 'utf8')
  const crc = crc32(data) >>> 0

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0x0800, 6) // names are UTF-8
  local.writeUInt16LE(useDeflate ? 8 : 0, 8)
  local.writeUInt16LE(dosTime, 10)
  local.writeUInt16LE(dosDate, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  locals.push(local, nameBuf, body)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4) // made by
  central.writeUInt16LE(20, 6) // version needed
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(useDeflate ? 8 : 0, 10)
  central.writeUInt16LE(dosTime, 12)
  central.writeUInt16LE(dosDate, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(offset, 42)
  centrals.push(central, nameBuf)

  offset += local.length + nameBuf.length + body.length
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(centrals.length / 2, 8)
end.writeUInt16LE(centrals.length / 2, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]))
console.log(`packed ${centrals.length / 2} files into ${relative(process.cwd(), out)} (no "key" in the store's manifest)`)
