'use strict'

// What the CLI says about itself.
//
// One table, two readers: the usage list and `<command> --help` are rendered
// from the same entries, so a command cannot be documented in one and forgotten
// in the other — nor claim an option it does not read.
//
// That last point is why the options a command accepts are declared rather than
// written out. `--remote` is honoured by three commands and ignored by the
// rest; a help that offered it everywhere would be worse than none, because it
// would be believed.

/**
 * Where a command's answer comes from. It is the first thing to know about any
 * of them, and it decides which options bear on it.
 */
const SOURCE = {
  // Off the files. Works with nothing running, which is when you most want it.
  DISK: 'disk',
  // Through the API. Needs a running engine, an address and a token.
  API: 'api',
  // Writes the job file. A running engine picks the change up on its own.
  FILE: 'file',
}

const COMMANDS = [
  {
    name: 'jobs',
    argument: '',
    summary: 'every job, its triggers, its next run, its last result',
    detail:
      'The next run is computed here, from the definitions — so it is what the ' +
      'files say will happen, not what a scheduler has armed. --remote asks the ' +
      'running engine what it actually believes; the two differing is itself ' +
      'worth knowing.',
    source: SOURCE.DISK,
    remote: true,
  },
  {
    name: 'show',
    argument: '<id>',
    summary: 'one job in full',
    detail:
      'The definition as it is on disk, unvalidated: a job the engine would ' +
      'refuse is exactly the one you want to look at.',
    source: SOURCE.DISK,
  },
  {
    name: 'next',
    argument: '',
    summary: 'the next occurrences, soonest first',
    detail:
      'Only enabled jobs with an occurrence to come. A job with no timed trigger ' +
      'never appears here, however often it runs.',
    source: SOURCE.DISK,
    remote: true,
  },
  {
    name: 'history',
    argument: '<id>',
    summary: 'past executions, newest first',
    detail: 'Read straight from history/<id>.jsonl, which is the whole record.',
    source: SOURCE.DISK,
    limit: '20',
  },
  {
    name: 'logs',
    argument: '<id>',
    summary: 'the output of the last execution, externalised parts included',
    detail:
      'Output too large for the history lives beside it in a file; this reads ' +
      'both and shows one thing.',
    source: SOURCE.DISK,
  },
  {
    name: 'validate',
    argument: '[id]',
    summary: 'what would refuse to load, and why',
    detail:
      'Every job file, or one of them. The exit status is 1 when something is ' +
      'wrong, so this belongs in whatever runs before you walk away.',
    source: SOURCE.DISK,
  },
  {
    name: 'status',
    argument: '',
    summary: 'what the running instance is doing',
    detail: 'Paused or not, screen locked or not, what is running right now.',
    source: SOURCE.API,
  },
  {
    name: 'work',
    argument: '<verb> [id]',
    arity: 2,
    summary: 'the durable queues: list, add, show, retry, cancel, rm',
    detail:
      'A job with a `work` trigger takes its items one at a time until there are ' +
      'none left, and nothing is asked of a model to discover an empty queue.\n\n' +
      '  work list [job]        what is queued, oldest first\n' +
      '  work add <job>         queue one, with --input and --id\n' +
      '  work show <id>         one item in full, input and result included\n' +
      '  work retry <id>        put a finished item back, attempts reset\n' +
      '  work cancel <id>       give up on it without running it\n' +
      '  work rm <id>           remove it outright\n\n' +
      '--input takes JSON: a reference to the work, not the work itself. --id ' +
      'names the item, which is what makes queueing idempotent — replaying the ' +
      'same event is then refused instead of queueing it twice.',
    source: SOURCE.API,
  },
  {
    name: 'run',
    argument: '<id>',
    summary: 'start a job now — agent jobs included',
    detail:
      'Returns as soon as the execution is accepted, not when it ends. Follow it ' +
      'with `events`, or read `history` afterwards.',
    source: SOURCE.API,
  },
  {
    name: 'stop',
    argument: '<id>',
    summary: 'stop its running executions',
    detail:
      'SIGTERM to the process group, then SIGKILL if it is still there. A job ' +
      'that was not running is not an error.',
    source: SOURCE.API,
  },
  {
    name: 'pause',
    argument: '',
    summary: 'suspend the scheduler',
    detail:
      'Nothing new starts. Executions already under way are left alone: stopping ' +
      'them midway would do more damage than letting them finish.',
    source: SOURCE.API,
  },
  {
    name: 'resume',
    argument: '',
    summary: 'let the scheduler fire again',
    detail: 'What was missed while paused follows the same catch-up rule as a wake-up.',
    source: SOURCE.API,
  },
  {
    name: 'events',
    argument: '',
    summary: 'follow what happens, as it happens',
    detail:
      'The engine’s event stream, printed one line per event until you stop it. ' +
      'It carries no history: you see what happens next, not what you missed.',
    source: SOURCE.API,
  },
  {
    name: 'enable',
    argument: '<id>',
    summary: 'let a job start on its own again',
    detail: 'Writes the file. A running engine notices within the second.',
    source: SOURCE.FILE,
  },
  {
    name: 'disable',
    argument: '<id>',
    summary: 'stop a job starting on its own',
    detail:
      'It can still be started by hand with `run`: disabled means "not on its ' +
      'own", not "not at all".',
    source: SOURCE.FILE,
  },
]

const byName = new Map(COMMANDS.map((command) => [command.name, command]))

const GLOBAL_OPTIONS = [
  ['--config-dir <dir>', 'which configuration directory to read. Defaults to $ROTA_CONFIG_DIR, then ~/.config/rota'],
  ['--json', 'print the raw JSON instead of a table'],
  ['--no-colour', 'plain text, no escape sequences (also NO_COLOR)'],
]

const API_OPTIONS = [
  ['--url <url>', 'where the engine listens. Defaults to what config.json says'],
  ['--token <token>', 'bearer token. Defaults to the one in config.json, $ROTA_TOKEN overrides'],
]

function usage() {
  const width = Math.max(...COMMANDS.map((c) => `${c.name} ${c.argument}`.trim().length))
  const line = (c) => `  ${`${c.name} ${c.argument}`.trim().padEnd(width)}  ${c.summary}`

  const group = (title, source) =>
    [title, ...COMMANDS.filter((c) => c.source === source).map(line)].join('\n')

  return `rotactl — driving Rota from a terminal

Usage:
  rotactl <command> [options]

${group('Reading the files — works with nothing running:', SOURCE.DISK)}

${group('Asking the running engine:', SOURCE.API)}

${group('Writing a job file:', SOURCE.FILE)}

Options:
${GLOBAL_OPTIONS.map(([flag, text]) => `  ${flag.padEnd(20)}  ${text}`).join('\n')}
${API_OPTIONS.map(([flag, text]) => `  ${flag.padEnd(20)}  ${text}`).join('\n')}
  --limit <n>           how many entries to show, where a command takes a limit
  -h, --help            this, or a command's own help
  -v, --version         the version

  rotactl <command> --help says what that command does, and which of these
  options it actually reads.
`
}

function commandHelp(name) {
  const command = byName.get(name)
  if (!command) return null

  const options = [...GLOBAL_OPTIONS]
  if (command.source === SOURCE.API || command.remote) options.push(...API_OPTIONS)
  if (command.limit) {
    options.push(['--limit <n>', `how many entries to show. Defaults to ${command.limit}`])
  }
  if (command.remote) {
    options.push(['--remote', 'ask the running engine instead of reading the files'])
  }

  const where = {
    [SOURCE.DISK]: 'Reads the configuration directory. Works with nothing running.',
    [SOURCE.API]: 'Asks the running engine over HTTP. Needs the API enabled and a token.',
    [SOURCE.FILE]: 'Writes the job file. A running engine picks the change up on its own.',
  }[command.source]

  return `rotactl ${command.name} ${command.argument}`.trim() + `

${command.summary}.

${command.detail}

${where}

Options:
${options.map(([flag, text]) => `  ${flag.padEnd(20)}  ${text}`).join('\n')}
`
}

module.exports = { COMMANDS, SOURCE, byName, usage, commandHelp }
