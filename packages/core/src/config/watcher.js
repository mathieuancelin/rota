'use strict'

// Watching config.json, jobs/ and profiles/.
//
// We watch directories rather than files: editors often save by writing a
// temporary file followed by a rename, which detaches a watcher placed on the
// file itself. The debounce coalesces the burst of events from a single save,
// and since the store systematically re-reads the whole directory, the exact
// semantics of the event are indifferent to us.

const fs = require('node:fs')

const DEBOUNCE_MS = 300

/**
 * @param {{root: string, jobsDir: string}} paths
 * @param {() => void} onChange called after things settle
 * @returns {{close: () => void}}
 */
function watchConfig(paths, onChange, { debounceMs = DEBOUNCE_MS } = {}) {
  const watchers = []
  let timer = null
  let closed = false

  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  const watch = (dir, filter) => {
    try {
      const watcher = fs.watch(dir, (_event, fileName) => {
        if (fileName && filter && !filter(fileName)) return
        schedule()
      })
      watcher.on('error', () => {
        /* directory deleted or renamed: we simply stop watching */
      })
      watchers.push(watcher)
    } catch {
      // The directory does not exist yet: ensureStructure() will have created it
      // at startup, and a missing watcher must not stop the application running.
    }
  }

  const json = (name) => name.endsWith('.json') && !name.startsWith('.')

  watch(paths.root, (name) => name === 'config.json')
  watch(paths.jobsDir, json)
  // A profile edited changes every job that points at it, and the store
  // re-resolves them all on reload: watching here is what makes that happen
  // without any notification of our own between the two.
  watch(paths.profilesDir, json)

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}

module.exports = { watchConfig }
