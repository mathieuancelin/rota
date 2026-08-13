# Writing a job

One file per job in `jobs/`, validated against a schema the editor knows. This is
the reference: what starts a job, the five kinds of thing it can run, what an agent
gets to work with, and when you hear about it.

[← Rota](../README.md) · **Writing a job** · [Running it](operating.md) · [Inside it](internals.md)

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

Full schema: [`packages/core/schemas/job.schema.json`](../packages/core/schemas/job.schema.json).
Ready-to-copy examples: [`examples/jobs/`](../examples/jobs/).

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
  { "type": "discord", "keyword": "deploy" },
  { "type": "power", "event": "unlock" }
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

#### `power`: when the machine comes back

```json
{ "type": "power", "event": "unlock" }
```

`wake` is the machine coming out of sleep. On a Mac that happens **at the lock
screen**, before anybody has typed anything — which is why `unlock` exists
separately, and why it is the one to use when the job needs the keychain, the
network as you left it, or you. One lid-opening produces a wake and then an
unlock; a `wake` job runs once, not twice.

A job that asks for `wake` but declares `requiresUnlockedSession` is not dropped:
it is held and started at the unlock, because on a laptop the screen is nearly
always locked at the moment of waking, and silently never running is the wrong
answer to a condition that normal.

Two events, and only two. Locking and going to sleep are deliberately absent: a
job started as the machine leaves is a job that gets killed halfway through.

Both work the same under `rotad`, which has no `powerMonitor` — it infers the
wake from the gap between two timer ticks and reads the screen lock from
`logind`. Same trigger, same behaviour, whichever is running the engine.

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
`POST /webhook/<id>` — see [Driving Rota over HTTP](operating.md#driving-rota-over-http).
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
text lives in [`packages/core/src/agent/defaults.js`](../packages/core/src/agent/defaults.js) — a
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
[`test/mcp-stdio.test.js`](../packages/core/test/mcp-stdio.test.js) and exercises the real path,
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

## Worked example: keeping a Git repository in sync

[`examples/scripts/sync-obsidian.js`](../examples/scripts/sync-obsidian.js) keeps a
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
