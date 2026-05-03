// Generates resources/icon.ico from a procedurally drawn PNG.
// Uses only Electron's nativeImage; requires no external image libs.
// Run via: node scripts/make-icon.js  (launches headless electron)
//
// Simpler approach: write a .ico file directly using a bundled PNG.
// We build a 256x256 PNG with canvas-like manual pixel drawing, then
// package it into a single-entry .ico container.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---------- PNG encoding helpers ----------
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, pixels /* RGBA Uint8Array */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type RGBA
  ihdr[10] = 0  // compression
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // interlace
  // Add filter byte 0 at start of each row
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- Drawing ----------
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2

  // Background gradient (purple/indigo)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      // Rounded square mask (radius = size * 0.18)
      const r = size * 0.18
      const dx = Math.max(0, Math.abs(x - cx) - (cx - r))
      const dy = Math.max(0, Math.abs(y - cy) - (cy - r))
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > r) { pixels[idx + 3] = 0; continue }

      // Gradient from #4f46e5 (top) to #7c3aed (bottom)
      const t = y / size
      const R = Math.round(0x4f + (0x7c - 0x4f) * t)
      const G = Math.round(0x46 + (0x3a - 0x46) * t)
      const B = Math.round(0xe5 + (0xed - 0xe5) * t)
      pixels[idx] = R
      pixels[idx + 1] = G
      pixels[idx + 2] = B
      pixels[idx + 3] = 255
    }
  }

  // Shield shape (white)
  function drawShield(color, scale = 1, offsetY = 0) {
    const sW = size * 0.52 * scale
    const sH = size * 0.62 * scale
    const sx = cx - sW / 2
    const sy = cy - sH / 2 + offsetY
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Normalized position inside shield bbox
        const nx = (x - sx) / sW
        const ny = (y - sy) / sH
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue
        // Shield path: top flat, sides curve inward, bottom pointed
        // Use a simple implicit function
        const fx = (nx - 0.5) * 2 // -1..1
        let insideX = Math.abs(fx) <= (1 - Math.pow(ny, 2.5) * 0.35)
        let insideY = ny <= 1 - Math.pow(Math.abs(fx), 2) * 0.5
        if (ny < 0.05) insideY = ny >= 0
        if (insideX && insideY) {
          const idx = (y * size + x) * 4
          pixels[idx] = color[0]
          pixels[idx + 1] = color[1]
          pixels[idx + 2] = color[2]
          pixels[idx + 3] = 255
        }
      }
    }
  }

  drawShield([255, 255, 255])

  // Inner checkmark (green)
  const check = [0x22, 0xc5, 0x5e]
  const lineW = Math.max(2, Math.round(size * 0.05))
  function plotLine(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1)
    const sx = x1 < x2 ? 1 : -1
    const sy = y1 < y2 ? 1 : -1
    let err = dx - dy
    let x = x1, y = y1
    while (true) {
      for (let oy = -lineW; oy <= lineW; oy++) {
        for (let ox = -lineW; ox <= lineW; ox++) {
          if (ox * ox + oy * oy <= lineW * lineW) {
            const px = x + ox, py = y + oy
            if (px < 0 || px >= size || py < 0 || py >= size) continue
            const idx = (py * size + px) * 4
            pixels[idx] = check[0]
            pixels[idx + 1] = check[1]
            pixels[idx + 2] = check[2]
            pixels[idx + 3] = 255
          }
        }
      }
      if (x === x2 && y === y2) break
      const e2 = err * 2
      if (e2 > -dy) { err -= dy; x += sx }
      if (e2 < dx) { err += dx; y += sy }
    }
  }
  // Checkmark coords inside shield
  plotLine(Math.round(cx - size * 0.10), Math.round(cy + size * 0.02),
           Math.round(cx - size * 0.02), Math.round(cy + size * 0.10))
  plotLine(Math.round(cx - size * 0.02), Math.round(cy + size * 0.10),
           Math.round(cx + size * 0.13), Math.round(cy - size * 0.08))

  return pixels
}

// ---------- ICO encoding ----------
function encodeIco(entries /* [{size, pngBuffer}] */) {
  const numEntries = entries.length
  const headerSize = 6 + numEntries * 16
  const bufs = [Buffer.alloc(6 + numEntries * 16)]
  bufs[0].writeUInt16LE(0, 0)            // reserved
  bufs[0].writeUInt16LE(1, 2)            // type = 1 (ICO)
  bufs[0].writeUInt16LE(numEntries, 4)   // count

  let offset = headerSize
  entries.forEach((e, i) => {
    const dir = bufs[0]
    const pos = 6 + i * 16
    dir[pos] = e.size === 256 ? 0 : e.size       // width
    dir[pos + 1] = e.size === 256 ? 0 : e.size   // height
    dir[pos + 2] = 0                             // palette
    dir[pos + 3] = 0                             // reserved
    dir.writeUInt16LE(1, pos + 4)                // planes
    dir.writeUInt16LE(32, pos + 6)               // bpp
    dir.writeUInt32LE(e.pngBuffer.length, pos + 8) // size
    dir.writeUInt32LE(offset, pos + 12)          // offset
    offset += e.pngBuffer.length
  })
  entries.forEach(e => bufs.push(e.pngBuffer))
  return Buffer.concat(bufs)
}

// ---------- Main ----------
const sizes = [16, 32, 48, 64, 128, 256]
const entries = sizes.map(s => ({ size: s, pngBuffer: encodePng(s, s, drawIcon(s)) }))
const ico = encodeIco(entries)
const outDir = path.join(__dirname, '..', 'resources')
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'icon.ico')
fs.writeFileSync(outPath, ico)

// Also dump the biggest PNG for debugging / use in tray.
const pngPath = path.join(outDir, 'icon.png')
fs.writeFileSync(pngPath, entries[entries.length - 1].pngBuffer)

console.log(`Wrote ${outPath} (${ico.length} bytes) and ${pngPath}`)
