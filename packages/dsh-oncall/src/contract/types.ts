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
 * One external conversation's subscriptions.
 *
 * `subscriptions` is the authoritative answer to "whose messages belong to
 * which Case": it is written in the same commit that opens the Case and never
 * loses an entry (closing a Case does not unsubscribe — a person's next message
 * on that thread resumes it, `docs/design/open-questions.md` §14.2 item 5).
 * `mandate.scope` is the authorization range and deliberately not read here;
 * deriving ownership from it would answer a different question twice.
 */
export interface ThreadRecord {
  readonly key: ThreadKey
  /** Every Case ever opened on this thread, oldest first. */
  readonly subscriptions: readonly CaseId[]
  /** When this thread was last seen, for ordering and the panel. */
  readonly lastAt: number
}

/**
 * What a worker's step reported.
 *
 * The vocabulary is `dsh-superagent`'s `ReportState` verbatim (`src/core/model.ts`):
 * one set of words means `oncall_report`, the stage derivation and the reply gate
 * never translate between two vocabularies. `progress` is not a state change, and
 * `waiting` is what an executor records when a turn ends without a report.
 */
export type ReportState = 'progress' | 'ready' | 'blocked' | 'failed' | 'waiting' | 'dropped'

export type Report =
  | { readonly state: 'progress' | 'waiting' | 'ready' | 'dropped'; readonly summary: string }
  | { readonly state: 'blocked'; readonly summary: string; readonly question: string }
  | { readonly state: 'failed'; readonly summary: string; readonly code: string }

/** A report, stamped with when it was recorded. */
export type StampedReport = Report & { readonly at: number }

/**
 * One step: `dsh-superagent`'s `Assignment`, minus what V0 does not need.
 *
 * `state` is not "this turn is running": a step stays `running` after its turn
 * ends, because it is still the assignment the Case is working through. It
 * becomes `ended` when the Case closes or a restart replaces it — the same
 * lifetime `Assignment` has (`src/core/model.ts`).
 */
export interface StepRecord {
  readonly caseId: CaseId
  readonly seq: number
  readonly state: 'running' | 'ended'
  /** What this step was told to do; a follow-up or a recovery note differs from the Case brief. */
  readonly brief: string
  /** The worker's latest report, `null` before one. */
  readonly report: StampedReport | null
  /** When the step started. */
  readonly at: number
  readonly endedAt?: number
}

/** Which reply a report earns, by `dsh-superagent`'s purpose gate (`src/core/replies.ts`). */
export type ReplyIntent = 'result' | 'attention' | 'failed'

/** One external message we owe, keyed by `caseId#seq` so a replay sends nothing twice. */
export interface ReplyRecord {
  readonly caseId: CaseId
  readonly seq: number
  readonly intent: ReplyIntent
  readonly text: string
  readonly state: 'pending' | 'sent' | 'gone' | 'failed'
  readonly at: number
}

/**
 * What to do next. Total by construction: every Case has an answer, including
 * "nothing yet" — a running step must not be queued a second time.
 */
export type Step =
  | { readonly kind: 'work'; readonly brief: string }
  | { readonly kind: 'close'; readonly reason: ClosedReason }
  | { readonly kind: 'idle' }

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
  | { readonly kind: 'case.followed-up'; readonly at: number; readonly caseId: CaseId; readonly trigger: TriggerKey }
  | {
      readonly kind: 'step.settled'
      readonly at: number
      readonly caseId: CaseId
      readonly seq: number
      readonly state: ReportState
      /** The failure code a `failed` report carries. */
      readonly code?: string
    }
  | { readonly kind: 'step.interrupted'; readonly at: number; readonly caseId: CaseId; readonly seq: number }
  | { readonly kind: 'trigger.refused'; readonly at: number; readonly trigger: TriggerKey; readonly reason: RefusalReason }
  | { readonly kind: 'poll.failed'; readonly at: number; readonly source: SourceId; readonly message: string }
