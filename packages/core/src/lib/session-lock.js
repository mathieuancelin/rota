'use strict'

// Is the screen locked?
//
// The question matters because locking does not stop the machine, but it makes
// unavailable everything that assumes somebody is present — first among them the
// keychain, and therefore SSH key passphrases. A job that pushes to a remote
// fails for as long as the screen is locked, with an error that blames the
// server.
//
// Neither system announces the current state, only transitions, so both are
// read rather than listened to:
//
//   - **macOS** publishes it in the session dictionary, which `ioreg` renders as
//     text. This is also what an application restarted with the screen already
//     locked needs: `powerMonitor` would report nothing until the next unlock,
//     and the jobs meant to be held back would all fire immediately.
//   - **Linux** has `logind`, which keeps a `LockedHint` per session. It is a
//     hint in the honest sense: it is true when the screen locker bothered to
//     tell logind, which GNOME and KDE both do. A desktop with a locker that
//     does not report reads as unlocked, and jobs run — see the default below.
//
// No dependency on Electron: this module is directly testable.

const { execFileSync } = require('node:child_process')

const IOREG = '/usr/sbin/ioreg'
const LOCKED = /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/

const LOGINCTL = 'loginctl'

/**
 * @param {{platform?: string, run?: () => string, env?: object}} [options] injectable for tests
 * @returns {boolean} false when the state cannot be determined — we would rather
 *          start one job too many than hold one back indefinitely on a failed
 *          read.
 */
function isSessionLocked({ platform = process.platform, run = null, env = process.env } = {}) {
  if (platform === 'darwin') {
    try {
      // The key is only published by a graphical session; its absence, like that
      // of the binary, counts as "unlocked".
      return LOCKED.test((run ?? readIoreg)())
    } catch {
      return false
    }
  }

  if (platform === 'linux') {
    try {
      return (run ?? (() => readLockedHint(env)))().trim().toLowerCase() === 'yes'
    } catch {
      // No logind, no session, no loginctl on PATH: all of them mean we cannot
      // tell, and cannot tell means we do not hold anything back.
      return false
    }
  }

  return false
}

function readIoreg() {
  return execFileSync(IOREG, ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 2000 })
}

/**
 * `loginctl show-session <id> -p LockedHint --value` answers "yes" or "no".
 *
 * With no XDG_SESSION_ID — a daemon started outside a graphical session, which
 * is the usual case for rotad — the argument is omitted and logind resolves
 * the caller's own session. A daemon that has none then errors, which the caller
 * reads as unlocked, which is right: a machine with no session has no screen to
 * lock.
 */
function readLockedHint(env) {
  const session = env.XDG_SESSION_ID
  return execFileSync(LOGINCTL, [
    'show-session',
    ...(session ? [session] : []),
    '-p',
    'LockedHint',
    '--value',
  ], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
}

module.exports = { isSessionLocked }
