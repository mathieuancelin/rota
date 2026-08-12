'use strict'

// One job triggering another.
//
// What makes possible the loop the scheduler cannot express: a job that works
// through a queue item by item and reschedules itself at the end, until there is
// nothing left. A fixed interval will not do — it can neither stop when the
// queue is empty, nor speed up when it is full.
//
// Two modes, and they do not serve the same purpose:
//
//   * **wait** — the called job is part of the caller's work, which needs its
//     result to carry on;
//   * **do not wait** — the caller hands over. This is the rescheduling mode:
//     the current execution finishes, the next starts after the delay.
//
// The deferred launch lives in a `setTimeout` of the main process: it does not
// survive the application closing. It is not a scheduled occurrence, and
// Rota does not pretend otherwise — see README.

const logger = require('../lib/logger')

// An agent stacking up launches endlessly would do more damage than an agent
// looping on itself: the loop, at least, is bounded by maxIterations.
const MAX_TRIGGERS_PER_RUN = 5

const MAX_DELAY_SECONDS = 86_400

/**
 * @param {object} deps
 * @param {import('../config/store').ConfigStore} deps.store
 * @param {import('../runner').Runner} deps.runner
 * @param {import('../scheduler').Scheduler} deps.scheduler
 */
function createJobLauncher({ store, runner, scheduler }) {
  return {
    /**
     * @param {object} options
     * @param {string} options.id job to trigger
     * @param {boolean} [options.wait] wait for it to finish
     * @param {number} [options.delaySeconds]
     * @param {string} options.callerJobId
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{ok: true, deferred?: boolean, entry?: object} | {ok: false, error: string}>}
     */
    async trigger({ id, wait = false, delaySeconds = 0, callerJobId, signal }) {
      const job = store.getJob(id)
      if (!job) {
        const known = store.getJobs().map((candidate) => candidate.id).join(', ')
        return { ok: false, error: `unknown job: ${id}. Known: ${known || 'none'}` }
      }

      // Waiting on itself cannot succeed: either the job refuses simultaneous
      // executions and the launch is ignored, or it accepts them and nested
      // executions stack up to the maximum delay.
      if (wait && id === callerJobId) {
        return {
          ok: false,
          error:
            'a job cannot wait on its own launch. ' +
            'To reschedule itself, launch without waiting, with a delay.',
        }
      }

      const delayMs = Math.max(0, Math.min(delaySeconds, MAX_DELAY_SECONDS)) * 1000

      if (!wait) {
        if (delayMs === 0) {
          const result = await scheduler.runNow(id, { trigger: 'agent' })
          return result.ok ? { ok: true, deferred: false } : { ok: false, error: result.errors.join(' | ') }
        }

        // Deferred and detached: the caller does not wait, and its execution
        // finishes well before. The timer is therefore not tied to its lifetime.
        const timer = setTimeout(() => {
          scheduler
            .runNow(id, { trigger: 'agent' })
            .catch((err) => logger.error(`deferred launch of ${id} failed`, err))
        }, delayMs)
        timer.unref?.()
        logger.info(`${callerJobId} schedules ${id} in ${Math.round(delayMs / 1000)} s`)
        return { ok: true, deferred: true }
      }

      if (delayMs > 0) await sleep(delayMs, signal)
      if (signal?.aborted) return { ok: false, error: 'launch interrupted' }

      // Straight through the runner: we want the history entry, which
      // `scheduler.runNow` does not return.
      const entry = await runner.run(job, { trigger: 'agent' })
      return { ok: true, deferred: false, entry }
    },

    MAX_TRIGGERS_PER_RUN,
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

module.exports = { createJobLauncher, MAX_TRIGGERS_PER_RUN, MAX_DELAY_SECONDS }
