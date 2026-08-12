'use strict'

// Sleep and lock detection with no powerMonitor to tell us anything.
//
// Every clock and every timer is injected: a test that had to wait twenty
// seconds to observe a twenty-second threshold would be a test nobody runs.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createDriftDetector, watchPower } = require('../src/power')

const TICK = 1000
const THRESHOLD = 20_000

test('a tick that arrives on time is not a sleep', () => {
  const drift = createDriftDetector({ tickMs: TICK, thresholdMs: THRESHOLD, start: 0 })
  assert.equal(drift.observe(1005), null)
})

test('a busy machine overshooting by a second is not a sleep either', () => {
  const drift = createDriftDetector({ tickMs: TICK, thresholdMs: THRESHOLD, start: 0 })
  assert.equal(drift.observe(2000), null)
})

test('a gap past the threshold is time the machine spent away', () => {
  const drift = createDriftDetector({ tickMs: TICK, thresholdMs: THRESHOLD, start: 0 })
  assert.equal(drift.observe(45_000), 45_000)
})

test('the threshold is on the overshoot, not on the whole gap', () => {
  const drift = createDriftDetector({ tickMs: TICK, thresholdMs: THRESHOLD, start: 0 })
  // 21 s elapsed is a 20 s overshoot: exactly at the threshold, and reported.
  assert.equal(drift.observe(21_000), 21_000)

  const other = createDriftDetector({ tickMs: TICK, thresholdMs: THRESHOLD, start: 0 })
  assert.equal(other.observe(20_999), null)
})

test('each observation measures from the previous one', () => {
  const drift = createDriftDetector({ tickMs: TICK, thresholdMs: THRESHOLD, start: 0 })
  assert.equal(drift.observe(30_000), 30_000)
  // Back to a normal cadence: the long gap is behind us, not still counted.
  assert.equal(drift.observe(31_000), null)
})

/** A scheduler that records what was asked of it, and in what order. */
function recordingScheduler() {
  const calls = []
  return {
    calls,
    handleSuspend: () => calls.push('suspend'),
    handleWake: () => (calls.push('wake'), ['nightly']),
    handleLock: () => calls.push('lock'),
    handleUnlock: () => (calls.push('unlock'), []),
  }
}

test('a daemon starting with the screen locked holds its jobs back', () => {
  const scheduler = recordingScheduler()
  const power = watchPower(scheduler, { readLocked: () => true, now: () => 0 })
  assert.deepEqual(scheduler.calls, ['lock'])
  power.close()
})

test('a daemon starting with the screen open does not touch the scheduler', () => {
  const scheduler = recordingScheduler()
  const power = watchPower(scheduler, { readLocked: () => false, now: () => 0 })
  assert.deepEqual(scheduler.calls, [])
  power.close()
})

test('waking disarms the stale timers before recomputing', async () => {
  const scheduler = recordingScheduler()
  let clock = 0

  const power = watchPower(scheduler, {
    readLocked: () => false,
    now: () => clock,
    // A one-millisecond tick with a five-millisecond threshold: the same rule,
    // at a speed a test can wait for.
    tickMs: 1,
    thresholdMs: 5,
    lockPollMs: 60_000,
  })

  // The tick fires while the clock says a minute went by.
  clock = 60_000
  await new Promise((resolve) => setTimeout(resolve, 20))
  power.close()

  // The order matters: the application is told before it sleeps and disarms its
  // timers then. Having had no warning, we disarm on the way out — otherwise a
  // timer whose deadline passed during the sleep fires on its own, outside the
  // catch-up rule that is about to decide whether it should run at all.
  assert.deepEqual(scheduler.calls.slice(0, 2), ['suspend', 'wake'])
})

test('locking and unlocking are reported once each, on the transition', async () => {
  const scheduler = recordingScheduler()
  let locked = false

  const power = watchPower(scheduler, {
    readLocked: () => locked,
    now: () => 0,
    tickMs: 60_000,
    lockPollMs: 1,
  })

  locked = true
  await new Promise((resolve) => setTimeout(resolve, 15))
  locked = false
  await new Promise((resolve) => setTimeout(resolve, 15))
  power.close()

  // Polling every millisecond over thirty of them: without the transition check
  // this would hold dozens of entries.
  assert.deepEqual(scheduler.calls, ['lock', 'unlock'])
})

test('closing stops both timers', async () => {
  const scheduler = recordingScheduler()
  let locked = false
  const power = watchPower(scheduler, {
    readLocked: () => locked,
    now: () => 0,
    tickMs: 1,
    thresholdMs: 1,
    lockPollMs: 1,
  })
  power.close()

  locked = true
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.deepEqual(scheduler.calls, [])
})
