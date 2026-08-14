'use strict'

// Scheduler: one timer per active timed trigger.
//
// A job carries as many as it likes — "every five minutes" and "at 9am on
// weekdays" cannot be said in one expression, and now coexist in the same
// definition. Triggers that wait to be come to, webhook and Discord, do not go
// through here: they have no occurrence to compute.
//
// Occurrences are derived from the last persisted execution rather than from an
// in-memory counter. Reloading the configuration or restarting the application
// therefore does not shift the jobs — otherwise editing one file would push
// every job in the directory back by its full interval.

const { EventEmitter } = require('node:events')

const logger = require('../lib/logger')
const { truncateToBytes } = require('../runner/output')
const { isTimed, nextRunAt, missedOccurrences, timeoutFor } = require('./next-run')
const { watchPath, DEFAULT_SETTLE_MS } = require('./watch-path')

// The label an `after` run carries in the history, and the mark that stops it
// from starting anything in turn.
const AFTER_TRIGGER = 'after'

// The label a run taken off the queue carries.
const WORK_TRIGGER = 'work'

// Defaults of a `work` trigger that declares neither. Kept here rather than in
// the schema, which would write them into every trigger of every type.
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_SECONDS = 60

// What is kept of an execution's output as the item's result. Enough to see
// what came of it from the queue view; the whole of it is in the history, under
// the execution the item names.
const RESULT_BYTES = 4096

// A timer key designates a trigger, not a job. The index is enough: it is stable
// as long as the file does not change, and a file that changes goes back
// through sync() anyway.
const keyOf = (jobId, index) => `${jobId}#${index}`

/** Timed triggers of a job, with their original index. */
function timedTriggers(job) {
  return (job.triggers ?? [])
    .map((trigger, index) => ({ trigger, index }))
    .filter(({ trigger }) => isTimed(trigger))
}

/**
 * The `work` trigger of a job, or null.
 *
 * One at most is meaningful: a second would say the same thing about the same
 * queue, and the first one found is the one that answers.
 */
function workTrigger(job) {
  return (job.triggers ?? []).find((t) => t.type === 'work' && t.enabled !== false) ?? null
}

class Scheduler extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config/store').ConfigStore} deps.store
   * @param {import('../state-store').StateStore} deps.state
   * @param {import('../runner').Runner} deps.runner
   * @param {import('../work/store').WorkStore} [deps.work] the queues. Absent,
   *   `work` triggers simply never fire — which is what every test that does not
   *   care about them wants.
   */
  constructor({ store, state, runner, work = null }) {
    super()
    this.store = store
    this.state = state
    this.runner = runner
    this.work = work
    /**
     * Armed timers, indexed by trigger — "<id>#<index>".
     * @type {Map<string, {timer: NodeJS.Timeout, targetAt: number, jobId: string}>}
     */
    this.timers = new Map()
    /**
     * Starting point of triggers that have never fired. Remembered so that a
     * configuration reload does not push their first execution back
     * indefinitely.
     * @type {Map<string, number>}
     */
    this.anchors = new Map()
    this.started = false
    /**
     * Session lock. Electron only reports the lock-screen / unlock-screen
     * transitions; the initial state is read at startup by lib/session-lock and
     * pushed here before the first arming.
     */
    this.locked = false
    /** Power triggers the lock held back, replayed when the session comes back. */
    this.pendingPower = new Map()
    // Bound once so that stop() can take it off again.
    this.onFinished = (execution) => this.#onFinished(execution)
    // Every move of a queue, not just an arrival. An item put back by hand —
    // the Queue again button, `rotactl work retry`, a run somebody stopped —
    // becomes available without anything being created, and a worker that only
    // listened for arrivals would leave it sitting there until something
    // unrelated happened to wake it.
    this.onWorkChanged = (item) => {
      const job = this.store.getJob(item.jobId)
      if (job) this.#serveWork(job)
    }
    /**
     * Jobs whose next item is being taken right now. Serving is asynchronous —
     * the claim is a write — and two serves that overlapped would both pass the
     * "is it running?" check before either had claimed anything.
     * @type {Set<string>}
     */
    this.serving = new Set()
    /**
     * One timer per job whose queue holds nothing but items still serving out
     * their backoff. Without it, a failed item would come back into the queue
     * at an instant nobody was watching.
     * @type {Map<string, NodeJS.Timeout>}
     */
    this.backoffTimers = new Map()
    /** One filesystem watcher per `path` trigger, keyed like the timers. */
    this.watchers = new Map()
    /** Paths we could not watch, so that the interface can say which. */
    this.unwatchable = new Map()
  }

  isPaused() {
    return this.store.getConfig().schedulerPaused
  }

  isSessionLocked() {
    return this.locked
  }

  /**
   * A job set aside by the lock. The typical case is a script pushing to a
   * remote repository: ssh reads the key's passphrase from the keychain,
   * unreadable with the screen locked, and the refusal that follows looks for
   * all the world like a permissions problem on the server side.
   */
  #deferredForLock(job) {
    return this.locked && job.execution.requiresUnlockedSession
  }

  /** Identifiers of jobs waiting for an unlock, for the interface. */
  deferredJobIds() {
    if (!this.locked) return new Set()
    return new Set(
      this.store
        .getJobs()
        .filter((job) => job.enabled && this.#deferredForLock(job))
        .map((job) => job.id),
    )
  }

  /** Starts the timers and fires the jobs marked runOnStartup. */
  async start() {
    this.started = true

    // Subscribed here rather than in the composition root: what starts a job
    // belongs to the scheduler, and an `after` trigger is one more thing that
    // starts a job.
    this.runner.on?.('finished', this.onFinished)
    // A queue moving is the whole of what a `work` trigger waits for. Like a
    // path watcher, it has no occurrence to compute and no timer to arm. Serving
    // is guarded and takes nothing when there is nothing to take, so the moves
    // that change nothing — an item completing mid-drain — cost a lookup.
    this.work?.on?.('changed', this.onWorkChanged)

    // Also picks up what was left in the queues while Rota was not running: the
    // store put the interrupted items back as pending when it loaded, and
    // sync() serves whoever is waiting for them.
    this.sync()

    if (this.isPaused()) {
      logger.info('scheduler paused at startup')
      return
    }
    for (const job of this.store.getJobs()) {
      if (job.enabled && job.execution.runOnStartup && !this.#deferredForLock(job)) {
        this.#trigger(job, 'startup')
      }
    }
  }

  stop() {
    this.started = false
    this.runner.off?.('finished', this.onFinished)
    this.work?.off?.('changed', this.onWorkChanged)
    for (const key of [...this.watchers.keys()]) this.#unwatch(key)
    for (const { timer } of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const timer of this.backoffTimers.values()) clearTimeout(timer)
    this.backoffTimers.clear()
  }

  /**
   * A job has ended: start whatever was waiting for it.
   *
   * **One hop, never a chain.** A job started this way does not itself start
   * others. That kills every cycle by construction rather than by a depth
   * counter nobody would tune, and it costs nothing real: chaining is what the
   * workflow runner is for, and it does it in one execution with one history
   * entry. `after` is for reacting to something you did not start.
   */
  #onFinished = (execution) => {
    if (!this.started || this.isPaused()) return
    if (execution.trigger === AFTER_TRIGGER) return

    // Neither of these is an ending to react to: one never ran, and the other
    // was stopped by somebody who was already watching.
    if (execution.status === 'skipped-already-running' || execution.status === 'cancelled') return

    const succeeded = execution.status === 'success'
    for (const job of this.store.getJobs()) {
      if (!job.enabled || job.id === execution.jobId) continue
      if (this.#deferredForLock(job)) continue

      const wants = (job.triggers ?? []).some((trigger) => {
        if (trigger.type !== 'after' || trigger.enabled === false) return false
        if (trigger.job !== execution.jobId) return false
        const on = trigger.on ?? 'success'
        return on === 'any' || (on === 'success') === succeeded
      })
      if (!wants) continue

      logger.info(`${job.id}: after ${execution.jobId} ${execution.status}`)
      this.#trigger(job, AFTER_TRIGGER)
    }
  }

  /** Recomputes every timer from the current state. Idempotent. */
  sync() {
    if (!this.started) return

    const jobs = this.store.getJobs()
    const active = new Set()
    const watched = new Set()

    for (const job of jobs) {
      if (!job.enabled || this.isPaused()) continue
      // Session locked: we do not arm, exactly as during a sleep. Unlocking
      // replays the wake-up logic.
      if (this.#deferredForLock(job)) continue
      for (const { trigger, index } of timedTriggers(job)) {
        active.add(keyOf(job.id, index))
        this.#arm(job, trigger, index)
      }
      // Watchers follow the same three rules as the timers, which is why they
      // are built in the same pass: a paused scheduler watches nothing, a
      // disabled job watches nothing, and a job waiting on an unlocked session
      // waits for it here too.
      for (const [index, trigger] of (job.triggers ?? []).entries()) {
        if (trigger.type !== 'path' || trigger.enabled === false) continue
        watched.add(keyOf(job.id, index))
        this.#watch(job, trigger, index)
      }
    }

    for (const key of [...this.timers.keys()]) {
      if (!active.has(key)) this.#disarm(key)
    }
    for (const key of [...this.watchers.keys()]) {
      if (!watched.has(key)) this.#unwatch(key)
    }

    // Whatever moved may have made a worker able to run again: the pause
    // lifted, the session unlocked, its definition re-enabled. Serving is
    // guarded and takes nothing when there is nothing to take, so this costs a
    // map lookup in the ordinary case.
    this.#serveWorkers()

    this.emit('changed')
  }

  // --- the queues ---------------------------------------------------------------

  /** Every job that consumes a queue, offered whatever is waiting in it. */
  #serveWorkers() {
    if (!this.work || !this.started) return
    for (const job of this.store.getJobs()) {
      if (!workTrigger(job)) continue
      this.#serveWork(job).catch((err) => logger.error(`serving ${job.id} failed`, err))
    }
  }

  /**
   * Comes back to a queue when the item it is holding back falls due.
   *
   * Same shape as `#schedule` for a timed trigger, and for the same reason: an
   * instant in the future, and a re-arming for delays longer than setTimeout
   * accepts. Rebuilt from the queue each time rather than remembered, so an
   * item cancelled or retried in the meantime moves the appointment.
   */
  #armBackoff(jobId) {
    this.#clearBackoff(jobId)
    const at = this.work?.nextAvailableAt(jobId) ?? null
    if (at === null) return

    const { delay, final } = timeoutFor(at, Date.now())
    const timer = setTimeout(() => {
      this.backoffTimers.delete(jobId)
      if (!final) {
        this.#armBackoff(jobId)
        return
      }
      const job = this.store.getJob(jobId)
      if (job) this.#serveWork(job).catch((err) => logger.error(`serving ${jobId} failed`, err))
    }, delay)
    timer.unref?.()
    this.backoffTimers.set(jobId, timer)
  }

  #clearBackoff(jobId) {
    const existing = this.backoffTimers.get(jobId)
    if (!existing) return
    clearTimeout(existing)
    this.backoffTimers.delete(jobId)
  }

  /** The three rules every firing obeys, plus the job's own concurrency. */
  #canServe(job) {
    if (!this.started || this.isPaused() || !job.enabled) return false
    if (this.#deferredForLock(job)) return false
    if (!workTrigger(job)) return false
    if (!job.execution.allowConcurrentRuns && this.runner.isRunning(job.id)) return false
    return true
  }

  /**
   * Works through a job's queue, item by item, until it runs dry.
   *
   * **The loop is here, and it is a consequence rather than a feature.** Nothing
   * counts turns, nothing decides when to stop, and no flag turns it on: a job
   * with a `work` trigger takes the next item as soon as it is done with the
   * last, and an empty queue is what ends it. An item that fails leaves the
   * queue for the length of its backoff, which is also what stops a worker from
   * spinning on something that fails instantly.
   *
   * Re-entrance is held off for the whole loop: claiming is a write, and two
   * serves that overlapped would both pass the concurrency check before either
   * had taken anything.
   */
  async #serveWork(job) {
    if (!this.work || this.serving.has(job.id)) return
    this.serving.add(job.id)
    try {
      for (;;) {
        // Re-read on every turn rather than closing over the definition: a job
        // disabled, edited or deleted while its queue was draining must not have
        // the rest of it run from a stale copy.
        const current = this.store.getJob(job.id)
        if (!current || !this.#canServe(current)) return

        const item = await this.work.claim(current.id)
        // Nothing to take. If something is only waiting out its backoff, this
        // is where we undertake to come back for it.
        if (!item) return this.#armBackoff(current.id)

        const status = await this.#runItem(current, item)

        // Two endings stop the loop rather than turning it. A run somebody
        // stopped by hand is not an invitation to start the next one, and a job
        // that turned out to be busy will not be less busy on the next turn.
        // Both put their item back, and something else — an arrival, a resume —
        // is what will pick the queue up again.
        if (status === 'cancelled' || status === 'skipped-already-running') return
      }
    } finally {
      this.serving.delete(job.id)
    }
  }

  /**
   * One item, from claim to outcome.
   * @returns {Promise<string>} the status the execution ended as
   */
  async #runItem(job, item) {
    // The attempt is counted now, not at the end: an execution interrupted by a
    // crash has to have cost the item something, otherwise a job that brings
    // Rota down takes the same item forever.
    await this.work.markRunning(item.id, null)

    this.#reanchor(job, Date.now())
    this.emit('changed')

    let entry = null
    try {
      entry = await this.runner.run(job, {
        trigger: WORK_TRIGGER,
        work: { id: item.id, input: item.input },
      })
    } catch (err) {
      logger.error(`running ${job.id} failed`, err)
    }

    await this.#settleWork(job, item, entry)
    this.sync()
    return entry?.status ?? 'failed'
  }

  /** What the run made of the item. The mapping itself is the store's. */
  async #settleWork(job, item, entry) {
    const trigger = workTrigger(job)
    const status = entry?.status ?? 'failed'
    const output = `${entry?.stdout ?? ''}`.trim()

    const settled = await this.work.settle(item.id, {
      status,
      result:
        status === 'success' && output !== '' ? truncateToBytes(output, RESULT_BYTES).text : null,
      error:
        entry?.error ?? (entry ? `the execution ended as ${status}` : 'the execution never started'),
      executionId: entry?.executionId ?? null,
      maxAttempts: trigger?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffSeconds: trigger?.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS,
    })

    if (settled) logger.info(`${job.id}: work item ${item.id} → ${settled.status}`)
    this.emit('changed')
  }

  /**
   * Starts watching for a `path` trigger, or keeps watching what it already
   * watches. Rebuilding a watcher on every sync() would mean tearing down and
   * recreating an inotify handle every time any job's state moved.
   */
  #watch(job, trigger, index) {
    const key = keyOf(job.id, index)
    const existing = this.watchers.get(key)
    if (existing && existing.target === trigger.path) return
    if (existing) this.#unwatch(key)

    const settleMs = (trigger.settleSeconds ?? DEFAULT_SETTLE_MS / 1000) * 1000
    try {
      const handle = watchPath(
        trigger.path,
        () => {
          // Re-read rather than close over what the job was when the watcher
          // was built: a definition edited since must not be run from a stale
          // copy.
          const current = this.store.getJob(job.id)
          if (!current || !current.enabled || this.isPaused()) return
          if (this.#deferredForLock(current)) return
          logger.info(`${current.id}: ${trigger.path} changed`)
          this.#trigger(current, 'path')
        },
        { settleMs },
      )
      this.watchers.set(key, { target: trigger.path, handle })
      this.unwatchable.delete(key)
    } catch (err) {
      // A path that is not there yet, or not readable. Said once rather than on
      // every sync, and retried the next time the configuration moves.
      if (!this.unwatchable.has(key)) {
        logger.warn(`${job.id}: cannot watch ${trigger.path} — ${err.message}`)
      }
      this.unwatchable.set(key, { jobId: job.id, path: trigger.path, error: err.message })
    }
  }

  #unwatch(key) {
    this.watchers.get(key)?.handle.close()
    this.watchers.delete(key)
    this.unwatchable.delete(key)
  }

  #anchorFor(key) {
    if (!this.anchors.has(key)) this.anchors.set(key, Date.now())
    return this.anchors.get(key)
  }

  #targetFor(job, trigger, key) {
    const anchorAt = this.#anchorFor(key)

    // `once` is the exception to everything below: whether it has happened is
    // not a question about cadence, and a job allowed to run concurrently would
    // otherwise never learn that its one instant is behind it.
    if (trigger.type === 'once') {
      const lastRun = this.state.getLastRun(job.id)
      return nextRunAt(trigger, { lastRunAt: lastRun ? Date.parse(lastRun.at) : null, anchorAt })
    }

    if (job.execution.allowConcurrentRuns) {
      // A regular cadence since the last start: that is precisely what
      // "concurrent executions allowed" means. Counting from the end would make
      // the schedule drift, and counting from an end older than the running
      // execution would restart the job in a loop.
      return nextRunAt(trigger, { lastRunAt: null, anchorAt })
    }

    // The last execution is the job's, whichever trigger started it: two
    // intervals on the same job both count from the same end, otherwise the
    // second would immediately restart what the first has just finished.
    const lastRun = this.state.getLastRun(job.id)
    return nextRunAt(trigger, {
      lastRunAt: lastRun ? Date.parse(lastRun.at) : null,
      anchorAt,
    })
  }

  #arm(job, trigger, index) {
    const key = keyOf(job.id, index)

    // As long as a non-concurrent execution is running, the last known execution
    // is the one before: the computed occurrence would already be past and the
    // timer would fire at once, in a loop. It is the `finally` of the running
    // execution that re-arms, once lastRun is up to date.
    if (!job.execution.allowConcurrentRuns && this.runner.isRunning(job.id)) {
      this.#disarm(key)
      return
    }

    const targetAt = this.#targetFor(job, trigger, key)
    if (targetAt === null) {
      // A spent `once` is the normal end of its life, not a problem to report.
      if (trigger.type !== 'once') {
        // A cron expression describing no reachable date: nothing to arm.
        // Validation already refuses it, this case should not arise.
        logger.warn(`${job.id}: no upcoming occurrence, trigger ${index} not scheduled`)
      }
      this.#disarm(key)
      return
    }

    const existing = this.timers.get(key)
    if (existing?.targetAt === targetAt) return // already armed at the right instant

    if (existing) clearTimeout(existing.timer)
    this.#schedule(job.id, key, targetAt)
  }

  #schedule(jobId, key, targetAt) {
    const { delay, final } = timeoutFor(targetAt, Date.now())
    const timer = setTimeout(() => {
      if (!final) {
        // Delay longer than setTimeout accepts: we re-arm.
        this.#schedule(jobId, key, targetAt)
        return
      }
      this.timers.delete(key)
      this.#fire(jobId)
    }, delay)
    timer.unref?.()
    this.timers.set(key, { timer, targetAt, jobId })
  }

  #disarm(key) {
    const existing = this.timers.get(key)
    if (!existing) return
    clearTimeout(existing.timer)
    this.timers.delete(key)
  }

  #fire(jobId) {
    const job = this.store.getJob(jobId)
    // The lock may happen between arming and firing: the disarmed timer may
    // already have been in the event queue.
    if (!job || !job.enabled || this.isPaused() || this.#deferredForLock(job)) {
      this.sync()
      return
    }
    this.#trigger(job, 'schedule')
  }

  #trigger(job, trigger) {
    // The anchors follow the last start: without that, a running job would stay
    // indefinitely "late" and would be restarted in a loop. Every trigger of the
    // job is realigned, not only the one that fired — it is indeed the job that
    // has just started.
    this.#reanchor(job, Date.now())
    this.emit('changed')
    this.runner
      .run(job, { trigger })
      .catch((err) => logger.error(`running ${job.id} failed`, err))
      .finally(() => {
        // The next occurrence starts from the end of the execution: a job lasting
        // longer than its interval does not stack on top of itself.
        this.sync()
      })
  }

  /**
   * Explicit launch: interface, tray, Discord, or an agent job triggering
   * another. Overrides the lock as it overrides the pause — asking for an
   * execution assumes having the machine in hand.
   *
   * @param {string} jobId
   * @param {{trigger?: string}} [options] where the request comes from, for the history
   */
  async runNow(jobId, { trigger = 'manual' } = {}) {
    const job = this.store.getJob(jobId)
    if (!job) return { ok: false, errors: [`Unknown job: ${jobId}`] }
    this.#trigger(job, trigger)
    return { ok: true }
  }

  #reanchor(job, at) {
    for (const { index } of timedTriggers(job)) this.anchors.set(keyOf(job.id, index), at)
  }

  /**
   * Next occurrence of each job: the soonest of its triggers. The interface
   * shows when the job will start, not which of its three triggers gets there
   * first — that one is read in the definition.
   */
  nextRunByJob() {
    const soonest = new Map()
    for (const { targetAt, jobId } of this.timers.values()) {
      const known = soonest.get(jobId)
      if (known === undefined || targetAt < known) soonest.set(jobId, targetAt)
    }
    return new Map(
      [...soonest].map(([jobId, targetAt]) => [jobId, new Date(targetAt).toISOString()]),
    )
  }

  lastRunByJob() {
    return this.state.lastRunByJob()
  }

  /**
   * After a wake-up: catches late jobs up once, then re-arms.
   *
   * @param {number} now injectable for tests
   * @param {{power?: string|null}} [options] which power trigger this return
   *   counts as. Unlocking delegates here for the catch-up, and must not also
   *   fire the jobs waiting on a wake: a Mac wakes at the lock screen, so one
   *   lid-opening would otherwise run them twice.
   */
  handleWake(now = Date.now(), { power = 'wake' } = {}) {
    if (!this.started) return []

    const caughtUp = []
    for (const job of this.store.getJobs()) {
      if (!job.enabled || this.isPaused()) continue
      // A Mac wakes on the lock screen: jobs requiring an open session wait for
      // handleUnlock(), not this wake-up.
      if (this.#deferredForLock(job)) continue

      const lastRun = this.state.getLastRun(job.id)
      // The catch-up stays unique per job, whatever the number of triggers that
      // missed their turn: what a wake-up catches up is the work not done, and
      // it was not left undone three times because three triggers asked for it.
      const missed = timedTriggers(job).reduce(
        (total, { trigger, index }) =>
          total +
          missedOccurrences(trigger, {
            lastRunAt: lastRun ? Date.parse(lastRun.at) : null,
            anchorAt: this.#anchorFor(keyOf(job.id, index)),
            now,
          }),
        0,
      )
      if (missed === 0) continue

      if (!job.execution.catchUpOnWake) {
        logger.info(`${job.id}: ${missed} missed occurrence(s), catch-up disabled`)
        this.emit('skipped', { job, missed })
        // We start again from now rather than staying perpetually late.
        this.#reanchor(job, now)
        this.state.recordRun(job.id, {
          at: new Date(now).toISOString(),
          status: 'skipped',
          durationMs: 0,
          executionId: null,
        })
        continue
      }

      logger.info(`${job.id}: ${missed} missed occurrence(s), single catch-up`)
      caughtUp.push(job.id)
      this.#trigger(job, 'wake')
    }

    // After the catch-up, and told what it already started: a job that was late
    // and also asks to run on wake must not be started twice in the same second.
    this.#firePower(power, new Set(caughtUp))

    this.sync()
    return caughtUp
  }

  /** Before a sleep: we disarm, timers are not reliable. */
  handleSuspend() {
    for (const { timer } of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Session lock. Only jobs marked requiresUnlockedSession are disarmed: the
   * others need nobody and keep running.
   *
   * An execution already started is not interrupted — it began while the
   * session was open, and stopping it midway would do more damage than letting
   * it finish.
   */
  handleLock() {
    if (this.locked) return
    this.locked = true

    const deferred = [...this.deferredJobIds()]
    if (deferred.length > 0) {
      logger.info(`session locked: ${deferred.join(', ')} waiting for unlock`)
    }
    // sync() handles the disarming: the jobs concerned are no longer active.
    this.sync()
  }

  /**
   * Unlock: the jobs set aside go back through the exact logic of a wake-up —
   * a single catch-up, or a skip if catchUpOnWake is disabled.
   * @param {number} now injectable for tests
   */
  handleUnlock(now = Date.now()) {
    this.locked = false
    return this.handleWake(now, { power: 'unlock' })
  }

  /**
   * Jobs asking to run when the machine comes back.
   *
   * Held to the same three rules as any other firing: a paused scheduler starts
   * nothing, a disabled job stays disabled, and a job needing an unlocked
   * session waits for the unlock rather than running against a locked keychain.
   */
  #firePower(event, alreadyRun = new Set()) {
    if (!event || this.isPaused()) return

    for (const job of this.store.getJobs()) {
      if (!job.enabled) continue
      const wants = (job.triggers ?? []).some(
        (trigger) =>
          trigger.type === 'power' && trigger.enabled !== false && trigger.event === event,
      )
      if (!wants) continue

      // The catch-up got there first. Two triggers agreeing that now is the
      // moment is one execution, not two.
      if (alreadyRun.has(job.id)) {
        logger.info(`${job.id}: on ${event}, already caught up`)
        continue
      }

      if (this.#deferredForLock(job)) {
        // It asked for the wake but needs the session open. Dropping it here
        // would mean it never runs at all: a Mac wakes at the lock screen, so
        // that condition is the normal one rather than the exception.
        this.pendingPower.set(job.id, event)
        logger.info(`${job.id}: on ${event}, waiting for the unlock`)
        continue
      }

      logger.info(`${job.id}: on ${event}`)
      this.#trigger(job, event)
    }

    if (!this.locked) this.#flushPendingPower(alreadyRun)
  }

  /** What the lock held back, once there is a session again. */
  #flushPendingPower(alreadyRun = new Set()) {
    if (this.pendingPower.size === 0) return

    for (const [jobId, event] of [...this.pendingPower]) {
      this.pendingPower.delete(jobId)
      const job = this.store.getJob(jobId)
      // Disabled, deleted or edited in the meantime: the promise was to run it
      // when the session came back, not whatever took its place.
      if (!job || !job.enabled || alreadyRun.has(jobId)) continue
      if (this.#deferredForLock(job)) {
        this.pendingPower.set(jobId, event)
        continue
      }
      logger.info(`${jobId}: on ${event}, held since the lock`)
      this.#trigger(job, event)
    }
  }
}

module.exports = { Scheduler }
