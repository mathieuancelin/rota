'use strict'

// The work queue: concrete items waiting for a job to process them.
//
// A job says what can run; a work item says what has to be processed right now.
// Until this file existed the distinction had nowhere to live, and an agent that
// worked through a queue kept the queue in its own memory — invisible from the
// outside, lost on a crash, and impossible to feed from anywhere else.
//
// One file per item, under work/<jobId>/<itemId>.json. A single file holding the
// whole queue would be rewritten on every transition, and there are four of them
// per item; here a claim writes one small file and touches nothing else. It is
// also the layout of the conversations, for the same reason.
//
// **The claim is a synchronous function call, not a protocol.** Rota is a single
// process — instance-lock.js sees to that — so choosing an item and marking it
// claimed happens with no `await` in between, and nothing can interleave. A
// lease, a compare-and-swap or a claim token would be machinery for a
// concurrency that cannot occur. If Rota ever runs as several processes, this is
// the paragraph that has to be revisited first.

const fsp = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')

const { readJson, writeJsonAtomic } = require('../lib/json-file')
const logger = require('../lib/logger')

const STATUS = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

// A status from which the item will not move again on its own.
const TERMINAL = new Set([STATUS.DONE, STATUS.FAILED, STATUS.CANCELLED])

const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
// Wider than a job identifier: an integration names its items after what they
// came from — "gh-issue-421", "2026-08-14.report" — and that is what makes
// creation idempotent. No slash, so a name is always one path segment.
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// The input travels to the job as an environment variable, and ARG_MAX bounds
// the whole environment. Well under the limit, and large enough that nobody
// meets it while passing a reference to the real work — which is what an input
// is for. The same ceiling bounds the result, which is stored, not passed.
const MAX_INPUT_BYTES = 32 * 1024

/** Items are served oldest first; the identifier only breaks a tie. */
const byArrival = (a, b) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)

function generateId() {
  return `wi_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

function sizeOf(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

/**
 * The stored shape, whatever the caller passed. Written out in full rather than
 * spread from the argument: a field that is not in this list does not reach the
 * disk, and the model stays the one the tests describe.
 */
function shape(item) {
  return {
    id: item.id,
    jobId: item.jobId,
    status: item.status,
    input: item.input ?? {},
    result: item.result ?? null,
    error: item.error ?? null,
    attempts: item.attempts ?? 0,
    availableAt: item.availableAt ?? null,
    executionId: item.executionId ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

class WorkStore extends EventEmitter {
  /** @param {string} workDir */
  constructor(workDir) {
    super()
    this.workDir = workDir
    /** @type {Map<string, object>} every item, by identifier */
    this.items = new Map()
  }

  #file(jobId, itemId) {
    if (!JOB_ID.test(jobId)) throw new Error(`Invalid job identifier: ${jobId}`)
    if (!ITEM_ID.test(itemId)) throw new Error(`Invalid work item identifier: ${itemId}`)
    return path.join(this.workDir, jobId, `${itemId}.json`)
  }

  /**
   * Reads the whole queue into memory and repairs what the last run left behind.
   *
   * An item marked claimed or running is one whose execution was interrupted: by
   * construction nothing is running at this point, so it goes back to pending
   * without burning an attempt. That is the entire orphan-recovery policy, and
   * it needs no lease and no timestamp — the process boundary is the proof.
   */
  async load() {
    this.items.clear()

    let jobDirs
    try {
      jobDirs = await fsp.readdir(this.workDir, { withFileTypes: true })
    } catch {
      return this.items
    }

    let recovered = 0
    for (const entry of jobDirs) {
      if (!entry.isDirectory()) continue
      const jobId = entry.name

      let names
      try {
        names = await fsp.readdir(path.join(this.workDir, jobId))
      } catch {
        continue
      }

      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const read = await readJson(path.join(this.workDir, jobId, name))
        if (!read.ok || read.value === null || typeof read.value !== 'object') {
          // One unreadable item must not cost us the queue.
          logger.warn(`work item ${jobId}/${name} unreadable, ignored`)
          continue
        }

        const item = shape({ ...read.value, jobId, id: path.basename(name, '.json') })
        if (item.status === STATUS.CLAIMED || item.status === STATUS.RUNNING) {
          item.status = STATUS.PENDING
          item.executionId = null
          item.updatedAt = new Date().toISOString()
          recovered += 1
          await this.#persist(item)
        }
        this.items.set(item.id, item)
      }
    }

    if (recovered > 0) {
      logger.info(`${recovered} interrupted work item(s) put back as pending`)
    }
    return this.items
  }

  async #persist(item) {
    await writeJsonAtomic(this.#file(item.jobId, item.id), shape(item))
  }

  /**
   * Persists and announces, in that order. A listener woken by `changed` must
   * find the disk already agreeing with what it was told.
   */
  async #save(item, event = null) {
    item.updatedAt = new Date().toISOString()
    await this.#persist(item)
    if (event) this.emit(event, shape(item))
    this.emit('changed', shape(item))
    return shape(item)
  }

  get(id) {
    const item = this.items.get(id)
    return item ? shape(item) : null
  }

  /**
   * @param {{jobId?: string, status?: string}} [filter]
   * @returns {object[]} oldest first
   */
  list({ jobId = null, status = null } = {}) {
    const all = [...this.items.values()]
      .filter((item) => (jobId === null || item.jobId === jobId) && (status === null || item.status === status))
      .sort(byArrival)
    return all.map(shape)
  }

  /**
   * Adds an item.
   *
   * An identifier given by the caller is what makes creation idempotent: an
   * integration replaying the same webhook names the item after its source and
   * gets told it already exists, rather than queueing the same work three times.
   *
   * @returns {Promise<{ok: true, item: object} | {ok: false, error: string}>}
   */
  async create({ jobId, input = {}, id = null } = {}) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
      return { ok: false, error: `Invalid job identifier: ${jobId}` }
    }
    if (id !== null && (typeof id !== 'string' || !ITEM_ID.test(id))) {
      return { ok: false, error: `Invalid work item identifier: ${id}` }
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, error: 'input must be an object' }
    }
    if (sizeOf(input) > MAX_INPUT_BYTES) {
      return {
        ok: false,
        error: `input exceeds ${MAX_INPUT_BYTES} bytes — pass a reference rather than the work itself`,
      }
    }

    const itemId = id ?? generateId()
    if (this.items.has(itemId)) {
      return { ok: false, error: `A work item named "${itemId}" already exists` }
    }

    const at = new Date().toISOString()
    const item = shape({
      id: itemId,
      jobId,
      status: STATUS.PENDING,
      input,
      createdAt: at,
      updatedAt: at,
    })
    this.items.set(itemId, item)

    await this.#persist(item)
    this.emit('created', shape(item))
    this.emit('changed', shape(item))
    return { ok: true, item: shape(item) }
  }

  /** Items a job could start on right now, oldest first. */
  available(jobId, { now = Date.now() } = {}) {
    return [...this.items.values()]
      .filter(
        (item) =>
          item.jobId === jobId &&
          item.status === STATUS.PENDING &&
          (item.availableAt === null || Date.parse(item.availableAt) <= now),
      )
      .sort(byArrival)
  }

  /**
   * When this job's queue next has something to offer, for items that are only
   * waiting on their backoff. Null if there are none.
   *
   * Without this the retry policy would be decorative: an item held back comes
   * back into the queue at a given instant, and if nobody is watching the clock
   * it sits there until something unrelated happens to wake the worker.
   *
   * @returns {number|null} epoch milliseconds
   */
  nextAvailableAt(jobId, { now = Date.now() } = {}) {
    let soonest = null
    for (const item of this.items.values()) {
      if (item.jobId !== jobId || item.status !== STATUS.PENDING) continue
      if (item.availableAt === null) continue
      const at = Date.parse(item.availableAt)
      if (!Number.isFinite(at) || at <= now) continue
      if (soonest === null || at < soonest) soonest = at
    }
    return soonest
  }

  /** Whether this job has anything to do, without building the list. */
  hasAvailable(jobId, { now = Date.now() } = {}) {
    for (const item of this.items.values()) {
      if (item.jobId !== jobId || item.status !== STATUS.PENDING) continue
      if (item.availableAt === null || Date.parse(item.availableAt) <= now) return true
    }
    return false
  }

  /**
   * Takes the next item for this job, or null.
   *
   * The choice and the mark happen with no `await` between them — see the header
   * of this file. The write that follows only records what has already been
   * decided.
   */
  async claim(jobId, { now = Date.now() } = {}) {
    const [next] = this.available(jobId, { now })
    if (!next) return null

    next.status = STATUS.CLAIMED
    return this.#save(next, 'claimed')
  }

  /** The execution has started: the item now names it. */
  async markRunning(id, executionId) {
    const item = this.items.get(id)
    if (!item) return null
    item.status = STATUS.RUNNING
    item.executionId = executionId
    item.attempts += 1
    return this.#save(item)
  }

  async complete(id, result = null) {
    const item = this.items.get(id)
    if (!item) return null
    item.status = STATUS.DONE
    item.error = null
    item.result = sizeOf(result) > MAX_INPUT_BYTES ? null : result
    return this.#save(item, 'completed')
  }

  /**
   * The attempt failed.
   *
   * Below the ceiling the item goes back to pending, but not before
   * `availableAt` — and that delay is what keeps a worker from spinning. An item
   * that fails instantly would otherwise be re-served instantly, and the loop
   * would burn a model call per turn of it. The backoff is the guard; there is
   * no counter anywhere else.
   *
   * @param {{error?: string, maxAttempts?: number, backoffSeconds?: number, now?: number}} options
   */
  async fail(id, { error = null, maxAttempts = 3, backoffSeconds = 60, now = Date.now() } = {}) {
    const item = this.items.get(id)
    if (!item) return null

    item.error = error
    if (item.attempts >= maxAttempts) {
      item.status = STATUS.FAILED
      item.availableAt = null
      return this.#save(item, 'failed')
    }

    // Doubling from the first retry: 60 s, 120 s, 240 s. An API that is down
    // stays down for longer than three consecutive attempts would cover.
    const delayMs = backoffSeconds * 1000 * 2 ** Math.max(0, item.attempts - 1)
    item.status = STATUS.PENDING
    item.executionId = null
    item.availableAt = new Date(now + delayMs).toISOString()
    return this.#save(item)
  }

  /**
   * Puts an item back without holding the attempt against it.
   *
   * For the endings nobody chose to fail: a run cancelled by hand, a job that
   * was already running. Counting those would spend the item's chances on
   * something it never got to try.
   */
  async release(id) {
    const item = this.items.get(id)
    if (!item) return null
    if (TERMINAL.has(item.status)) return shape(item)

    item.status = STATUS.PENDING
    item.executionId = null
    item.attempts = Math.max(0, item.attempts - 1)
    return this.#save(item)
  }

  /**
   * Gives up on an item for good, with a reason.
   *
   * Distinct from `fail`, and deliberately terminal: a failed execution is
   * something that went wrong and may well go right next time, which is what
   * the backoff is for. This is a job that looked at the item and concluded it
   * cannot be done — trying it twice more would only cost what it cost once.
   */
  async giveUp(id, reason = null) {
    const item = this.items.get(id)
    if (!item) return null
    item.status = STATUS.FAILED
    item.error = reason
    item.availableAt = null
    return this.#save(item, 'failed')
  }

  async cancel(id) {
    const item = this.items.get(id)
    if (!item) return null
    item.status = STATUS.CANCELLED
    item.availableAt = null
    return this.#save(item, 'cancelled')
  }

  /**
   * Puts a finished item back in the queue, by hand.
   *
   * The attempts go back to zero: somebody looked at it and decided it deserved
   * another chance, which is exactly the judgement the ceiling stands in for
   * when nobody is there. The count is not a record to preserve — the history of
   * what actually ran is in the executions.
   */
  async retry(id) {
    const item = this.items.get(id)
    if (!item) return null
    item.status = STATUS.PENDING
    item.attempts = 0
    item.availableAt = null
    item.executionId = null
    item.error = null
    return this.#save(item)
  }

  /**
   * The execution is over: the item follows from its outcome.
   *
   * The whole mapping from "what happened to the run" to "what becomes of the
   * item" lives here, in one place, rather than being spread over whoever
   * happens to be watching executions. Two of the endings are not failures and
   * must not be counted as such: a run stopped by hand, and one that never
   * started because the job was already busy. Neither is the item's fault.
   *
   * @param {string} id
   * @param {{status: string, result?: any, error?: string|null,
   *   executionId?: string|null, maxAttempts?: number, backoffSeconds?: number,
   *   now?: number}} outcome
   */
  async settle(
    id,
    {
      status,
      result = null,
      error = null,
      executionId = null,
      maxAttempts = 3,
      backoffSeconds = 60,
      now = Date.now(),
    } = {},
  ) {
    const item = this.items.get(id)
    if (!item) return null

    // The job may have settled its own item along the way — an agent calling
    // work_fail because it looked at the thing and concluded it cannot be done.
    // Whoever got there first decided, and a successful exit does not overrule
    // an agent that said it had given up.
    if (item.status !== STATUS.RUNNING) return shape(item)

    // Written on the item before it moves, so that whichever transition follows
    // carries it out in the single write it was already going to make.
    if (executionId) item.executionId = executionId

    if (status === 'success') return this.complete(id, result)
    if (status === 'cancelled' || status === 'skipped-already-running') return this.release(id)
    return this.fail(id, { error, maxAttempts, backoffSeconds, now })
  }

  async remove(id) {
    const item = this.items.get(id)
    if (!item) return false
    this.items.delete(id)
    await fsp.rm(this.#file(item.jobId, item.id), { force: true })
    this.emit('changed', shape(item))
    return true
  }

  /** How many items sit in each status, per job. For the interface's badges. */
  countsByJob() {
    const counts = new Map()
    for (const item of this.items.values()) {
      let forJob = counts.get(item.jobId)
      if (!forJob) {
        forJob = { pending: 0, claimed: 0, running: 0, done: 0, failed: 0, cancelled: 0 }
        counts.set(item.jobId, forJob)
      }
      forJob[item.status] += 1
    }
    return counts
  }

  /** Removes the queues of jobs that no longer exist. */
  async prune(existingJobIds) {
    const keep = new Set(existingJobIds)

    for (const [id, item] of [...this.items]) {
      if (!keep.has(item.jobId)) this.items.delete(id)
    }

    let entries
    try {
      entries = await fsp.readdir(this.workDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue
      await fsp
        .rm(path.join(this.workDir, entry.name), { recursive: true, force: true })
        .catch((err) => logger.warn(`cleaning up the queue of ${entry.name}: ${err.message}`))
      logger.info(`work queue of ${entry.name} deleted (job gone)`)
    }
  }
}

module.exports = { WorkStore, STATUS, TERMINAL, MAX_INPUT_BYTES, generateId }
