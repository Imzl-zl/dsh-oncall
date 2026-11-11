/**
 * Painting the room: the only module that touches a 2D context.
 *
 * Two things here are deliberate and load-bearing:
 *
 * - **The static half is painted once.** Floor, walls, rug, waiting pad,
 *   posters, lamp pools and the plant never change unless the room size does,
 *   so they live in one offscreen canvas and each frame is a single `drawImage`
 *   plus one pass over the agents. That is what keeps a frame near 0.1ms.
 * - **It never owns data.** Everything comes from a {@link RoomScene} produced
 *   by ./office-scene.ts; this file decides pixels, not placement.
 *
 * `document` may be absent (the test renderer has no canvas): the sprite and
 * static-layer factories return `undefined` there and painting degrades to
 * whatever it can draw, so importing this module never breaks a suite.
 *
 * Note: 性能预算与降级 —— 见 docs/design/agent-fleet-drawer.md
 * 「像素办公室视图（2026-10-27 定稿）」
 */

import type { RoomScene, ScenePerson, VisualState } from './office-scene.ts'
import {
  DESK_WORKSTATION,
  FRAME_MS,
  ROOM_TILES_H,
  ROOM_TILES_W,
  SPRITE_H,
  SPRITE_W,
  STEP_X,
  STEP_Y,
  TILE_H,
  TILE_W,
  WALL_H,
  deskTopCorners,
  monitorBaseRect,
  project,
} from './office-template.ts'

/** Logical (pre-upscale) room size. */
export const ROOM_W = (ROOM_TILES_W + ROOM_TILES_H) * STEP_X + 16
export const ROOM_H = (ROOM_TILES_W + ROOM_TILES_H) * STEP_Y + WALL_H + 44
const ORIGIN_X = ROOM_W / 2
const ORIGIN_Y = WALL_H + 8

/** Where the room's (0,0) grid point lands, in logical pixels. */
export const ROOM_ORIGIN = { x: ORIGIN_X, y: ORIGIN_Y } as const

/** One colour per visual state: chips, screens and markers all read this. */
export const STATE_COLOR: Readonly<Record<VisualState, string>> = {
  busy: '#7ee787',
  stuck: '#ff7b72',
  done: '#e3b341',
  idle: '#5b6673',
  unknown: '#8b96a5',
}

const FLOOR = ['#8a5c36', '#7b502d'] as const
const FLOOR_LINE = 'rgba(0,0,0,0.16)'
const WALL_A = '#302e3a'
const WALL_B = '#3a3744'
const WAIN_A = '#3d3b47'
const WAIN_B = '#474451'
const SKIRT = '#1d1b22'
const WOOD = ['#a9743f', '#8a5a2f', '#6b4423'] as const
const METAL = ['#5b6472', '#3d4551', '#1a1f27'] as const
const PLANT = ['#4f8460', '#3f6b4f', '#2c4a37'] as const
const RUG = ['#33404f', '#2b3440'] as const
const ZONE = ['#5b6270', '#525a68'] as const
const SHIRTS = ['#5b8def', '#d2a8ff', '#7ee787', '#f2a65a', '#79c0ff', '#ff9bce'] as const
const HAIRS = ['#2b2118', '#4a2f1b', '#1f2a37', '#5b3a1a'] as const
const CHAIR = '#3b4654'
const CHAIR_DARK = '#2b3440'
const PAPER = '#efe8d7'

/** Sprite poses. `typeA`/`typeB` alternate while a screen is busy. */
export type Pose = 'typeA' | 'typeB' | 'stand'

const hasDocument = (): boolean =>
  typeof document !== 'undefined' && typeof document.createElement === 'function'

const hash = (text: string): number => {
  let value = 2166136261
  for (const char of text) {
    value ^= char.codePointAt(0) ?? 0
    value = Math.imul(value, 16777619)
  }
  return Math.abs(value)
}

/** The palette an agent's body is drawn with, derived from its id. */
function lookOf(id: string): { shirt: string; hair: string } {
  const n = hash(id)
  return { shirt: SHIRTS[n % SHIRTS.length]!, hair: HAIRS[n % HAIRS.length]! }
}

/** Draw one 24×32 person into its own canvas (cached by agent id + pose). */
function makeSprite(shirt: string, hair: string, pose: Pose): HTMLCanvasElement | undefined {
  if (!hasDocument()) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = SPRITE_W
  canvas.height = SPRITE_H
  const g = canvas.getContext('2d')
  if (g === null) return undefined
  const rect = (x: number, y: number, w: number, h: number, color: string): void => {
    g.fillStyle = color
    g.fillRect(x, y, w, h)
  }
  const skin = '#f2c49b'
  const parts: [number, number, number, number, string][] = [
    [7, 2, 10, 15, hair], [5, 4, 14, 12, hair],
    [9, 7, 6, 8, skin], [8, 8, 8, 6, skin],
    [9, 17, 6, 8, shirt], [7, 18, 10, 6, shirt],
    [6, 19, 2, 5, shirt], [16, 19, 2, 5, shirt],
  ]
  if (pose === 'stand') {
    parts.push([8, 25, 3, 6, '#2b3440'], [13, 25, 3, 6, '#2b3440'], [7, 31, 4, 1, '#171d26'], [13, 31, 4, 1, '#171d26'])
  }
  for (const [x, y, w, h, color] of parts) {
    rect(x - 1, y, w, h, '#1b2028')
    rect(x + 1, y, w, h, '#1b2028')
    rect(x, y - 1, w, h, '#1b2028')
    rect(x, y + 1, w, h, '#1b2028')
    rect(x, y, w, h, color)
  }
  rect(9, 10, 3, 3, '#20262e')
  rect(14, 10, 3, 3, '#20262e')
  rect(9, 10, 1, 1, '#ffffff')
  rect(14, 10, 1, 1, '#ffffff')
  rect(12, 13, 1, 2, '#d9a07f')
  rect(11, 15, 2, 1, '#c0745f')
  rect(8, 6, 8, 2, hair)
  return canvas
}

const sprites = new Map<string, HTMLCanvasElement | undefined>()

/** The cached sprite for one person and pose (undefined without a document). */
export function spriteFor(person: ScenePerson, pose: Pose): HTMLCanvasElement | undefined {
  const key = `${person.agent.id}|${pose}`
  if (!sprites.has(key)) {
    const look = lookOf(person.agent.id)
    sprites.set(key, makeSprite(look.shirt, look.hair, pose))
  }
  return sprites.get(key)
}

/** Paint the room's immutable half into a fresh canvas (browser only). */
export function paintStaticRoom(): HTMLCanvasElement | undefined {
  if (!hasDocument()) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = ROOM_W
  canvas.height = ROOM_H
  const g = canvas.getContext('2d')
  if (g === null) return undefined
  const at = (gx: number, gy: number): readonly [number, number] => project(ORIGIN_X, ORIGIN_Y, gx, gy)
  const poly = (points: readonly (readonly [number, number])[], color: string): void => {
    g.beginPath()
    g.moveTo(points[0]![0], points[0]![1])
    for (const point of points.slice(1)) g.lineTo(point[0], point[1])
    g.closePath()
    g.fillStyle = color
    g.fill()
  }
  const diamond = (gx: number, gy: number, color: string): void => {
    const [x, y] = at(gx, gy)
    poly([[x, y], [x + TILE_W / 2, y + TILE_H / 2], [x, y + TILE_H], [x - TILE_W / 2, y + TILE_H / 2]], color)
  }

  for (let gy = 0; gy < ROOM_TILES_H; gy += 1) {
    for (let gx = 0; gx < ROOM_TILES_W; gx += 1) {
      diamond(gx, gy, (gx + gy) % 2 === 0 ? FLOOR[0] : FLOOR[1])
      const [x, y] = at(gx, gy)
      poly([[x, y], [x + TILE_W / 2, y + TILE_H / 2], [x + TILE_W / 2, y + TILE_H / 2 + 1], [x, y + 1]], FLOOR_LINE)
    }
  }
  for (let gy = 0.5; gy < 3.5; gy += 0.5) {
    for (let gx = 0.8; gx < 9.2; gx += 0.5) {
      const [x, y] = at(gx, gy)
      poly([[x, y], [x + STEP_X / 2, y + STEP_Y / 2], [x, y + STEP_Y], [x - STEP_X / 2, y + STEP_Y / 2]],
        (Math.round(gx * 2) + Math.round(gy * 2)) % 2 === 0 ? RUG[0] : RUG[1])
    }
  }
  for (let gy = 4.6; gy < 6.2; gy += 0.5) {
    for (let gx = 0.8; gx < 3.2; gx += 0.5) {
      const [x, y] = at(gx, gy)
      poly([[x, y], [x + STEP_X / 2, y + STEP_Y / 2], [x, y + STEP_Y], [x - STEP_X / 2, y + STEP_Y / 2]],
        (Math.round(gx * 2) + Math.round(gy * 2)) % 2 === 0 ? ZONE[0] : ZONE[1])
    }
  }

  const a = at(0, 0), b = at(ROOM_TILES_W, 0), d = at(0, ROOM_TILES_H)
  poly([[a[0], a[1] - WALL_H], [b[0], b[1] - WALL_H], [b[0], b[1]], [a[0], a[1]]], WALL_A)
  poly([[a[0], a[1] - WALL_H], [d[0], d[1] - WALL_H], [d[0], d[1]], [a[0], a[1]]], WALL_B)
  poly([[a[0], a[1] - 16], [b[0], b[1] - 16], [b[0], b[1]], [a[0], a[1]]], WAIN_A)
  poly([[a[0], a[1] - 16], [d[0], d[1] - 16], [d[0], d[1]], [a[0], a[1]]], WAIN_B)
  poly([[a[0], a[1] - 17], [b[0], b[1] - 17], [b[0], b[1] - 16], [a[0], a[1] - 16]], SKIRT)
  poly([[a[0], a[1] - 17], [d[0], d[1] - 17], [d[0], d[1] - 16], [a[0], a[1] - 16]], SKIRT)

  const poster = (gy0: number, gy1: number, color: string): void => {
    const p0 = at(0, gy0), p1 = at(0, gy1)
    poly([[p0[0], p0[1] - 44], [p1[0], p1[1] - 44], [p1[0], p1[1] - 22], [p0[0], p0[1] - 22]], '#1b1e26')
    poly([[p0[0], p0[1] - 42], [p1[0], p1[1] - 42], [p1[0], p1[1] - 24], [p0[0], p0[1] - 24]], color)
  }
  poster(1.2, 3.0, '#3f5f8a')
  poster(3.8, 5.2, '#3c6b4f')

  for (const [gx, gy] of [[2.6, 1.6], [6.4, 2.6]] as const) {
    const [x, y] = at(gx, gy)
    const grad = g.createRadialGradient(x, y + 8, 1, x, y + 8, 62)
    grad.addColorStop(0, 'rgba(255,208,138,0.26)')
    grad.addColorStop(0.6, 'rgba(255,200,130,0.10)')
    grad.addColorStop(1, 'rgba(255,200,130,0)')
    g.fillStyle = grad
    g.beginPath()
    g.ellipse(x, y + 8, 62, 31, 0, 0, Math.PI * 2)
    g.fill()
  }

  const [px, py] = at(0.8, 2.2)
  g.fillStyle = '#6b4b2a'
  g.fillRect(px - 6, py - 13, 12, 13)
  g.fillStyle = PLANT[2]
  g.fillRect(px - 9, py - 26, 8, 13)
  g.fillRect(px + 1, py - 29, 8, 15)
  g.fillStyle = PLANT[0]
  g.fillRect(px - 5, py - 34, 10, 12)
  g.fillStyle = PLANT[1]
  g.fillRect(px + 4, py - 31, 5, 10)

  const vg = g.createRadialGradient(ROOM_W / 2, ROOM_H / 2, Math.min(ROOM_W, ROOM_H) * 0.36,
    ROOM_W / 2, ROOM_H / 2, Math.max(ROOM_W, ROOM_H) * 0.64)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.42)')
  g.fillStyle = vg
  g.fillRect(0, 0, ROOM_W, ROOM_H)
  return canvas
}

/** Paint one seated agent: chair back, agent, desk over the legs, monitor, clutter. */
function paintSeat(g: CanvasRenderingContext2D, person: ScenePerson, tick: number): void {
  const { deskH, chairW, chairH, monitorW, monitorH } = DESK_WORKSTATION
  const [x, y] = person.at
  const [seatX, seatY] = [x + DESK_WORKSTATION.seatDX, y + DESK_WORKSTATION.seatDY]
  g.fillStyle = CHAIR
  g.fillRect(seatX - chairW / 2, seatY - SPRITE_H + 6, chairW, chairH)
  g.fillStyle = CHAIR_DARK
  g.fillRect(seatX + chairW / 2 - 3, seatY - SPRITE_H + 6, 3, chairH)
  const pose: Pose = person.visual === 'busy' || person.visual === 'stuck'
    ? (tick % 12 < 6 ? 'typeA' : 'typeB')
    : 'typeA'
  const sprite = spriteFor(person, pose)
  if (sprite !== undefined) g.drawImage(sprite, seatX - SPRITE_W / 2, seatY - SPRITE_H)

  const corners = deskTopCorners(x, y)
  g.fillStyle = WOOD[2]
  for (const [cx, cy] of corners) g.fillRect(Math.round(cx) - 1, Math.round(cy), 2, deskH + 1)
  g.beginPath()
  g.moveTo(corners[0]![0], corners[0]![1])
  for (const point of corners.slice(1)) g.lineTo(point[0], point[1])
  g.closePath()
  g.fillStyle = WOOD[0]
  g.fill()
  const nearL = corners[3]!
  const nearR = corners[2]!
  g.fillStyle = WOOD[1]
  g.fillRect(nearL[0], nearL[1], nearR[0] - nearL[0], 4)
  g.fillStyle = WOOD[2]
  g.fillRect(nearR[0], nearR[1], 4, 4)

  const base = monitorBaseRect(x, y)
  const screen = STATE_COLOR[person.visual]
  g.fillStyle = 'rgba(0,0,0,0.35)'
  g.fillRect(base.x, base.y, base.w, base.h)
  g.fillStyle = METAL[1]
  g.fillRect(x + DESK_WORKSTATION.monitorDX - 2, base.y - 6, 4, 6)
  g.fillStyle = METAL[2]
  g.fillRect(base.x + 2, base.y - monitorH - 6, monitorW - 4, monitorH)
  g.globalAlpha = person.visual === 'busy' ? 0.6 + 0.4 * ((tick % 18) / 18) : 0.92
  g.fillStyle = screen
  g.fillRect(base.x + 4, base.y - monitorH - 4, monitorW - 8, monitorH - 3)
  g.globalAlpha = 1
  g.fillStyle = PAPER
  g.fillRect(x - 26, base.y - 4, 12, 3)
  g.fillStyle = METAL[0]
  g.fillRect(x - 33, base.y - 5, 4, 4)

  if (person.visual === 'stuck') {
    g.fillStyle = STATE_COLOR.stuck
    g.fillRect(seatX + 12, seatY - SPRITE_H - 2, 2, 7)
    g.fillRect(seatX + 12, seatY - SPRITE_H + 6, 2, 2)
  }
}

/** Paint one standing agent (waiting pad). */
function paintStanding(g: CanvasRenderingContext2D, person: ScenePerson): void {
  const sprite = spriteFor(person, 'stand')
  if (sprite === undefined) return
  const [x, y] = person.at
  g.fillStyle = 'rgba(0,0,0,0.3)'
  g.beginPath()
  g.ellipse(x, y + 2, 10, 4, 0, 0, Math.PI * 2)
  g.fill()
  g.drawImage(sprite, x - SPRITE_W / 2, y - SPRITE_H)
}

/**
 * Paint one frame.
 *
 * @param g - destination 2D context.
 * @param scene - placement, from ./office-scene.ts.
 * @param tick - animation frame counter (monotonic; drives the typing pose).
 * @param staticRoom - the baked room, or `undefined` to paint on bare floor.
 */
export function paintFrame(
  g: CanvasRenderingContext2D,
  scene: RoomScene,
  tick: number,
  staticRoom?: HTMLCanvasElement,
): void {
  g.imageSmoothingEnabled = false
  g.clearRect(0, 0, ROOM_W, ROOM_H)
  if (staticRoom !== undefined) g.drawImage(staticRoom, 0, 0)
  for (const person of scene.seated) paintSeat(g, person, tick)
  for (const person of scene.waiting) paintStanding(g, person)
}

// ---------------------------------------------------------------------------
// Frame clock: ONE loop for every room on screen.
//
// Rooms subscribe; the clock only runs while at least one subscriber exists,
// the document is visible, and somebody is animating. Ten frames a second is
// plenty for a typing pose and keeps a hidden-but-mounted tab cheap.
// ---------------------------------------------------------------------------
type FrameListener = (tick: number) => void

const listeners = new Set<FrameListener>()
let frameHandle = 0
let frameTick = 0
let frameLast = 0

function step(now: number): void {
  if (now - frameLast >= FRAME_MS && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    frameLast = now
    frameTick += 1
    for (const listener of listeners) listener(frameTick)
  }
  frameHandle = requestAnimationFrame(step)
}

/** Subscribe to animation ticks. Returns the unsubscribe handle. */
export function subscribeFrame(listener: FrameListener): () => void {
  listeners.add(listener)
  if (frameHandle === 0 && typeof requestAnimationFrame === 'function') {
    frameLast = 0
    frameHandle = requestAnimationFrame(step)
  }
  return function () {
    listeners.delete(listener)
    if (listeners.size === 0 && frameHandle !== 0) {
      cancelAnimationFrame(frameHandle)
      frameHandle = 0
    }
  }
}

/** Current tick, for a first paint that matches a later one. */
export function currentTick(): number {
  return frameTick
}
