/**
 * Mention detection: does this text address `login`?
 *
 * A plain `text.includes('@' + login)` is wrong in two ways that both ship as
 * bugs: `@alice` would match inside `@alice-bot` (so the bot working under a
 * related name wakes the agent on its own replies, an infinite loop), and it
 * would match inside `ops@alice.example` (a mail address in a body). Both are
 * silent — the agent just starts working on messages nobody addressed to it.
 *
 * The rule: `@login` matches only when the character before is not part of a
 * handle (`[A-Za-z0-9_.-]`) and the character after is not part of one either.
 * A `-` after is what separates `alice` from `alice-bot`; a `.` after is ordinary
 * punctuation and does match.
 *
 * Mention syntax is generic on purpose — a chat source uses the same helper, so
 * there is one definition of "addressed to me" across sources.
 */

/** Characters that may continue a handle. Anything else is a boundary. */
const HANDLE_CHAR = /[\w.-]/
/** Characters that may continue a login. A `-` here is what splits `alice-bot`. */
const LOGIN_CHAR = /[\w-]/

/** Whether `text` addresses `login` as a mention. Empty login never matches. */
export function mentions(text: string, login: string): boolean {
  if (login === '') return false
  const needle = `@${login}`
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return false
    const before = at === 0 ? undefined : text[at - 1]
    const after = text[at + needle.length]
    const startOk = before === undefined || !HANDLE_CHAR.test(before)
    const endOk = after === undefined || !LOGIN_CHAR.test(after)
    if (startOk && endOk) return true
    from = at + 1
  }
}
