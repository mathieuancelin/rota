'use strict'

// Sleep and session lock, without Electron.
//
// `powerMonitor` does not exist outside Electron, and nothing on macOS will
// call us when the lid closes. So both facts are inferred rather than received:
//
//   - **Sleep** by the gap between two ticks. Timers do not elapse while the
//     machine is away, so a one-second interval that comes back twenty seconds
//     late is twenty seconds the machine spent asleep. A busy machine overshoots
//     by milliseconds; nothing legitimate overshoots by twenty seconds.
//   - **The screen lock** by polling, because macOS publishes the state in the
//     session dictionary but announces no transition. `ioreg` takes a few
//     milliseconds, so five seconds between reads costs nothing and is well
//     inside the time it takes anyone to unlock and expect their jobs back.
//
// The application gets both of these for free and earlier — it is told before
// the machine sleeps, and can disarm its timers. We are told afterwards, which
// is why `handleSuspend()` is called on the way *out* of sleep: see below.

const { isSessionLocked, logger } = require('@rota/core')

const TICK_MS = 1000

// Past this, the gap between two ticks is time the machine spent away.
const SLEEP_THRESHOLD_MS = 20_000

const LOCK_POLL_MS = 5000

/**
 * Reports how far a tick overshot, when that is far enough to mean sleep.
 *
 * Kept separate from the timer that drives it so the rule can be tested without
 * anyone waiting twenty seconds.
 *
 * @param {{tickMs: number, thresholdMs: number, start: number}} options
 */
function createDriftDetector({ tickMs = TICK_MS, thresholdMs = SLEEP_THRESHOLD_MS, start }) {
  let last = start
  return {
    /** @returns {number|null} the whole gap, or null if the tick was ordinary. */
    observe(now) {
      const elapsed = now - last
      last = now
      const overshoot = Math.max(0, elapsed - tickMs)
      return overshoot >= thresholdMs ? elapsed : null
    },
  }
}

/**
 * Watches for what the application receives as `powerMonitor` events, and calls
 * the same three methods on the scheduler.
 *
 * @param {import('@rota/core').Scheduler} scheduler
 * @param {object} [options] all injectable, because a test must not sleep.
 * @returns {{close: () => void}}
 */
function watchPower(
  scheduler,
  {
    readLocked = isSessionLocked,
    now = () => Date.now(),
    tickMs = TICK_MS,
    thresholdMs = SLEEP_THRESHOLD_MS,
    lockPollMs = LOCK_POLL_MS,
  } = {},
) {
  // Read before the timers start, for the reason the session-lock module exists:
  // a daemon started with the screen locked would otherwise believe the session
  // open and immediately fire the very jobs it is meant to hold back.
  let locked = readLocked()
  if (locked) {
    logger.info('starting up with the session locked')
    scheduler.handleLock()
  }

  const report = (caughtUp) => {
    if (caughtUp?.length > 0) logger.info(`catching up: ${caughtUp.join(', ')}`)
  }

  const drift = createDriftDetector({ tickMs, thresholdMs, start: now() })

  const tick = setInterval(() => {
    const gap = drift.observe(now())
    if (gap === null) return

    logger.info(`waking up after about ${Math.round(gap / 1000)} s: recomputing occurrences`)
    // The application disarms its timers *before* sleeping, on the suspend
    // event. We have no such warning, so we do it here: any timer still pending
    // is one whose deadline passed while we were away, and letting it fire on
    // its own would run the job outside of the catch-up rule that is about to
    // decide whether it should run at all.
    scheduler.handleSuspend()
    report(scheduler.handleWake())
  }, tickMs)
  tick.unref?.()

  const poll = setInterval(() => {
    const current = readLocked()
    if (current === locked) return
    locked = current

    if (current) {
      logger.info('session locked')
      scheduler.handleLock()
    } else {
      logger.info('session unlocked: recomputing occurrences')
      report(scheduler.handleUnlock())
    }
  }, lockPollMs)
  poll.unref?.()

  return {
    close() {
      clearInterval(tick)
      clearInterval(poll)
    },
  }
}

module.exports = { watchPower, createDriftDetector, TICK_MS, SLEEP_THRESHOLD_MS, LOCK_POLL_MS }
