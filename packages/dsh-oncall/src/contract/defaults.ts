/**
 * Every default the ingress has, in one place.
 *
 * A default replaces a setting when one value suits almost every deployment
 * (`dsh-superagent` docs/000-philosophy.md:20). The point of this file is that
 * "what a deployment gets when it configures nothing" is answerable by reading
 * one file instead of collecting literals from schemas, guards and text.
 */

import type { AcceptMode } from './policy.ts'

/**
 * Off by default: a fresh install must not act on work nobody asked for. The
 * first thing an operator does is put one person on the allowed list, and the
 * agent stays silent about everything else.
 */
export const DEFAULT_ACCEPT_MODE: AcceptMode = 'off'

/**
 * How many steps one Case may run before it closes itself as `stopped`.
 *
 * A Case is one request; a request that needs forty worker turns is a design
 * problem, not a longer budget. The cap exists so a looping worker cannot burn a
 * night of tokens unattended.
 */
export const MAX_STEPS_PER_CASE = 40

/** Attempts allowed per physical route inside one step, before moving on. */
export const DEFAULT_RETRIES_PER_ROUTE = 1

/**
 * How much of one request a Case carries as its brief.
 *
 * A bound on the ledger, not on the model: the worker reads the original thread, so
 * the brief only has to say what was asked. Four thousand characters holds a normal
 * issue body with its log; anything longer is a template, and the cut is marked.
 */
export const MAX_BRIEF_CHARS = 4_000

/**
 * The environment variable the ingress reads its GitHub token from.
 *
 * Not a setting: configuration lands in the profile's `cordis.patch.yml`, so a token
 * there is a token in a file that gets copied, backed up and pasted into bug reports.
 * One name, so there is no "which variable wins" question.
 */
export const INGRESS_TOKEN_ENV = 'GITHUB_TOKEN'

/** How often the ingress reads its sources when nothing says otherwise. */
export const DEFAULT_INGRESS_POLL_SECONDS = 15

/**
 * The Policy version a Mandate records.
 *
 * Bumped by the plugin when the *shape* of the rules changes (a new admit branch),
 * not when a deployment edits its lists — that is what the actor identity and the
 * timestamp on the Case are for.
 */
export const INGRESS_POLICY_VERSION = 1
