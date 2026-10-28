/**
 * The pixel office's geometry, as data.
 *
 * A workstation is authored ONCE in a local frame whose origin is the desk's
 * floor centre, then stamped at every grid point. Nothing in the painting code
 * may invent an offset: every number lives in {@link DESK_WORKSTATION}, so
 * tuning one workstation tunes all of them — and {@link assertWorkstation}
 * turns the three rules that were learned the hard way into checkable facts
 * instead of something to eyeball on a screenshot:
 *
 * 1. the agent's feet sit inside the desk's near face (otherwise the agent
 *    floats above the floor — raising the seat is NOT how you make the agent
 *    look taller than the monitor);
 * 2. the monitor's base stays inside the desk-top diamond (the diamond narrows
 *    with height, so a "looks fine" x offset can still hang over the edge);
 * 3. nothing but the desk decides where the status chip goes (`chipDY`).
 *
 * Units: the grid is isometric 2:1 with `TW`/`TH` in screen pixels, and one
 * grid step is **TW / 2 = 24px** horizontally — not TW. Getting that wrong is
 * what made an earlier revision lay out desks as an overlapping heap.
 *
 * Note: 为何模板化、三层信息架构与布局表 —— 见
 * docs/design/agent-fleet-drawer.md「像素办公室视图（2026-10-27 定稿）」
 */

import type { FleetAgentState } from './model.ts'

/** Isometric tile width in screen pixels (2:1 with {@link TILE_H}). */
export const TILE_W = 48
/** Isometric tile height in screen pixels. */
export const TILE_H = 24
/** One grid step, horizontally, in screen pixels. */
export const STEP_X = TILE_W / 2
/** One grid step, vertically, in screen pixels. */
export const STEP_Y = TILE_H / 2
/** Back-wall height above the floor line. */
export const WALL_H = 66

/** Logical (pre-upscale) room size for a 10×7 single room. */
export const ROOM_TILES_W = 10
export const ROOM_TILES_H = 7

/** Desk slots inside a 10×7 room: three in the back row, two staggered in front. */
export const DESK_SLOTS: readonly (readonly [number, number])[] = [
  [2.5, 1.2], [5, 1.2], [7.5, 1.2], [3.75, 2.9], [6.25, 2.9],
]

/** Where the idle agents stand in the 10×7 room. */
export const WAIT_SLOTS: readonly (readonly [number, number])[] = [
  [1.4, 4.8], [2.3, 4.8], [3.2, 4.8],
]

/** The single source of truth for a workstation's proportions. */
export const DESK_WORKSTATION = {
  /** Desk top above the floor. */
  deskH: 13,
  /** Footprint half-extents, in tiles: the long axis runs along uy. */
  halfW: 0.22,
  halfD: 0.42,
  /** Agent's feet, relative to the anchor (the desk's floor centre). */
  seatDX: -7,
  seatDY: -8,
  /** Monitor centre / base, relative to the anchor. */
  monitorDX: 1,
  monitorDY: 3,
  monitorW: 16,
  monitorH: 9,
  /** Chair back behind the agent. */
  chairW: 16,
  chairH: 14,
  /** Status chip, below the anchor. */
  chipDY: 12,
} as const

/** Agent sprite size, in logical pixels. */
export const SPRITE_W = 24
export const SPRITE_H = 32

/** A point in logical room pixels. */
export type Point = readonly [number, number]

/** Project a grid coordinate into the room's logical pixel space. */
export function project(originX: number, originY: number, gx: number, gy: number): Point {
  return [originX + (gx - gy) * STEP_X, originY + (gx + gy) * STEP_Y]
}

/** The desk top's four corners, clockwise from the far corner. */
export function deskTopCorners(x: number, y: number): readonly Point[] {
  const { deskH, halfW, halfD } = DESK_WORKSTATION
  const at = (a: number, b: number): Point => [
    x + a * STEP_X - b * STEP_X,
    y + a * STEP_Y + b * STEP_Y - deskH,
  ]
  return [at(-halfW, -halfD), at(halfW, -halfD), at(halfW, halfD), at(-halfW, halfD)]
}

/** The agent's feet position for an anchor. */
export function seatPoint(x: number, y: number): Point {
  return [x + DESK_WORKSTATION.seatDX, y + DESK_WORKSTATION.seatDY]
}

/** The monitor's base rectangle (2px tall) for an anchor. */
export function monitorBaseRect(x: number, y: number): { x: number; y: number; w: number; h: number } {
  const { deskH, monitorDX, monitorDY, monitorW } = DESK_WORKSTATION
  return { x: x + monitorDX - (monitorW - 4) / 2, y: y - deskH + monitorDY - 2, w: monitorW - 4, h: 2 }
}

/** Half-extents of the desk-top diamond on screen. */
function deskTopSpan(): { sx: number; sy: number } {
  const { halfW, halfD } = DESK_WORKSTATION
  return { sx: (halfW + halfD) * STEP_X, sy: (halfW + halfD) * STEP_Y }
}

/** Whether a screen point lies inside the desk-top diamond for this anchor. */
export function insideDeskTop(x: number, y: number, px: number, py: number): boolean {
  const { deskH } = DESK_WORKSTATION
  const span = deskTopSpan()
  const dx = Math.abs(px - x) / span.sx
  const dy = Math.abs(py - (y - deskH)) / span.sy
  return dx + dy <= 1
}

/**
 * Whether the agent's feet are hidden behind the desk's near face.
 *
 * The desk's top face covers `y - deskH ± span.sy`; the near face adds 4px of
 * thickness below that. Feet anywhere inside that band are covered, which is
 * what makes the agent read as seated rather than floating.
 */
export function seatIsBehindDeskEdge(x: number, y: number): boolean {
  const { deskH } = DESK_WORKSTATION
  const span = deskTopSpan()
  const top = y - deskH - span.sy
  const bottom = y - deskH + span.sy + 4
  const feet = seatPoint(x, y)[1]
  return feet >= top && feet <= bottom
}

/** Whether the whole monitor base sits inside the desk top. */
export function monitorBaseInsideDeskTop(x: number, y: number): boolean {
  const rect = monitorBaseRect(x, y)
  const corners: Point[] = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ]
  return corners.every(([px, py]) => insideDeskTop(x, y, px, py))
}

/** The three invariants, as a list of violations (empty means the template holds). */
export function workstationViolations(x = 0, y = 0): string[] {
  const out: string[] = []
  if (!seatIsBehindDeskEdge(x, y)) out.push('seat is outside the desk edge (the agent would float)')
  if (!monitorBaseInsideDeskTop(x, y)) out.push('monitor base hangs over the desk top')
  if (DESK_WORKSTATION.chipDY <= 0) out.push('status chip must hang below the anchor')
  return out
}

/** The agent's pose for a state and animation tick. */
export function poseOf(state: FleetAgentState, tick: number): 'typeA' | 'typeB' | 'stand' {
  if (state === 'idle') return 'stand'
  if (state === 'running' || state === 'anomaly') return tick % 12 < 6 ? 'typeA' : 'typeB'
  return 'typeA'
}

/** How many milliseconds a pixel animation frame lasts (≈10fps). */
export const FRAME_MS = 96
