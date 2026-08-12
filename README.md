# Rota

**Recurring local work — including agentic work — on your own machine.**

A job is a script to run, or a paragraph describing what you want achieved. The
second kind is handed to a model with tools: it can read and write files in its own
directory, run commands, fetch pages, call MCP servers, remember what it learned last
time, and come back and ask you a question if it needs one. Both kinds are ordinary
jobs — same schedule, same history, same notification when they break.

Nothing leaves the machine unless you send it there. The model can be
[Ollama](https://ollama.com) on localhost; the configuration is a directory of JSON
files you can read, edit and track in Git. No server, no account, no telemetry.

[![CI](https://github.com/mathieuancelin/rota/actions/workflows/ci.yml/badge.svg)](https://github.com/mathieuancelin/rota/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS and Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#three-shapes-one-engine)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)](.nvmrc)

> **Status.** Works, used daily, single-machine scale.

## Three shapes, one engine

The scheduler is a library, not a window. Pick whichever shape suits the machine —
they run the same code, over the same configuration directory, and you can change
your mind later:

| | What it is | macOS | Linux |
|---|---|---|---|
| **Rota.app** | menu bar application: a real interface to write a job, watch it run, and put it right | ✅ Apple Silicon and Intel | ✅ x64, with one caveat below |
| **`rotad`** | the same engine with nobody attached — a headless box, a server, a Raspberry Pi | ✅ | ✅ arm64 and x64 |
| **`rotactl`** | the same engine from a terminal: list, validate, run, follow | ✅ | ✅ arm64 and x64 |

```sh
# A machine with no screen — no Node, no Bun, no runtime of any kind to install
rotad run --config-dir ~/.config/rota

# From anywhere, over SSH or not
rotactl jobs          # what exists, when it runs next, how it went last time
rotactl run backup    # start one now
rotactl events        # follow what happens, as it happens
```

`rotad` and `rotactl` are standalone binaries: everything they need is
compiled in. And the two shapes are not exclusive — the application can drive a
daemon instead of running its own scheduler, on this machine or another, and it
looks exactly the same from the window. That is also how an agent running headless
asks a question: it goes out over the event stream, and whichever interface is
attached opens the panel.

> **Where it is supported, honestly.** Everything here runs on macOS and Linux,
> arm64 and x64 — the daemon verified running a job on a bare Debian container with
> no runtime installed, the application verified starting, scheduling and running
> one on the same. Windows is not supported at all.
>
> **The one caveat, and it is not ours to fix: GNOME has shipped no system tray
> since version 3.** With an [AppIndicator
> extension](https://extensions.gnome.org/extension/615/appindicator-support/) the
> icon appears and everything behaves as on any other desktop; without one it does
> not, and a menu bar application on a desktop with no menu bar is a fair thing to
> be annoyed about. Closing the window is not a trap either way — the scheduler
> keeps running, and starting Rota again brings the window back. KDE, XFCE,
> Cinnamon and Budgie carry a tray natively.

## Contents

- [Three shapes, one engine](#three-shapes-one-engine)
- [Coming from TickTray](#coming-from-ticktray)
- [Why not cron?](#why-not-cron)
- [Requirements](#requirements)
- [Getting started](#getting-started)
  - [From source](#from-source)
- [Where data lives](#where-data-lives)
- [Defining a job](#defining-a-job)
  - [Editing: form, JSON, or both](#editing-form-json-or-both)
  - [Putting a job right without leaving the editor](#putting-a-job-right-without-leaving-the-editor)
  - [What is handled](#what-is-handled)
  - [What starts a job: `triggers`](#what-starts-a-job-triggers)
  - [Code inside the job: `bun-inline`](#code-inside-the-job-bun-inline)
  - [Describing intent instead of steps: `agent`](#describing-intent-instead-of-steps-agent)
  - [Global memory: what every agent knows](#global-memory-what-every-agent-knows)
  - [Chaining jobs: `workflow`](#chaining-jobs-workflow)
  - [Isolating a job: the Docker sandbox](#isolating-a-job-the-docker-sandbox)
  - [Notifying only when something happened](#notifying-only-when-something-happened)
  - [Jobs that need an unlocked session](#jobs-that-need-an-unlocked-session)
  - [Notifications and macOS](#notifications-and-macos)
- [Driving Rota over HTTP](#driving-rota-over-http)
  - [The token is the whole lock](#the-token-is-the-whole-lock)
  - [The API](#the-api)
  - [The webhook](#the-webhook)
- [Driving Rota from Discord](#driving-rota-from-discord)
  - [Talking to an agent from the channel](#talking-to-an-agent-from-the-channel)
- [Worked example: keeping a Git repository in sync](#worked-example-keeping-a-git-repository-in-sync)
- [Project layout](#project-layout)
  - [Running it without a window](#running-it-without-a-window)
  - [Driving it from a terminal](#driving-it-from-a-terminal)
  - [Driving the window from elsewhere](#driving-the-window-from-elsewhere)
- [Security](#security)
- [Development](#development)
- [Distribution](#distribution)
- [Scope and non-goals](#scope-and-non-goals)
- [Contributing](#contributing)
- [License](#license)

## Why not cron?

A fair question: for "run this script every five minutes", `crontab` does the job in
one line, and it has been doing it for forty years.

Scheduling is not the hard part. **What happens when a job breaks** — and whether you
notice — is.

The example job in this repository, which keeps a Git-backed notes vault in sync,
once spent four hours failing on this:

```text
git@github.com: Permission denied (publickey).
```

The cause had nothing to do with Git. The SSH key was not loaded into `ssh-agent`, so
`ssh` decrypted it on every run by reading its passphrase from the keychain —
unreadable while the screen is locked. The diagnosis came down to one thing: 53
timestamped executions with their `stderr`, cross-referenced against screen-lock
events in the log. 45 failures, 8 successes, **every failure with the screen locked,
every success with it unlocked, no counter-example**.

Under `crontab`, that evidence does not exist. `stderr` goes to a local mail spool
nobody reads. You find out days later, when the repository turns out to be stale.

Worse: the cron daemon runs outside the graphical session, with a minimal
environment — **no `SSH_AUTH_SOCK`**. That job would have failed 100% of the time
rather than 40%. Rota passes the variable through explicitly, from an allowlist
([`packages/core/src/runner/index.js`](packages/core/src/runner/index.js)).

| | `crontab` | `launchd` | Rota |
|---|---|---|---|
| Time expressions | yes | intervals | yes, five fields |
| Catch-up after sleep | no | once on wake | once, can be disabled |
| Skip while the screen is locked | no | no | `requiresUnlockedSession` |
| Output kept and browsable | local mail | a file you manage | JSONL history + UI |
| Timeout, descendants killed | no | `ExitTimeOut` | SIGTERM then SIGKILL of the group |
| Notification on failure | no | no | yes, with the details one click away |
| Controlled environment | minimal | declarative | allowlist + per-job variables |

**Where `crontab` still wins:** it is already installed, it does not drag a hundred
megabytes of Chromium cache behind it, it needs no packaging, and forty years of use
have taken its bugs out. Rota understands the same expressions, but through its
own parser — young, and therefore less battle-tested than Vixie's.

**So the right tool depends on the job.** A nightly `rsync` that needs nothing and
that nobody watches: `crontab`, no hesitation. A job that touches the network,
credentials, or files you would rather not lose, and that you want to know has
stopped working: that is what Rota is for.

## Requirements

**To run it: nothing.** `rotad` and `rotactl` are standalone binaries, and
the `.dmg` carries its own Electron. There is no runtime to install first.

Per feature, and only if you use it:

- **[Bun](https://bun.sh)** for `bun` and `bun-inline` jobs — jobs written in
  JavaScript. `shell` jobs need nothing
- **An OpenAI-compatible API** for `agent` jobs — [Ollama](https://ollama.com) on
  localhost by default, with a model that can call tools. A hosted API works too,
  and then the prompt does leave the machine
- **[Docker](https://www.docker.com)** for the sandbox, whatever the job type

**To build it from source:** Node 22 (`nvm use` reads [`.nvmrc`](.nvmrc)) and
[Bun](https://bun.sh) for the compiled binaries.

## Getting started

Everything is on the [releases page](../../releases). Whichever you take, they all
open the same `~/.config/rota`, so starting with one and moving to another costs
nothing.

**The application, on macOS.** Download the `.dmg` for your machine, drag it to
Applications. It is ad-hoc signed and not notarized, so the first launch is
right-click → Open. It carries a matching `rotad` inside, at
`Contents/Resources/rotad`, for the day you want the scheduler to keep running
without a window.

**The daemon and the command line, anywhere.** No runtime to install first:

```bash
tar -xzf rotad-0.1.0-linux-x64.tar.gz
sudo install rotad-0.1.0-linux-x64/rotad /usr/local/bin/
rotad run --config-dir ~/.config/rota

# and to have the init system start it — this prints the file, and installs nothing
rotad service systemd > ~/.config/systemd/user/rotad.service
rotad service launchd > ~/Library/LaunchAgents/com.rota.daemon.plist
```

**One engine per configuration directory.** The first to open one takes a lock on
it, and a second refuses by name and by process id — an application and a daemon on
the same directory would otherwise run every job twice, with nothing to tell you but
a job that ran twice at three in the morning.

### From source

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

## Coming from TickTray

The project was called **TickTray** while it was only a menu bar application. It
is three things now, two of which have no tray to live in, so the name went.
`rota` is the Latin for wheel, and in English the roster of duties taken in turn —
which is what a `jobs/` directory is.

Nothing of yours is moved or broken by that:

- **Your configuration directory stays where it is.** If `~/.config/rota` does not
  exist and `~/.config/ticktray` does, that is the one the engine opens, and it
  says so at startup with the `mv` that finishes the job. Do it when you feel
  like it; the engine has no opinion about which afternoon.
- **Your job scripts keep working.** Every variable a job receives is handed to it
  under both names — `ROTA_JOB_ID` and `TICKTRAY_JOB_ID`, and likewise for
  `_EXECUTION_ID` and `_STEPS`. `TICKTRAY_CONFIG_DIR` and `TICKTRAY_TOKEN` are
  still read.
- **Your job files keep validating.** `$schema` is a free string, so the old
  `ticktray.local` URL is accepted; new files get the new one.

The old names are deprecated, not permanent. They are pinned by
`packages/core/test/legacy-name.test.js`, which is to be deleted in the same
commit that drops them.

What does change, once, and cannot be helped: the macOS application identifier is
now `com.rota.app`, so the system treats it as a new application — notification
permissions are asked for again.

## Where data lives

```text
~/.config/rota/
├── config.json           global settings: Discord, HTTP server, defaults
├── .env                  secrets referenced by ${VARIABLE} — create it yourself
├── jobs/<id>.json        one job per file
├── scripts/              conventional home for your scripts
├── inline/<id>.js        code of bun-inline jobs, regenerated before every run
├── agents/<id>/          default working directory of an agent job
├── memory/<id>.mem.json  what an agent remembers between runs
├── memory/global.json    what every agent remembers — see Global memory
├── conversations/<id>/   chat threads, one file per conversation
├── history/<id>.jsonl    one execution per line
├── history/outputs/      outputs too large for the JSONL
├── logs/rota.log
├── state.json            last runs, acknowledged errors
├── rota.lock         which engine has this directory open, and its process id
└── .chromium/            Electron cache and session, kept out of the way
```

The same path on every system, macOS included. `Library/Application Support` is
meant for data a user is not supposed to open; this is the opposite — JSON files and
scripts you edit by hand, track in a repository, open from a terminal.
`XDG_CONFIG_HOME` is honoured when set.

Electron's `userData` points at that same directory by default, which would scatter
twenty-odd Chromium session files through your configuration. It is moved into
`.chromium/` at startup.

`ROTA_CONFIG_DIR` points somewhere else — useful for running a development
instance without touching your real configuration:

```bash
ROTA_CONFIG_DIR=/tmp/rota-dev npm start
```

## Defining a job

One file per job in `jobs/`. **The file name must be the `id`**: it is what indexes
the history.

From the Jobs tab, "New job" asks for an identifier and a template, writes the JSON
and opens the editor on it. Six templates: inline code, inline code on a cron
expression, Bun script, shell script, workflow, agent. An identifier already in use
is rejected rather than overwritten. The job is created **disabled**: a template does
not yet do what you want, and for the types that point at a file, that file does not
even exist.

Disabling stops every trigger — timer, webhook and keyword alike. "Run" stays
available in the list and in the tray menu — that is how you put a job right before
letting it run on its own.

**The list carries three actions only**: run — or stop, if the job is running —
enable or disable scheduling, and edit. Everything else lives in the editor, which
**the whole card opens** on click: a job is one place with tabs, rather than a row of
buttons each leading somewhere different.

```json
{
  "$schema": "https://rota.local/schemas/job.schema.json",
  "id": "sync-notes",
  "name": "Notes sync",
  "triggers": [{ "type": "interval", "every": 5, "unit": "minutes" }],
  "runner": {
    "type": "bun",
    "script": "/Users/you/scripts/sync-notes.js",
    "workingDirectory": "/Users/you/notes"
  },
  "execution": { "timeoutSeconds": 120, "catchUpOnWake": true },
  "notifications": { "onError": true }
}
```

Full schema: [`packages/core/schemas/job.schema.json`](packages/core/schemas/job.schema.json).
Ready-to-copy examples: [`examples/jobs/`](examples/jobs/).

Files are hot-reloaded. **Invalid JSON never overwrites the definition in memory**:
the job keeps running on its last valid version, flagged "previous definition", and
the error surfaces in the UI.

### Editing: form, JSON, or both

The editor opens the same definition from several angles. **Form** covers every
setting of every type, grouped by theme, with the schema's explanations under each
field. **Definition** shows the JSON, validated live. Depending on the type it is
joined by **Code** (JavaScript), or **Prompt** and **System** (markdown), plus
**Chat** for an agent job.

Behind a divider, last: **History** — this job's past executions, paginated from the
end. It edits nothing, hence the divider, and that is exactly why it belongs here:
you open it between two attempts.

The JSON is always the source of truth: the form writes back to it on every change,
the text tabs re-inject their content when you leave them. The views cannot drift
apart, and a single validation decides — the main process's, on save.

**Delete** is here too, and it is the only red button in the application. The
confirmation is a modal sheet owned by the main process — the only one in Rota —
because the action is irreversible and does not take only the file: the job's history
goes with it, externalized outputs included. "Cancel" is the default button. A
running job cannot be deleted.

Two points of method:

- **Labels live in the form, explanations in the schema.** A description is written
  once and used twice: as the JSON tooltip, and as the hint under the field. Two
  texts for one setting would eventually contradict each other. A test asserts that
  no schema field is missing from the form.
- **Changing the type converts the definition.** Going from `bun` to `agent` drops
  `script` and seeds `agent`, in both directions, without ever overwriting what you
  already typed: a round trip loses nothing.

Three fields stay out of the form, and say so: inline code and the prompts, which
have their own tabs, and `api.extraBody`, a free-form object with no known shape.

### Putting a job right without leaving the editor

A job is tuned by successive attempts: run, watch, fix, run again. So the editor
carries **Run** and **Stop**, and shows **the output of the current execution** as it
happens. The rest of the loop is one tab away: history for what has finished, chat
for a prompt being worked out.

This is the only view that shows output before the end. The main process keeps the
last 64 KiB of each running execution and pushes the rest in batches; the view asks
for what already exists when it opens, then only appends. An agent job has no output
stream: what scrolls is its transcript, line by line, as it is written.

The text **stays on screen after the end**, with the status — that is when you need
it most. It clears on the next run, or when you leave the view: what has to last is
in the history, with its pagination and externalized outputs.

Two details you notice in use: scrolling follows the bottom as long as you are there,
and freezes as soon as you scroll up to read something; and "Run" is disabled while
there are unsaved changes, since it is the on-disk definition that would execute.

The JSON accepts **no comments** — neither `JSON.parse` nor the schema, which also
rejects trailing commas. A field's documentation is elsewhere: hovering any key in
the built-in editor shows its description, taken from the schema, and completion
offers the allowed values. A job's `description` field is the only free text in a
definition.

### What is handled

| | |
|---|---|
| Scheduling | plain intervals, or five-field cron expressions |
| Execution | `bun run <script>`, `sh`/`bash <script>`, JS carried by the job, or an agent |
| Concurrency | `allowConcurrentRuns`, otherwise status `skipped-already-running` |
| Timeout | `timeoutSeconds`, SIGTERM then SIGKILL five seconds later |
| Sleep | **single** catch-up on wake, disabled with `catchUpOnWake` |
| Locked session | `requiresUnlockedSession` pauses the job, like sleep |
| Isolation | `sandbox` runs the job in a disposable Docker container, network off |
| Outputs | truncated at `maxOutputBytes`, inline excerpt beyond 8 KiB |
| Retention | `retainExecutions`, deferred JSONL compaction |
| Notifications | on start, on success, on failure, or only when something changed |
| Interface | create from a template, form or JSON, live output, paginated history, stop a running execution |
| Appearance | light, dark, or the system's — Settings → General |
| Tray | active jobs, next three runs, recent errors, manual run, global pause |
| Discord | outbound reports, and control from a channel if a bot is configured |

### What starts a job: `triggers`

**A job says what it does, and separately what starts it.** The two are independent:
any type of job takes any kind of trigger, and it takes as many as it likes.

```json
"triggers": [
  { "type": "interval", "every": 5, "unit": "minutes" },
  { "type": "cron", "expression": "0 9 * * 1-5" },
  { "type": "webhook" },
  { "type": "discord", "keyword": "deploy" }
]
```

"Every five minutes" and "at 9am on weekdays" cannot be said in one expression, so
they are said in two. `"enabled": false` on a trigger silences it while leaving it
there — better than deleting the one you want back next week.

**An empty list is legitimate.** Such a job never starts on its own: it runs from the
list, from the tray, from Discord's `run`, or as a step of a workflow. That is the
normal shape of a job that exists to be called.

Disabling the *job* stops every trigger, timer and webhook alike. Running it by hand
stays available — that is the whole point of disabling it.

> **Coming from an earlier version.** Jobs used to carry a single `schedule` object.
> Rota rewrites them into `triggers` on first launch and keeps the original as
> `<id>.json.bak`. The schema no longer accepts `schedule`, so the rewrite is visible
> and reviewable rather than silently translated on every load.

#### Interval and cron

An **interval** is counted from the *end* of the previous execution: "every five
minutes" means five minutes after the last one finished, so a job slower than its
interval never stacks on top of itself. The trade-off is that the clock drifts, and
that "at 9am" cannot be expressed.

A **cron expression** names absolute instants, aligned to the minute and independent
of how long executions take. Five fields — minute, hour, day of month, month, day of
week — evaluated in **local time**. The `@hourly`, `@daily`, `@weekly`, `@monthly`
and `@yearly` shorthands are accepted, as are month and day names (`0 9 * * mon-fri`).

Two behaviours worth knowing, because they surprise people:

- **Day of month and day of week are OR-ed** as soon as both are restricted.
  `0 0 1 * 1` means "on the 1st of the month, *and also* every Monday". That is
  Vixie cron's rule, not an invention. A field starting with `*` does not count as
  restricted.
- **Local time governs.** A job at 02:30 does not happen on the night the clock
  springs forward, when that minute does not exist, and happens once — not twice —
  when it falls back.

No seconds: the minute is the smallest step, and a six-field expression is rejected
with that explanation. No `L`, `#` or `?` extensions either.

The expression is parsed **at validation time**, not when a timer is armed: a typo
shows up immediately in the UI, naming the offending field and bound, instead of
producing a loaded job that would never fire.

```text
triggers.0.expression: hour: 25 is out of 0-23
```

Catch-up on wake works identically, and **once per job** however many triggers
missed their turn: what a wake-up catches up is the work not done, and it was not
left undone three times because three triggers asked for it.

#### Webhook and Discord keyword

The other two wait to be come to. A **webhook** trigger makes the job reachable at
`POST /webhook/<id>` — see [Driving Rota over HTTP](#driving-rota-over-http).
A **discord** trigger claims a word: `@Rota deploy` starts the job that declares
`"keyword": "deploy"`. Built-in commands win over keywords, and the validation
refuses a keyword that shadows one — a job that could never start is worse than a
job that refuses to load.

Neither declares *when*; both mean "this job accepts being started from there".
Declaring them is what makes those doors exist for that job, and nothing else opens
them.

### Code inside the job: `bun-inline`

For jobs a few lines long, managing a script file next to the JSON costs more than
the job itself. The `bun-inline` type carries its code in its definition:

```json
"runner": {
  "type": "bun-inline",
  "code": "const n = await Bun.file('/tmp/f').text()\nconsole.log(n.length)"
}
```

`script` and `code` are mutually exclusive: a `bun-inline` job carries code, the
others a path. Both the schema and the main process reject the two together.

In the UI, such a job's editor gains a **Code** tab, in JavaScript rather than
escaped onto one line of JSON. The definition remains the source of truth: the code
is extracted when the tab opens and re-injected when you leave it or save, so the two
views cannot drift apart.

**Nothing is passed to a shell, not even as an argument.** Before each run, Rota
writes the code to `inline/<id>.js` and runs `bun run` on it: the launch path is
exactly that of an ordinary script. Stack traces therefore point at a real file, at
the line the editor shows — the "generated file" banner sits at the *end* of the file
precisely so that nothing is offset. These files are derived content: rewritten
before every run, purged when the job disappears.

Without `workingDirectory`, an inline job runs in the generated-files directory.

### Describing intent instead of steps: `agent`

The other three types say *how*. The `agent` type says *what*, and lets a language
model work out the how, in a loop, with tools.

```json
"runner": {
  "type": "agent",
  "agent": {
    "prompt": "Check that https://example.com responds, then write a report.",
    "model": "gemma4:latest",
    "api": { "baseUrl": "http://127.0.0.1:11434/v1" },
    "tools": { "enabled": ["fetch", "memory", "report"] }
  }
}
```

That is the minimal definition: without a `systemPrompt`, the agent gets Rota's
default instructions. The "Agent" template, by contrast, writes out **every** setting
with its default value — some thirty fields across four levels, which you can then
change without hunting through the schema.

Any OpenAI-compatible API will do — Ollama locally by default, but also vLLM, LM
Studio, or a remote service. The model must **know how to call tools**: without that
it will answer with prose and the loop will stop on the first turn. The transcript
says so, rather than letting it look like a crash.

The full run — reasoning, tool calls, results, final message — goes to the
execution's standard output. It reads back in the history like any other output, with
the same truncation and the same pagination.

#### The default instructions

A model knows nothing about the application calling it. Without a frame, it believes
it is having a conversation when it is in fact running a scheduled job nobody is
watching: it asks an empty screen for confirmation, proposes absolute paths that path
resolution refuses, and takes three paragraphs to say one line.

So Rota ships a default system prompt — who you are, which tools exist, how to
behave when nobody is there. It is inserted by reference:

```json
"systemPrompt": "${defaults.system_prompt}\n\n# This job\n\nYou supervise…"
```

That is **the field's default value**: a job that says nothing gets it as is. Putting
it first and writing after it extends it; not referencing it starts from scratch. The
text lives in [`packages/core/src/agent/defaults.js`](packages/core/src/agent/defaults.js) — a
reference rather than a copy, so that it follows the application instead of ageing
inside every job ever created.

What depends on the run is appended afterwards, whatever the job says: name, trigger,
sandboxed or not, path boundary, and **the keys of memory**. A job therefore cannot
end up without that information.

`${defaults.system_prompt}` also works in `prompt`, and in a message typed into the
chat tab.

#### Tools

Nothing is offered to the model that is not listed in `tools.enabled`. By default:
`fetch`, `file_read`, `file_list`, `todo`, `memory`, `report` — reading, network and
reporting. Writing, deleting and running commands are added explicitly.

| Tool | |
|---|---|
| `fetch` | HTTP calls, with an optional host allowlist |
| `exec` | a command and its arguments, **no shell** |
| `shell` | a command line handed to `sh -c` — pipes and redirections |
| `file_read`, `file_list`, `file_write`, `file_del` | access to the working directory, and to it alone |
| `todo_read`, `todo_add`, `todo_del`, `todo_clear` | in-memory task list, for the duration of the run |
| `memory_list`, `memory_read`, `memory_write`, `memory_del` | persistent memory between runs |
| `report` | markdown report window, **non-blocking** |
| `report_discord` | the same report, sent to the Discord channel configured in settings |
| `ask_user`, `confirm` | **blocking** questions, with a timeout |
| `run_job` | triggers another job, or its own after a delay |
| `sub_agent` | hands a task to a second agent of the same job, and waits for its answer |
| *MCP servers* | their tools join the above, prefixed with the connector name |
| `signal_change` | reports a real effect — this is what triggers `onChange` |

`shell` is the only place in the project where a string is handed to a shell. The
rule is lifted deliberately: the string is not assembled by Rota out of
uncontrolled values, it *is* the request. It stays out of the default list, and gets
sandboxed like everything else.

#### Reporting when nobody is there

`report` opens a window, which assumes someone is in front of the screen — yet a
scheduled job mostly runs when nobody is. `report_discord` sends the same report to a
channel, which waits to be read.

The destination is declared **once, under Settings → Discord**, not per job: a channel
usually serves a whole machine, and a job file gets shared — a webhook URL should not.
It accepts `${DISCORD_WEBHOOK}`, resolved like API headers.

Messages go out **under the job's name**: in a channel that receives several, knowing
which one is speaking beats a common label. A report longer than 2000 characters —
Discord's limit — is split on line boundaries, up to five messages; beyond that the
agent is told it was cut off.

With no webhook configured, the tool is simply **not offered to the model**, and the
transcript says so. Letting it fail at the moment the agent finally has something to
report would be the worst possible time to find out.

Unlike `fetch`, the sandbox does not remove it: the destination is the user's choice,
not the model's.

#### What memory puts in the context, and what it does not

The system prompt lists **the keys** of memory, with the date each was last
written. Not the values:

```text
# Memory

What you remember from previous executions, listed by key. These are labels —
yours, or the user's for the ones marked (global) […]. Read the ones that bear on
the request with memory_read — their values are not repeated here:

- me/conventions (global, updated 2026-07-02T08:11:00.000Z)
- cloud-apim/status (updated 2026-08-02T19:34:22.405Z)
```

Two reasons, and the second is the one that decided it.

**A value asserted in the instructions reads as an instruction.** An agent told
"you remember that cloud-apim answers HTTP 200" and then asked about a different
site will happily report on cloud-apim: the memory steers instead of informing. A
key says "you know something about this" and leaves the agent to go and get it —
which is a deliberate act, visible in the transcript.

**And that block is re-sent on every round trip.** `maxEntries` allows 100
entries of up to 4000 characters each; nothing bounds their sum. A job that
remembers diligently would eventually leave room for nothing else, twenty-five
times per run.

The cost is one tool call when the values actually matter — and `memory_read`
takes a key, so it is one entry rather than the lot.

### Global memory: what every agent knows

Who you are, which machine this is, what conventions your projects follow — none of
that belongs to one job, and copying it into each system prompt means it ages job by
job. **Settings → Global memory** holds it, in the same key/value shape, in
`memory/global.json`.

It is **merged at read time** with each job's own, and marked `(global)` in the key
list so the agent knows where it comes from. At equal keys **the job's memory wins**:
a job that has learnt something more precise on its own ground knows better than the
general setting, and must not be contradicted by it on every run.

Agents read it and cannot write it. `memory_write` always writes to the job's own
memory — writing the same key there is how a job overrides the general setting for
itself — and `memory_del` on a global key says so rather than reporting it missing,
which would send the agent off to re-record it under another name.

The file is yours to edit by hand like the rest; the settings panel says where it is.

#### A job that reschedules itself

A fixed interval can neither stop when there is nothing left to do, nor speed up when
the queue is full. `run_job` triggers a job by its identifier — including **its own**,
after a delay:

> Take the first open issue in the project and handle it. If any are left, trigger
> this job again in 60 seconds with `run_job`. Otherwise finish without triggering
> anything.

The job drains its queue one item at a time, at its own pace, and stops by itself
when the queue is empty. Scheduling is then only there to prime the pump.

Two modes: `wait: true` waits for the end and returns the status, the duration and an
excerpt of the output — the called job is part of the work. Without `wait`, the
caller hands over, and that is the rescheduling mode.

Four guardrails, because an agent that gets this wrong gets it wrong in a loop:

- **A job cannot wait on its own launch.** Either it refuses concurrent runs and the
  launch is ignored, or it allows them and you stack nested executions until the
  timeout. The error explains the right way to do it.
- **Five launches maximum per execution.** A loop is already bounded by
  `maxIterations`; a stack of launches would outlive the execution.
- **`tools.jobs.allow`** restricts which jobs can be triggered. Empty, all of them
  can be — including those that run system commands, which is an escalation path for
  an agent that does not have `shell`.
- **A deferred launch does not survive quitting Rota.** It is a `setTimeout` in
  the process, not a scheduled occurrence. The tool tells the agent so in its reply.

These executions appear in the history with the "by an agent" trigger, distinct from
a manual or scheduled run.

#### Delegating to a sub-agent

What `sub_agent` buys is **context**. An agent that has to read forty files to answer
one question spends its whole turn budget filling its own window with what it will
not need again. A sub-agent reads them in a window of its own and hands back the
three lines that mattered:

> Before deciding, use `sub_agent` to find out which of the notes changed this week.
> Give it the folder and ask for the list of names, nothing else.

It is **not** `run_job`. That one starts another job, with its own definition, its own
history entry and its own notifications. This one starts nothing the outside can see:
one execution, one history entry, one transcript — the sub-agent's turns are written
into it, indented under the call that started it.

It inherits the model, the temperature, the API, the tools, the working directory,
the container and the memory. It is the same job doing the same work, so what it
writes is what the caller finds, and what it memorises the job finds again next
week. What it does **not** inherit is the conversation: it sees the task and nothing
else, which is the whole point — state the task in full, and use `context` for what
it has no way of finding out.

Only its final message comes back. A sub-agent that concludes without saying
anything is reported as a failure rather than as an empty answer, because the second
is indistinguishable from a task that was never understood.

Three guardrails, under `tools.subagents`:

- **`maxDepth`**, 1 by default: a sub-agent cannot delegate in turn. That is what
  stops a job that misunderstood its task from growing a tree of them. `0` refuses
  the tool outright, and it is then not offered at all — a tool the model can only
  ever be refused costs a turn every time it tries.
- **`maxPerRun`**, 3 by default, counted **across the whole execution** and not per
  agent: three agents allowed three each is nine, and the number that matters is
  what the machine ends up running.
- **`deny`** lists tools a sub-agent does not inherit. This is where you hand out a
  reader that cannot write, or keep `run_job` for yourself.

`maxIterations` under the same block gives a sub-agent a shorter turn budget than
the job's, which is usually what a task meant to be narrow deserves.

#### Connecting MCP servers

The tools above are Rota's. `runner.agent.mcp` adds others, from
[MCP](https://modelcontextprotocol.io) servers, in both transports of the
specification:

```json
"mcp": [
  {
    "name": "fs",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/notes"]
  },
  {
    "name": "api",
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer ${API_TOKEN}" }
  }
]
```

Their tools become ordinary agent tools: same transcript, same iteration counter,
same error handling.

- **Names are prefixed** with the connector's — `fs__read_file`. Two servers will
  happily both expose a `search`, and the model API has a single flat namespace; the
  prefix also says where the call is going.
- **`tools.allow`** keeps only the named tools, under their original names. A server
  exposing sixty of them does not have to put all sixty in the context.
- **A connector that fails to start does not fail the execution.** It is reported in
  the transcript, with the tail of its standard error — which is where a server says
  "module not found" or "token rejected" — and the others carry on.
- **Values accept `${VARIABLE}`**, in HTTP headers as in environment variables,
  resolved like the model API's.

Two limits worth knowing:

- **A stdio server is started on the host**, never inside the sandbox container. That
  is a boundary, not a hole: the user declares their servers, just as they declare
  their model's address. The sandbox contains what the agent decides, not what was
  put at its disposal.
- **No resources, no prompts, no sampling.** Only tools are used. Rota advertises
  no client capability at initialization either: claiming otherwise would break a
  server that relied on it.

The client is hand-written — two transports, a handshake, a paginated inventory — for
the usual reason: the specification is small, and an SDK would bring what this project
has no use for. A complete test server lives in
[`test/mcp-stdio.test.js`](test/mcp-stdio.test.js) and exercises the real path,
process included.

#### The working directory is a jail

`runner.workingDirectory` serves twice: it is the current directory of commands and
the **only** place the file tools may go. A path leading out of it is refused,
including through a symbolic link — the path is resolved to its real ancestor before
being compared.

Undeclared, each agent gets `agents/<id>/` in the configuration directory, created on
first run. An agent without a boundary would be an agent without file tools.

#### Blocking questions have a timeout

A scheduled job may ask its question at three in the morning. `ask_user` and `confirm`
therefore wait for `tools.interaction.timeoutSeconds` — 120 s by default — then hand
back: the agent learns it got no answer, and carries on. An unanswered `confirm`
counts as a refusal.

#### Secrets do not live in the job

The values of `api.headers` accept `${VARIABLE}` references, resolved at run time from
the environment, completed by `~/.config/rota/.env`:

```json
"api": { "headers": { "Authorization": "Bearer ${OPENAI_API_KEY}" } }
```

```text
# ~/.config/rota/.env
OPENAI_API_KEY=sk-…
```

That file is not a luxury: launched from the Finder, a macOS application inherits no
shell environment. A missing variable fails the execution **before the first network
call**, naming it — rather than sending `Bearer ${OPENAI_API_KEY}` literally and
letting the server answer 401.

#### Working out a prompt: the Chat tab

A scheduled prompt you have never tried goes wrong the first time, and you find out
the next morning in the history. The **Chat** tab of the editor opens a conversation
with the agent, right next to the prompt you are writing: the input starts from the
job's prompt, and can be edited.

This is **not** a run of the job: nothing is written to the history, no notification
goes out, the scheduler knows nothing about it. What is shared is everything else —
model, tools, working directory, sandbox, and **memory**. What you teach the agent in
conversation, it finds again on its next scheduled run.

The answer streams in, tool calls scroll past with their results, and a "Stop" button
interrupts the current turn. The conversation lives in the main process: leaving the
tab, or even the editor, does not interrupt it — coming back finds it as you left it.

**A job has as many conversations as you want**, listed in a sidebar and deletable
one at a time. They share the job's working directory and memory — it is the same
agent — but not their thread: changing subject should not mean erasing the previous
one, nor dragging it along in the context.

Each lives in its own file, under `conversations/<job>/`, and therefore **survives
quitting the application**. What comes back when one resumes is the conversation
itself — your messages and its answers — and not the tool traffic: the stored trail
is written to be read, and abbreviates arguments and results. Replaying tool calls
faithfully would mean keeping a second record in step with the first. The instructions
are rebuilt rather than restored, since memory, trigger and available tools may have
changed since.

What has to outlive the thread still goes through `memory_write`.

#### What an agent sees of the sandbox

`execution.sandbox.enabled` applies to agent jobs like any other, with one difference:
the container stays **open for the duration of the run**, and every command enters it
through `docker exec`. An agent chains dozens of commands that must see one another;
each in its own disposable container, it would start from scratch every time.

Two consequences are worth stating, because they surprise people:

- **`network: false` cuts the container's network, not the calls to the model.** The
  loop runs in the main process: it keeps talking to Ollama, or the agent could do
  nothing at all. The isolation covers its tools, not its reasoning. In exchange, the
  `fetch` tool is **withdrawn** in that case — it would otherwise bypass exactly the
  cut you just asked for.
- **The image must provide `sleep`**, on top of whatever the agent's commands need.
  That is what keeps the container open.

### Chaining jobs: `workflow`

Some work is a sequence: build, then test, then publish. `run_job` can express it —
an agent triggering the next one — but it puts a language model in charge of a chain
that has no decision in it. The `workflow` type says the sequence outright.

```json
"runner": {
  "type": "workflow",
  "workflow": {
    "steps": [
      { "name": "build", "runner": { "type": "bun-inline", "code": "…" } },
      { "name": "tests", "job": "run-tests" },
      { "name": "publish", "job": "publish", "continueOnError": true }
    ]
  }
}
```

A step **names a job** or **carries a runner**, never both and never neither. A named
job runs with its own definition — runner, environment, timeout, sandbox. A runner
written on the spot has exactly the fields a job's own runner has, minus the workflow
type: a workflow does not nest, and a step that needs to chain others names a workflow
job, which already carries its list.

Steps run in the order written, one at a time. **The first failure stops the chain**,
unless that step says `continueOnError` — a chain whose second link broke rarely has
anything useful to do with the third. A step whose job is already running is *skipped*
rather than failed: what it wanted is happening.

**The whole chain is one execution.** One history entry, one output, one notification.
What each step wrote is folded into that output under its own heading:

```text
Workflow "Deploy" — 3 steps

── step 1/3 · build ──
2 files compiled
✓ succeeded in 2.1 s

── step 2/3 · tests (job "run-tests")──
✗ failed in 41.0 s — The script exited with code 1

── result ──
2 of 3 steps ran, stopped at step 2.
```

The referenced jobs write **no history entry of their own and send no notification**:
nobody scheduled them, and a line in their history would claim otherwise. They stay
visible while they run, though — stopping the workflow stops the step it is waiting
on, down to the process.

Two guards worth knowing. A step naming a job that does not exist stops the chain
saying so, rather than being passed over in silence. And a workflow cannot name
itself; the validation refuses it before the first run rather than at the bottom of a
stack.

Steps are edited in the **JSON** tab: a step carries a whole runner, which no
two-column form renders honestly.

### Isolating a job: the Docker sandbox

A job running unattended every five minutes has access to everything its user is
allowed to touch. For code you do not re-read on every change, or that came from
elsewhere, `sandbox` runs it in a disposable container:

```json
"execution": {
  "sandbox": { "enabled": true }
}
```

The rest of the execution path does not change — the command is simply wrapped in a
`docker run --rm`, with the same `spawn`, the same argument array, the same timeout,
the same output collection.

**What the container sees of the disk:** the script, mounted alone and read-only, and
`runner.workingDirectory` if declared. Nothing else.

**What it does not see:** the SSH agent, the keychain, `HOME`, the host's `PATH`, the
rest of the filesystem. Only `LANG`, `LC_ALL`, `TZ`, the two correlation variables and
those declared by the job are passed through. A sandboxed job therefore **cannot**
push to a remote over SSH — that is the price of isolation, not an oversight.

The network is **off by default**: without that, "sandbox" would not mean much.

| Setting | Default | |
|---|---|---|
| `enabled` | `false` | |
| `image` | `oven/bun:1` | must provide `bun`, or `sh`/`bash` for a shell job |
| `network` | `false` | `true` restores the network |
| `mountWorkingDirectory` | `true` | `false`: no write access to the host disk at all |

A timeout does two things instead of one: killing the `docker` client would not be
enough, since the container runs in the daemon, outside the process group. Every
container is therefore named after its execution, and a `docker kill` follows the
`SIGKILL`.

The `docker` binary is resolved like Bun's — `PATH`, then the usual locations of
Docker Desktop, OrbStack and Rancher — or forced through `runners.dockerPath` in
`config.json`.

### Notifying only when something happened

A job that runs every five minutes does nothing most of the time. `"onSuccess": true`
would produce 288 notifications a day, almost all of them saying "nothing to do" —
which mostly teaches you to ignore them.

A script can therefore report that it actually had an effect, by writing a line to
standard output starting with the marker:

```text
::rota:changed::
::rota:changed:: 3 files pushed
```

The optional text that follows becomes the notification's title. With
`"onChange": true`, that is the only situation in which a notification is sent.

```json
"notifications": { "onSuccess": false, "onChange": true, "onError": true }
```

`onSuccess` and `onChange` can coexist: `onChange` wins when an effect is reported,
and there are never two notifications for one execution. The marker stays visible in
the history, and the executions concerned carry a badge there.

### Reporting from a script

An agent has `report` and `report_discord`. A script has neither, and yet a nightly
sync has as much to say as an agent does. Two more markers give it the same reach:

```text
::rota:report:: Nightly sync
## 3 files pushed
- notes.md
::rota:end::
```

`::rota:report::` opens the report window; `::rota:report_discord::` sends
to the channel instead. What follows the marker is the title — optional, the job's
name otherwise — and everything up to `::rota:end::` is the markdown body. A
block left open by a script that died in the middle is delivered anyway: having
written the report is enough, and swallowing it would lose precisely what was meant
to be said.

Reports follow the same rule as the change marker in a workflow: a step's output is
copied verbatim into the trail, so a report written by a step is delivered once, by
the workflow.

Like `report_discord`, the destination comes from the settings and never from the
script — which is what lets these work inside the sandbox, where `fetch` is out of
reach. A script says what it has to say; Rota decides where that goes.

### Jobs that need an unlocked session

> **Read differently on each system.** macOS publishes the state in the session
> dictionary, which `ioreg` renders as text. Linux has `logind`, which keeps a
> `LockedHint` per session — set by GNOME's and KDE's lockers, and by anything else
> that bothers to tell logind. A desktop whose locker does not report, or a daemon
> with no graphical session at all, reads as unlocked and the job runs: a machine
> with no screen has no screen to lock.

Locking your screen does not put the Mac to sleep: timers keep running. But
everything that assumes a user is present becomes unavailable, starting with the
keychain. A job pushing to a remote over SSH finds out the hard way: if the key is not
loaded into `ssh-agent`, `ssh` decrypts it on every run by reading its passphrase from
the keychain, and fails for as long as the screen is locked — with a message that
blames the server:

```text
git@github.com: Permission denied (publickey).
```

`requiresUnlockedSession` treats that window like sleep: nothing is started while the
screen is locked, and unlocking replays exactly the wake logic — single catch-up, or a
skip if `catchUpOnWake` is disabled.

```json
"execution": { "requiresUnlockedSession": true, "catchUpOnWake": true }
```

Other jobs are unaffected: they keep running with the screen locked. An execution
already underway when the screen locks is never interrupted, and a manual run
overrides the flag.

This is a workaround, not a fix: the cause is a key missing from the agent.
`ssh-add --apple-use-keychain ~/.ssh/id_rsa` loads it, and the agent survives screen
locking — but **not logging out**: after a restart the key has to be loaded again, by
hand or by a LaunchAgent. So the flag keeps its usefulness even with the key loaded,
if only to cover that window.

### Notifications and macOS

Started through `npm start`, the application presents itself to the system under the
`com.github.Electron` bundle, which macOS generally does not allow to post
notifications: they are silently dropped. The packaged application has its own bundle
identifier and behaves normally. This is worth knowing before spending an afternoon
looking for a bug in the notification code.

The logo is varied by outcome: **green** on success, **red** on failure, plain on
start. The red icon also replaces the chevron with an exclamation mark, like the
tray's: colour alone is a fragile signal at that size. The three PNGs are produced by
`npm run icons` into `assets/notification/`.

File and network triggers, dependencies between jobs and keychain-stored secrets
remain future work.

## Driving Rota over HTTP

A local HTTP server, off by default, that answers two very different needs — hence
**three flags that stack on purpose**, under Settings → HTTP.

| Flag | What it opens |
|---|---|
| Run the HTTP server | the port, and nothing else |
| Expose the API | `/api/…` — list, run, stop, enable, history, logs, chat |
| Expose the webhook endpoint | `POST /webhook/<id>`, and only for jobs declaring it |

Separating them is the point: a webhook address can be handed to a third-party
service without handing it the rest.

### The token is the whole lock

**The server does not start without a token**, loopback included. An open port with
no password is reachable by anything running on the machine — including a web page in
an open tab, which can send it a request. The Settings panel generates one; it is
kept in `config.json` and accepts `${VARIABLE}` like the rest, so a shared
configuration file need not carry it.

```bash
curl -X POST -H "Authorization: Bearer tt_…" \
     http://127.0.0.1:47823/api/jobs/sync-notes/run
```

`X-Rota-Token` is accepted too: some webhook senders do not let you choose the
authorization header, and refusing their only option would be refusing the webhook.
Comparison is constant-time — `===` on a string stops at the first differing
character, which is enough to guess a token byte by byte.

The default port, **47823**, is nothing well-known: a common port would already be
taken, or worse, would answer in place of what you meant to reach.

**The listening address is a setting.** `127.0.0.1` keeps the server on this machine;
`0.0.0.0` makes it reachable from the network, which a webhook coming from outside
needs. Past loopback the token is the only thing between the network and a machine
where a job runs shell commands — the settings panel says so, in those words, as soon
as the address is not loopback.

### The API

Routes are versioned: `/api/v1/...`. The unprefixed `/api/...` stays an alias for
the same handlers, so anything written against an earlier build keeps working.

`GET /api/v1/events` is a server-sent event stream — `state`, `started`, `output`,
`finished`, `chat`, and `ui-request` when an agent has a question and needs whoever
is attached to answer it. It carries no history: you see what happens next, not what
you missed. `rotactl events` is a reader for it.

| | |
|---|---|
| `GET /api/status` | scheduler, running executions, job count |
| `GET /api/jobs` | the jobs, their triggers, their next and last runs |
| `GET /api/jobs/<id>` | the same, for one |
| `POST /api/jobs/<id>/run` \| `/stop` | start, stop |
| `POST /api/jobs/<id>/enable` \| `/disable` | turn triggers on or off |
| `GET /api/jobs/<id>/history?limit=n` | the last n executions |
| `GET /api/jobs/<id>/logs` | the running execution's output, otherwise the last one's |
| `GET /api/openapi.json` | the description of everything here, webhook included |
| `GET /api/docs` | a page to read it in |
| `POST /api/jobs/<id>/chat` | `{"message": "…"}` → the agent's answer |
| `POST /api/scheduler/pause` \| `/resume` | suspend the scheduler |

**Editing stays local**, as it does over Discord, and for the same reason. What comes
back describes jobs without their code or their prompts: an API that listed the
contents of every script would be a second way to read the disk.

`GET /api/openapi.json` describes all of the above, the webhook included — that is
the address you hand to someone else, so it is the one that most needs describing.
`GET /api/docs` is a page to read it in. The page opens without the token, because a
browser cannot set a header by following a link and the page carries nothing the open
port does not already reveal; it asks for the token itself and keeps it for the visit
only. The description stays behind the token like everything else, so that the API
does not double as a directory.

It is written by hand, in one place, and checked from both ends: a test calls every
operation it describes and refuses a 404, then reads back the actions the router
handles and refuses any that the description ignores. A description that ages without
anyone noticing is worse than none — it sends people calling addresses that have gone.

An API that is off answers **404, not 403** — it is not there. A wrong token gets the
same reply as a job that does not exist, so that the API does not double as a
directory for whoever is probing it.

`chat` behaves like Discord's: a separate thread from the editor's, the same working
directory and memory, no blocking questions since nobody is watching, and one turn at
a time — a second message while the first is running is refused rather than queued.

### The webhook

```bash
curl -X POST -H "Authorization: Bearer tt_…" \
     http://127.0.0.1:47823/webhook/deploy
```

**Only a job that declares a webhook trigger can be started this way**, and that is
what distinguishes the endpoint from the API: an address given to a third party
starts what you said it could start, and nothing else. A job without that trigger
answers 404, exactly like one that does not exist.

A trigger may carry a **token of its own** — `${VARIABLE}` accepted — which then
replaces the server's for that job. That is how an address is handed out that starts
one job and opens nothing else. A variable that cannot be resolved refuses the call
rather than falling back to comparing against the literal `${…}`, which anyone
reading the job file could guess.

A disabled job does not answer either. Disabling means "do not start on your own",
and an HTTP call is exactly that.

## Driving Rota from Discord

A webhook can only write. To receive commands you need a **bot**, and a Gateway
connection — a WebSocket Rota keeps open.

```text
@Rota list
@Rota run sync-notes
@Rota logs sync-notes
```

| | |
|---|---|
| `list` | the jobs, their state, their last result |
| `status` | scheduler, running executions, next three occurrences |
| `run <id>` / `stop <id>` | start, stop |
| `enable <id>` / `disable <id>` | turn scheduling on or off |
| `pause` / `resume` | suspend the scheduler |
| `history <id> [n]` | the last n executions |
| `logs <id>` | the output of the running execution, otherwise of the last one |
| `chat <id> <message>` | talk to an agent job — off by default, see below |
| *a job's own keyword* | starts it, if it declares a `discord` trigger |

A job that declares `{ "type": "discord", "keyword": "deploy" }` answers to
`@Rota deploy`. Built-in commands are read first, so no definition can seize
`pause` — and `run <id>` keeps working for every job, keyword or not. `help` lists
the keywords currently declared: they come from job files, and an aid that omitted
them would leave their only documentation in a JSON file.

**Editing stays local**, deliberately: a JSON definition pasted into a channel reads
badly and corrects even worse.

### What this opens, and what it does not

**The channel is the only access control.** Anyone who can write in it can start a
job — and a job can run system commands or an agent. That channel is access to the
machine: treat it as such. The [HTTP server](#driving-rota-over-http) makes the
same trade with a token instead of a channel.

Four consequences, accepted as such:

- **Control requires an explicit flag** on top of the token, in settings. Pasting a
  token is not enough to open a remote control.
- **Chatting requires a second flag.** See below: it is not the same power as the
  rest.
- **Direct messages are ignored**, without a reply: they would bypass the only lock
  there is, and answering would teach something to whoever is probing the bot.
- **Only mentions count.** The bot does not read the channel, it reads what is
  addressed to it.

### Talking to an agent from the channel

`chat <id> <message>` sends what you wrote to the agent of a job and posts its
answer back.

```text
@Rota chat watch-services anything unusual since yesterday?
```

**It has a flag of its own, off by default**, and here is why. `run` executes the
prompt the job carries — written, reviewed, versioned. `chat` lets whoever is in the
channel compose the prompt, for an agent that may hold `exec`, `shell` or
`file_write`. Every other command triggers work that was decided in advance; this one
decides the work. The same reasoning that put control behind a flag on top of the
token applies again, one level further.

Three things that follow from nobody being in front of the screen:

- **It is a separate conversation from the editor's Chat tab.** Same job, same
  working directory, same memory — but its own thread. Two people writing into one
  context would interleave badly, and the two threads do not need the same tools.
- **`ask_user` and `confirm` are not offered** for that conversation. They would
  block for their timeout and resolve as a refusal; withdrawing them is stated in the
  transcript, like every other withdrawal. `report` stays: mirrored to Discord, it
  gets read.
- **A turn takes as long as it takes.** The bot acknowledges immediately — a plain
  message has no deadline, unlike a slash command — then posts the final answer,
  split across up to five messages if needed.

A conversation holds one turn at a time: a second message while the first is still
running is refused rather than queued.

### Installing the bot

1. Create an application and a bot on
   [discord.com/developers](https://discord.com/developers/applications), copy the
   token.
2. Invite the bot to the server, with the "Read Messages" and "Send Messages"
   permissions in the intended channel.
3. Get the channel identifier: with developer mode enabled, right-click the channel,
   "Copy ID".
4. Fill both in under **Settings → Discord**, and tick "Control Rota from
   Discord" — plus "Allow chatting with agents from Discord" if you want `chat`.

**No privileged intent is required.** `MESSAGE_CONTENT` is one, and is not needed:
Discord delivers the content of a message that mentions the bot.

### What the bridge adds on the way out

A bot can write too. It therefore serves as the destination for `report_discord` when
no webhook is declared — a webhook stays simpler for anyone who only wants reports,
and wins when present.

With **"Also publish agent reports to Discord"** — on by default — an agent's
`report` tool opens its window *and* publishes. A window assumes someone in front of the
screen, which a scheduled job almost never has. A failed mirror does not take the
report down with it: it is displayed, and the agent learns that publishing failed.

### What is hand-written, and why

The Gateway protocol comes down to a handful of opcodes, where a library would bring
hundreds of kilobytes for voice, entity caching and component builders. Same reasoning
as for the cron parser.

Three things separate a bot that lasts the week from one that drops out overnight, and
each has its test: the **heartbeat**, whose missing acknowledgement reveals a dead
connection the system believes is open; **session resumption**, which reattaches after
a cut instead of replaying everything; and **refusing to retry a fatal close** — an
invalid token replayed every five seconds ends in an IP ban.

## Worked example: keeping a Git repository in sync

[`examples/scripts/sync-obsidian.js`](examples/scripts/sync-obsidian.js) keeps a
Git-backed notes vault in sync, silently, and exits with a distinct code per failure
cause so that the history stays readable:

| Code | Cause |
|---|---|
| 0 | synced, or nothing to do |
| 10 | the directory is not a Git repository |
| 11 | a rebase or a merge is already in progress |
| 12 | conflict during the rebase — aborted cleanly, never a half-rebased state |
| 13 | remote unreachable |
| 14 | push rejected |
| 15 | authentication refused by the remote |

The `--dry-run` option runs only the read commands and describes what would be done,
without committing or pushing anything — worth running once against your real
repository before letting the job loose:

```bash
cd ~/notes
bun run ~/.config/rota/scripts/sync-obsidian.js --dry-run
```

### Installing the job

The files under `examples/` are templates: nothing installs them automatically.
Copying the script into the configuration directory makes it independent of this
repository:

```bash
CONF=~/.config/rota
mkdir -p "$CONF/scripts"
cp examples/scripts/sync-obsidian.js "$CONF/scripts/"
cp examples/jobs/obsidian-sync.json "$CONF/jobs/"
# then fix "script" and "workingDirectory" in the copied file
```

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
  session](#jobs-that-need-an-unlocked-session).
- **A system tray, which GNOME does not have.** This is the one that is not ours.
  See the note at the top.

### Running it without a window

The application embeds the engine by default: one thing to install, one thing to
quit. `rotad` is the same engine with nobody attached — for a machine you reach
over SSH, or a scheduler that should keep running when you close the window.

```bash
rotad run --config-dir ~/.config/rota
rotad service launchd > ~/Library/LaunchAgents/com.rota.daemon.plist
rotad service systemd > ~/.config/systemd/user/rotad.service
```

`service` **prints** the unit file and installs nothing. Telling an init system what
to run at every login is your decision, and the command says which two lines make it
so.

**One engine per configuration directory.** Two schedulers on one directory overwrite
each other's `state.json`, fire every trigger twice and interleave two runs into one
JSONL — with nothing to warn you but a job that ran twice at three in the morning.
So the first engine to open a directory takes a lock on it, and the second refuses by
name and by process id. This covers the application too: it is the same engine.

A lock file left behind by a process that was killed outright is treated as stale —
the process id in it answers to nobody — so a machine that lost power does not
refuse to start ever again.

### Driving it from a terminal

`rotactl` reads the configuration directory directly for anything it can answer
from the files, and goes through the API for anything that needs a running
scheduler. The split is in the help, per command, because it decides whether the
answer needs anything to be running at all.

```bash
rotactl jobs                 # every job, its triggers, its next run, its last result
rotactl validate             # what would refuse to load, and why — exit 1 if anything would
rotactl history sync-notes   # past executions, newest first
rotactl logs sync-notes      # the output of the last one, externalised parts included

rotactl run sync-notes       # start it now
rotactl status               # what the running instance is doing
rotactl events               # follow what happens, as it happens
```

The token comes from `config.json` with `${VARIABLE}` resolved, so there is no second
copy of it to keep; `ROTA_TOKEN` and `--token` override, in that order.

`--remote` makes the reading commands ask the running engine instead of the files.
The two disagreeing is itself worth knowing: it means the scheduler has not picked up
an edit, or is holding a job back.

### Driving the window from elsewhere

The application has a second mode. Instead of building the engine in this process,
it connects to a `rotad` — on this machine or another:

```json
{
  "engine": { "mode": "remote", "url": "http://127.0.0.1:47823", "token": "${ROTA_TOKEN}" }
}
```

The renderer is not told which it got, and there is nothing for it to notice: the
same snapshot arrives, on the same channels. What the window adds is a screen, which
is a thing a daemon does not have — so an agent running under `rotad` that wants
to ask a question sends it over the event stream, and the attached window opens the
same panel it would have opened locally.

**An interface is attached for exactly as long as its connection lives.** Not a
registration, not a session: the connection is the lease. With nobody attached, the
two tools that wait for an answer are not offered to the agent at all, and its
transcript says which were withdrawn and why — better than letting it ask and
discover three seconds later that nobody was there.

## Security

A daemon that runs arbitrary shell behind a bearer token deserves to have its
defaults stated in public rather than discovered.

### What is off until you turn it on

Three flags, and they stack. Nothing here is on in a fresh installation:

| Setting | Default | What turning it on means |
|---|---|---|
| `http.enabled` | `false` | opens a port. Nothing is served yet |
| `http.apiEnabled` | `false` | that port drives everything: run, stop, pause, edit, delete |
| `http.webhookEnabled` | `false` | that port can start jobs that declare a webhook trigger — and only those |
| `integrations.discordControlEnabled` | `false` | a Discord channel can drive the same things the API can |
| `engine.mode` | `embedded` | the scheduler runs in the application; nothing is contacted over a network |

The default port, 47823, is nothing well known: a common one would be taken, or
worse, would answer in place of what you meant to reach. The server binds
`127.0.0.1` unless told otherwise, and **refuses to start without a token at all**,
loopback included — a port with no password is driveable by any local process, and
by any web page open in a tab.

### What an attacker gets, and what stops them

- **Someone with the token** can do everything the interface can: run any job, edit
  any definition, delete any history. There is no second tier. Treat it as a
  password to the machine, because with a `shell` runner that is what it is. It is
  compared in constant time; `${VARIABLE}` keeps it out of `config.json` when you
  would rather it lived in `.env`.
- **Someone on the network, without the token**, gets a 401 and nothing else — the
  API answers like an address that does not exist when it is switched off, rather
  than admitting there is something there to unlock.
- **A web page in a browser** cannot read the answers: nothing here sends CORS
  headers, and every response is `no-store`.
- **A local process** is the case the token cannot help with, and neither can
  anything else on a single-user machine. This is a personal scheduler; it does not
  pretend to defend against code you already ran.

### Where the process boundaries are

- `nodeIntegration` off, `contextIsolation` and `sandbox` on, strict CSP
- IPC channels enumerated explicitly, never built dynamically
- Job identifiers re-validated in the main process, and again in the API — they
  compose file paths
- `spawn` always receives a command and an argument array, never a shell string;
  `shell: true` is used nowhere. **One accepted exception**: an agent job's `shell`
  tool hands a command line to `sh -c`. The rule protects against strings assembled
  from uncontrolled values; here the string *is* the request. The tool stays out of
  the default list, and `exec` covers the rest without a shell
- An agent's file access is bounded to its working directory, resolved to its real
  ancestor: a symbolic link does not get you out of the perimeter
- Child process environment is an allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`,
  `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SSH_AUTH_SOCK`, plus whatever the job declares
- The code of `bun-inline` jobs is written to a file and then run as an ordinary
  script: it goes through neither a shell nor the command line
- Deleting a job over HTTP has no modal sheet to hide behind, so the caller repeats
  the identifier as `?confirm=<id>`. The history goes with it, and there is no undo

`SSH_AUTH_SOCK` is indispensable to Git-over-SSH jobs: without it, `git push` waits
for a passphrase that will never come.

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
([`.github/workflows/release.yml`](.github/workflows/release.yml)):

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

## Scope and non-goals

Rota schedules local jobs on one machine, for one user. It deliberately does not
try to be:

- **a distributed scheduler** — no remote workers, no cluster, no coordination
  protocol;
- **a multi-user service** — there is no authentication, and the Discord bridge is
  gated by channel access alone;
- **a CI system** — no build matrix, no artifacts, no pipeline model beyond one job
  triggering another;
- **a cloud product** — nothing leaves the machine except what a job explicitly
  sends.

Where this document calls something a limitation, it is a decision rather than an
oversight — the reasoning is given on the spot.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. `npm test` must pass.
2. New behaviour that can regress silently comes with a test.
3. Comments explain *why*, not *what* — the codebase is consistent about this, and
   the surrounding style is the reference.

On language: everything is in English — the user interface, this document, what the
application prints, and the code comments. The comments were French until the
codebase grew past the point where that was a reasonable thing to ask of a
contributor.

## License

MIT — see [LICENSE](LICENSE).
