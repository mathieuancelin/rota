'use strict'

// Generates the menu bar, application and notification icons.
//
// The icons are macOS "template images": only the alpha channel counts, the
// system recolours them according to the light or dark theme. So we rasterise
// pure black with an antialiased alpha.
//
// Rendering goes from signed distance functions rather than an SVG converted by
// an external tool: at 16 pixels every pixel counts, and this avoids a build
// dependency (rsvg/ImageMagick) for four small files.
//
//   node scripts/generate-icons.js
//
// The PNGs produced are versioned: there is no need to replay this script to
// build the application.

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'tray')
const LINUX_OUT_DIR = path.resolve(__dirname, '..', 'assets', 'tray-linux')
const ICONSET_DIR = path.resolve(__dirname, '..', 'assets', 'app', 'icon.iconset')
const NOTIFICATION_DIR = path.resolve(__dirname, '..', 'assets', 'notification')
const GRID = 16 // design space, in units
const SAMPLES = 8 // subsampling per axis

// --- signed distance primitives (negative = inside) --------------------------

const disc = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r

/** Rounded-corner rectangle, for the background of the application icon. */
const roundedRect = (cx, cy, halfWidth, halfHeight, radius) => (x, y) => {
  const dx = Math.abs(x - cx) - (halfWidth - radius)
  const dy = Math.abs(y - cy) - (halfHeight - radius)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
}

const ring = (cx, cy, r, width) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - width / 2

/** Segment with rounded ends. */
const capsule = (x1, y1, x2, y2, width) => {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  return (x, y) => {
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2))
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - width / 2
  }
}

const union =
  (...shapes) =>
  (x, y) =>
    Math.min(...shapes.map((s) => s(x, y)))

const NOTHING = () => Number.POSITIVE_INFINITY

// --- variants ----------------------------------------------------------------

// Common dial. The chevron stands for hands as much as for a terminal prompt.
// Strokes deliberately thin: at 16 pixels, the inside of the dial is only about
// ten pixels across and saturates quickly.
const CLOCK = ring(8, 8, 6.3, 1.35)
const CHEVRON = union(capsule(6.55, 5.7, 9.0, 8, 1.5), capsule(9.0, 8, 6.55, 10.3, 1.5))

const BADGE_CENTER = [13.3, 2.7]
const BADGE = disc(...BADGE_CENTER, 1.95)
// Transparent ring around the dot, so that it stands out from the dial.
const BADGE_KNOCKOUT = disc(...BADGE_CENTER, 3.2)

const VARIANTS = {
  // Idle: dial + chevron.
  idle: { base: union(CLOCK, CHEVRON), knockout: NOTHING, top: NOTHING },
  // At least one job running: solid dot at the top right.
  active: { base: union(CLOCK, CHEVRON), knockout: BADGE_KNOCKOUT, top: BADGE },
  // Recent error: exclamation mark in place of the chevron.
  error: {
    base: union(CLOCK, capsule(8, 4.9, 8, 8.8, 1.5), disc(8, 11.2, 0.95)),
    knockout: NOTHING,
    top: NOTHING,
  },
  // Scheduler paused: pause symbol.
  paused: {
    base: union(CLOCK, capsule(6.6, 5.6, 6.6, 10.4, 1.5), capsule(9.4, 5.6, 9.4, 10.4, 1.5)),
    knockout: NOTHING,
    top: NOTHING,
  },
}

// --- rasterisation -----------------------------------------------------------

/**
 * @param {number[]} [colour] RGB to paint. Omitted, the glyph is pure black and
 *   only the alpha carries the shape — which is what a macOS template image is.
 */
function rasterize({ base, knockout, top }, size, colour = null) {
  const scale = GRID / size
  const step = scale / SAMPLES
  const offset = step / 2
  const pixels = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px * scale + sx * step + offset
          const y = py * scale + sy * step + offset
          const inside = (base(x, y) <= 0 && knockout(x, y) > 0) || top(x, y) <= 0
          if (inside) covered++
        }
      }
      const i = (py * size + px) * 4
      if (colour) {
        pixels[i] = colour[0]
        pixels[i + 1] = colour[1]
        pixels[i + 2] = colour[2]
      }
      // Without a colour: pure black, and only the alpha carries the shape.
      pixels[i + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255)
    }
  }
  return pixels
}

// --- the Linux tray -------------------------------------------------------------

// macOS recolours a template image to suit the menu bar; nothing does that on
// Linux, so a template image lands there as a flat black shape — invisible on
// the dark panel most desktops ship with. The Linux icon therefore carries its
// own colour.
//
// The colours are mid-tones, chosen to hold against a white panel and a near
// black one rather than to look their best on either. And they are never the
// only signal: each state already has its own shape — chevron, dot, exclamation
// mark, pause bars — which is what somebody who cannot separate red from green
// reads instead.
const LINUX_COLOURS = {
  idle: [0x8a, 0x93, 0xa5],
  active: [0x4d, 0x9b, 0xe6],
  error: [0xe2, 0x5c, 0x56],
  paused: [0xe0, 0x9a, 0x3c],
}

// --- application icon ----------------------------------------------------------

// Unlike the tray, the application icon is in colour and must hold from 16 px
// (Finder title bar) up to 1024 px (Launchpad). A margin of about 9%: macOS
// icons never touch the edge of the canvas.
const APP_BACKGROUND = roundedRect(8, 8, 6.55, 6.55, 3.05)
const APP_DIAL = ring(8, 8, 4.35, 0.95)
const APP_GLYPH = union(
  APP_DIAL,
  capsule(6.65, 6.45, 8.3, 8, 1.05),
  capsule(8.3, 8, 6.65, 9.55, 1.05),
)
// Alert variant: the exclamation mark replaces the chevron, exactly as in the
// tray's error icon. Colour alone is not enough to carry the information — it
// disappears for some colour-blind people, and a notification thumbnail is
// small.
const APP_ALERT_GLYPH = union(APP_DIAL, capsule(8, 5.6, 8, 8.5, 1.05), disc(8, 10.3, 0.68))

const APP_GLYPH_COLOR = [0xff, 0xff, 0xff]

// Background of the application icon, varied by state for the notifications.
const PALETTES = {
  neutral: { top: [0x32, 0x36, 0x42], bottom: [0x1c, 0x1e, 0x26], glyph: APP_GLYPH },
  success: { top: [0x2f, 0xa0, 0x62], bottom: [0x1b, 0x6a, 0x40], glyph: APP_GLYPH },
  error: { top: [0xd9, 0x4a, 0x45], bottom: [0x8f, 0x25, 0x24], glyph: APP_ALERT_GLYPH },
}

function rasterizeAppIcon({ top, bottom, glyph }, size) {
  const scale = GRID / size
  const step = scale / SAMPLES
  const offset = step / 2
  const pixels = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px * scale + sx * step + offset
          const y = py * scale + sy * step + offset
          if (APP_BACKGROUND(x, y) > 0) continue

          const [cr, cg, cb] =
            glyph(x, y) <= 0 ? APP_GLYPH_COLOR : gradientAt(top, bottom, y / GRID)
          r += cr
          g += cg
          b += cb
          covered++
        }
      }

      const total = SAMPLES * SAMPLES
      const i = (py * size + px) * 4
      if (covered > 0) {
        // Average colour of the covered subsamples, alpha = coverage rate.
        pixels[i] = Math.round(r / covered)
        pixels[i + 1] = Math.round(g / covered)
        pixels[i + 2] = Math.round(b / covered)
        pixels[i + 3] = Math.round((covered / total) * 255)
      }
    }
  }
  return pixels
}

function gradientAt(top, bottom, t) {
  return top.map((from, i) => from + (bottom[i] - from) * t)
}

// --- PNG encoding --------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // profondeur
  ihdr[9] = 6 // RGBA
  // 10..12: compression, filter, interlacing — all at 0

  // One row = one filter byte (0 = none) followed by the pixels.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- output ----------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const [name, variant] of Object.entries(VARIANTS)) {
  // The "Template" suffix triggers automatic recolouring by macOS.
  for (const [size, suffix] of [
    [16, ''],
    [32, '@2x'],
    [64, '@4x'],
  ]) {
    const file = path.join(OUT_DIR, `${name}Template${suffix}.png`)
    fs.writeFileSync(file, encodePng(rasterize(variant, size), size))
    console.log(`${path.relative(process.cwd(), file)}  ${size}×${size}`)
  }
}

// The same four shapes for Linux, in colour, at the sizes a panel asks for.
// Electron reads the "@2x" companion on its own when the display is HiDPI.
fs.mkdirSync(LINUX_OUT_DIR, { recursive: true })
for (const [name, variant] of Object.entries(VARIANTS)) {
  for (const [size, suffix] of [
    [22, ''],
    [44, '@2x'],
  ]) {
    const file = path.join(LINUX_OUT_DIR, `${name}${suffix}.png`)
    fs.writeFileSync(file, encodePng(rasterize(variant, size, LINUX_COLOURS[name]), size))
    console.log(`${path.relative(process.cwd(), file)}  ${size}×${size}`)
  }
}

// Variants for the notifications: same logo, background coloured by outcome.
// 256 pixels is enough — macOS only displays a thumbnail of it.
fs.mkdirSync(NOTIFICATION_DIR, { recursive: true })
for (const [name, palette] of Object.entries(PALETTES)) {
  const file = path.join(NOTIFICATION_DIR, `${name}.png`)
  fs.writeFileSync(file, encodePng(rasterizeAppIcon(palette, 256), 256))
  console.log(`${path.relative(process.cwd(), file)}  256×256`)
}

// Set of application icons, under the names iconutil expects.
fs.mkdirSync(ICONSET_DIR, { recursive: true })
for (const [base, scale] of [
  [16, 1],
  [16, 2],
  [32, 1],
  [32, 2],
  [128, 1],
  [128, 2],
  [256, 1],
  [256, 2],
  [512, 1],
  [512, 2],
]) {
  const size = base * scale
  const name = `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`
  fs.writeFileSync(
    path.join(ICONSET_DIR, name),
    encodePng(rasterizeAppIcon(PALETTES.neutral, size), size),
  )
  console.log(`${path.relative(process.cwd(), path.join(ICONSET_DIR, name))}  ${size}×${size}`)
}

console.log('\nTo produce the .icns:')
console.log(`  iconutil -c icns ${path.relative(process.cwd(), ICONSET_DIR)} -o build/icon.icns`)
