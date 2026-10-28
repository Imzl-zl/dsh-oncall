/**
 * The office as a React component: refs, measurement and events — no pixels.
 *
 * The division of labour this file exists to keep:
 *
 * - ./office-scene.ts decides WHO sits WHERE (pure, unit-tested);
 * - ./office-render.ts decides what a room looks like (canvas only);
 * - this file owns the browser-only concerns: the canvas element, the integer
 *   upscale from the container width, the shared frame clock, and turning a
 *   click into an intent the caller already understands (`onOpen(agentId)`).
 *
 * Degradation is explicit: with no 2D context (the test renderer has no
 * canvas) the room paints nothing and the status chips remain — the component
 * never becomes the reason a surface fails to render.
 *
 * Note: 三层信息架构、容器断点与性能预算 —— 见
 * docs/design/agent-fleet-drawer.md「像素办公室视图（2026-10-27 定稿）」
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { h } from '../dom.ts'
import type { FleetAgent } from './model.ts'
import { buildScene, peopleOf } from './office-scene.ts'
import type { RoomScene } from './office-scene.ts'
import { ROOM_H, ROOM_ORIGIN, ROOM_W, currentTick, paintFrame, paintStaticRoom, subscribeFrame } from './office-render.ts'

/** Container widths below this hide the room entirely (see fleet styles). */
export const OFFICE_MIN_WIDTH = 460
const MAX_SCALE = 3

interface OfficeRoomProps {
  readonly agents: readonly FleetAgent[]
  /** Called with the agent's child-session id when its chip or desk is clicked. */
  readonly onOpen: (id: string) => void
  /** Accessible name for the chip group. */
  readonly label: string
}

/**
 * One room for one session.
 * @param props - the session's direct children plus the open callback.
 * @returns the room block: a canvas, and one chip per agent.
 */
export function OfficeRoom(props: OfficeRoomProps): ReactElement {
  const host = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const surface = useRef<CanvasRenderingContext2D | null>(null)
  const staticRoom = useRef<HTMLCanvasElement | undefined>(undefined)
  const [scale, setScale] = useState(0)
  const scene = useMemo(
    function () { return buildScene(ROOM_ORIGIN.x, ROOM_ORIGIN.y, props.agents) },
    [props.agents],
  )
  // The frame callback and the repaint effect both read the latest scene; a ref
  // keeps the subscription from being torn down on every state flip.
  const sceneRef = useRef<RoomScene>(scene)
  sceneRef.current = scene

  // The room is painted by one effect that owns the canvas for its lifetime:
  // measuring, the first paint, and the frame subscription are the same
  // lifecycle, so a resize cannot leave a half-painted canvas behind.
  useEffect(function () {
    const element = host.current
    const target = canvas.current
    if (element === null || target === null) return
    target.width = ROOM_W
    target.height = ROOM_H
    const context = target.getContext('2d')
    if (context !== null) {
      surface.current = context
      staticRoom.current ??= paintStaticRoom()
      paintFrame(context, sceneRef.current, currentTick(), staticRoom.current)
    }

    const measure = (): void => {
      const width = element.clientWidth
      if (width < OFFICE_MIN_WIDTH) { setScale(0); return }
      setScale(Math.max(1, Math.min(MAX_SCALE, Math.floor(width / ROOM_W))))
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    observer?.observe(element)

    // A user who asked for less motion gets the room's first frame and nothing
    // else — the canvas is decoration over data the chips already carry.
    const reduced = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches
    const unsubscribe = reduced ? function () { /* no clock */ } : subscribeFrame(function (tick) {
      const ctx = surface.current
      if (ctx === null || !sceneRef.current.animating) return
      paintFrame(ctx, sceneRef.current, tick, staticRoom.current)
    })
    return function () {
      unsubscribe()
      observer?.disconnect()
      surface.current = null
    }
  }, [])

  // Repaint when the agents change (a new child, a state flip), without
  // touching the element lifecycle above.
  useEffect(function () {
    const ctx = surface.current
    if (ctx === null) return
    paintFrame(ctx, scene, currentTick(), staticRoom.current)
  }, [scene])

  const people = peopleOf(scene)
  return h('div', { className: 'dsh-fleet-office', ref: host, 'data-scale': String(scale) },
    h('canvas', {
      className: 'dsh-fleet-office-canvas',
      ref: canvas,
      'aria-hidden': 'true',
      style: scale > 0
        ? { width: `${ROOM_W * scale}px`, height: `${ROOM_H * scale}px` }
        : { display: 'none' },
    }),
    h('div', { className: 'dsh-fleet-office-chips', role: 'group', 'aria-label': props.label },
      people.map(function (person) {
        return h('button', {
          key: person.agent.id,
          type: 'button',
          className: 'dsh-fleet-office-chip',
          'data-agent': person.agent.id,
          'data-state': person.visual,
          style: { left: `${person.chip[0] * Math.max(scale, 1)}px`, top: `${person.chip[1] * Math.max(scale, 1)}px` },
          title: person.agent.label,
          onClick: function () { props.onOpen(person.agent.id) },
        },
          h('span', { className: 'dsh-fleet-office-dot', 'data-state': person.visual }),
          person.agent.label)
      }),
      scene.overflow > 0
        ? h('span', { className: 'dsh-fleet-office-more' }, `+${scene.overflow}`)
        : null))
}
