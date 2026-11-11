/**
 * One environment variable, read without `@types/node`.
 *
 * The host program compiles with `lib: ["es2024", "esnext.disposable", "dom"]` and no
 * Node type package (`tsconfig.json`), so `process` is not declared and `tsc` rejects
 * it. Pulling `@types/node` into the plugin for one lookup would also pull a second
 * definition of globals the host already declares.
 *
 * So the cast names the single shape this file needs. It is deliberately the only
 * place in the plugin that touches `process`: a credential lookup scattered across
 * modules is how a token ends up in an error message.
 */

/** The value of `name`, or the empty string when it is unset. */
export function envOf(name: string): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.[name] ?? ''
}
