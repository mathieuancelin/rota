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
const { isTimed, nextRunAt, missedOccurrences, timeoutFor } = require('./next-run')

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

class Scheduler extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config/store').ConfigStore} deps.store
   * @param {import('../state-store').StateStore} deps.state
   * @param {import('../runner').Runner} deps.runner
   */
  constructor({ store, state, runner }) {
    super()
    this.store = store
    this.state = state
    this.runner = runner
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
    for (const { timer } of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** Recomputes every timer from the current state. Idempotent. */
  sync() {
    if (!this.started) return

    const jobs = this.store.getJobs()
    const active = new Set()

    for (const job of jobs) {
      if (!job.enabled || this.isPaused()) continue
      // Session locked: we do not arm, exactly as during a sleep. Unlocking
      // replays the wake-up logic.
      if (this.#deferredForLock(job)) continue
      for (const { trigger, index } of timedTriggers(job)) {
        active.add(keyOf(job.id, index))
        this.#arm(job, trigger, index)
      }
    }

    for (const key of [...this.timers.keys()]) {
      if (!active.has(key)) this.#disarm(key)
    }

    this.emit('changed')
  }

  #anchorFor(key) {
    if (!this.anchors.has(key)) this.anchors.set(key, Date.now())
    return this.anchors.get(key)
  }

  #targetFor(job, trigger, key) {
    const anchorAt = this.#anchorFor(key)

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
      // A cron expression describing no reachable date: nothing to arm.
      // Validation already refuses it, this case should not arise.
      logger.warn(`${job.id}: no upcoming occurrence, trigger ${index} not scheduled`)
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
   * @param {number} now injectable for tests
   */
  handleWake(now = Date.now()) {
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
    return this.handleWake(now)
  }
}

module.exports = { Scheduler }
