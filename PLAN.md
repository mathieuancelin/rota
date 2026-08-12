# Extraction plan — one Electron app into core, daemon, CLI and app

Written 2026-08-10. Implemented 2026-08-11: **all ten phases are done.**

| | Before | After |
|---|---|---|
| Packages | 1 | 4 — `core`, `daemon`, `cli`, `app` |
| Files that need Electron | 7 of 77 | 7 of 7 in `packages/app/src/main` |
| `app/src/main/index.js` | 487 lines | 430 — down to 280 after Phase 3, then back up for the remote mode Phase 6 added |
| Tests | 763 | 827, on both runtimes, in CI |
| Binaries | 0 | 2 × 4 targets, plus a `rotad` inside the `.dmg` |

Two things were added that this plan did not call for, and both are recorded under
"Decisions taken": `createEngine()` in core, without which Phase 4 would have been a
second copy of the application's wiring; and `instance-lock.js` in core rather than
in the daemon, because Phase 6 requires the embedded application to take the same
lock and an application that depended on the daemon package would have the
dependency backwards.

The `experiments/` tree has been deleted, as Phase 9 asks. It is recoverable in full
at the `rust-experiment-final` tag; the baseline it was measured against is
`pre-extraction`.

## The decision

The engine stops being part of the window. `src/main/` splits into a library
anyone can embed, a daemon that runs without a screen, a CLI that drives it, and
an Electron application that — by default — embeds the library rather than
talking to anything.

**The Rust port under `experiments/` is not the direction.** It is finished and
it works, but it costs two languages, an HTTP contract to keep in step, a forked
renderer and a differential harness to maintain, and it buys a dependency-free
binary this project does not need. It stays until Phase 4 is done, because two
of its files are the specification for work that has no JS equivalent yet (see
"What `experiments/` is still for"), then it is archived.

**Everything is Bun-first except the Electron application**: `core`, `daemon` and
`cli` build to compiled binaries with `bun build --compile`. The daemon's binary
is `rotad`, the CLI's is `rotactl`.

## Why this is cheap — the audit that decided it

Measured on the current tree, not assumed:

| | |
|---|---|
| Files under `src/main/` | 77 |
| Files that `require('electron')` | **7** |
| Of those, files that are not shell by nature | **1** — `scheduler/wake.js` |

And `scheduler/wake.js` is already an adapter, with an injection seam already in
place. It translates `powerMonitor` events into calls the scheduler exposes on
its own:

```js
powerMonitor.on('suspend', () => scheduler.handleSuspend())
powerMonitor.on('resume',  () => scheduler.handleWake())
```

The scheduler knows nothing about Electron. `src/main/index.js` is already a
clean composition root: 22 engine `require`s, 6 shell ones. There is nothing to
untangle — only a line to draw.

Two more findings that remove work we would otherwise have planned for:

- **`agent/ui.js` already implements `createUnavailableUi()`** — "refuses rather
  than throwing: an agent must learn that its question could not be asked, and
  carry on". The headless degradation is written, in JS, today. The daemon needs
  no new behaviour to run agent jobs with nobody attached.
- **The engine has no runtime asset dependency.** Its only non-builtin imports
  are `ajv` and two JSON schemas pulled in with a static `require`, so
  `bun build --compile` inlines them. Every `__dirname` in the tree
  (`tray.js`, `notifications.js`, `window.js`) is on the Electron side, which is
  not compiled by Bun. Nothing to relocate, nothing to embed by hand.

## Target layout

```
rota/
  package.json                    workspace root — Bun workspaces, no code
  packages/
    core/                         @rota/core     library, no binary
      schemas/                    moved from the repository root
      src/                        config runner scheduler agent discord history http lib
      test/                       37 files
    daemon/                       @rota/daemon   bin: rotad
      src/
      test/
    cli/                          @rota/cli      bin: rotactl
      src/
      test/
    app/                          rota           Electron, not compiled by Bun
      src/main  src/preload  src/renderer
      test/                       4 files
      electron-builder.yml  vite.config.mjs  build/  assets/
```

`schemas/` moves **into** `packages/core`. A package that cannot validate without
a sibling directory is not a package. It is re-exported through the `exports` map
so the renderer's Monaco setup and the form generator keep reading the one
source:

```json
"exports": {
  ".": "./src/index.js",
  "./schemas/*": "./schemas/*"
}
```

## Where every file goes

**`packages/core` — everything that has no screen.** Moved wholesale, paths
unchanged inside each directory:

- `config/` (8) · `runner/` (10) · `history/` (3) · `http/` (5) · `lib/` (5)
- `discord/` (4) · `agent/` (31, including `tools/` and `mcp/`)
- `scheduler/index.js`, `scheduler/next-run.js` — **not** `wake.js`
- `snapshot.js`, `state-store.js`
- a new `src/index.js` that names the public surface explicitly, rather than
  letting consumers reach into paths we would then owe them forever

**`packages/app` — the shell, and only the shell:**

- `index.js` (rewritten: composes, does not implement), `ipc.js`, `tray.js`,
  `window.js`, `autostart.js`, `notifications.js`, `agent-panels.js`
- `scheduler/wake.js` → `main/power-electron.js`. It is an adapter over
  `powerMonitor`; it belongs on the side that has Electron.
- `preload/`, `renderer/` unchanged

**`packages/daemon` — new code, mostly composition:**

- `index.js` — what `src/main/index.js` does minus the shell
- `power.js` — sleep and screen-lock detection without `powerMonitor`
- `lock.js` — one daemon per configuration directory
- `service.js` — prints a launchd plist (macOS) or a systemd unit (Linux)

**`packages/cli` — new.** Reads off the configuration directory by default, acts
through the API. The `rotactl` command set from the Rust experiment was
right and is worth keeping.

### Tests

41 files, and the split falls out of what they already import:

- **37 → `packages/core/test/`** — every file whose `require`s point at
  `config/`, `runner/`, `scheduler/`, `agent/`, `discord/`, `history/`, `http/`,
  `lib/`, `state-store`.
- **4 → `packages/app/test/`** — `channels.test.js` (`main/ipc`),
  `notifications.test.js`, `job-form.test.js`, `job-list.test.js` (renderer
  models).

`notifications.test.js` intercepts `require('electron')` by patching
`Module._load` from `node:module`. That is a Node internal and will not work
under Bun — which is fine, it lives in the Electron package and runs under
`node --test`. It is the reason the app package keeps its own test command
instead of inheriting the Bun one.

## Phases

Each phase ends green and committed. Nothing here requires the next phase to be
useful.

### Phase 0 — baseline

`nvm use` first (`.nvmrc` says 22.16.0; the shell's default Node 18 produces
about 21 phantom failures). Confirm `npm test` is green on all 41 files, and tag
the commit — this tag is what "the engine behaved like this before the move"
means for the rest of the plan.

**Day-1 spike, before anything moves** — three unknowns, cheap to answer, each
able to change a decision:

1. Does `node:test` run under `bun test`, on a representative core file
   (`cron.test.js`, `validate.test.js`, `runner.test.js`)? If not, core keeps
   `node --test` and Bun is used only to build.
2. Does `bun build --compile` handle this CommonJS tree? A throwaway entry that
   requires `config/validate` and prints a validation result answers it.
3. Does `bun install` with workspaces produce a `node_modules` layout
   `electron-builder` can package? This is the one with a real chance of
   biting — see "Known risks".

*Done when:* baseline tagged, three answers written down here.

#### The three answers, measured 2026-08-11

Baseline: **763 tests, 0 failures** across the 41 files on Node 22.16, tagged
`pre-extraction` at `da8e28b`.

1. **`node:test` runs under `bun test`.** `cron` (32), `validate` (52) and
   `runner` (39) all pass. One caveat, and it is not a divergence: `bun test`
   imposes a default 5 s per-test timeout that `node --test` does not, which
   fails `runner.test.js`'s "child processes are killed with the script on
   timeout" — a test that deliberately sleeps 4.5 s after a 1 s run. With
   `--timeout 30000` it is green. **Core keeps `node --test` as its own command
   and gains Bun as a second runner in CI**, per the "run the core suite under
   both runtimes" note below.
2. **`bun build --compile` handles the CommonJS tree.** A throwaway entry
   requiring `config/validate` bundles **76 modules** in 10 ms and compiles in
   139 ms. `ajv` and both JSON schemas are inlined: the resulting binary
   validates a job correctly when run from `/`, with no configuration directory
   and no `node_modules` in sight. The audit's claim about runtime assets holds.
3. **`bun install` with workspaces packages cleanly — the highest-risk unknown
   is not a risk.** Bun links the four packages into `node_modules/@rota/`
   as symlinks, and `electron-builder` 26.15.3 **dereferences them and copies
   real directories into `app.asar`**. Verified end to end, not assumed: a file
   placed in `packages/core/src/` was extracted back out of the packaged
   `app.asar` and loaded. The fallback in "Known risks" (bundling core into the
   main process) is **not needed**; `electron-builder.yml` keeps its
   no-bundling comment, which stays true.

   Two notes for later. `electron-builder` logs `duplicate dependency
   references` for `@rota/core` — cosmetic, it comes from several packages
   naming the same workspace dependency. And the root `postinstall`
   (`install-electron`) fails under the shell's default Node 18 with
   `ERR_REQUIRE_ESM`, because `@electron/get` is ESM: **`nvm use` before
   `bun install`, exactly as before `npm test`**. This is the same trap the
   baseline note describes, one step earlier in the process.

### Phase 1 — workspace skeleton

Root `package.json` becomes a workspace with no code of its own. Create the four
package directories with their manifests and nothing else. Wire the root scripts
(`dev`, `test`, `build`, `compile`, `package`) to delegate.

*Done when:* `bun install` resolves, `bun run test` runs the old suite from its
old location, everything still passes.

### Phase 2 — move core

Mechanical, and the largest diff of the whole plan: `git mv` the engine
directories and their 37 tests, fix relative paths, move `schemas/`, add
`src/index.js`. **No behaviour change and no rewrite in this phase** — a move
that also improves something is a move that cannot be reviewed.

`src/main/` keeps working throughout by requiring `@rota/core`, so the
Electron app runs at every commit.

*Done when:* 37 tests green from `packages/core/test/`, the app still launches
and runs a job.

### Phase 3 — reduce the app

`packages/app/src/main/index.js` becomes composition only: build the engine from
`@rota/core`, wire the tray, the windows, the notifications, the IPC.
`wake.js` moves in as `power-electron.js`. Nothing else changes; the renderer is
untouched.

*Done when:* the app behaves as it does today, and `packages/app/src/main/` holds
only files that have a reason to know about Electron.

### Phase 4 — the daemon

The first phase with genuinely new code.

- **Composition** — the same wiring as the app, minus the shell, plus signal
  handling (`SIGTERM` → clean stop) and startup logging that says which
  configuration directory it opened.
- **Power and lock, without Electron.** `powerMonitor` does not exist outside
  Electron, so detect sleep by the gap between two timer ticks (a gap past ~20 s
  is time the machine spent asleep) and poll `ioreg` for the screen lock on
  macOS, which `lib/session-lock.js` already does and already guards by
  platform. `experiments/rotad/crates/rotad-core/src/daemon.rs` is a
  working implementation of exactly this — read it before deleting it.
- **The instance lock.** Two schedulers on one configuration directory overwrite
  each other's `state.json`, fire every trigger twice and interleave two runs
  into one JSONL. This is the one place where leaving Rust costs something real:
  Node has no `flock`. Take `O_EXCL` on a lock file holding the PID, and treat a
  file whose PID is no longer alive as stale — that covers the crash case a
  plain PID file gets wrong. Name the holding process in the refusal message.
- **`rotad` as the binary name**, via `bin` in the manifest and as the
  `--outfile` of the compile step.
- **`service.js`** — print the launchd plist or the systemd unit, never install
  it. Telling the init system to load something is the user's decision.

*Done when:* `rotad run --config-dir <dir>` schedules and runs jobs with no
Electron anywhere, survives sleep and wake, refuses to start twice on one
directory, and stops cleanly on `SIGTERM`.

### Phase 5 — the CLI

`rotactl`, linking `@rota/core` directly rather than only speaking HTTP —
that is what lets `jobs`, `show`, `history`, `logs` and `validate` answer with
nothing running. `run`, `stop`, `pause`, `resume`, `status` and `events` go
through the API. `enable`/`disable` write the job file and let the watcher pick
it up.

The token comes from `config.json` in the configuration directory, `${VARIABLE}`
resolved, with `--token` and `ROTA_TOKEN` as overrides. There is no reason to
ask anyone to keep a second copy of a token the application generated.

*Done when:* the reading commands work against a directory with nothing running,
and the acting ones against a live `rotad`.

### Phase 6 — the app talks to a daemon (optional mode)

The payoff, and the biggest chunk of new work. The application gains a second
mode: instead of building the engine in-process, connect to a `rotad` — local
or remote. Embedded stays the default, so the desktop install remains one thing.

The `experiments/rotaui` experiment already proved a renderer cannot tell the
difference: its IPC channel surface matches the current app's to within five
names. What it needed, and what the JS HTTP API does not have yet:

- **`GET /api/events`, an SSE stream.** There is none today; the Electron app
  had IPC instead. This is the piece everything else in this phase rests on.
- **About twelve routes that only existed as IPC channels**: `/api/state`,
  `/api/config`, `/api/config/http-token`, `/api/templates`,
  `/api/outputs/{reference}`, `/api/memory/global`, `/api/jobs/{id}/definition`,
  `/api/jobs/{id}/chats`, `/api/errors/acknowledge`, `/api/ui/answer`,
  `/api/system/power/{event}`, `/api/jobs/{id}/stop`.
- **`ui-request` over the stream** for `ask_user` and `confirm`: an interface
  attaches for exactly as long as its connection lives, the two blocking tools
  are not offered at all when nobody is attached, and the transcript says which
  were withdrawn and why.

`experiments/rotad/crates/rotad-core/src/api/` is the specification for
all three. Port the route list and the semantics, not the code.

One trap to avoid: in embedded mode the app builds the engine **and** can serve
the HTTP API. It must not bind the port when it is attached to a daemon that
already holds it, and the instance lock from Phase 4 must cover the embedded
engine too — otherwise the app and a `rotad` on the same directory are
exactly the double-scheduler this plan spent Phase 4 preventing.

*Done when:* the same window drives an embedded engine or a remote daemon, tells
the user which, and says where it was looking when a daemon is gone.

### Phase 7 — compile and package

```bash
bun build packages/daemon/src/index.js --compile --outfile dist/rotad \
  --target=bun-darwin-arm64      # then darwin-x64, linux-x64, linux-arm64
bun build packages/cli/src/index.js --compile --outfile dist/rotactl --target=…
```

The Electron app keeps Vite for the renderer and `electron-builder` for the
`.dmg`, unchanged apart from paths.

*Done when:* a `rotad` binary copied to a machine with no Node and no Bun
opens a configuration directory and runs a job.

### Phase 8 — CI and documentation

A GitHub Actions matrix (macOS and Linux) running the four test suites and both
compile targets. There is no CI today, which is why nothing enforces any of the
above. Then rewrite the root README around the new shape: four packages, two
binaries, one application, the installation paths for each, and a threat-model
section — a daemon that runs arbitrary shell behind a bearer token needs its
defaults stated in public. They are good today (`enabled: false`,
`apiEnabled: false`, `discordControlEnabled: false`, three flags that stack, a
port that is nothing well-known); say so rather than letting them be discovered.

### Phase 9 — retire `experiments/`

Only once Phase 6 is done. Tag, write two paragraphs in the README about what the
experiment proved — that the engine was never the interface — and delete.

## Known risks, and what we do about them

**`electron-builder` and workspace symlinks.** `bun install` links workspace
packages into `node_modules` as symlinks, and `electron-builder` has historically
mishandled those when collecting `files`. This is the highest-probability
blocker in the plan, which is why it is a Phase 0 spike and not a Phase 7
surprise. Fallback if it bites: bundle `@rota/core` into the app's main
process with Bun or Vite at build time, so the packaged app ships one file rather
than a linked tree. The current `electron-builder.yml` deliberately does not
bundle the main process — that comment stops being true if we take this route,
and should be updated rather than left to mislead.

**`node:test` under Bun.** If Bun's runner does not carry these tests, do not
rewrite 37 files to `bun:test`. Keep `node --test` for the suites and use Bun
only for building and running. Whichever way it goes, run the core suite under
**both** runtimes in CI: the daemon ships as a Bun binary and the app runs the
same code under Electron's Node, so a divergence between the two is a bug we
would otherwise find in production.

**`Module._load` in `notifications.test.js`** — Node-only, stays on `node --test`
in the app package. Noted so nobody spends an afternoon on it.

**The instance lock is the weak point of leaving Rust.** `flock` is released by
the kernel however the process died; a PID file is not. The `O_EXCL` + liveness
check above is the standard mitigation and it is good enough, but it is the one
place to write a test for the ugly case: killed with `SIGKILL`, lock file left
behind, daemon restarted.

**One configuration directory, two possible engines.** With the app embedding the
engine by default, `~/.config/rota` can now be opened by the app and by a
`rotad` at once. The lock must be taken by the embedded engine too, not only
by the daemon binary. The Rust experiment explicitly did not do this for the
Electron side; we do not get to make the same exception, because here both sides
are the same engine.

## What `experiments/` was for

*(Phase 9 is done: it is deleted, and recoverable at `rust-experiment-final`. Kept
here as the record of what was read out of it before it went.)*

It was not deleted before Phase 6. Two files are specifications with no JS
equivalent yet, and one is a corpus:

- `crates/rotad-core/src/daemon.rs` — sleep detection by tick gap, screen
  lock polling, watcher intervals. Phase 4 reimplements this.
- `crates/rotad-core/src/api/` — the route list, the SSE stream and the
  `ui-request` protocol. Phase 6 reimplements this.
- `tests/oracle/` and the four `*_differential.rs` — a recorded description of
  how cron, the runner, history and templates behave. If any of the moves above
  ever raises a doubt about fidelity, this is the second opinion.

## Decisions taken, so tomorrow does not relitigate them

- **Package names**: `@rota/core`, `@rota/daemon`, `@rota/cli`, and
  `rota` for the application.
- **Binaries**: `rotad`, `rotactl`.
- **CommonJS stays.** The whole tree is CJS, Bun compiles it, Electron runs it.
  Converting to ESM is not on the critical path and would contaminate every diff
  in Phases 2 and 3.
- **Configuration directory**: one, `~/.config/rota`, for the app and the
  daemon alike. There is one engine now; two directories would only mean two
  places to be confused about.
- **Embedded is the default** for the application. Remote is a mode, not the
  architecture.
- **Zero-dependency is not a goal.** It was the Rust experiment's discipline; it
  is not inherited. Take a dependency when it is the better answer.
- **`createEngine()` lives in core** (added during Phase 3, not in the original
  plan). Phase 3 asked the application's `index.js` to "build the engine from
  `@rota/core`" and Phase 4 asked the daemon for "the same wiring as the
  app, minus the shell". Without a composition root inside core, "the same
  wiring" would have meant a second copy of ~120 lines — recording an execution,
  pruning orphans, honouring a pause, reacting to a reload — and a daemon that
  got any of it subtly different would have been a bug nobody could see. So
  `core/src/engine.js` owns the composition and emits what a shell needs
  (`started`, `output`, `finished`, `changed`, `config-changed`, `chat`); the
  two things that genuinely differ are injected: the agent UI, and the power
  adapter. `packages/app/src/main/index.js` went from 487 lines to 280 at this
  phase, and every line it kept is there because there is a screen. Phase 6 later
  brought it to 430, by adding the choice between an embedded engine and a remote
  one — which is also a decision only a shell can take.
- **Electron's version is pinned**, not a range. Bun hoists `electron` to the
  workspace root, so `electron-builder` run from `packages/app` can no longer
  read the installed version and falls back to the manifest — where a range is
  refused. Pinning is also the honest description of a desktop app that ships
  one specific binary.

## Open questions for tomorrow

1. **Publish to npm?** It changes whether `@rota/core` needs a stable public
   surface from Phase 2, or whether `src/index.js` can stay loose for a while.
   1. response: no
2. **Does the packaged `.app` ship the `rotad` binary** alongside the
   embedded engine, so a user can switch to daemon mode without a second
   download? Cheap to do at Phase 7, awkward to retrofit.
  2. response: yes
3. **API versioning** — worth a `/api/v1` prefix before anything is public, or
   left until there is something to break?
  3. response: yes
