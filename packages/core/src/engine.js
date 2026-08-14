'use strict'

// The engine, composed: everything that has to exist for jobs to run, and
// nothing that needs a screen.
//
// Both shells build one of these — the application around a tray and a window,
// the daemon around a signal handler — and that is what stops the two from
// drifting apart. Only two things differ, and both are injected: the interface
// an agent asks its questions through, and the adapter that tells the scheduler
// the machine went to sleep. Everything else, including the parts a reader
// would expect to be "application logic" — recording an execution, forgetting a
// job whose file was deleted, honouring a pause — is here, because a daemon
// that got any of it subtly different would be a bug nobody could see.
//
// The engine says what happened; it does not decide what to show. Notifying,
// drawing a tray icon, sending to a renderer: those are the shell's, and they
// hang off the events below.

const path = require('node:path')
const { EventEmitter } = require('node:events')

const agentMemory = require('./agent/memory')
const logger = require('./lib/logger')

const { ConfigStore } = require('./config/store')
const { createChatSessions } = require('./agent/chat')
const { createDiscordControl } = require('./discord')
const { createHttpServer } = require('./http')
const { createJobLauncher } = require('./agent/jobs')
const { createUiBridge } = require('./http/ui-bridge')
const { ensureStructure, isLegacyConfigDir, resolvePaths } = require('./config/paths')
const { HistoryStore } = require('./history/store')
const { migrateJobsDir } = require('./config/migrate')
const { pruneInlineScripts } = require('./runner/inline')
const { Runner } = require('./runner')
const { Scheduler } = require('./scheduler')
const { StateStore } = require('./state-store')
const { WorkStore } = require('./work/store')
const { buildSnapshot } = require('./snapshot')
const { watchConfig } = require('./config/watcher')

// The interface throttles its own copy of the state at 250 ms; the stream has
// no reason to be more talkative.
const STATE_PUBLISH_THROTTLE_MS = 250

/**
 * Builds every part of the engine and wires them together. Everything is ready
 * when this resolves, but nothing is scheduled yet: call `start()`.
 *
 * @param {object} [options]
 * @param {object} [options.paths] Where everything lives. Defaults to the one
 *   configuration directory, which is what both shells want.
 * @param {{report: Function, ask: Function, confirm: Function}} [options.ui]
 *   How an agent reaches a person. Defaults to asking over the event stream —
 *   which, with nobody attached, is the interface that politely refuses.
 * @returns {Promise<EventEmitter & object>}
 */
async function createEngine({ paths = resolvePaths(), ui = null } = {}) {
  await ensureStructure(paths)
  logger.init(path.join(paths.logsDir, 'rota.log'))
  logger.info(`starting up — configuration in ${paths.root}`)

  // The project used to be called TickTray. Nothing is moved on its own, so an
  // installation that predates the rename keeps opening its old directory — and
  // is told once, per start, where it stands and how to finish the job.
  if (isLegacyConfigDir(paths.root)) {
    logger.info(
      `this directory is named for the project's old name — ` +
        `\`mv ${paths.root} ${path.join(path.dirname(paths.root), 'rota')}\` when convenient`,
    )
  }

  // Before the first load: a definition written for an earlier version of the
  // schema would otherwise be refused, and the job would vanish from the list
  // until one worked out why.
  await migrateJobsDir(paths.jobsDir)

  const engine = new EventEmitter()

  // With no window in this process, an agent's questions go out over the event
  // stream and come back as a POST. A shell that has windows passes its own,
  // and the bridge is then only there for the routes that answer it.
  const uiBridge = createUiBridge()
  const agentUi = ui ?? uiBridge.ui

  const store = new ConfigStore(paths)
  await store.reload()

  const state = new StateStore(paths.stateFile)
  await state.load()

  // Loaded before anything can run: its load() is also what puts back the items
  // an interrupted execution left claimed, and a worker must not be offered one
  // of those as though it were fresh.
  const work = new WorkStore(paths.workDir)
  await work.load()

  const history = new HistoryStore(paths, {
    getDefaults: () => store.getConfig().defaults,
  })

  // Created before the runner: the agents borrow its Discord sending. The
  // connection itself is only opened at the `sync()` in `start()`.
  const discord = createDiscordControl({
    store,
    get scheduler() {
      return scheduler
    },
    get runner() {
      return runner
    },
    state,
    history,
    // Like the scheduler: the conversations are built further down, and they
    // need the bridge to publish their reports.
    get chat() {
      return chat
    },
    setPaused,
    onStatusChange: () => engine.emit('changed'),
  })

  const runner = new Runner({ store, history, ui: agentUi, discord, work })
  const scheduler = new Scheduler({ store, state, runner, work })

  // The launcher loops: the runner needs it, it needs the scheduler, which needs
  // the runner. We put it in place once the three are built.
  runner.jobs = createJobLauncher({ store, runner, scheduler })

  const chat = createChatSessions({
    store,
    runner,
    ui: agentUi,
    discord,
    send: (event) => engine.emit('chat', event),
  })

  // The port opens no more readily without the settings asking for it. Created
  // after the conversations: `chat` is what the API serves on /chat.
  const http = createHttpServer({
    store,
    scheduler,
    runner,
    state,
    history,
    work,
    chat,
    setPaused,
    onStatusChange: () => engine.emit('changed'),
    // What a client attaching to the stream is told before anything happens.
    snapshot: () => engine.snapshot(),
    // The routes that carry an agent's questions, and the answers to them.
    ui: uiBridge,
  })

  // Now that there is something to carry them.
  uiBridge.bind({ publish: http.publish, attachedCount: http.streamCount })

  let watcher = null
  let statePublishTimer = null

  // Everything the engine says, said again over the event stream — but only when
  // somebody is listening. A snapshot is not cheap to build, and an engine with
  // nobody attached should not pay for one.
  const republish = (event) => (payload) => {
    if (http.streamCount() > 0) http.publish(event, payload)
  }

  /**
   * The state, at most once per throttle window. The interface does the same
   * with its own copy, and for the same reason: a chatty job changes the state
   * dozens of times a second, and nobody can read that.
   */
  function publishState() {
    if (statePublishTimer || http.streamCount() === 0) return
    statePublishTimer = setTimeout(() => {
      statePublishTimer = null
      if (http.streamCount() > 0) http.publish('state', engine.snapshot())
    }, STATE_PUBLISH_THROTTLE_MS)
    statePublishTimer.unref?.()
  }

  runner.on('started', (execution) => {
    engine.emit('started', execution)
    engine.emit('changed')
  })

  engine.on('started', republish('started'))
  engine.on('finished', republish('finished'))
  engine.on('output', republish('output'))
  engine.on('chat', republish('chat'))
  engine.on('changed', publishState)

  // A chatty job produces dozens of chunks a second. They are forwarded raw:
  // batching them is a question of how they are displayed, which is the shell's
  // to answer.
  runner.on('output', (chunk) => engine.emit('output', chunk))

  runner.on('finished', (execution) => {
    // A skipped execution did not happen: it must not shift the next occurrence,
    // so we do not keep it as the last execution.
    if (execution.status !== 'skipped-already-running') {
      state.recordRun(execution.jobId, {
        at: execution.finishedAt,
        status: execution.status,
        durationMs: execution.durationMs,
        executionId: execution.executionId,
      })
    }

    if (execution.status === 'failed' || execution.status === 'timed-out') {
      state.recordError({
        jobId: execution.jobId,
        name: execution.jobName,
        at: execution.finishedAt,
        executionId: execution.executionId,
        status: execution.status,
      })
    }

    engine.emit('finished', execution)
    engine.emit('changed')
  })

  scheduler.on('changed', () => engine.emit('changed'))

  // A queue that moves is a state change like any other: the interface shows
  // what is waiting per job, and the publication is throttled downstream.
  work.on('changed', () => engine.emit('changed'))

  store.on('change', async () => {
    logIssues()
    // Before the engine's own reaction: a shell has settings of its own to
    // apply — a theme, a launch-at-login — and they should not wait behind a
    // Discord reconnection.
    engine.emit('config-changed', store.getConfig())
    discord.sync()
    http.sync()
    scheduler.sync()
    await pruneOrphans()
    engine.emit('changed')
  })

  function logIssues() {
    const issues = store.getIssues()
    logger.info(`${store.getJobs().length} job(s) loaded, ${issues.length} configuration problem(s)`)
    for (const issue of issues) {
      logger.warn(`${issue.file} : ${issue.errors.join(' | ')}`)
    }
  }

  /** Removes state, history and generated code of jobs whose file disappeared. */
  async function pruneOrphans() {
    const ids = store.getJobs().map((job) => job.id)
    await chat.prune(ids).catch((err) => logger.error('pruning conversations', err))
    state.prune(ids)
    await history.prune(ids).catch((err) => logger.error('pruning history', err))
    await work.prune(ids).catch((err) => logger.error('pruning the work queues', err))
    await pruneInlineScripts(paths, ids).catch((err) => logger.error('pruning inline code', err))
    // Both lists: a memory file is named after a profile as readily as after a
    // job, and sweeping on the jobs alone would wipe every profile's memory on
    // the next start.
    await agentMemory
      .prune(paths.memoryDir, ids, store.getProfiles().map((profile) => profile.id))
      .catch((err) => logger.error('pruning agent memory', err))
  }

  async function setPaused(paused) {
    const result = await store.patchConfig({ schedulerPaused: paused })
    if (!result.ok) {
      logger.error('pausing failed', result.errors.join(' | '))
      return
    }
    logger.info(paused ? 'scheduler paused' : 'scheduler resumed')
    scheduler.sync()
    engine.emit('changed')
  }

  Object.assign(engine, {
    paths,
    store,
    state,
    history,
    work,
    runner,
    scheduler,
    chat,
    discord,
    http,
    ui: uiBridge,

    /**
     * Opens the two doors that the settings may ask for, starts watching the
     * configuration directory, and schedules. Idempotent parts stay idempotent:
     * both `sync()`s are replayed on every reload.
     */
    async start() {
      logIssues()
      discord.sync()
      http.sync()
      watcher = watchConfig(paths, () => {
        store.reload().catch((err) => logger.error('reload failed', err))
      })
      await scheduler.start()
      await pruneOrphans()
      engine.emit('changed')
    },

    /**
     * Stops everything, in the order that loses the least. Children run in their
     * own process group: without cancelling them they would survive us.
     */
    async stop() {
      watcher?.close()
      watcher = null
      if (statePublishTimer) clearTimeout(statePublishTimer)
      statePublishTimer = null
      scheduler.stop()
      runner.cancelAll()
      // Conversations before anything that could ask a question: closing one may
      // ask a last one, which there would be no point opening.
      chat.closeAll()
      discord.stop()
      http.stop()
      await state.flush().catch(() => {})
      logger.info('shutting down')
    },

    setPaused,
    pruneOrphans,

    /**
     * The whole state, as the interface consumes it. A shell adds what only it
     * can know — whether it managed to register for launch at login, whether
     * notifications are permitted — and a daemon simply does not.
     */
    snapshot({ autostart = null, notifier = null } = {}) {
      return buildSnapshot({
        store,
        scheduler,
        runner,
        state,
        work,
        autostart,
        notifier,
        discord,
        http,
      })
    },
  })

  return engine
}

module.exports = { createEngine }
