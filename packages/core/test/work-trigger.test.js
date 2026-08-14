'use strict'

// The `work` trigger, and the loop that comes with it.
//
// A worker is not a new kind of thing in Rota: it is a job with one more
// trigger. What is worth testing is therefore not the machinery but the
// consequences — that an arriving item wakes the job, that the job then takes
// the next one by itself until there is nothing left, and above all that it
// stops. A worker that kept going on an empty queue would be exactly the
// polling this whole feature exists to avoid.
//
// The other half is the three rules every other trigger already obeys: a paused
// scheduler starts nothing, a disabled job stays disabled, and a job that needs
// an unlocked session waits for one. They are inherited rather than
// reimplemented, and these tests are what says so.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const { Scheduler } = require('../src/scheduler')
const { WorkStore, STATUS } = require('../src/work/store')

function makeJob(id, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    triggers: [{ type: 'work' }],
    runner: { type: 'shell', script: '/tmp/x.sh', interpreter: 'sh', args: [], environment: {} },
    execution: {
      timeoutSeconds: 60,
      allowConcurrentRuns: false,
      runOnStartup: false,
      catchUpOnWake: true,
      requiresUnlockedSession: false,
      maxOutputBytes: 1024,
    },
    notifications: { onStart: false, onSuccess: false, onError: true },
    history: { enabled: true, retainExecutions: 500 },
    ...overrides,
  }
}

/**
 * The scheduler over a real queue and a fake runner.
 *
 * @param {object[]} jobs
 * @param {{paused?: boolean, outcome?: (run: object) => object}} options
 *   `outcome` decides what each run ends as, which is the only thing the item's
 *   fate depends on.
 */
async function harness(t, jobs, { paused = false, outcome = () => ({ status: 'success' }) } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-worker-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const work = new WorkStore(path.join(dir, 'work'))
  await work.load()

  const runs = []
  const running = new Map()
  const lastRuns = {}

  const store = {
    getJobs: () => jobs,
    getJob: (id) => jobs.find((job) => job.id === id) ?? null,
    getConfig: () => ({ schedulerPaused: paused }),
  }
  const state = {
    getLastRun: (id) => lastRuns[id] ?? null,
    lastRunByJob: () => new Map(Object.entries(lastRuns)),
    recordRun: (id, run) => {
      lastRuns[id] = run
    },
  }

  const runner = new EventEmitter()
  Object.assign(runner, {
    isRunning: (id) => (running.get(id) ?? 0) > 0,
    run: async (job, options) => {
      const run = { jobId: job.id, trigger: options.trigger, work: options.work ?? null }
      runs.push(run)
      running.set(job.id, (running.get(job.id) ?? 0) + 1)
      await Promise.resolve()
      running.set(job.id, running.get(job.id) - 1)

      const entry = {
        executionId: `exec-${runs.length}`,
        stdout: '',
        stderr: '',
        error: null,
        ...outcome(run),
      }
      runner.emit('finished', { jobId: job.id, status: entry.status, trigger: options.trigger })
      return entry
    },
  })

  const scheduler = new Scheduler({ store, state, runner, work })
  t.after(() => scheduler.stop())

  return { scheduler, work, runs, dir, setPaused: (value) => (paused = value) }
}

/**
 * Waits for the queues to stop moving.
 *
 * Serving is started by an event and runs on its own; there is no promise to
 * await from the outside, which is the point — nobody is waiting for a worker
 * in real life either.
 */
async function quiet(scheduler, { timeoutMs = 5000 } = {}) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
  const deadline = Date.now() + timeoutMs

  // Serving is taken synchronously when an item arrives or when start() syncs,
  // so by the time we get here it is already held if there was anything to do.
  await pause()
  while (scheduler.serving.size > 0 && Date.now() < deadline) await pause()
  // And one more, for whatever the last settle set off.
  await pause()
}

// --- waking up -----------------------------------------------------------------------

test('an item arriving wakes the job it is for', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev')])
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: { issue: 1 } })
  await quiet(scheduler)

  assert.equal(runs.length, 1)
  assert.equal(runs[0].jobId, 'dev')
  assert.equal(runs[0].trigger, 'work')
})

test('the item travels with the run', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev')])
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: { repository: 'acme/api', issue: 421 } })
  await quiet(scheduler)

  assert.equal(runs[0].work.id, 'a')
  assert.deepEqual(runs[0].work.input, { repository: 'acme/api', issue: 421 })
})

test('a job with no work trigger is never served', async (t) => {
  const plain = makeJob('plain', { triggers: [{ type: 'interval', every: 5, unit: 'minutes' }] })
  const { scheduler, work, runs } = await harness(t, [plain])
  await scheduler.start()

  await work.create({ jobId: 'plain', id: 'a', input: {} })
  await quiet(scheduler)

  assert.equal(runs.length, 0)
  assert.equal(work.get('a').status, STATUS.PENDING)
})

test('a disabled trigger is as good as none', async (t) => {
  const off = makeJob('dev', { triggers: [{ type: 'work', enabled: false }] })
  const { scheduler, work, runs } = await harness(t, [off])
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  assert.equal(runs.length, 0)
})

// --- the loop --------------------------------------------------------------------------

test('the queue is worked through item by item, then the worker stops', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev')])
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await work.create({ jobId: 'dev', id: 'b', input: {} })
  await work.create({ jobId: 'dev', id: 'c', input: {} })
  await quiet(scheduler)

  // One execution per item, in the order they arrived, and not one more: an
  // empty queue is what ends the loop.
  assert.equal(runs.length, 3)
  assert.deepEqual(
    runs.map((run) => run.work.id),
    ['a', 'b', 'c'],
  )
  for (const id of ['a', 'b', 'c']) {
    assert.equal(work.get(id).status, STATUS.DONE)
  }

  // And it stays stopped.
  await quiet(scheduler)
  assert.equal(runs.length, 3)
})

test('an empty queue costs no execution at all', async (t) => {
  const { scheduler, runs } = await harness(t, [makeJob('dev')])

  await scheduler.start()
  await quiet(scheduler)

  assert.equal(runs.length, 0)
})

test('the item records the execution that took it', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev')])
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  assert.equal(work.get('a').executionId, runs[0] && 'exec-1')
})

test('the output of the run is kept as the result', async (t) => {
  const { scheduler, work } = await harness(t, [makeJob('dev')], {
    outcome: () => ({ status: 'success', stdout: 'issue closed\n' }),
  })
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  assert.equal(work.get('a').result, 'issue closed')
})

// --- failure ---------------------------------------------------------------------------

test('a failed item leaves the queue rather than being served again at once', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev')], {
    outcome: () => ({ status: 'failed', error: 'boom' }),
  })
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  // Tried once, then held back: this is what keeps a worker from spinning on
  // something that fails instantly.
  assert.equal(runs.length, 1)
  const item = work.get('a')
  assert.equal(item.status, STATUS.PENDING)
  assert.equal(item.attempts, 1)
  assert.equal(item.error, 'boom')
  assert.ok(Date.parse(item.availableAt) > Date.now())
})

// Without this the retry policy would be decorative: the item goes back into
// the queue at an instant, and if nobody is watching the clock it sits there
// until something unrelated happens to wake the worker.
test('a held-back item is served again when its backoff falls due', async (t) => {
  let attempt = 0
  const job = makeJob('dev', { triggers: [{ type: 'work', maxAttempts: 3, backoffSeconds: 1 }] })
  const { scheduler, work, runs } = await harness(t, [job], {
    outcome: () => {
      attempt += 1
      return attempt === 1 ? { status: 'failed', error: 'boom' } : { status: 'success' }
    },
  })
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)
  assert.equal(runs.length, 1, 'tried once, then held back')
  assert.equal(work.get('a').status, STATUS.PENDING)

  // Nothing else happens: no item arrives, no sync is asked for. The scheduler
  // comes back on its own.
  await new Promise((resolve) => setTimeout(resolve, 1300))
  await quiet(scheduler)

  assert.equal(runs.length, 2)
  assert.equal(work.get('a').status, STATUS.DONE)
})

// The Queue again button, and `rotactl work retry`. Nothing is created, so a
// worker listening only for arrivals would leave the item sitting there.
test('an item put back by hand wakes the worker', async (t) => {
  let attempt = 0
  const job = makeJob('dev', { triggers: [{ type: 'work', maxAttempts: 1 }] })
  const { scheduler, work, runs } = await harness(t, [job], {
    outcome: () => {
      attempt += 1
      return attempt === 1 ? { status: 'failed', error: 'boom' } : { status: 'success' }
    },
  })
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)
  assert.equal(work.get('a').status, STATUS.FAILED, 'given up on at the ceiling')
  assert.equal(runs.length, 1)

  await work.retry('a')
  await quiet(scheduler)

  assert.equal(runs.length, 2)
  assert.equal(work.get('a').status, STATUS.DONE)
})

test('a run stopped by hand gives the item its attempt back', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev')], {
    outcome: () => ({ status: 'cancelled' }),
  })
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  const item = work.get('a')
  assert.equal(item.status, STATUS.PENDING)
  assert.equal(item.attempts, 0)
  assert.equal(item.availableAt, null)
  // It is claimable again — the loop simply did not go round, because a run
  // that somebody stopped is not an invitation to start another.
  assert.equal(work.hasAvailable('dev'), true)
  assert.equal(runs.length, 1)
})

test('the ceiling gives up on an item that keeps failing', async (t) => {
  const job = makeJob('dev', { triggers: [{ type: 'work', maxAttempts: 1, backoffSeconds: 60 }] })
  const { scheduler, work } = await harness(t, [job], {
    outcome: () => ({ status: 'failed', error: 'boom' }),
  })
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  const item = work.get('a')
  assert.equal(item.status, STATUS.FAILED)
  assert.equal(item.availableAt, null)
})

// --- the three rules ----------------------------------------------------------------------

test('a paused scheduler serves nothing', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev')], { paused: true })
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  assert.equal(runs.length, 0)
  assert.equal(work.get('a').status, STATUS.PENDING)
})

test('resuming picks up what was waiting', async (t) => {
  const { scheduler, work, runs, setPaused } = await harness(t, [makeJob('dev')], { paused: true })
  await scheduler.start()
  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)
  assert.equal(runs.length, 0)

  setPaused(false)
  scheduler.sync()
  await quiet(scheduler)

  assert.equal(runs.length, 1)
  assert.equal(work.get('a').status, STATUS.DONE)
})

test('a disabled job serves nothing', async (t) => {
  const { scheduler, work, runs } = await harness(t, [makeJob('dev', { enabled: false })])
  await scheduler.start()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)

  assert.equal(runs.length, 0)
})

test('a job waiting on an unlocked session keeps its queue for later', async (t) => {
  const job = makeJob('dev')
  job.execution.requiresUnlockedSession = true
  const { scheduler, work, runs } = await harness(t, [job])
  await scheduler.start()
  scheduler.handleLock()

  await work.create({ jobId: 'dev', id: 'a', input: {} })
  await quiet(scheduler)
  assert.equal(runs.length, 0)

  scheduler.handleUnlock()
  await quiet(scheduler)

  assert.equal(runs.length, 1)
  assert.equal(work.get('a').status, STATUS.DONE)
})

// --- restart ------------------------------------------------------------------------------

test('items left in the queue are picked up when Rota starts', async (t) => {
  const { scheduler, work, runs, dir } = await harness(t, [makeJob('dev')])

  // Written straight into the directory, as another process would have: the
  // scheduler has not started, so nothing can have consumed them yet.
  const before = new WorkStore(path.join(dir, 'work'))
  await before.load()
  await before.create({ jobId: 'dev', id: 'left-over', input: { n: 1 } })

  await work.load()
  await scheduler.start()
  await quiet(scheduler)

  assert.equal(runs.length, 1)
  assert.equal(runs[0].work.id, 'left-over')
  assert.equal(work.get('left-over').status, STATUS.DONE)
})
