# Inside it

Four packages, two binaries, one application. How it is laid out, how to build and
test it, how a release is cut — and what the Rust port that is no longer here
proved before it went.

[← Rota](../README.md) · [Writing a job](jobs.md) · [Running it](operating.md) · **Inside it**

## Project layout

Four packages in one workspace. The line between them is the one the code already
drew: **seven files needed Electron, and none of them was the engine.**

| Package | What it is |
|---|---|
| `packages/core` | `@rota/core` — the engine. Configuration, scheduler, runner, agents, history, Discord, HTTP API. Knows nothing about any screen |
| `packages/daemon` | `rotad` — the engine with nobody attached. A compiled binary |
| `packages/cli` | `rotactl` — driving it from a terminal. A compiled binary |
| `packages/app` | `rota` — the Electron application. Tray, windows, notifications, IPC, and nothing else |

Inside the engine:

| Path | Role |
|---|---|
| `packages/core/src/engine.js` | the composition both shells build; the reason they cannot drift apart |
| `packages/core/src/index.js` | the published surface — what a consumer may rely on, and the one place that debt is visible |
| `packages/core/src/config/` | paths, schema, loading, watching, job templates, trigger lookup, migration |
| `packages/core/src/scheduler/` | occurrence computation, one timer per timed trigger, sleep, wake, screen lock |
| `packages/core/src/runner/` | child processes, outputs, Bun and Docker resolution, inline code, sandbox, workflow steps |
| `packages/core/src/agent/` | tool loop, OpenAI-compatible client, tools, memory, persistent container, conversations |
| `packages/core/src/agent/mcp/` | hand-written MCP client: stdio and Streamable HTTP transports |
| `packages/core/src/discord/` | hand-written Gateway connection, commands, shared sending |
| `packages/core/src/http/` | node:http server, routing separated from plumbing, token comparison, OpenAPI, the event stream |
| `packages/core/src/history/` | JSONL, pagination from the end, retention |
| `packages/core/src/lib/` | logging, atomic writes, cron parser, lock state |
| `packages/core/src/instance-lock.js` | one engine per configuration directory — taken by the daemon and by the application alike |
| `packages/core/schemas/` | the job and configuration schemas. They live with the package that validates against them |

And the shell:

| Path | Role |
|---|---|
| `packages/app/src/main/index.js` | composition only: it builds an engine and wires a screen to it |
| `packages/app/src/main/power-electron.js` | `powerMonitor` translated into the three calls the scheduler already exposes |
| `packages/app/src/main/remote-engine.js` | the same surface, served over HTTP, when the engine is somewhere else |
| `packages/app/src/preload/` | allowlisted IPC bridge, sandboxed; the agent windows' bridge is separate and narrower |
| `packages/app/src/renderer/` | React UI; holds no business state |
| `packages/app/src/renderer/agent.jsx` | second window: reports and questions |
| `packages/app/src/renderer/monaco.js` | editor: JSON validated against the schema, JavaScript for inline code, markdown for prompts |
| `packages/app/scripts/generate-icons.js` | hand-rolled icon rasterizer, no dependencies |

Two modules are hand-written where a dependency would have done: `lib/cron.js` and
`generate-icons.js`. The cron format and the PNG format are small and frozen, and
the engine has exactly one runtime dependency — `ajv`. Markdown rendering of agent
reports, on the other hand, leans on `marked` and `dompurify`: sanitizing HTML by
hand is the kind of exercise you fail silently. Like React and Monaco, they are
bundled into the renderer by Vite, hence `devDependencies` — `ajv` remains the only
runtime dependency, and it is inlined into the compiled binaries.

The engine holds the single source of truth and emits events; a shell decides what
to show. The renderer never runs a command: it sends intents through the surface
defined in `packages/app/src/main/ipc.js`.

### What Linux gets, and what it does not

The engine never needed a screen, so the two binaries were portable from the day
they existed. The application took three small things and one it cannot have:

- **Its own tray icons.** The macOS set are template images — alpha only, recoloured
  by the menu bar. Nothing recolours them on Linux, where they would arrive as flat
  black shapes on a dark panel, so there is a second set that carries its own
  colour. Both draw the same four shapes; the shape is what distinguishes the
  states, and the colour is a second signal rather than the only one.
- **Launch at login as a file.** Electron implements the system setting on macOS and
  Windows only. On Linux the mechanism is a `.desktop` entry in
  `~/.config/autostart`, which every desktop that follows the freedesktop
  specification reads — so Rota writes one, and removes it when you untick the
  box.
- **The screen lock from `logind`.** See [Jobs that need an unlocked
  session](jobs.md#jobs-that-need-an-unlocked-session).
- **A system tray, which GNOME does not have.** This is the one that is not ours.
  See the note at the top.

## From source

```bash
nvm use
bun install     # or npm install — also downloads the Electron binary
npm start       # Vite dev server + Electron
npm test        # every package's suite (node:test, no framework)
npm run build   # bundle the renderer
npm run compile # rotad and rotactl, four targets
npm run package # .app + ad-hoc signed .dmg, into packages/app/release/
npm run icons   # regenerate icons (PNGs and .icns are committed)
```

`npm start -- --remote-debugging-port=9222` forwards arguments to Electron.

**`nvm use` first, and not only for the tests.** The shell's default Node 18 fails
the install too: Electron's postinstall requires `@electron/get`, which is ESM.

## Development

```bash
nvm use            # 22.16.0 — the shell's default Node 18 produces phantom failures
bun install        # or npm install; both resolve the workspace
npm start          # Vite dev server + Electron, hot reload on the renderer
npm test           # every package's suite, node:test, no framework
npm run test:bun   # the engine again, under the runtime the daemon ships as
npm run compile    # rotad and rotactl, four targets
npm run package    # .app + ad-hoc signed .dmg, with a rotad beside it
```

A package's own suite runs from its own directory:

```bash
npm test --workspace @rota/core
node --test packages/daemon/test/*.test.js
```

**Run the engine's suite under both runtimes.** The daemon ships as a Bun binary and
the application runs the same code under Electron's Node; a divergence between the
two is a bug you would otherwise meet in production. `npm run test:bun` does this,
and names the files it skips — Bun has no `node:test` mock timers yet, and rewriting
those two files to a second dialect would cost more than it buys.

The suite covers the parts that regress silently: the cron parser, occurrence
computation, wake and lock handling, the runner and its timeouts, output truncation,
JSONL retention, schema validation, the agent loop and its tools, the MCP client
(against a real stdio server), the Discord Gateway state machine, the instance lock
(including the case where the holder was killed with `SIGKILL`), and the sleep
detection the daemon uses in place of `powerMonitor`.

Four conventions worth knowing before contributing:

- **Nothing that has no screen belongs in `packages/app`.** The test is mechanical:
  if it does not `require('electron')`, it goes in the engine.
- **Consumers import from `@rota/core`, never from a path inside it.** A path we
  let somebody reach into is a path we owe them forever.
- **The renderer holds no business state.** Anything that outlives a render belongs
  to the engine, which pushes snapshots.
- **Logic that deserves a test does not live in a component.** It moves to a
  `.mjs` module next to it — see `views/job-list-model.mjs` and
  `views/job-form-model.mjs`.

## Distribution

`npm run package` produces an **ad-hoc signed** `.dmg`, good enough for personal use.
It is neither signed with an Apple Developer certificate nor notarized: macOS will
warn on first launch on another machine.

The bundle carries a `rotad` compiled for the same architecture, at
`Rota.app/Contents/Resources/rotad`. Nobody needs it — the application
embeds the engine — but somebody who later wants the scheduler to survive quitting
the window should not have to find a second download for a binary built from the code
already in their Applications folder.

`npm run compile` produces standalone binaries for macOS and Linux, on arm64 and
x64. They inline everything, `ajv` and both schemas included: copied to a machine
with neither Node nor Bun on it, `rotad` opens a configuration directory and runs
a job.

### Releasing

Pushing a `v*` tag builds everything and publishes one GitHub release
([`.github/workflows/release.yml`](../.github/workflows/release.yml)):

```bash
npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
git commit -am "0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The tag has to match every manifest — the workflow checks before it builds
anything, because a release named v0.2.0 whose binaries answer `--version` with
0.1.0 is a thing nobody notices until they are reading a bug report months later.
Nothing is published until every build has succeeded: the release is created in one
step at the end, from artifacts, rather than growing an asset at a time and leaving
half of one behind when a job fails. Re-running a failed publish replaces the assets
instead of refusing.

`workflow_dispatch` builds an existing tag, as a draft by default, which is the way
to rehearse one.

| | macOS arm64 | macOS x64 | Linux x64 | Linux arm64 |
|---|---|---|---|---|
| `rotad`, `rotactl` | ✅ `.tar.gz` | ✅ | ✅ | ✅ |
| Application | ✅ `.dmg` | ✅ `.dmg` | ✅ `.AppImage`, `.deb` | — |

Each `.dmg` and `.AppImage` carries a `rotad` **compiled for its own
architecture** — the workflow checks that, because one built for the other would
fail at the moment somebody first reaches for it. Linux arm64 gets binaries and no
application on purpose: an arm64 Linux box running Rota is usually a machine
with no screen, which is the case `rotad` exists for.

## What the Rust port proved

For a while this repository carried a second implementation: `rotad` and
`rotactl` written in Rust, with a forked renderer and a differential test
harness that replayed recorded behaviour against both. It worked. It is gone, and
what it was for is worth writing down, because the answer is the reason this
repository has the shape it now has.

It proved **the engine was never the interface.** The Rust daemon ran the same jobs,
kept the same history and answered the same questions with no window anywhere near
it, and its renderer — a fork of this one — could not tell which implementation it
was attached to, to within five channel names. That is a strong claim to have
evidence for, and it made the case for the split obvious: if a scheduler can be
driven by a window it does not know about, the window is not part of the scheduler.

What it cost was two languages, an HTTP contract to keep in step by hand, a forked
renderer and a differential harness to maintain — for a dependency-free binary this
project did not need, since `bun build --compile` produces one from the JavaScript
that already existed. So the split happened in the language the application is in,
the Rust tree was read as a specification for the two things that had no JavaScript
equivalent — sleep detection without `powerMonitor`, and the event stream that
carries an agent's questions — and then deleted. It is recoverable in full at the
`rust-experiment-final` tag, which is where it should stay.
