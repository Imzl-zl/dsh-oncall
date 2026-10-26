<p align="center">
  <img src="https://raw.githubusercontent.com/Imzl-zl/dsh-model-desk/master/docs/assets/banner.svg" alt="dsh-model-desk" width="640">
</p>

<p align="center">
  <a href="https://github.com/Imzl-zl/dsh-model-desk/actions/workflows/ci.yml"><img src="https://github.com/Imzl-zl/dsh-model-desk/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://www.npmjs.com/package/dsh-model-desk"><img src="https://img.shields.io/npm/v/dsh-model-desk?color=4A65E8" alt="npm"></a>
  <a href="https://github.com/Imzl-zl/dsh-model-desk/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-4A65E8.svg" alt="License: MIT"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH-0.2.1--rc.3-4A65E8.svg" alt="DSH 0.2.1-rc.3"></a>
</p>

<p align="center">
  <a href="https://github.com/Imzl-zl/dsh-model-desk/blob/master/README.md">简体中文</a> | English
</p>

---

<p align="center">
  Select a model in DSH's selector as usual. When it fails, the request moves to the next physical channel in the chain this conversation routes on, and the conversation reports the failure code, the candidate that answered, and why the switch was allowed.
</p>

## Features

- **Named chains, chosen per session** — several fallback chains, each with its own candidates, switch-on rules and budgets; a conversation picks one right in the composer chip, with no separate session-management page.
- **Per-route retry overrides** — a session can override a route's retry count: `0` means "do not retry this route", empty means "follow the chain".
- **Retries this plugin executes** — for codes in `switchOn`, the configured number is the real number (no provider-policy ceiling); codes outside `switchOn` still go to DSH's `llm-retry`.
- **Immediate-switch whitelist** — failures a retry cannot change (a rejected key, an exhausted quota, a refused request) skip the retry budget and move straight to the next candidate; everything else still retries. The default list is those three, editable under "Retries and turns".
- **Pre-fire validation** — every candidate is resolved through `ctx.llm.resolveCallConfig()` before a real call, so an unservable candidate is skipped rather than burned.
- **Conditional routing** — per-candidate `images` and `minContextTokens` gates, plus per-code `switchOn`.
- **Channel health workspace** — zero-token passive latency and throughput, opt-in 1-token probes, route- and channel-scoped circuit breakers, and a failover-history drawer folded from the durable session log.
- **Bilingual UI** — Chinese and English, with an unsaved-changes bar.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/Imzl-zl/dsh-model-desk/master/docs/assets/session-chains/session-routing-popover.png" alt="Per-session chain and per-route retry overrides" width="100%"></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/Imzl-zl/dsh-model-desk/master/docs/assets/session-chains/failover-notice.png" alt="Failover notice in the conversation" width="100%"></td>
  </tr>
  <tr>
    <td><sub>Chain and per-route retries, edited from the composer chip.</sub></td>
    <td><sub>A dead first hop moves to the next candidate; the conversation reports it.</sub></td>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/Imzl-zl/dsh-model-desk/master/docs/assets/session-chains/chain-management.png" alt="Named chains" width="100%"></td>
    <td><img src="https://raw.githubusercontent.com/Imzl-zl/dsh-model-desk/master/docs/assets/session-chains/update-notes.png" alt="Release notes after an update" width="100%"></td>
  </tr>
  <tr>
    <td><sub>Named chains, each with its own candidates, switch-on rules and budgets.</sub></td>
    <td><sub>After an update, the workbench shows once what changed in that version.</sub></td>
  </tr>
</table>

Screenshots come from an isolated instance against real gateways; the dead route is deliberate.

## Installation

Requires DSH `0.2.1-rc.3`.

```sh
dsh plugin add dsh-model-desk
```

From a checkout instead (the package name is `dsh-model-desk`; the public registry's `dsh-model-desk` is an unrelated package):

```sh
git clone https://github.com/Imzl-zl/dsh-model-desk.git
cd dsh-model-desk
npm install
npm run bundle --prefix packages/dsh-model-desk
dsh plugin --profile web add packages/dsh-model-desk
```

Open **dsh-model-desk** from the sidebar's panel list to configure chains.

## Updates

Updates are handled natively by DSH's plugin market (`dshmarket`): its installed list checks the npm version, offers **one-click update**, and shows **What changed** from this repository's GitHub Release notes (the matching `CHANGELOG.md` section). The plugin never spawns a package manager or copies the install algorithm itself.

- **After an update**, the first visit to the workbench opens the new version's notes once; the page head keeps a **What's new** button for later.
- **Manual CLI update**: `dsh plugin --profile <profile> remove dsh-model-desk`, then `dsh plugin --profile <profile> add dsh-model-desk@latest`.
- **Desktop app**: update from its own Settings → Plugins; do not edit the profile the app manages.
- Release history: [CHANGELOG.md](https://github.com/Imzl-zl/dsh-model-desk/blob/master/CHANGELOG.md).

## Configuration

```yaml
policyVersion: 2                 # failure-policy version; maintained by the plugin, do not edit
enabled: true
defaultChainId: default          # sessions with no choice of their own
chains:
  - id: default                  # stable id: sessions bind to it
    name: ""                     # empty = "default chain" in the UI
    candidates:                  # fallbacks; the selected model is the implicit first hop
      - { provider: deepseek-official, model: deepseek-v4-flash, maxRetries: 1, needs: { images: false } }
      - { provider: pi-ai-gpt, model: gpt-5, maxRetries: 0, needs: { images: true } }
    switchOn: { rateLimit: true, server: true, timeout: true, transport: true, emptyResponse: true, invalidRequest: true, auth: true, quota: true, other: true }
    immediateSwitch: [auth, quota, invalidRequest]   # these skip the retries (same keys as switchOn)
    firstHopMaxRetries: 0        # retries after the first hop's first call (0 = move on)
    stickyTurns: 0               # no-image turns to keep the image route after an image turn
    strategy: order
  - id: coding
    name: Write code
    candidates: [...]
```

The first hop is always the model you selected in DSH — it is not part of the config — so a chain only answers "where next". A config without `policyVersion` is read once as the old one (`emptyResponse`/`invalidRequest` and retry counts at their old defaults); the first save stamps the version, and your own choices are kept from then on. With no fallbacks at all the plugin stays out of the request path — the first hop's retry count has no effect either, and DSH's own retry policy decides.

## How it works

The plugin owns two seams of the Agent loop:

- **`agent/request`** (`prepend: true`) selects the physical route for every attempt. It runs outside `installModelSelection`, so the model you picked always attempts first and a switch never happens without a failure.
- **`agent/request-error`** (`prepend: true`, outermost) sees every failed attempt first: for a code in `switchOn` it waits and retries itself, then advances the chain; for any other code it delegates to DSH, so `llm-retry` keeps its own retries and cap.

Every switch is folded from the durable session log into a `router/failover-history` projection and surfaced in the failover-history drawer.

## Project layout

| Path | What it is |
|---|---|
| `packages/dsh-model-desk/src/` | The plugin: Host half (`index.ts`, `router.ts`, `bindings.ts`, `chain.ts`, …) and browser half (`src/client/`). |
| `packages/dsh-model-desk/tests/` | Four suites: `unit`, `client-controller`, `remote` (in-process production profile) and `run` (real headless Loader composition per scenario). |
| `docs/design/` | Current design: routing proposal, source map, capability boundary, per-session chains, release notes policy. |
| `.agents/notes/` | Decision notes (why, what was rejected, what it cost). Status is the directory. |
| `spike/` | Phase 1 evidence kept as-is; not part of the package. |

## Development

```sh
npm install                                                  # root: the DSH CLI + peers
npm ci --prefix packages/dsh-model-desk --legacy-peer-deps # package: tsc, tsdown, typert generator
npm run bundle --prefix packages/dsh-model-desk           # build lib/ (host + client + typert)
npm test                                                     # the four suites
```

Individual suites (each takes its own file, the composition suite a scenario name):

```sh
node packages/dsh-model-desk/tests/unit.mjs
node packages/dsh-model-desk/tests/client-controller.mjs
node packages/dsh-model-desk/tests/remote.mjs
node packages/dsh-model-desk/tests/run.mjs [scenario]
```

The package keeps the built `lib/` out of git (it is in `files`, so npm ships
it); `npm run bundle` must run before a browser or a Loader sees a source
change, and the composition tests load that artifact on purpose.

## Releasing

```sh
npm version minor --prefix packages/dsh-model-desk   # 0.2.0 → 0.3.0, no tag yet
# move the CHANGELOG's "Unreleased" content under the new version heading
git add -A && git commit -m "chore(release): 0.3.0"
git tag -a v0.3.0 -m "dsh-model-desk 0.3.0" && git push origin master v0.3.0
```

Pushing the tag is the whole release:

- `.github/workflows/release.yml` refuses the tag unless it equals the package
  version, builds `lib/`, publishes to npm with provenance (`--provenance`,
  public access) and opens the GitHub release with the matching CHANGELOG
  section (`scripts/release-notes.mjs`).
- Authentication is npm **trusted publishing** (OIDC): the package's npm
  settings name this repository and this workflow file, so the run exchanges a
  short-lived GitHub OIDC token for publish access and attests provenance. No
  secret, no token, nothing to rotate. The npm account's publishing access is
  set to "two-factor authentication, bypass tokens disallowed".
- `.github/workflows/ci.yml` runs on every push to `master` and every pull
  request: the build, the host type-check and the four suites.

The version policy is the CHANGELOG's: below `1.0.0` the minor digit marks a
delivery milestone, and the plugin's DSH peer range moves with it.

The package is `dsh-model-desk`: the public registry's `dsh-model-desk`
belongs to another publisher, so install commands, badges and the bundle patch
use the plural name.

## Limitations

- **Agent main requests only.** Compaction and session-title calls keep their own DSH configuration and are not routed.
- **Tool capability is not pre-checked.** DSH exposes no machine-readable "supports function calling" metadata; an incompatible candidate fails at runtime and is handled by `switchOn.invalidRequest`.
- **Notices are trajectory-first.** Failover notices ride the durable log into the trajectory view; this DSH build does not surface context rows in the chat conversation.
- **Forks do not inherit session bindings.** A fork is a new session id, and bindings are keyed by session id, so a forked conversation falls back to the default chain.
- **Two DSH processes on one home** rewrite the binding file whole (last writer wins); one process with many sessions is unaffected.

## Friends

<p align="center">
  <a href="https://linux.do/" title="LINUX DO"><img src="https://raw.githubusercontent.com/Imzl-zl/dsh-model-desk/master/docs/assets/linux-do-logo.svg" alt="LINUX DO" width="32" height="32"></a><br>
  <a href="https://linux.do/">LINUX DO</a>
</p>

## Documentation

Design rationale, source-verified capability boundaries, and the decision register live in [`docs/design/`](https://github.com/Imzl-zl/dsh-model-desk/tree/master/docs/design/). Release history is in [CHANGELOG.md](https://github.com/Imzl-zl/dsh-model-desk/blob/master/CHANGELOG.md).

## License

[MIT](https://github.com/Imzl-zl/dsh-model-desk/blob/master/LICENSE)
