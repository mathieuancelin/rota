'use strict'

// Persistent execution state: last runs and error acknowledgement.
//
// Distinct from config.json, which is user content editable by hand. state.json
// is written by the application; losing it is harmless, it merely pushes the
// next occurrences back.
//
// Writes are batched: a job running every 10 seconds must not cause a
// synchronous disk write on every cycle.

const { readJson, writeJsonAtomic } = require('./lib/json-file')
const logger = require('./lib/logger')

const FLUSH_DELAY_MS = 1000
const MAX_RECENT_ERRORS = 20

class StateStore {
  constructor(filePath) {
    this.filePath = filePath
    this.state = { lastRuns: {}, recentErrors: [], acknowledgedErrorsAt: null }
    this.flushTimer = null
    this.flushing = null
  }

  async load() {
    const read = await readJson(this.filePath)
    if (read.ok && read.value && typeof read.value === 'object') {
      this.state = {
        lastRuns: read.value.lastRuns ?? {},
        recentErrors: read.value.recentErrors ?? [],
        acknowledgedErrorsAt: read.value.acknowledgedErrorsAt ?? null,
      }
    } else if (!read.ok && !read.missing) {
      // We start from a clean state rather than refusing to start.
      logger.warn(`state.json unreadable (${read.error.message}), reset`)
    }
    return this.state
  }

  getLastRun(jobId) {
    return this.state.lastRuns[jobId] ?? null
  }

  lastRunByJob() {
    return new Map(Object.entries(this.state.lastRuns))
  }

  /** @param {{at: string, status: string, durationMs: number, executionId: string}} run */
  recordRun(jobId, run) {
    this.state.lastRuns[jobId] = run
    this.#scheduleFlush()
  }

  recordError({ jobId, name, at, executionId, status }) {
    this.state.recentErrors.unshift({ jobId, name, at, executionId, status })
    this.state.recentErrors = this.state.recentErrors.slice(0, MAX_RECENT_ERRORS)
    this.#scheduleFlush()
  }

  getRecentErrors() {
    return this.state.recentErrors
  }

  getAcknowledgedAt() {
    return this.state.acknowledgedErrorsAt
  }

  acknowledgeErrors() {
    this.state.acknowledgedErrorsAt = new Date().toISOString()
    this.#scheduleFlush()
  }

  /** Removes the traces of jobs that no longer exist. */
  prune(existingJobIds) {
    const keep = new Set(existingJobIds)
    let changed = false
    for (const jobId of Object.keys(this.state.lastRuns)) {
      if (!keep.has(jobId)) {
        delete this.state.lastRuns[jobId]
        changed = true
      }
    }
    const before = this.state.recentErrors.length
    this.state.recentErrors = this.state.recentErrors.filter((e) => keep.has(e.jobId))
    if (changed || this.state.recentErrors.length !== before) this.#scheduleFlush()
  }

  #scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush().catch((err) => logger.error('writing state.json failed', err))
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  /** Writes immediately. Concurrent calls share the same write. */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushing) return this.flushing
    this.flushing = writeJsonAtomic(this.filePath, this.state).finally(() => {
      this.flushing = null
    })
    return this.flushing
  }
}

module.exports = { StateStore }
