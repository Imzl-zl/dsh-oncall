/**
 * The request text a Case carries, bounded.
 *
 * An issue body is user-authored and can be tens of kilobytes of template, logs and
 * screenshots. Storing it whole in every Case row makes the ledger grow with the
 * chattiness of the repo rather than with the work, and the worker reads the thread
 * itself anyway — the brief only has to say *what was asked*.
 *
 * The cut is marked. A silent truncation is worse than no truncation: the model
 * would see a sentence ending mid-word and treat it as the whole request.
 */

import { MAX_BRIEF_CHARS } from '../contract/defaults.ts'

/** The mark that says "there was more". Rendered as text, never as an instruction. */
const CUT_MARK = '\n\n… (truncated; read the original thread for the rest)'

/** The brief for one request: the text, cut to `MAX_BRIEF_CHARS` if it is longer. */
export function briefOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_BRIEF_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_BRIEF_CHARS)}${CUT_MARK}`
}
