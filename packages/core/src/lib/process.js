'use strict'

// Stopping a child process and its descendants.
//
// Children are started in their own process group: without that, a shell script
// delegating to other commands would leave orphans behind it when the timeout
// hits. The signal therefore goes to the whole group, and the child alone is
// only a fallback.

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* the process is already gone */
    }
  }
}

module.exports = { killGroup }
