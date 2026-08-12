'use strict'

// The commands Rota accepts from Discord.
//
// Nothing here knows the network: we receive a message, we return a text. That
// is what allows the behaviour to be exercised without a bot or a server.
//
// Editing stays local, deliberately: a JSON definition pasted into a channel
// reads badly, and corrects even worse. What is driven remotely is what can be
// said in one line — start, stop, enable, pause.

const { jobForKeyword, keywordsOf } = require('../config/triggers')
const logger = require('../lib/logger')

// Copied from src/renderer/format.js rather than imported: that one is an ESM
// module of the renderer bundle, which the main process does not load. The two
// lists describe the same statuses, defined in the engine's runner/index.js.
const STATUS_LABELS = {
  success: 'succeeded',
  failed: 'failed',
  'timed-out': 'timed out',
  cancelled: 'cancelled',
  'skipped-already-running': 'already running',
}

/** `<@123>` and `<@!123>`: the second form dates from server nicknames. */
const MENTION = /^<@!?(\d+)>\s*/

/**
 * Extracts a command addressed to the bot.
 *
 * Only mentions count: without that the bot would read the whole channel, and
 * Discord would not send the content of the other messages anyway without the
 * privileged intent.
 *
 * `rest` carries the text as it was written, newlines included: a command taking
 * a sentence — `chat` — cannot make do with words glued back together by spaces.
 *
 * @param {string} content
 * @param {string} botUserId
 * @returns {{name: string, args: string[], rest: string} | null}
 */
function parseCommand(content, botUserId) {
  if (typeof content !== 'string' || !botUserId) return null

  const match = content.trim().match(MENTION)
  if (!match || match[1] !== botUserId) return null

  const body = content.trim().slice(match[0].length).trim()
  const words = body.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { name: 'help', args: [], rest: '' }

  return {
    name: words[0].toLowerCase(),
    args: words.slice(1),
    rest: body.slice(words[0].length).trim(),
  }
}

const bloc = (text) => `\`\`\`\n${text}\n\`\`\``

const HELP = [
  '**Commands**',
  '`list` — the jobs and their state',
  '`status` — scheduler state and running executions',
  '`run <id>` — run a job now',
  '`stop <id>` — stop its running execution',
  '`enable <id>` / `disable <id>` — turn scheduling on or off',
  '`pause` / `resume` — pause or resume the scheduler',
  '`history <id> [n]` — the last n executions (5 by default)',
  '`logs <id>` — the output of the last execution',
  '`chat <id> <message>` — talk to an agent job, if enabled',
  '',
  'A job can also declare a keyword of its own, listed below when there is one.',
  'Editing a job stays local.',
].join('\n')

/**
 * Runs a command.
 *
 * @param {{name: string, args: string[], rest?: string}} command
 * @param {object} deps store, scheduler, runner, state, history, setPaused, chat, ack
 * @returns {Promise<string>} answer in Discord markdown
 */
async function runCommand({ name, args, rest = '' }, deps) {
  const handler = COMMANDS[name]
  if (handler) return handler(args, deps, rest)

  // A word that is no command may be a job's keyword. The command comes first:
  // that is what guarantees `run` stays `run` whatever a definition claims, and
  // validation already refuses duplicates.
  const byKeyword = await runKeyword(name, deps)
  if (byKeyword) return byKeyword

  return `Unknown command: \`${name}\`.\n\n${help(deps)}`
}

/**
 * Starts the job a keyword designates.
 * @returns {Promise<string|null>} null if no job claims it
 */
async function runKeyword(keyword, { store, scheduler }) {
  const found = jobForKeyword(store.getJobs(), keyword)
  if (!found) return null

  if (found.ambiguous.length > 0) {
    logger.warn(
      `discord: "${keyword}" is claimed by ${[found.job.id, ...found.ambiguous].join(', ')} — ` +
        `${found.job.id} wins, rename the others`,
    )
  }

  const result = await scheduler.runNow(found.job.id, { trigger: 'discord' })
  if (!result.ok) return `Run refused: ${result.errors.join(' | ')}`
  return `▶ \`${found.job.id}\` started. \`logs ${found.job.id}\` for the output.`
}

/**
 * The help, augmented with the declared keywords.
 *
 * They are not in the fixed text because they are not fixed: they come from the
 * definitions, and a help that kept quiet about them would leave their only
 * instructions in a JSON file.
 */
function help({ store }) {
  const keywords = keywordsOf(store.getJobs())
  if (keywords.length === 0) return HELP
  return [
    HELP,
    '',
    '**Keywords**',
    ...keywords.map(({ keyword, jobId }) => `\`${keyword}\` — runs \`${jobId}\``),
  ].join('\n')
}

/** Finds a job, or returns the error message to display. */
function findJob(store, id) {
  if (!id) return { ok: false, error: 'Name a job identifier.' }
  const job = store.getJobs().find((candidate) => candidate.id === id)
  if (!job) {
    const known = store.getJobs().map((candidate) => `\`${candidate.id}\``).join(', ')
    return { ok: false, error: `Unknown job: \`${id}\`.\nKnown: ${known || 'none'}` }
  }
  return { ok: true, job }
}

const COMMANDS = {
  help: (_args, deps) => help(deps),

  list(_args, { store, runner, state }) {
    const jobs = store.getJobs()
    if (jobs.length === 0) return 'No job configured.'

    const lastRuns = state.lastRunByJob()
    const lines = jobs.map((job) => {
      const running = runner.isRunning(job.id)
      const last = lastRuns.get(job.id)
      const mark = running ? '▶' : job.enabled ? '·' : '×'
      const latest = last ? STATUS_LABELS[last.status] ?? last.status : 'never run'
      return `${mark} ${job.id.padEnd(24)} ${latest}`
    })

    return [
      `**${jobs.length} job(s)** — ▶ running · enabled × disabled`,
      bloc(lines.join('\n')),
    ].join('\n')
  },

  status(_args, { scheduler, runner }) {
    const running = runner.runningExecutions()
    const byJob = scheduler.nextRunByJob()
    const next = [...byJob.entries()]
      .sort(([, a], [, b]) => Date.parse(a) - Date.parse(b))
      .slice(0, 3)
      .map(([jobId, at]) => `${new Date(at).toLocaleString('en-GB')} — ${jobId}`)

    return [
      `**Scheduler**: ${scheduler.isPaused() ? 'paused' : 'active'}`,
      `**Running**: ${running.length === 0 ? 'nothing' : running.map((e) => e.jobId).join(', ')}`,
      next.length > 0 ? `**Next**\n${bloc(next.join('\n'))}` : '**Next**: none',
    ].join('\n')
  },

  async run(args, deps) {
    const found = findJob(deps.store, args[0])
    if (!found.ok) return found.error

    const result = await deps.scheduler.runNow(found.job.id)
    if (!result.ok) return `Run refused: ${result.errors.join(' | ')}`
    return `▶ \`${found.job.id}\` started. \`logs ${found.job.id}\` for the output.`
  },

  stop(args, deps) {
    const found = findJob(deps.store, args[0])
    if (!found.ok) return found.error

    const executions = deps.runner
      .runningExecutions()
      .filter((execution) => execution.jobId === found.job.id)
    if (executions.length === 0) return `\`${found.job.id}\` has no running execution.`

    for (const execution of executions) deps.runner.cancel(execution.executionId)
    return `■ Stop requested for \`${found.job.id}\`.`
  },

  enable: (args, deps) => setEnabled(args, deps, true),
  disable: (args, deps) => setEnabled(args, deps, false),

  async pause(_args, { setPaused }) {
    await setPaused(true)
    return 'Scheduler paused.'
  },

  async resume(_args, { setPaused }) {
    await setPaused(false)
    return 'Scheduler resumed.'
  },

  async history(args, { store, history }) {
    const found = findJob(store, args[0])
    if (!found.ok) return found.error

    const limit = Math.min(Math.max(Number.parseInt(args[1], 10) || 5, 1), 20)
    const { entries } = await history.read(found.job.id, { limit })
    if (entries.length === 0) return `\`${found.job.id}\` has no history yet.`

    const lines = entries.map((entry) => {
      const when = new Date(entry.startedAt).toLocaleString('en-GB')
      const duration = `${(entry.durationMs / 1000).toFixed(1)} s`
      return `${when}  ${(STATUS_LABELS[entry.status] ?? entry.status).padEnd(14)} ${duration}`
    })
    return [`**${found.job.id}** — last ${entries.length}`, bloc(lines.join('\n'))].join('\n')
  },

  async logs(args, { store, history, runner }) {
    const found = findJob(store, args[0])
    if (!found.ok) return found.error

    // A running execution wins: that is the one you want to see when you have
    // just started it.
    const live = runner.runningExecutions().find((execution) => execution.jobId === found.job.id)
    if (live) {
      const output = runner.liveOutput(live.executionId)
      const text = output.ok ? `${output.stdout.text}${output.stderr.text}`.trim() : ''
      return [
        `**${found.job.id}** — running execution`,
        bloc(tail(text) || '(no output yet)'),
      ].join('\n')
    }

    const { entries } = await history.read(found.job.id, { limit: 1 })
    if (entries.length === 0) return `\`${found.job.id}\` has no history yet.`

    const entry = entries[0]
    const text = `${entry.stdout ?? ''}${entry.stderr ?? ''}`.trim()
    return [
      `**${found.job.id}** — ${STATUS_LABELS[entry.status] ?? entry.status}, ` +
        `${new Date(entry.startedAt).toLocaleString('en-GB')}`,
      bloc(tail(text) || '(no output)'),
      entry.error ? `⚠ ${entry.error}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  },

  // `run` executes the job's prompt: written, reviewed, versioned. `chat` lets
  // the prompt be composed in the channel. That is not the same power, hence a
  // flag of its own — control had already asked for one on top of the token.
  async chat(args, deps, rest) {
    const { store, chat, ack } = deps
    if (!store.getConfig().integrations.discordChatEnabled) {
      return 'Chatting from Discord is off. Enable it under Settings → Discord.'
    }
    if (!chat) return 'Chatting is unavailable.'

    const found = findJob(store, args[0])
    if (!found.ok) return found.error

    const message = rest.startsWith(args[0]) ? rest.slice(args[0].length).trim() : rest.trim()
    if (message === '') return `Write something after \`${found.job.id}\`.`

    const opened = chat.open(found.job.id, 'discord')
    if (!opened.ok) return opened.errors.join(' | ')
    // One turn occupies the conversation: two messages crossing would stack up
    // on the same context.
    if (opened.busy) return `\`${found.job.id}\` is still working on the previous message.`

    // A turn can last a minute. With no acknowledgement, the channel looks dead
    // and one retypes the command.
    await ack?.(`▶ \`${found.job.id}\` is thinking…`)

    const result = await chat.post(opened.chatId, message)
    if (!result.ok) return `Refused: ${result.error}`
    if (!result.turn.ok) return `⚠ ${result.turn.error}`
    return result.turn.content?.trim() || '(no answer)'
  },
}

async function setEnabled(args, { store }, enabled) {
  const found = findJob(store, args[0])
  if (!found.ok) return found.error

  const result = await store.setJobEnabled(found.job.id, enabled)
  if (!result.ok) return `Refused: ${result.errors.join(' | ')}`
  return `\`${found.job.id}\` ${enabled ? 'enabled' : 'disabled'}.`
}

/**
 * Tail of an output. A Discord channel is not a console: we show the end, the
 * one carrying the failure, and point at the rest in the application.
 */
function tail(text, maxChars = 1200) {
  if (text.length <= maxChars) return text
  const cut = text.slice(text.length - maxChars)
  const boundary = cut.indexOf('\n')
  return `[…]\n${boundary === -1 ? cut : cut.slice(boundary + 1)}`
}

module.exports = { parseCommand, runCommand, tail, HELP, COMMANDS }
