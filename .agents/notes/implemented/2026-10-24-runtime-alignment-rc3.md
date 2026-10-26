# Agent Note: the dev workspace follows the checkout's version (0.2.1-rc.3), not the desktop's installed one

Status: implemented

## Problem

Two different "current versions" coexisted with no rule saying which one this
workspace follows. The root pin was `@deepseek-ai/dsh` 0.2.1-rc.2 — npm's
`latest`, and what the desktop installs — while the read-only reference checkout
(`D:\sudy\github\deepseek-harness`, HEAD `22ddee3792`) sits at 0.2.1-rc.3, npm's
`next`, 1533 commits past the rc.3 tag. The previous alignment note rejected
"follow `next` because the peer range allows it" for a good reason (a dev install
must not test a runtime no user runs), and that left the opposite case unstated:
what to do when the *checkout* moves ahead of the product first.

That case arrived, and it is not cosmetic. The session-projection contract this
round depends on — a projection's `wire` participates in `session.list`'s summary
key set unless it says `summary: false` — is an rc.3 fact. On rc.2 the same code
passes for a different reason, so a green run there says nothing about the
runtime we target.

## Decision

1. **The root devDependency pins `@deepseek-ai/dsh` exactly at `0.2.1-rc.3`**, and
   the workspace follows the **checkout's** version rather than the desktop's
   installed one. The pin stays exact (no range, no `latest`/`next` tag).
2. **The six peers move with it** to `^0.2.1-rc.3` (`dsh-agent`, `dsh-llm`,
   `dsh-session`, `dsh-storage-domain`, `dsh-tools`, `dsh-typert-protocol`). They
   remain `peerDependencies`: the dev workspace root supplies them through the
   DSH tree, which is the only way this package resolves the same module
   instances the host uses.
3. **The four declaration-only devDependencies move too** —
   `dsh-client-store`, `dsh-client-ui-primitives`, `dsh-client-ui-slots` at
   `^0.2.1-rc.3`, and `dsh-typert-generator` exact at `0.2.1-rc.3` (it generates
   the remote metadata factories, so it is a runtime-version fact like zod).
4. **`legacy-peer-deps=true` in `packages/dsh-models-router/.npmrc` is unchanged**;
   only the version numbers moved. The mechanism it protects is the reason this
   alignment is one edit instead of a second copy of every DSH package.
5. **Mechanical gate, checked after install**: `require.resolve` of the six peers,
   `dsh`, `cordis`, `schemastery` and `zod` from the repo root **and** from
   `packages/dsh-models-router` must return the identical path, and the tree must
   contain exactly one `zod`. A second instance stops the round instead of being
   worked around.

## Alternatives considered

1. **Stay on rc.2 until the desktop ships rc.3.**
   - Strongest reason: it is the previous note's own rule — a dev install should
     exercise what users actually run, and rc.2 is what the desktop installs
     today. It also keeps the browser smoke comparable to the 2026-10-24
     baseline.
   - Why rejected: this round's contract only exists on rc.3. On rc.2 the wire
     without `summary` lands in the summary key set because the default is the
     old one, so the item-1 evidence ("the test goes red when the key is
     excluded") could not be produced at all — the code under test would be
     verified against a contract that has already been replaced in the checkout.
     Following the checkout is the defensible direction when the two disagree;
     the desktop catches up on the same version line.
2. **Bump the six peers only, leave the four declaration devDependencies at rc.2.**
   - Strongest reason: those packages are never executed, so their version looks
     like a pure install detail; the diff stays at the seven lines the task named.
   - Why rejected: they exist precisely to carry the runtime's own declarations
     into the client type program. Leaving them at rc.2 would type-check
     `Input` / `Tag` / `Tooltip` / the module table against the previous
     release while the runtime serves rc.3 — a silent drift whose failure mode
     is "compiles, misbehaves". Moving them is one line each.
3. **Use a range at the root (`^0.2.1-rc.2`, or the `next` tag) instead of an
   exact pin.**
   - Strongest reason: no edit on every bump; the range already matches rc.3.
   - Why rejected: same reason the previous note pinned exact — a floating root
     pin can land on a different runtime than the one the fixtures and the
     manual smoke ran against, and the mismatch shows up as test failures with
     no version in the message. `latest` is worse still: it currently resolves
     to rc.2, i.e. it would undo this alignment on the next install.

## Consequences

- Gains: tests, both type programs, the bundle and the browser smoke now run the
  same contract the checkout documents. Re-measured on rc.3: `npm test`
  233 unit / 123 client-controller / 25 remote / 35 scenarios, 0 failure;
  `bundle` exit 0 with host 208.13 kB / client 467.01 kB; specified host `tsc`,
  client `tsc`, `node --check lib/client.js` all exit 0; DSH checkout still 0
  porcelain lines.
- Gains, measured in the browser: the health page drew the same 8 cards the
  independent fold of the persisted projection cache produced from the 27
  sessions on disk — 7 observed routes card for card (13.03 s / 118.9, 24.80 s /
  10.6, 34.94 s / 45.7, 22.50 s / 141.1, 888.07 s / 3.4, 601.75 s, 20.40 s) plus
  the configured-but-unobserved `deepseek-chat`, with tabs 5 / 2 / 1; the
  failover drawer's "暂无故障转移记录" was confirmed truthful (0 of the 27
  existing sessions carries a `router/failover-history` row; the 54 cache files
  that do carry it belong to sessions no longer on disk).
- Costs: the workspace is now **ahead** of the installed desktop runtime, so a
  bug reported from the desktop cannot be reproduced here without downgrading,
  and the next alignment is again a multi-file edit (root pin + six peer ranges
  + four declaration devDependencies + two lockfiles).
- Cost, and the reason this needed a note: the previous note's rejected
  alternative 3 reads as "rc.3 is off limits". It is not — that rejection was
  about *floating* onto `next`, not about the version number. The two claims are
  separated here so the next session does not re-litigate either one.
- Preserved on purpose: `zod` stays exactly `4.4.3` at the root and single in the
  tree (rc.3 still pins it exactly); no source file changed, so no behaviour
  changed; the checkout was read, never written.
