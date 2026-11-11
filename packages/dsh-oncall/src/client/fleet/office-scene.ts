/**
 * The office as DATA: who sits where, who waits, what overflows.
 *
 * A pure adapter between the fleet model and the renderer:
 *
 * - `FleetAgentState` → {@link VisualState} happens ONCE, here. The renderer
 *   only knows four visual states, so adding a fleet state later is a change to
 *   this table rather than to every `switch` in the painting code.
 * - Seat assignment is a pure function of the ordered agent list, so "the same
 *   agents always sit at the same desks" is a property the unit suite can
 *   check — the renderer never decides placement on its own.
 *
 * No DOM, no canvas, no React: this module is imported by tests as-is.
 *
 * Note: 三层信息架构与布局表 —— 见 docs/design/agent-fleet-drawer.md
 * 「像素办公室视图（2026-10-27 定稿）」
 */

import type { FleetAgent, FleetAgentState } from './model.ts'
import {
  DESK_SLOTS,
  DESK_WORKSTATION,
  WAIT_SLOTS,
  project,
  type Point,
} from './office-template.ts'

/** What the room paints. Deliberately smaller than `FleetAgentState`. */
export type VisualState = 'busy' | 'stuck' | 'done' | 'idle' | 'unknown'

/** One agent placed in the room. */
export interface ScenePerson {
  readonly agent: FleetAgent
  readonly visual: VisualState
  /** Feet position, in logical room pixels. */
  readonly at: Point
  /** Where this agent's status chip hangs. */
  readonly chip: Point
  readonly seated: boolean
}

/** Everything one room needs to paint itself. */
export interface RoomScene {
  /** Seated agents, in slot order. */
  readonly seated: readonly ScenePerson[]
  /** Agents standing in the waiting pad, in slot order. */
  readonly waiting: readonly ScenePerson[]
  /** Agents that did not fit in either place. */
  readonly overflow: number
  /** Total agents considered (seated + waiting + overflow). */
  readonly total: number
  /** Whether any agent animates; the frame clock only runs then. */
  readonly animating: boolean
}

/** The single place a fleet state becomes a visual state. */
export function visualStateOf(state: FleetAgentState): VisualState {
  switch (state) {
    case 'running': return 'busy'
    case 'anomaly': return 'stuck'
    case 'done': return 'done'
    case 'idle': return 'idle'
    default: return 'unknown'
  }
}

/** Whether a visual state belongs at a desk (everything except plain idle). */
export function takesDesk(visual: VisualState): boolean {
  return visual !== 'idle'
}

/** Whether a visual state animates the scene. */
export function animates(visual: VisualState): boolean {
  return visual === 'busy' || visual === 'stuck'
}

/**
 * Place the agents.
 *
 * Order is preserved on purpose: the fleet model already sorts children, and
 * re-sorting here would make the room disagree with the list beside it.
 * @param originX - room origin in logical pixels (from the room size).
 * @param originY - same, vertical.
 * @param agents - the session's direct children.
 * @returns the room, ready to paint.
 */
export function buildScene(
  originX: number,
  originY: number,
  agents: readonly FleetAgent[],
): RoomScene {
  const seated: ScenePerson[] = []
  const waiting: ScenePerson[] = []
  let overflow = 0
  for (const agent of agents) {
    const visual = visualStateOf(agent.state)
    if (takesDesk(visual)) {
      const slot = DESK_SLOTS[seated.length]
      if (slot === undefined) { overflow += 1; continue }
      const at = project(originX, originY, slot[0], slot[1])
      seated.push({ agent, visual, at, chip: [at[0], at[1] + DESK_WORKSTATION.chipDY], seated: true })
      continue
    }
    const slot = WAIT_SLOTS[waiting.length]
    if (slot === undefined) { overflow += 1; continue }
    const at = project(originX, originY, slot[0], slot[1])
    waiting.push({ agent, visual, at, chip: [at[0], at[1] + 6], seated: false })
  }
  return {
    seated,
    waiting,
    overflow,
    total: agents.length,
    animating: seated.concat(waiting).some(function (person) { return animates(person.visual) }),
  }
}

/** Agents in paint order: seats first (back row then front), then the waiting pad. */
export function peopleOf(scene: RoomScene): readonly ScenePerson[] {
  return scene.seated.concat(scene.waiting)
}
