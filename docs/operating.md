# Running it

Where the files live, how to run the scheduler without a window, and the three ways
in from outside: a terminal, an HTTP API, a Discord channel. Ends with what the
security defaults are, stated rather than left to be discovered.

[← Rota](../README.md) · [Writing a job](jobs.md) · **Running it** · [Inside it](internals.md)

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

## Running it without a window

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

## Driving it from a terminal

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

## Driving the window from elsewhere

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
