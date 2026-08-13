'use strict'

// Watching a file or a directory, for the `path` trigger.
//
// The same shape as config/watcher.js, and for the same reasons — a directory
// rather than a file where there is a choice, because editors save by writing a
// temporary file and renaming it over the target, which detaches a watcher
// placed on the file itself.
//
// What differs is the wait. The configuration watcher debounces by 300 ms,
// which is enough to coalesce one save. Here the event is somebody's work
// landing: unpacking an archive into a directory, a build writing five hundred
// files, a sync tool pulling a folder down. So we wait for the noise to *stop*
// rather than for a fixed delay to pass, and only then say that something
// happened. A job that ran on the first of five hundred events would run
// against a half-written directory.
//
// And one thing measured rather than assumed: on macOS, fs.watch delivers the
// recent past when it attaches. Watching a directory reports a change to the
// directory itself, and a file written just before the watcher existed comes
// through as if it had just landed. Without a guard, every start of the
// scheduler would run every path job — on every restart, for every job. So the
// first settle window after attaching is a warm-up that never fires: a watcher
// reports what happens after it arrives, not the state it found.

const fs = require('node:fs')

const DEFAULT_SETTLE_MS = 2000

/**
 * @param {string} target absolute path to a file or a directory
 * @param {() => void} onSettled called once the changes have stopped
 * @param {{settleMs?: number, fileSystem?: object}} [options]
 * @returns {{close: () => void}}
 * @throws when the path cannot be watched — it does not exist, or it is not
 *   readable. The caller decides what to do about it; here we would only be
 *   able to swallow it.
 */
function watchPath(target, onSettled, { settleMs = DEFAULT_SETTLE_MS, fileSystem = fs } = {}) {
  let timer = null
  let closed = false
  const attachedAt = Date.now()

  // Recursive where the platform allows it: watching a directory without it
  // would miss everything written a level down, which is where files usually
  // land. Node has supported it on Linux since 20, and this needs 22.
  const watcher = fileSystem.watch(target, { recursive: isDirectory(target, fileSystem) })

  const settle = () => {
    if (closed) return
    // The warm-up: what arrives now describes where we came in.
    if (Date.now() - attachedAt < settleMs) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onSettled()
    }, settleMs)
    timer.unref?.()
  }

  watcher.on('change', settle)
  watcher.on('rename', settle)
  // A watched directory that is itself deleted ends the watcher. Nothing to
  // recover here: the next sync() rebuilds what should be watched, and reports
  // the path as unwatchable if it is still gone.
  watcher.on('error', () => close())

  function close() {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    timer = null
    try {
      watcher.close()
    } catch {
      // Already closed by the error that brought us here.
    }
  }

  return { close }
}

function isDirectory(target, fileSystem) {
  try {
    return fileSystem.statSync(target).isDirectory()
  } catch {
    return false
  }
}

module.exports = { watchPath, DEFAULT_SETTLE_MS }
