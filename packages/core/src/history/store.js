'use strict'

// Execution history, one JSON Lines file per job.
//
// Appending is pure append: an execution never rewrites the whole file.
// Retention is done by deferred compaction — copying the file on every
// execution would cost more than the space it saves.

const fs = require('node:fs/promises')
const path = require('node:path')

const logger = require('../lib/logger')
const outputs = require('./outputs')
const { readLastLines, countLines } = require('./tail')
const { truncateToBytes } = require('../runner/output')

// We only compact past 20% overshoot, to amortise the cost.
const COMPACTION_SLACK = 1.2
const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

class HistoryStore {
  /**
   * @param {{historyDir: string, outputsDir: string}} paths
   * @param {{getDefaults: () => {inlineOutputBytes: number, retainExecutions: number}}} deps
   */
  constructor(paths, { getDefaults }) {
    this.historyDir = paths.historyDir
    this.outputsDir = paths.outputsDir
    this.getDefaults = getDefaults
    /** @type {Map<string, number>} known line count, per job */
    this.lineCounts = new Map()
    /** Serialises the writes of a single job. */
    this.queues = new Map()
  }

  #file(jobId) {
    if (!JOB_ID.test(jobId)) throw new Error(`Invalid job identifier: ${jobId}`)
    return path.join(this.historyDir, `${jobId}.jsonl`)
  }

  /** Chains a job's operations to avoid interleaved writes. */
  #enqueue(jobId, task) {
    const previous = this.queues.get(jobId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(
      jobId,
      next.catch(() => {}),
    )
    return next
  }

  /**
   * Appends an execution. Large outputs go to a separate file.
   * @returns {Promise<object>} the entry as it was written
   */
  async append(entry, job = null) {
    return this.#enqueue(entry.jobId, async () => {
      const defaults = this.getDefaults()
      const stored = await this.#externalizeOutputs(entry, defaults.inlineOutputBytes)

      await fs.mkdir(this.historyDir, { recursive: true })
      await fs.appendFile(this.#file(entry.jobId), `${JSON.stringify(stored)}\n`, 'utf8')

      const retain = job?.history?.retainExecutions ?? defaults.retainExecutions
      await this.#trackAndCompact(entry.jobId, retain)
      return stored
    })
  }

  async #externalizeOutputs(entry, inlineLimit) {
    const stored = { ...entry, outputFiles: null }

    for (const stream of ['stdout', 'stderr']) {
      const text = entry[stream] ?? ''
      if (Buffer.byteLength(text, 'utf8') <= inlineLimit) continue

      try {
        const relative = await outputs.write(this.outputsDir, entry.executionId, stream, text)
        const excerpt = truncateToBytes(text, inlineLimit)
        stored[stream] = excerpt.text
        stored[`${stream}Truncated`] = true
        stored.outputFiles = { ...(stored.outputFiles ?? {}), [stream]: relative }
      } catch (err) {
        // An excerpt with no separate file beats an untracked execution.
        logger.error(`writing the ${stream} output failed`, err)
        stored[stream] = truncateToBytes(text, inlineLimit).text
        stored[`${stream}Truncated`] = true
      }
    }
    return stored
  }

  /** Separate outputs of a job whose history is about to be removed. */
  async #removeOutputsOf(jobId) {
    let raw
    try {
      raw = await fs.readFile(this.#file(jobId), 'utf8')
    } catch {
      return
    }
    const executionIds = raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map(executionIdOf)
      .filter(Boolean)

    if (executionIds.length > 0) await outputs.removeFor(this.outputsDir, executionIds)
  }

  async #trackAndCompact(jobId, retain) {
    let count = this.lineCounts.get(jobId)
    if (count === undefined) count = await countLines(this.#file(jobId))
    else count += 1
    this.lineCounts.set(jobId, count)

    if (count <= retain * COMPACTION_SLACK) return
    await this.#compact(jobId, retain)
  }

  async #compact(jobId, retain) {
    const filePath = this.#file(jobId)
    const raw = await fs.readFile(filePath, 'utf8')
    const lines = raw.split('\n').filter((line) => line.length > 0)
    if (lines.length <= retain) {
      this.lineCounts.set(jobId, lines.length)
      return
    }

    const dropped = lines.slice(0, lines.length - retain)
    const kept = lines.slice(-retain)

    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, `${kept.join('\n')}\n`, 'utf8')
    await fs.rename(tmp, filePath)
    this.lineCounts.set(jobId, kept.length)

    await outputs.removeFor(this.outputsDir, dropped.map(executionIdOf).filter(Boolean))
    logger.info(`history of ${jobId} compacted: ${dropped.length} entry(ies) removed`)
  }

  /**
   * A page of history, from the most recent to the oldest.
   * @param {string} jobId
   * @param {{limit?: number, offset?: number}} options
   */
  async read(jobId, { limit = 50, offset = 0 } = {}) {
    const wanted = offset + limit
    const { lines, reachedStart } = await readLastLines(this.#file(jobId), wanted + 1)

    const entries = lines
      .slice(offset, wanted)
      .map(parseEntry)
      .filter(Boolean)

    return {
      entries,
      hasMore: lines.length > wanted || !reachedStart,
    }
  }

  /** Reads the full output of an execution stored separately. */
  async readOutput(relative) {
    if (typeof relative !== 'string' || relative.length === 0) {
      return { ok: false, error: 'Missing output path' }
    }
    return outputs.read(this.historyDir, relative)
  }

  /** Deletes the history files of jobs that no longer exist. */
  async prune(existingJobIds) {
    const keep = new Set(existingJobIds)
    let entries
    try {
      entries = await fs.readdir(this.historyDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const jobId = path.basename(name, '.jsonl')
      if (keep.has(jobId)) continue

      // Outputs too large live in separate files, named after the execution:
      // nothing in their name says which job they belong to. The JSONL must
      // therefore be read before being removed, otherwise they would stay on
      // disk with nothing left to designate them.
      await this.#removeOutputsOf(jobId)

      await fs.rm(path.join(this.historyDir, name), { force: true })
      this.lineCounts.delete(jobId)
      logger.info(`history of ${jobId} deleted (job gone)`)
    }
  }
}

function parseEntry(line) {
  try {
    return JSON.parse(line)
  } catch {
    // A line truncated by an abrupt stop must not break the display.
    return null
  }
}

function executionIdOf(line) {
  return parseEntry(line)?.executionId ?? null
}

module.exports = { HistoryStore, COMPACTION_SLACK }
