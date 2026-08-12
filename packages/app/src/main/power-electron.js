'use strict'

// Wiring the scheduler to macOS's power and session events.
//
// Timers do not elapse during sleep: on waking they would all fire at once. So
// we disarm them before sleep and let the scheduler decide on the catch-up when
// it wakes.
//
// Locking the session does not stop the machine, but it makes unavailable
// everything that assumes a user is present — first among them the keychain,
// hence SSH key passphrases. Jobs that declare it are treated as during sleep:
// nothing while locked, catch-up on unlock.

const { powerMonitor } = require('electron')
const { logger, isSessionLocked } = require('@rota/core')

/**
 * @param {import('@rota/core').Scheduler} scheduler
 * @param {{readLocked?: () => boolean}} [options] injectable for tests
 * @returns {{close: () => void}}
 */
function watchPower(scheduler, { readLocked = isSessionLocked } = {}) {
  // To be wired before the scheduler starts: without this initial state, a
  // restart with the screen locked would immediately start the jobs to hold back.
  if (readLocked()) {
    logger.info('starting up with the session locked')
    scheduler.handleLock()
  }

  const report = (caughtUp) => {
    if (caughtUp.length > 0) logger.info(`catching up: ${caughtUp.join(', ')}`)
  }

  const onSuspend = () => {
    logger.info('going to sleep: timers disarmed')
    scheduler.handleSuspend()
  }

  const onResume = () => {
    logger.info('waking up: recomputing occurrences')
    report(scheduler.handleWake())
  }

  const onLock = () => {
    logger.info('session locked')
    scheduler.handleLock()
  }

  // Unlocking is also a good moment to check we have not drifted (clock changed,
  // wake with no resume event, and so on).
  const onUnlock = () => {
    logger.info('session unlocked: recomputing occurrences')
    report(scheduler.handleUnlock())
  }

  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  powerMonitor.on('lock-screen', onLock)
  powerMonitor.on('unlock-screen', onUnlock)

  return {
    close() {
      powerMonitor.off('suspend', onSuspend)
      powerMonitor.off('resume', onResume)
      powerMonitor.off('lock-screen', onLock)
      powerMonitor.off('unlock-screen', onUnlock)
    },
  }
}

module.exports = { watchPower }
