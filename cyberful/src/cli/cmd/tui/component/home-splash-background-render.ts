// ── Home Splash Background Painter ───────────────────────────────
// Generates the animated glyph field and interpolated palette written directly
//   into the home-screen framebuffer at bounded spatial and temporal resolution.
// ─────────────────────────────────────────────────────────────────

import { OptimizedBuffer, RGBA } from "@opentui/core"

export type Rgb = [number, number, number]

const SPACE = 32
const GLYPHS = ["o", "0", "O", "x", "+", "-"].map((char) => char.codePointAt(0) ?? SPACE)
const PERIOD = 42000
const NOISE_CELL = 2
const COLOR_CELL = 3
const DRAW_CELL = 2
const SCALE_X = 0.62
const SCALE_Y = 0.68
const REFERENCE_STOPS: Rgb[] = [
  [48, 96, 239],
  [190, 55, 220],
  [248, 78, 74],
  [255, 186, 45],
  [245, 224, 88],
  [124, 190, 54],
  [54, 214, 190],
]

type SplashColorSource = {
  color: Rgb
  x: number
  y: number
  rx: number
  ry: number
  strength: number
  phase: number
}

const SOURCE_FIELDS: SplashColorSource[] = [
  { color: [42, 116, 242], x: 0.1, y: 0.78, rx: 0.3, ry: 0.36, strength: 0.72, phase: 0.14 },
  { color: [190, 46, 222], x: 0.24, y: 0.36, rx: 0.3, ry: 0.34, strength: 0.78, phase: 0.36 },
  { color: [248, 72, 72], x: 0.48, y: 0.7, rx: 0.32, ry: 0.28, strength: 0.68, phase: 0.58 },
  { color: [255, 126, 35], x: 0.52, y: 0.24, rx: 0.28, ry: 0.3, strength: 0.92, phase: 0.73 },
  { color: [255, 214, 66], x: 0.54, y: 0.47, rx: 0.32, ry: 0.28, strength: 1.1, phase: 0.92 },
  { color: [130, 202, 42], x: 0.84, y: 0.4, rx: 0.26, ry: 0.34, strength: 0.76, phase: 0.18 },
  { color: [45, 212, 191], x: 0.9, y: 0.82, rx: 0.2, ry: 0.24, strength: 0.48, phase: 0.44 },
]

export type HomeSplashBackgroundRenderOptions = {
  deltaTime?: number
}

export function toRgb(color: RGBA): Rgb {
  const [r, g, b] = color.toInts()
  return [r, g, b]
}

function clamp(n: number) {
  return Math.max(0, Math.min(1, n))
}

function mixChannel(base: number, overlay: number, alpha: number) {
  return Math.round(base + (overlay - base) * clamp(alpha))
}

function writeRgb(buffer: Uint16Array, offset: number, color: Rgb) {
  buffer[offset] = color[0]
  buffer[offset + 1] = color[1]
  buffer[offset + 2] = color[2]
  buffer[offset + 3] = 255
}

function mix(base: Rgb, overlay: Rgb, alpha: number): Rgb {
  return [
    mixChannel(base[0], overlay[0], alpha),
    mixChannel(base[1], overlay[1], alpha),
    mixChannel(base[2], overlay[2], alpha),
  ]
}

function ease(n: number) {
  const p = clamp(n)
  return p * p * (3 - 2 * p)
}

function wrap(n: number) {
  return ((n % 1) + 1) % 1
}

function quantized(value: number, cell: number, max: number) {
  if (max <= 1) return 0
  return Math.min(max - 1, Math.floor(value / cell) * cell + cell * 0.5) / (max - 1)
}

function paletteAt(palette: Rgb[], value: number) {
  const fallback: Rgb = [0, 0, 0]
  const scaled = wrap(value) * palette.length
  const index = Math.floor(scaled)
  const base = palette[index] ?? palette[0] ?? fallback
  const overlay = palette[(index + 1) % palette.length] ?? base
  return mix(base, overlay, ease(scaled - index))
}

function referencePaletteColor(
  palette: Rgb[],
  x: number,
  y: number,
  width: number,
  height: number,
  seed: number,
  t: number,
) {
  const qx = quantized(x, COLOR_CELL, width)
  const qy = quantized(y, COLOR_CELL, height)
  const diagonal = qx * 0.82 + qy * 0.58 + Math.sin((qx * 2.3 - qy * 1.6 + t * 0.07) * Math.PI * 2) * 0.08
  const counter = qy * 0.94 - qx * 0.46 + Math.sin((qx * 1.2 + qy * 2.7 - t * 0.1) * Math.PI * 2) * 0.11
  const braid = (Math.sin((qx * 3.4 - qy * 2.1 + t * 0.16 + seed * 0.22) * Math.PI * 2) + 1) * 0.5
  return mix(
    paletteAt(palette, diagonal + t * 0.022 + seed * 0.045),
    paletteAt(palette, counter + 0.34 - t * 0.018 + seed * 0.06),
    0.1 + braid * 0.76,
  )
}

function referenceImageField(x: number, y: number, width: number, height: number, seed: number, t: number) {
  const qx = quantized(x, COLOR_CELL, width)
  const qy = quantized(y, COLOR_CELL, height)
  const weighted = SOURCE_FIELDS.reduce(
    (result, source) => {
      const phase = (source.phase + seed * 0.025) * Math.PI * 2
      const cx = source.x + Math.sin(t * 0.13 + phase) * 0.035 + Math.sin(t * 0.07 + phase * 1.7) * 0.018
      const cy = source.y + Math.cos(t * 0.11 + phase * 1.2) * 0.028 + Math.sin(t * 0.05 + phase * 0.8) * 0.014
      const dx = (qx - cx) / source.rx
      const dy = (qy - cy) / source.ry
      const weight = Math.exp(-(dx * dx + dy * dy) * 1.7) * source.strength
      return {
        total: result.total + weight,
        r: result.r + source.color[0] * weight,
        g: result.g + source.color[1] * weight,
        b: result.b + source.color[2] * weight,
      }
    },
    { total: 0, r: 0, g: 0, b: 0 },
  )

  const color: Rgb =
    weighted.total > 0
      ? [
          Math.round(weighted.r / weighted.total),
          Math.round(weighted.g / weighted.total),
          Math.round(weighted.b / weighted.total),
        ]
      : [0, 0, 0]
  return {
    color,
    mass: clamp(weighted.total),
  }
}

function fieldCrossing(x: number, y: number, width: number, height: number, seed: number, t: number) {
  const qx = quantized(x, COLOR_CELL, width)
  const qy = quantized(y, COLOR_CELL, height)
  const diagonal = Math.abs(Math.sin((qx * 3.1 + qy * 1.7 - t * 0.2) * Math.PI * 2))
  const counter = Math.abs(Math.sin((qx * 1.5 - qy * 3.6 + t * 0.16 + seed * 0.18) * Math.PI * 2))
  return clamp((diagonal * counter - 0.3) * 1.45)
}

function sameRgb(a: Rgb, b: Rgb) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function hash(x: number, y: number) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return value - Math.floor(value)
}

// ── Coarse Fields Bound Framebuffer Work ─────────────────────────
// Color, noise, and drawing use separate cell sizes so an animated frame does
// not recompute expensive continuous fields for every terminal cell. Geometry
// seeds rebuild only after a resize, while elapsed time wraps before precision
// can drift. Every painted cell still receives explicit foreground, background,
// glyph, and attribute values, preventing stale framebuffer state at the edges.
// ─────────────────────────────────────────────────────────────────
export class HomeSplashBackgroundPainter {
  private baseRgb: Rgb = [2, 3, 5]
  private primaryRgb: Rgb = REFERENCE_STOPS[5] ?? [124, 190, 54]
  private accentRgb: Rgb = REFERENCE_STOPS[6] ?? [54, 214, 190]
  private elapsed = 0
  private geometryWidth = 0
  private geometryHeight = 0
  private seed = new Float32Array(0)

  setBase(value: RGBA | Rgb | undefined) {
    if (!value) return false
    const next = value instanceof RGBA ? toRgb(value) : value
    if (sameRgb(this.baseRgb, next)) return false
    this.baseRgb = next
    return true
  }

  setPrimary(value: RGBA | Rgb | undefined) {
    if (!value) return false
    const next = value instanceof RGBA ? toRgb(value) : value
    if (sameRgb(this.primaryRgb, next)) return false
    this.primaryRgb = next
    return true
  }

  setAccent(value: RGBA | Rgb | undefined) {
    if (!value) return false
    const next = value instanceof RGBA ? toRgb(value) : value
    if (sameRgb(this.accentRgb, next)) return false
    this.accentRgb = next
    return true
  }

  render(frameBuffer: OptimizedBuffer, options: HomeSplashBackgroundRenderOptions = {}) {
    this.elapsed = (this.elapsed + (options.deltaTime ?? 0)) % PERIOD
    this.rebuildGeometry(frameBuffer)
    this.draw(frameBuffer)
  }

  private rebuildGeometry(frameBuffer: OptimizedBuffer) {
    const width = frameBuffer.width
    const height = frameBuffer.height
    if (width === this.geometryWidth && height === this.geometryHeight) return

    this.geometryWidth = width
    this.geometryHeight = height
    this.seed = new Float32Array(width * height)

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        this.seed[y * width + x] =
          hash(Math.floor(x / NOISE_CELL), Math.floor(y / NOISE_CELL)) * 0.78 + hash(x, y) * 0.22
      }
    }
  }

  private draw(frameBuffer: OptimizedBuffer) {
    const width = frameBuffer.width
    const height = frameBuffer.height
    const buffers = frameBuffer.buffers
    const t = this.elapsed / 1000
    const palette = this.palette()

    buffers.attributes.fill(0)

    for (let y = 0; y < height; y += DRAW_CELL) {
      for (let x = 0; x < width; x += DRAW_CELL) {
        const index = y * width + x
        const nx = width <= 1 ? 0 : x / (width - 1)
        const ny = height <= 1 ? 0 : y / (height - 1)
        const seed = this.seed[index] ?? 0
        const sx = x * SCALE_X
        const sy = y * SCALE_Y
        const drift = Math.sin(sx * 0.055 + sy * 0.11 - t * 0.48)
        const wave =
          Math.sin(sx * 0.14 + sy * 0.36 - t * 1.24 + drift * 1.6) * 0.44 +
          Math.sin(sx * 0.23 - sy * 0.2 + t * 0.92) * 0.34 +
          Math.sin((nx * 1.9 + ny * 3.2 - t * 0.16) * Math.PI * 2) * 0.38
        const reference = referenceImageField(x, y, width, height, seed, t)
        const color = mix(referencePaletteColor(palette, x, y, width, height, seed, t), reference.color, reference.mass)
        const crossing = fieldCrossing(x, y, width, height, seed, t)
        const density = wave * 0.4 + seed * 0.5 + reference.mass * 1.15 + crossing * 0.32 - 0.4
        const edgeFade = clamp((Math.min(nx, 1 - nx, ny, 1 - ny) + 0.04) * 4.8)
        const glow = clamp((density + 0.3) * (0.12 + reference.mass * 0.16 + crossing * 0.04)) * edgeFade
        const active = density > 0.24
        const faint = reference.mass > 0.08 || density > -0.08
        const char = active
          ? (GLYPHS[Math.floor(seed * GLYPHS.length + t * 0.55 + sx * 0.08 + sy * 0.12) % GLYPHS.length] ?? SPACE)
          : faint
            ? (GLYPHS[0] ?? SPACE)
            : SPACE
        const strength = active ? clamp((density - 0.1) * 1.42) : clamp(reference.mass * 0.42)
        const highlight = mix(color, this.accentRgb, crossing * 0.2)
        const bg = mix(this.baseRgb, color, glow)
        const fg =
          !active && !faint
            ? mix(this.baseRgb, color, 0.08)
            : mix(this.baseRgb, highlight, active ? 0.45 + strength * 0.55 : 0.18 + strength)

        for (let yy = y; yy < Math.min(height, y + DRAW_CELL); yy += 1) {
          for (let xx = x; xx < Math.min(width, x + DRAW_CELL); xx += 1) {
            const cellIndex = yy * width + xx
            const offset = cellIndex * 4
            buffers.char[cellIndex] = char
            writeRgb(buffers.bg, offset, bg)
            writeRgb(buffers.fg, offset, fg)
          }
        }
      }
    }
  }

  private palette() {
    return REFERENCE_STOPS.map((color, index) => {
      if (index === 5) return mix(color, this.primaryRgb, 0.06)
      if (index === REFERENCE_STOPS.length - 1) return mix(color, this.accentRgb, 0.08)
      return color
    })
  }
}
