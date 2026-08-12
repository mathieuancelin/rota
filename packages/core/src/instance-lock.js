'use strict'

// One engine per configuration directory.
//
// Two schedulers on the same directory overwrite each other's state.json, fire
// every trigger twice, and interleave two runs into one JSONL. Nothing warns
// you: the symptom is a job that ran twice at three in the morning, and a
// history that cannot explain it.
//
// This lives in the engine rather than in the daemon because the daemon is not
// the only thing that can hold a directory — the application embeds the same
// engine, and "a daemon and an application on one directory" is exactly the
// double scheduler this prevents.
//
// Why not flock: Node exposes none. The mitigation is the usual one — create
// the file with O_EXCL so that two racing processes cannot both win, write the
// PID into it, and treat a file whose PID is no longer alive as stale. That
// last part is what a plain PID file gets wrong: flock is released by the
// kernel however the process died, a file is not, and a machine that lost power
// mid-run would otherwise refuse to start ever again.

const fs = require('node:fs')
const path = require('node:path')

const LOCK_FILENAME = 'rota.lock'

/**
 * @param {number} pid
 * @returns {boolean} whether a process with this identifier is still around.
 *   Signal 0 checks for existence without delivering anything. EPERM means it
 *   exists and belongs to somebody else, which for our purposes is alive.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

class InstanceLockError extends Error {
  constructor(message, { file, holder }) {
    super(message)
    this.name = 'InstanceLockError'
    this.code = 'ELOCKED'
    this.file = file
    this.holder = holder
  }
}

/**
 * Takes the lock on a configuration directory.
 *
 * @param {{root: string}} paths
 * @param {object} [options]
 * @param {number} [options.pid] who to record as the holder — injectable for tests.
 * @param {(pid: number) => boolean} [options.isAlive] injectable for tests.
 * @param {string} [options.role] what is holding it, for the refusal message.
 * @returns {{file: string, release: () => void}}
 * @throws {InstanceLockError} when another live process holds it. The message
 *   names the holder: "already running" without saying what is running is a
 *   message that sends people to Activity Monitor.
 */
function acquireInstanceLock(
  paths,
  { pid = process.pid, isAlive = isProcessAlive, role = 'rota' } = {},
) {
  const file = path.join(paths.root, LOCK_FILENAME)
  const mine = JSON.stringify({ pid, role, since: new Date().toISOString() })

  // Two attempts at most: the second is for the case where we found a stale
  // file and removed it. A third would mean somebody is fighting us for the
  // directory, and losing that race is the correct outcome.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = fs.openSync(file, 'wx')
      fs.writeSync(handle, mine)
      fs.closeSync(handle)
      return { file, release: () => release(file, pid) }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      const holder = readHolder(file)
      if (holder && isAlive(holder.pid)) {
        throw new InstanceLockError(
          `another Rota engine is already running on ${paths.root} ` +
            `(${holder.role ?? 'unknown'}, pid ${holder.pid}${
              holder.since ? `, since ${holder.since}` : ''
            }). Stop it, or point this one at another directory with --config-dir.`,
          { file, holder },
        )
      }

      // Stale: either unreadable, or naming a process that is gone. Both mean
      // the holder died without tidying up.
      try {
        fs.unlinkSync(file)
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr
      }
    }
  }

  throw new InstanceLockError(`could not take the lock on ${paths.root}`, { file, holder: null })
}

/** @returns {{pid: number, role?: string, since?: string}|null} */
function readHolder(file) {
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isInteger(holder?.pid) ? holder : null
  } catch {
    // An empty or half-written file is one a process died in the middle of
    // writing. There is nothing to respect in it.
    return null
  }
}

/** Releases the lock, but only if it is still ours: never delete a successor's. */
function release(file, pid) {
  const holder = readHolder(file)
  if (holder && holder.pid !== pid) return
  try {
    fs.unlinkSync(file)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

module.exports = { acquireInstanceLock, isProcessAlive, InstanceLockError, LOCK_FILENAME }
