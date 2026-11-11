/**
 * Probe plugin: measures four runtime facts the V0 executor depends on, in a real
 * Loader composition with a real provider turn.
 *
 * Two phases, because one process cannot observe a resume from persistence:
 *   A — create a session with our own deterministic id, deliver a message with our
 *       own MessageId, run one real turn, record what `agent/status` and
 *       `turn/end` said, and read the session log back through persistence.
 *   B — a fresh process on the same DSH_HOME: resolveAgent(same id) must bring the
 *       same session back with its history.
 *
 * Results are written as JSON to `PROBE_OUT`; the app is exited afterwards.
 *
 * Note: 这四条为什么必须先测 —— 见 docs/design/oncall-v0-architecture.md 第六节。
 */

import { writeFileSync } from 'node:fs'

export const name = 'oncall-probe'

export async function apply(ctx) {
  const out = process.env.PROBE_OUT
  const phase = process.env.PROBE_PHASE
  const sessionId = process.env.PROBE_SESSION
  const cwd = process.env.PROBE_WORK
  const results = { phase, checks: [] }
  const check = (name, ok, detail) => { results.checks.push({ name, ok, detail }) }
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    try { writeFileSync(out, JSON.stringify(results, null, 2)) } catch (error) { process.stderr.write(`probe write failed: ${String(error)}\n`) }
    setTimeout(() => process.exit(results.checks.every(item => item.ok) ? 0 : 1), 200)
  }
  // A wedged probe must fail loudly instead of hanging the suite.
  setTimeout(() => { check('probe finished within 120s', false); finish() }, 120_000)

  await ctx.inject(['sessionController', 'agents', 'sessionPersistence'], async child => {
    const controller = child.get('sessionController')
    const agents = child.get('agents')
    const persistence = child.get('sessionPersistence')
    check('sessionController is mounted', controller !== undefined)
    check('agents registry is mounted', agents !== undefined)
    check('sessionPersistence is mounted', persistence !== undefined)
    if (!controller || !agents || !persistence) { finish(); return }

    // ---- Q3a: unknown id answers a structured not-found, not a throw -------------
    if (phase === 'A') {
      const unknown = await controller.resolveAgent('oncall-probe-missing')
      check('resolveAgent(unknown) answers a result envelope', typeof unknown === 'object' && unknown !== null)
      check('resolveAgent(unknown) says session/not-found', unknown?.error?.code === 'session/not-found', String(unknown?.error?.code ?? JSON.stringify(unknown)))

      // ---- Q3b: create with our own session id ---------------------------------
      let created
      try {
        created = await controller.create({ sessionId, cwd })
        check('create({sessionId, cwd}) accepts a caller-chosen id', created?.sessionId === sessionId, JSON.stringify(created))
      } catch (error) {
        check('create({sessionId, cwd}) accepts a caller-chosen id', false, String(error))
        finish()
        return
      }
      const agent = agents.get(sessionId)
      check('the registry answers for that id', agent !== undefined)
      if (!agent) { finish(); return }

      // ---- Q1: agent/status must publish running → idle around a real turn -----
      const statuses = []
      let sawRunning = false
      let idleAfterRunning
      const idleReached = new Promise(resolve => { idleAfterRunning = resolve })
      child.on('agent/status', ({ agent: who, status }) => {
        if (who?.id !== sessionId) return
        statuses.push(status)
        if (status === 'running') sawRunning = true
        else if (status === 'idle' && sawRunning) idleAfterRunning()
      })
      const turnEnds = []
      child.on('session/event', (session, event) => {
        if (session?.id !== sessionId || event.type !== 'turn/end') return
        turnEnds.push(event.data?.reason?.kind ?? 'unknown')
      })
      child.on('agent/error', payload => { if (payload?.agent?.id === sessionId) results.agentError = String(payload.error) })

      try {
        await controller.selectModel({ sessionId, provider: process.env.PROBE_PROVIDER, model: process.env.PROBE_MODEL })
      } catch (error) {
        check('selectModel accepts the probed route', false, String(error))
      }

      // ---- Q2: a message we identified, delivered to the agent ------------------
      const messageId = `oncall:${sessionId}#0`
      let frozen
      try {
        const { MessageId, freezeMessage } = await import('@deepseek-ai/dsh-llm')
        frozen = freezeMessage({
          id: MessageId(messageId),
          role: 'user',
          content: [{ type: 'text', text: '只回两个字：收到' }],
          source: { kind: 'oncall-probe', form: 'relay' },
        })
        check('freezeMessage accepts our own MessageId', frozen?.id === messageId, String(frozen?.id))
      } catch (error) {
        check('freezeMessage accepts our own MessageId', false, String(error))
      }
      if (frozen) {
        try { agent.followup(frozen) } catch (error) { check('followup accepts the frozen message', false, String(error)) }
      }

      // ---- Q1 measured ---------------------------------------------------------
      const idled = await Promise.race([
        idleReached.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 90_000)),
      ])
      check('agent/status published running then idle', idled, JSON.stringify(statuses))
      results.statuses = statuses
      results.turnEndReasons = turnEnds
      check('turn/end carried a reason kind', turnEnds.length > 0 && turnEnds.every(kind => kind !== 'unknown'), JSON.stringify(turnEnds))

      // ---- Q4: flush + read the session log ------------------------------------
      try {
        await persistence.flush()
        const handle = await persistence.open(sessionId, 'read')
        const { events } = await handle.read(0, 512)
        await handle.close?.()
        const ids = events.filter(event => event.type === 'user/message').map(event => event.data?.id)
        check('sessionPersistence.flush/open/read returns events', events.length > 0, `${events.length} events`)
        check('our message id is in the persisted log', ids.includes(messageId), JSON.stringify(ids.slice(0, 4)))
        results.persistedEvents = events.length
      } catch (error) {
        check('sessionPersistence.flush/open/read returns events', false, String(error))
      }
      finish()
      return
    }

    // ---- phase B: resume the same session from persistence --------------------
    const resumed = await controller.resolveAgent(sessionId)
    check('a fresh process resolves the persisted session', resumed?.agent !== undefined, String(resumed?.error?.code ?? 'agent'))
    if (resumed?.agent) {
      const events = resumed.agent.session.snapshotEvents()
      const ids = events.filter(event => event.type === 'user/message').map(event => event.data?.id)
      check('the resumed session kept its history', events.length > 0, `${events.length} events`)
      check('the resumed session kept our message id', ids.includes(`oncall:${sessionId}#0`), JSON.stringify(ids.slice(0, 4)))
      // A second resolve must be idempotent (no second session, same identity).
      const again = await controller.resolveAgent(sessionId)
      check('resolving twice keeps the same identity', again?.agent?.id === resumed.agent.id)
    }
    finish()
  })
}
