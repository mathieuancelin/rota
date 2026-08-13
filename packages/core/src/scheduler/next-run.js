'use strict'

// Computing occurrences. Pure functions, with no implicit clock and no side
// effects: this is the module whose bug would only show after several days of
// running, hence the one that most deserves tests.
//
// Two kinds of scheduling coexist. An interval counts from the last execution:
// "every five minutes" means five minutes after the previous one finished, so a
// job slower than its interval does not stack up. A cron expression, by
// contrast, designates absolute instants, independent of how long executions
// take; the last execution then only serves to know where to start again from.

const { compileCron, countOccurrences, nextOccurrence } = require('../lib/cron')

const UNIT_MS = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
}

// setTimeout silently truncates beyond 2^31-1 ms (~24.8 days) and then fires
// immediately. Longer delays are therefore cut up.
const MAX_TIMEOUT_MS = 2_147_483_647

// The triggers the scheduler arms. The others — webhook, Discord — wait to be
// come to: they have no occurrence to compute, and a job carrying only those
// consumes no timer.
const TIMED_TYPES = new Set(['interval', 'cron', 'once'])

const isTimed = (trigger) => TIMED_TYPES.has(trigger.type) && trigger.enabled !== false

function intervalMs(trigger) {
  const unit = UNIT_MS[trigger.unit]
  if (!unit) throw new Error(`Unknown scheduling unit: ${trigger.unit}`)
  return trigger.every * unit
}

/**
 * Instant of the next execution. May be in the past if occurrences were missed
 * — it is up to the caller to decide what to do with that.
 *
 * @param {object} trigger trigger of the interval or cron type
 * @param {{lastRunAt?: number|null, anchorAt: number}} reference
 *        lastRunAt: end of the last execution; anchorAt: starting point of a job
 *        that has never run.
 * @returns {number|null} epoch ms, or null if the scheduling describes no
 *          upcoming occurrence — an impossible expression, or an invalid one
 *          despite validation. Better never to start than to start in a loop.
 */
function nextRunAt(trigger, { lastRunAt = null, anchorAt }) {
  const reference = lastRunAt ?? anchorAt
  if (trigger.type === 'once') return onceAt(trigger, lastRunAt)
  if (trigger.type === 'cron') {
    const fields = compileCron(trigger.expression)
    return fields ? nextOccurrence(fields, reference) : null
  }
  return reference + intervalMs(trigger)
}

/**
 * Number of occurrences that passed with no execution — typically after a sleep.
 * @returns {number}
 */
function missedOccurrences(trigger, { lastRunAt = null, anchorAt, now }) {
  const reference = lastRunAt ?? anchorAt
  if (trigger.type === 'once') {
    const at = onceAt(trigger, lastRunAt)
    return at !== null && at <= now ? 1 : 0
  }
  if (trigger.type === 'cron') {
    const fields = compileCron(trigger.expression)
    return fields ? countOccurrences(fields, reference, now) : 0
  }
  const elapsed = now - reference
  const period = intervalMs(trigger)
  if (elapsed < period) return 0
  return Math.floor(elapsed / period)
}

/**
 * The instant a `once` trigger names, or null once it is spent.
 *
 * "Spent" is read from the job's last execution rather than from a flag of its
 * own: if the job has run at or after the instant, that instant has been
 * honoured. It survives a restart, which a flag in memory would not, and it
 * needs nothing new in state.json.
 *
 * A moment already past is not dropped. "Run this once at nine" with the
 * machine switched off at nine means running it when the machine comes back —
 * that is what a person means, and it is the same rule the catch-up applies to
 * every other timed trigger. Deleting the trigger is how you cancel it.
 */
function onceAt(trigger, lastRunAt) {
  const at = Date.parse(trigger.at)
  if (!Number.isFinite(at)) return null
  if (lastRunAt !== null && lastRunAt >= at) return null
  return at
}

/**
 * Delay to hand to setTimeout, bounded to avoid overflow.
 * @returns {{delay: number, final: boolean}} final=false ⇒ it will need re-arming
 */
function timeoutFor(targetAt, now) {
  const remaining = Math.max(0, targetAt - now)
  if (remaining > MAX_TIMEOUT_MS) return { delay: MAX_TIMEOUT_MS, final: false }
  return { delay: remaining, final: true }
}

module.exports = {
  onceAt,
  UNIT_MS,
  MAX_TIMEOUT_MS,
  TIMED_TYPES,
  isTimed,
  intervalMs,
  nextRunAt,
  missedOccurrences,
  timeoutFor,
}
