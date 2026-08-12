'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  intervalMs,
  nextRunAt,
  missedOccurrences,
  timeoutFor,
  MAX_TIMEOUT_MS,
} = require('../src/scheduler/next-run')

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

test('every unit is converted to milliseconds', () => {
  assert.equal(intervalMs({ every: 30, unit: 'seconds' }), 30_000)
  assert.equal(intervalMs({ every: 5, unit: 'minutes' }), 5 * MINUTE)
  assert.equal(intervalMs({ every: 2, unit: 'hours' }), 2 * HOUR)
  assert.equal(intervalMs({ every: 1, unit: 'days' }), DAY)
})

test('an unknown unit throws rather than producing NaN', () => {
  assert.throws(() => intervalMs({ every: 1, unit: 'semaines' }), /Unknown scheduling unit/)
})

test('a job never run starts from its anchor', () => {
  const anchorAt = 1_000_000
  assert.equal(
    nextRunAt({ every: 5, unit: 'minutes' }, { anchorAt }),
    anchorAt + 5 * MINUTE,
  )
})

test('a job that has already run carries on from its last execution', () => {
  const lastRunAt = 5_000_000
  assert.equal(
    nextRunAt({ every: 1, unit: 'hours' }, { lastRunAt, anchorAt: 0 }),
    lastRunAt + HOUR,
  )
})

test('the occurrence may be in the past — the caller decides', () => {
  const lastRunAt = 1000
  const next = nextRunAt({ every: 5, unit: 'minutes' }, { lastRunAt, anchorAt: 0 })
  assert.ok(next < lastRunAt + 10 * MINUTE)
  assert.equal(next, lastRunAt + 5 * MINUTE)
})

test('nothing is missed until the interval has run out', () => {
  const lastRunAt = 0
  const trigger = { every: 5, unit: 'minutes' }
  assert.equal(missedOccurrences(trigger, { lastRunAt, anchorAt: 0, now: 0 }), 0)
  assert.equal(missedOccurrences(trigger, { lastRunAt, anchorAt: 0, now: 4 * MINUTE }), 0)
  // Exactly at the occurrence: it is due.
  assert.equal(missedOccurrences(trigger, { lastRunAt, anchorAt: 0, now: 5 * MINUTE }), 1)
})

test('a night asleep counts every skipped occurrence', () => {
  const trigger = { every: 5, unit: 'minutes' }
  // 8 hours of sleep for a job running every 5 minutes.
  const missed = missedOccurrences(trigger, { lastRunAt: 0, anchorAt: 0, now: 8 * HOUR })
  assert.equal(missed, 96)
})

test('a daily job does not skip a whole day without saying so', () => {
  const missed = missedOccurrences(
    { every: 1, unit: 'days' },
    { lastRunAt: 0, anchorAt: 0, now: 2 * DAY + HOUR },
  )
  assert.equal(missed, 2)
})

test('timeoutFor returns the remaining delay when it fits in setTimeout', () => {
  assert.deepEqual(timeoutFor(1000, 0), { delay: 1000, final: true })
})

test('an occurrence already past gives a zero delay, never a negative one', () => {
  assert.deepEqual(timeoutFor(500, 1000), { delay: 0, final: true })
})

test("past setTimeout's ceiling, the delay is cut into pieces", () => {
  // 40 days: setTimeout would silently truncate and fire at once.
  const target = 40 * DAY
  const first = timeoutFor(target, 0)
  assert.deepEqual(first, { delay: MAX_TIMEOUT_MS, final: false })

  const second = timeoutFor(target, MAX_TIMEOUT_MS)
  assert.equal(second.final, true)
  assert.equal(second.delay, target - MAX_TIMEOUT_MS)
})

// --- cron scheduling ------------------------------------------------------------
//
// An interval counts from the last execution; a cron expression designates
// absolute instants, and the last execution then only says where to start again
// from.

const CRON = { type: 'cron', expression: '0 9 * * *' }
const localAt = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()

test('the next cron occurrence does not depend on how long the execution took', () => {
  const lastRunAt = localAt(2026, 3, 10, 9, 47) // a 47-minute execution
  assert.equal(
    nextRunAt(CRON, { lastRunAt, anchorAt: 0 }),
    localAt(2026, 3, 11, 9, 0),
    'toujours 9h le lendemain, pas 9h47',
  )
})

test('a cron job never run starts from its anchor', () => {
  assert.equal(
    nextRunAt(CRON, { anchorAt: localAt(2026, 3, 10, 7, 0) }),
    localAt(2026, 3, 10, 9, 0),
  )
})

test('the missed cron occurrences are counted', () => {
  const missed = missedOccurrences(CRON, {
    lastRunAt: localAt(2026, 3, 10, 9, 0),
    anchorAt: 0,
    now: localAt(2026, 3, 13, 12, 0),
  })
  assert.equal(missed, 3, 'les 11, 12 et 13 mars')
})

test('a cron job on time has missed nothing', () => {
  const missed = missedOccurrences(CRON, {
    lastRunAt: localAt(2026, 3, 10, 9, 0),
    anchorAt: 0,
    now: localAt(2026, 3, 10, 18, 0),
  })
  assert.equal(missed, 0)
})

test('an impossible expression produces no occurrence', () => {
  const impossible = { type: 'cron', expression: '0 0 30 2 *' }
  assert.equal(nextRunAt(impossible, { anchorAt: localAt(2026, 3, 1) }), null)
})

// An invalid expression should not get past validation. If it did, never starting
// beats starting in a loop.
test('an invalid expression produces neither an occurrence nor a catch-up', () => {
  const broken = { type: 'cron', expression: 'n’importe quoi' }
  assert.equal(nextRunAt(broken, { anchorAt: Date.now() }), null)
  assert.equal(missedOccurrences(broken, { anchorAt: 0, now: Date.now() }), 0)
})
