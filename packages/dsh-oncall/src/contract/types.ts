/**
 * The ingress contract: what arrives from outside, what a case remembers, and
 * what a step is.
 *
 * ### Why branded strings
 *
 * `SourceId`, `CaseId`, `ThreadKey` and `TriggerKey` are all strings, and mixing
 * any two of them is a silent data error that surfaces as "the wrong case got
 * updated" much later. A brand makes the compiler reject the swap and costs
 * nothing at runtime — the value stays a plain string in JSON, in the store and
 * on the wire.
 *
 * ### Why nothing is imported here
 *
 * This half is compiled twice: by the host program (`tsconfig.json`) and by the
 * browser program (`tsconfig.client.json`), and the browser program reaches it
 * through `src/core/*`. Anything imported here would be dragged into both. The
 * guard in `tests/layers.mjs` fails the build if a value import appears.
 *
 * Note: 为何状态不落库、为何 Step 用联合类型 —— 见 docs/design/super-plugin-code.md 一、二节。
 */

/** A nominal tag for a string that must not be confused with another string. */
type Brand<Name extends string> = { readonly __brand: Name }

/** One source instance: `github:acme/widgets`, `chat:oc_xxx`. */
export type SourceId = string & Brand<'SourceId'>
/** One unit of authorized work. */
export type CaseId = string & Brand<'CaseId'>
/** One external conversation: an issue, a PR, a chat. */
export type ThreadKey = string & Brand<'ThreadKey'>
/** One immutable external event, globally unique through its source. */
export type TriggerKey = string & Brand<'TriggerKey'>
/** One agent preset a worker Session runs under. */
export type PresetId = string & Brand<'PresetId'>

/** Who produced a Trigger, in that Source's own identity system. */
export interface Actor {
  readonly source: SourceId
  readonly id: string
  readonly handle: string
  readonly kind: 'human' | 'bot' | 'system'
}

/**
 * What an external event can mean before the gate has judged it.
 *
 * - `direct` / `mention`: the message addresses the agent.
 * - `ambient`: a human message that does not address it. Kept as its own kind so
 *   the gate can refuse it by name (`not-addressed`) instead of inferring intent
 *   from an empty mention list — the admission table in `dsh-superagent` exists
 *   for exactly this case (`docs/002-authorization.md:15`).
 * - `follow-up`: it lands on a thread an existing Case already owns. The gate
 *   refuses it on purpose — routing it to that Case is a subscription lookup,
 *   not an admission decision (see `docs/design/super-plugin.md` 7.3).
 * - `manual` / `schedule`: started from inside the harness, no external source.
 */
export type TriggerKind = 'direct' | 'mention' | 'ambient' | 'follow-up' | 'manual' | 'schedule'

/** One immutable external event. `key` is built only by `triggerKey()`. */
export interface Trigger {
  readonly key: TriggerKey
  readonly source: SourceId
  readonly thread: ThreadKey
  readonly kind: TriggerKind
  readonly actor: Actor
  readonly text: string
  readonly at: number
}

/**
 * Why this work may be done, and how far it may go. Immutable, like
 * `dsh-superagent`'s Mandate: widening the scope means a new Case, never an
 * edited Mandate.
 */
export interface Mandate {
  readonly strength: 'explicit' | 'inferred'
  readonly actor: Actor
  readonly scope: readonly ThreadKey[]
  readonly policyVersion: number
}

/** How a Case ended. */
export type ClosedReason = 'completed' | 'merged' | 'stopped' | 'failed' | 'dropped'

/** The durable facts of one Case. State is derived from these, never stored. */
export interface CaseRecord {
  readonly id: CaseId
  readonly mandate: Mandate
  readonly origin: TriggerKey
  readonly brief: string
  readonly openedAt: number
  readonly closed: { readonly reason: ClosedReason; readonly at: number } | null
}

/**
 * What a worker reported when its step settled.
 *
 * There is no `progress` variant: progress that is not a state change belongs in
 * the audit stream, not in the state machine (`dsh-superagent` reached the same
 * conclusion about "waiting" reports, docs/001-domain.md:60).
 */
export type Outcome =
  | { readonly kind: 'done'; readonly summary: string }
  | { readonly kind: 'waiting'; readonly summary: string }
  | { readonly kind: 'blocked'; readonly question: string }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }

/** One recorded step, settled or in flight. */
export interface StepRecord {
  readonly seq: number
  readonly step: Step
  readonly startedAt: number
  readonly outcome: Outcome | undefined
}

/**
 * What to do next. A discriminated union rather than one interface with optional
 * fields: every consumer would otherwise have to ask "is `brief` set?", and the
 * wrong answer is a runtime `undefined` — not a compile error.
 */
export type Step =
  | { readonly kind: 'work'; readonly brief: string; readonly preset: PresetId }
  | { readonly kind: 'ask'; readonly question: string }
  | { readonly kind: 'close'; readonly reason: ClosedReason }

/**
 * The Case's state, derived from facts on every read.
 *
 * Storing this would create a second source of truth that can disagree with the
 * records; deriving it costs one pure function call.
 */
export type Stage =
  | { readonly kind: 'needs-person'; readonly reason: PersonReason; readonly since: number }
  | { readonly kind: 'queued'; readonly since: number }
  | { readonly kind: 'waiting'; readonly since: number }
  | { readonly kind: 'working'; readonly since: number }
  | { readonly kind: 'done'; readonly how: ClosedReason; readonly at: number }

/** Why a Case cannot continue without a person. */
export type PersonReason = 'delivery-failed' | 'review' | 'question' | 'blocked' | 'failed'

/**
 * Why a Trigger did not become a Case.
 *
 * Lives in the contract rather than next to the gate because the panel, the audit
 * stream and the gate all name the same reasons, and three copies of this union
 * would drift. The gate is the only producer.
 */
export type RefusalReason =
  | 'follow-up-owned'
  | 'source-disabled'
  | 'bot-not-allowed'
  | 'sender-not-allowed'
  | 'not-addressed'
  | 'inferred-mode-off'

/**
 * One fact the ingress wants to remember after the fact.
 *
 * Append-only: nothing here is ever updated, and no reader derives a state from
 * it. That is what makes it safe to write from two code paths (the pass and a
 * person's action) without a lock — `dsh-superagent` keeps the same separation
 * between `.comet.yaml` and `state-events.jsonl` on the Comet side.
 *
 * `case.observed` is not a Case: under `observe` the agent records what it would
 * have done and deliberately creates nothing, so a team can read a week of
 * intended work before switching it on.
 */
export type AuditEvent =
  | {
      readonly kind: 'case.opened'
      readonly at: number
      readonly caseId: CaseId
      readonly trigger: TriggerKey
      readonly strength: 'explicit' | 'inferred'
    }
  | { readonly kind: 'case.observed'; readonly at: number; readonly trigger: TriggerKey; readonly brief: string }
  | { readonly kind: 'trigger.refused'; readonly at: number; readonly trigger: TriggerKey; readonly reason: RefusalReason }
  | { readonly kind: 'poll.failed'; readonly at: number; readonly source: SourceId; readonly message: string }
