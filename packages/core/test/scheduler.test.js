'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { EventEmitter } = require('node:events')

const { Scheduler } = require('../src/scheduler')

const MINUTE = 60_000
const HOUR = 3_600_000

function makeJob(id, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
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
 * A fake runner reproducing the real one's contract: concurrency lock,
 * execution duration, and recording the end into the state — it is that last
 * point that drives the computation of the next occurrence.
 */
function harness(jobs, { paused = false, lastRuns = {}, runDurationMs = 0 } = {}) {
  const runs = []
  const skipped = []
  const running = new Map()

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
      if (!job.execution.allowConcurrentRuns && runner.isRunning(job.id)) {
        skipped.push({ jobId: job.id, trigger: options.trigger })
        return { status: 'skipped-already-running' }
      }
      runs.push({ jobId: job.id, trigger: options.trigger })
      running.set(job.id, (running.get(job.id) ?? 0) + 1)

      if (runDurationMs > 0) await new Promise((resolve) => setTimeout(resolve, runDurationMs))

      running.set(job.id, running.get(job.id) - 1)
      // As in index.js: only a real execution updates the state.
      lastRuns[job.id] = {
        at: new Date().toISOString(),
        status: 'success',
        durationMs: runDurationMs,
      }
      const execution = { jobId: job.id, status: 'success', trigger: options.trigger }
      runner.emit('finished', execution)
      return { status: 'success' }
    },
  })

  const scheduler = new Scheduler({ store, state, runner })
  return { scheduler, runs, skipped, runner, setPaused: (value) => (paused = value), lastRuns }
}

test('start arms one timer per active job', async () => {
  const jobs = [makeJob('a'), makeJob('b', { enabled: false })]
  const { scheduler } = harness(jobs)

  await scheduler.start()
  const next = scheduler.nextRunByJob()

  assert.deepEqual([...next.keys()], ['a'], 'only the enabled job is scheduled')
  scheduler.stop()
})

test('the first occurrence of a job never run starts from now', async () => {
  const { scheduler } = harness([makeJob('a')])
  const before = Date.now()

  await scheduler.start()
  const at = Date.parse(scheduler.nextRunByJob().get('a'))

  assert.ok(at >= before + 5 * MINUTE, 'au moins un intervalle plus tard')
  assert.ok(at <= Date.now() + 5 * MINUTE + 1000)
  scheduler.stop()
})

test('reloading the configuration does not push the occurrences back', async () => {
  const { scheduler } = harness([makeJob('a')])
  await scheduler.start()
  const first = scheduler.nextRunByJob().get('a')

  await new Promise((resolve) => setTimeout(resolve, 20))
  scheduler.sync()
  scheduler.sync()

  assert.equal(scheduler.nextRunByJob().get('a'), first, "the anchor is kept between two syncs")
  scheduler.stop()
})

test('the next occurrence starts from the last execution', async () => {
  const lastAt = new Date(Date.now() - MINUTE).toISOString()
  const { scheduler } = harness([makeJob('a')], {
    lastRuns: { a: { at: lastAt, status: 'success', durationMs: 10 } },
  })

  await scheduler.start()

  assert.equal(
    scheduler.nextRunByJob().get('a'),
    new Date(Date.parse(lastAt) + 5 * MINUTE).toISOString(),
  )
  scheduler.stop()
})

test('suspending disarms every timer', async () => {
  const jobs = [makeJob('a')]
  const { scheduler, setPaused } = harness(jobs)
  await scheduler.start()
  assert.equal(scheduler.nextRunByJob().size, 1)

  setPaused(true)
  scheduler.sync()

  assert.equal(scheduler.nextRunByJob().size, 0)
  scheduler.stop()
})

test('runOnStartup fires at startup, the others do not', async () => {
  const jobs = [makeJob('a', { execution: { ...makeJob('a').execution, runOnStartup: true } }), makeJob('b')]
  const { scheduler, runs } = harness(jobs)

  await scheduler.start()

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'startup' }])
  scheduler.stop()
})

test('nothing starts at launch if the scheduler is paused', async () => {
  const jobs = [makeJob('a', { execution: { ...makeJob('a').execution, runOnStartup: true } })]
  const { scheduler, runs } = harness(jobs, { paused: true })

  await scheduler.start()

  assert.deepEqual(runs, [])
  scheduler.stop()
})

test('a manual launch overrides the occurrence', async () => {
  const { scheduler, runs } = harness([makeJob('a')])
  await scheduler.start()

  assert.deepEqual(await scheduler.runNow('a'), { ok: true })
  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'manual' }])
  scheduler.stop()
})

test('a manual launch on an unknown job is refused', async () => {
  const { scheduler } = harness([makeJob('a')])
  await scheduler.start()

  const result = await scheduler.runNow('fantome')
  assert.equal(result.ok, false)
  scheduler.stop()
})

// --- wake-up -------------------------------------------------------------------

test('on waking, a late job is caught up exactly once', async () => {
  const lastAt = new Date(Date.now() - 8 * HOUR).toISOString()
  const { scheduler, runs } = harness([makeJob('a')], {
    lastRuns: { a: { at: lastAt, status: 'success', durationMs: 10 } },
  })
  await scheduler.start()

  // Eight hours of sleep for a job running every five minutes: 96 missed
  // occurrences, but a single execution.
  scheduler.handleWake()

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }])
  scheduler.stop()
})

test('on waking, a job that is on time is not started again', async () => {
  const lastAt = new Date(Date.now() - MINUTE).toISOString()
  const { scheduler, runs } = harness([makeJob('a')], {
    lastRuns: { a: { at: lastAt, status: 'success', durationMs: 10 } },
  })
  await scheduler.start()

  scheduler.handleWake()

  assert.deepEqual(runs, [])
  scheduler.stop()
})

test('catchUpOnWake off skips the occurrences instead of catching up', async () => {
  const job = makeJob('a')
  job.execution.catchUpOnWake = false
  const lastAt = new Date(Date.now() - 8 * HOUR).toISOString()
  const { scheduler, runs, lastRuns } = harness([job], {
    lastRuns: { a: { at: lastAt, status: 'success', durationMs: 10 } },
  })
  await scheduler.start()

  const skipped = []
  scheduler.on('skipped', (payload) => skipped.push(payload.job.id))
  scheduler.handleWake()

  assert.deepEqual(runs, [], 'no execution')
  assert.deepEqual(skipped, ['a'])
  assert.equal(lastRuns.a.status, 'skipped', 'the trace is kept in the state')
  scheduler.stop()
})

test('the jump on waking restarts from now, with no perpetual lateness', async () => {
  const job = makeJob('a')
  job.execution.catchUpOnWake = false
  const { scheduler } = harness([job], {
    lastRuns: { a: { at: new Date(Date.now() - 8 * HOUR).toISOString(), status: 'success', durationMs: 0 } },
  })
  await scheduler.start()

  scheduler.handleWake()

  const next = Date.parse(scheduler.nextRunByJob().get('a'))
  assert.ok(next > Date.now(), 'the next occurrence is in the future')
  scheduler.stop()
})

test('handleSuspend disarms everything without firing anything', async () => {
  const { scheduler, runs } = harness([makeJob('a')])
  await scheduler.start()

  scheduler.handleSuspend()

  assert.equal(scheduler.nextRunByJob().size, 0)
  assert.deepEqual(runs, [])
  scheduler.stop()
})

test('a paused job is not caught up on waking', async () => {
  const { scheduler, runs } = harness([makeJob('a')], {
    paused: true,
    lastRuns: { a: { at: new Date(Date.now() - 8 * HOUR).toISOString(), status: 'success', durationMs: 0 } },
  })
  await scheduler.start()

  scheduler.handleWake()

  assert.deepEqual(runs, [])
  scheduler.stop()
})

// --- session lock ---------------------------------------------------------------

function lockedJob(id = 'a') {
  const job = makeJob(id)
  job.execution.requiresUnlockedSession = true
  return job
}

test('locking disarms the jobs that require an open session', async () => {
  const { scheduler } = harness([lockedJob('a'), makeJob('b')])
  await scheduler.start()
  assert.equal(scheduler.nextRunByJob().size, 2)

  scheduler.handleLock()

  assert.deepEqual([...scheduler.nextRunByJob().keys()], ['b'], 'les autres tâches continuent')
  assert.deepEqual([...scheduler.deferredJobIds()], ['a'])
  scheduler.stop()
})

test('screen locked, the occurrence fires nothing', async () => {
  const job = lockedJob('a')
  job.schedule = { type: 'interval', every: 1, unit: 'seconds' }
  const { scheduler, runs } = harness([job])
  await scheduler.start()

  scheduler.handleLock()
  await new Promise((resolve) => setTimeout(resolve, 1400))

  assert.deepEqual(runs, [], 'no execution while it is locked')
  scheduler.stop()
})

test('on unlocking, a late job is caught up exactly once', async () => {
  const { scheduler, runs } = harness([lockedJob('a')], {
    lastRuns: { a: { at: new Date(Date.now() - 4 * HOUR).toISOString(), status: 'success', durationMs: 10 } },
  })
  await scheduler.start()
  scheduler.handleLock()

  scheduler.handleUnlock()

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }])
  assert.equal(scheduler.deferredJobIds().size, 0)
  scheduler.stop()
})

test('on unlocking, catchUpOnWake off skips instead of catching up', async () => {
  const job = lockedJob('a')
  job.execution.catchUpOnWake = false
  const { scheduler, runs, lastRuns } = harness([job], {
    lastRuns: { a: { at: new Date(Date.now() - 4 * HOUR).toISOString(), status: 'success', durationMs: 10 } },
  })
  await scheduler.start()
  scheduler.handleLock()

  scheduler.handleUnlock()

  assert.deepEqual(runs, [])
  assert.equal(lastRuns.a.status, 'skipped')
  scheduler.stop()
})

test('a lock shorter than the interval causes no catch-up', async () => {
  const { scheduler, runs } = harness([lockedJob('a')], {
    lastRuns: { a: { at: new Date(Date.now() - MINUTE).toISOString(), status: 'success', durationMs: 10 } },
  })
  await scheduler.start()
  scheduler.handleLock()

  scheduler.handleUnlock()

  assert.deepEqual(runs, [], 'nothing missed')
  assert.ok(scheduler.nextRunByJob().has('a'), 'the job is armed again')
  scheduler.stop()
})

test('waking with the screen locked does not catch up the jobs concerned', async () => {
  // A Mac coming out of sleep shows the lock screen: resume arrives before
  // unlock-screen, and the job must wait for the second.
  const lastAt = new Date(Date.now() - 4 * HOUR).toISOString()
  const { scheduler, runs } = harness([lockedJob('a'), makeJob('b')], {
    lastRuns: {
      a: { at: lastAt, status: 'success', durationMs: 10 },
      b: { at: lastAt, status: 'success', durationMs: 10 },
    },
  })
  await scheduler.start()
  scheduler.handleLock()

  scheduler.handleWake()
  assert.deepEqual(runs, [{ jobId: 'b', trigger: 'wake' }], 'only the free job is caught up')

  scheduler.handleUnlock()
  assert.deepEqual(runs.map((run) => run.jobId), ['b', 'a'])
  scheduler.stop()
})

test('runOnStartup is held back if the session is locked at startup', async () => {
  const job = lockedJob('a')
  job.execution.runOnStartup = true
  const { scheduler, runs } = harness([job])

  scheduler.handleLock()
  await scheduler.start()

  assert.deepEqual(runs, [])
  scheduler.stop()
})

test('a manual launch stays possible with the session locked', async () => {
  const { scheduler, runs } = harness([lockedJob('a')])
  await scheduler.start()
  scheduler.handleLock()

  await scheduler.runNow('a')

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'manual' }])
  scheduler.stop()
})

test('a job without the flag ignores the lock entirely', async () => {
  const { scheduler, runs } = harness([makeJob('a')], {
    lastRuns: { a: { at: new Date(Date.now() - 4 * HOUR).toISOString(), status: 'success', durationMs: 10 } },
  })
  await scheduler.start()

  scheduler.handleLock()
  assert.ok(scheduler.nextRunByJob().has('a'), 'still armed')

  scheduler.handleWake()
  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }], 'caught up on waking, locked or not')
  scheduler.stop()
})

// --- regression: loop of skipped executions -------------------------------------
//
// A job lasting longer than its interval left lastRun on the previous execution.
// sync(), called as soon as another job finished, recomputed an occurrence
// already past, armed a timer at zero milliseconds, got a
// skipped-already-running, whose finally called sync() again: several hundred
// history entries a second.

test('sync during an execution does not rearm a timer', async () => {
  const job = makeJob('a', { triggers: [{ type: 'interval', every: 1, unit: 'seconds' }] })
  const { scheduler, runs, skipped } = harness([job], { runDurationMs: 300 })
  await scheduler.start()

  await scheduler.runNow('a')
  assert.equal(runs.length, 1)

  // What the end of another job would have caused, in bursts.
  for (let i = 0; i < 50; i++) scheduler.sync()

  assert.equal(scheduler.nextRunByJob().size, 0, 'aucun timer tant que la tâche tourne')
  assert.deepEqual(skipped, [], "no skipped execution is produced")
  assert.equal(runs.length, 1)
  scheduler.stop()
})

test('a job longer than its interval does not run away', async () => {
  const job = makeJob('a', { triggers: [{ type: 'interval', every: 1, unit: 'seconds' }] })
  const { scheduler, runs, skipped } = harness([job], { runDurationMs: 400 })
  await scheduler.start()

  await new Promise((resolve) => setTimeout(resolve, 2600))
  scheduler.stop()

  // A cycle of about 1.4 s (interval + duration): two executions expected, and
  // above all no burst.
  assert.ok(runs.length <= 3, `${runs.length} executions in 2.6 s`)
  assert.equal(skipped.length, 0, `${skipped.length} skipped executions`)
})

test('a concurrent job keeps a steady cadence without restarting in a loop', async () => {
  const job = makeJob('a', {
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    execution: { ...makeJob('a').execution, allowConcurrentRuns: true },
  })
  const { scheduler, runs } = harness([job], { runDurationMs: 500 })
  await scheduler.start()

  await scheduler.runNow('a')
  for (let i = 0; i < 50; i++) scheduler.sync()

  const next = Date.parse(scheduler.nextRunByJob().get('a'))
  assert.ok(next > Date.now() + 4 * MINUTE, "the next occurrence starts from the launch, in the future")
  assert.equal(runs.length, 1, 'no immediate restart')
  scheduler.stop()
})

test('a manual launch during an execution gives exactly one skipped', async () => {
  const job = makeJob('a')
  const { scheduler, runs, skipped } = harness([job], { runDurationMs: 400 })
  await scheduler.start()

  await scheduler.runNow('a')
  await scheduler.runNow('a')
  await new Promise((resolve) => setTimeout(resolve, 600))

  assert.equal(runs.length, 1)
  assert.equal(skipped.length, 1, "le statut skipped-already-running reste atteignable")
  scheduler.stop()
})

test('a short job really does fire in the end', async () => {
  // Checks the full timer → execution chain, with a one-second interval.
  const job = makeJob('a', { triggers: [{ type: 'interval', every: 1, unit: 'seconds' }] })
  const { scheduler, runs } = harness([job])

  await scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 1400))

  assert.ok(runs.length >= 1, `expected at least one execution, got ${runs.length}`)
  assert.equal(runs[0].trigger, 'schedule')
  scheduler.stop()
})

// --- manual launch of a disabled job ---------------------------------------------
//
// Disabling only stops the scheduling. Running by hand stays the way to put a job
// right before leaving it to run on its own.

test('a disabled job stays startable by hand', async () => {
  const { scheduler, runs } = harness([makeJob('a', { enabled: false })])
  await scheduler.start()
  assert.equal(scheduler.nextRunByJob().size, 0, 'it is not scheduled for all that')

  assert.deepEqual(await scheduler.runNow('a'), { ok: true })

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'manual' }])
  scheduler.stop()
})

test('starting a disabled job does not reschedule it', async () => {
  const { scheduler } = harness([makeJob('a', { enabled: false })])
  await scheduler.start()

  await scheduler.runNow('a')

  assert.equal(scheduler.nextRunByJob().size, 0)
  scheduler.stop()
})

// --- cron scheduling ---------------------------------------------------------------

const cronJob = (id, expression, overrides = {}) =>
  makeJob(id, { triggers: [{ type: 'cron', expression }], ...overrides })

test('a cron job is armed on its next occurrence', async () => {
  const { scheduler } = harness([cronJob('a', '0 9 * * *')])

  await scheduler.start()

  const next = new Date(scheduler.nextRunByJob().get('a'))
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
  assert.ok(next.getTime() > Date.now(), 'dans le futur')
  scheduler.stop()
})

test('an impossible expression does not crash the scheduler', async () => {
  // 30 February: the job is loaded, but has no upcoming occurrence.
  const { scheduler, runs } = harness([cronJob('a', '0 0 30 2 *'), makeJob('b')])

  await scheduler.start()

  assert.deepEqual([...scheduler.nextRunByJob().keys()], ['b'], 'les autres tâches sont intactes')
  assert.deepEqual(runs, [], 'and nothing fires in a loop')
  scheduler.stop()
})

test('a late cron job is caught up exactly once on waking', async () => {
  const lastAt = new Date(Date.now() - 8 * HOUR).toISOString()
  const { scheduler, runs } = harness([cronJob('a', '*/5 * * * *')], {
    lastRuns: { a: { at: lastAt, status: 'success', durationMs: 10 } },
  })
  await scheduler.start()

  scheduler.handleWake()

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }])
  scheduler.stop()
})

test('a cron job on time is not caught up', async () => {
  const { scheduler, runs } = harness([cronJob('a', '0 3 * * *')], {
    lastRuns: { a: { at: new Date(Date.now() - MINUTE).toISOString(), status: 'success', durationMs: 10 } },
  })
  await scheduler.start()

  scheduler.handleWake()

  assert.deepEqual(runs, [])
  scheduler.stop()
})

test('a manual launch stays possible on a cron job', async () => {
  const { scheduler, runs } = harness([cronJob('a', '0 9 * * 1-5')])
  await scheduler.start()

  await scheduler.runNow('a')

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'manual' }])
  scheduler.stop()
})

test('a short cron job really does fire in the end', async () => {
  // Full timer → execution chain: "every minute" would not do for a test, so we
  // aim at the next minute with a broad expression.
  const job = cronJob('a', '* * * * *')
  const { scheduler } = harness([job])

  await scheduler.start()
  const target = Date.parse(scheduler.nextRunByJob().get('a'))

  assert.ok(target - Date.now() <= 60_000, 'au plus une minute d’attente')
  assert.equal(new Date(target).getSeconds(), 0, 'aligned on the minute')
  scheduler.stop()
})

// --- several triggers on the same job ----------------------------------------------
//
// "Every five minutes" and "at 9am on weekdays" cannot be said in one
// expression. A job therefore carries as many as it likes, and the scheduler arms
// one timer per trigger — but shows only one occurrence, the soonest: it is the
// job that starts, not the trigger.

test('every timed trigger arms a timer of its own', async () => {
  const job = makeJob('a', {
    triggers: [
      { type: 'interval', every: 5, unit: 'minutes' },
      { type: 'interval', every: 1, unit: 'hours' },
    ],
  })
  const { scheduler } = harness([job])

  await scheduler.start()

  assert.equal(scheduler.timers.size, 2, 'one timer per trigger')
  scheduler.stop()
})

test('the occurrence announced is the soonest of the triggers', async () => {
  const job = makeJob('a', {
    triggers: [
      { type: 'interval', every: 2, unit: 'hours' },
      { type: 'interval', every: 5, unit: 'minutes' },
    ],
  })
  const { scheduler } = harness([job])

  await scheduler.start()
  const at = Date.parse(scheduler.nextRunByJob().get('a'))

  assert.ok(at <= Date.now() + 5 * MINUTE + 1000, 'les cinq minutes, pas les deux heures')
  scheduler.stop()
})

// Webhook and keyword wait to be come to: nothing to compute, nothing to arm. A
// job carrying only those consumes no timer, and announces no occurrence.
test('the triggers with no occurrence arm nothing', async () => {
  const job = makeJob('a', {
    triggers: [{ type: 'webhook' }, { type: 'discord', keyword: 'deploy' }],
  })
  const { scheduler } = harness([job])

  await scheduler.start()

  assert.equal(scheduler.timers.size, 0)
  assert.equal(scheduler.nextRunByJob().get('a'), undefined)
  scheduler.stop()
})

test('a disabled trigger arms nothing, the others carry on', async () => {
  const job = makeJob('a', {
    triggers: [
      { type: 'interval', every: 5, unit: 'minutes', enabled: false },
      { type: 'interval', every: 1, unit: 'hours' },
    ],
  })
  const { scheduler } = harness([job])

  await scheduler.start()
  const at = Date.parse(scheduler.nextRunByJob().get('a'))

  assert.equal(scheduler.timers.size, 1)
  assert.ok(at > Date.now() + 30 * MINUTE, 'reste l’heure, pas les cinq minutes')
  scheduler.stop()
})

// The catch-up is for the work not done, and it was not left undone three times
// because three triggers asked for it.
test('on waking, a job with several triggers is caught up only once', async () => {
  const job = makeJob('a', {
    triggers: [
      { type: 'interval', every: 5, unit: 'minutes' },
      { type: 'interval', every: 10, unit: 'minutes' },
    ],
  })
  const { scheduler, runs } = harness([job], {
    lastRuns: { a: { at: new Date(Date.now() - 2 * HOUR).toISOString(), status: 'success' } },
  })

  await scheduler.start()
  scheduler.handleWake()

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }])
  scheduler.stop()
})

test('a job with no trigger at all stays startable by hand', async () => {
  const { scheduler, runs } = harness([makeJob('a', { triggers: [] })])

  await scheduler.start()
  assert.equal(scheduler.timers.size, 0)

  await scheduler.runNow('a')

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'manual' }])
  scheduler.stop()
})

// --- the power trigger ---------------------------------------------------------
//
// A job that runs when the machine comes back. The distinction that costs
// something is wake versus unlock: a Mac wakes at the lock screen, and
// handleUnlock() delegates to handleWake() for the catch-up, so the naive
// wiring runs a wake job twice for one lid-opening.

const powerJob = (id, event, overrides = {}) =>
  makeJob(id, { triggers: [{ type: 'power', event }], ...overrides })

test('a wake job runs when the machine wakes', async () => {
  const { scheduler, runs } = harness([powerJob('a', 'wake')])
  await scheduler.start()
  runs.length = 0

  scheduler.handleWake()
  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }])
})

test('an unlock job does not run on a plain wake', async () => {
  const { scheduler, runs } = harness([powerJob('a', 'unlock')])
  await scheduler.start()
  runs.length = 0

  scheduler.handleWake()
  assert.deepEqual(runs, [], 'the screen is still locked at that point')
})

test('one lid-opening runs a wake job once, not twice', async () => {
  const { scheduler, runs } = harness([powerJob('a', 'wake')])
  await scheduler.start()
  runs.length = 0

  // What actually happens: the machine wakes at the lock screen, then somebody
  // types their password.
  scheduler.handleWake()
  scheduler.handleUnlock()

  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }])
})

test('unlocking runs the jobs waiting for it', async () => {
  const { scheduler, runs } = harness([powerJob('a', 'unlock')])
  await scheduler.start()
  runs.length = 0

  scheduler.handleUnlock()
  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'unlock' }])
})

test('a paused scheduler starts nothing on wake', async () => {
  const { scheduler, runs } = harness([powerJob('a', 'wake')], { paused: true })
  await scheduler.start()
  runs.length = 0

  scheduler.handleWake()
  assert.deepEqual(runs, [])
})

test('a disabled job, and a disabled trigger, are both ignored', async () => {
  const { scheduler, runs } = harness([
    powerJob('off', 'wake', { enabled: false }),
    makeJob('muted', { triggers: [{ type: 'power', event: 'wake', enabled: false }] }),
    // Deliberately behind the two skipped ones: skipping must not mean
    // stopping. Written this way because the first version of the loop said
    // `break`, and a test with nothing after the disabled job passed anyway.
    powerJob('live', 'wake'),
  ])
  await scheduler.start()
  runs.length = 0

  scheduler.handleWake()
  assert.deepEqual(runs, [{ jobId: 'live', trigger: 'wake' }])
})

test('a job needing an unlocked session waits for the unlock, not the wake', async () => {
  const job = powerJob('a', 'wake', {
    execution: { ...makeJob('a').execution, requiresUnlockedSession: true },
  })
  const { scheduler, runs } = harness([job])
  await scheduler.start()
  scheduler.handleLock()
  runs.length = 0

  // Waking at the lock screen: the keychain is not available, so neither is
  // the job.
  scheduler.handleWake()
  assert.deepEqual(runs, [], 'held back while the screen is locked')

  scheduler.handleUnlock()
  assert.deepEqual(runs, [{ jobId: 'a', trigger: 'wake' }], 'and it goes as soon as it can')
})

test('a job with both a schedule and a power trigger is not run twice at once', async () => {
  const job = makeJob('a', {
    triggers: [
      { type: 'interval', every: 5, unit: 'minutes' },
      { type: 'power', event: 'wake' },
    ],
  })
  // Late enough that the catch-up wants it too.
  const { scheduler, runs } = harness([job], {
    lastRuns: { a: { at: new Date(Date.now() - HOUR).toISOString(), status: 'success' } },
  })
  await scheduler.start()
  runs.length = 0

  scheduler.handleWake()
  // The catch-up fires it; the power trigger must not add a second run on top.
  assert.equal(runs.length, 1, `expected one run, got ${JSON.stringify(runs)}`)
})

// --- the after trigger ----------------------------------------------------------
//
// Reacting to another job's ending. The rule that shapes everything here is one
// hop: a job started this way starts nothing itself, which is what makes cycles
// impossible without a depth counter nobody would tune.

const afterJob = (id, job, on) =>
  makeJob(id, { triggers: [{ type: 'after', job, ...(on ? { on } : {}) }] })

/** What the runner announces when a job ends, for the cases a run cannot make. */
const ended = (scheduler, runner, jobId, status, trigger = 'schedule') =>
  runner.emit('finished', { jobId, status, trigger })

test('a job waiting on another runs when it succeeds', async () => {
  const { scheduler, runs, runner } = harness([makeJob('backup'), afterJob('upload', 'backup')])
  await scheduler.start()
  runs.length = 0

  ended(scheduler, runner, 'backup', 'success')
  assert.deepEqual(runs, [{ jobId: 'upload', trigger: 'after' }])
})

test('success is the default, so a failure starts nothing', async () => {
  const { scheduler, runs, runner } = harness([makeJob('backup'), afterJob('upload', 'backup')])
  await scheduler.start()
  runs.length = 0

  ended(scheduler, runner, 'backup', 'failed')
  assert.deepEqual(runs, [], 'uploading what a failed backup produced is the footgun')
})

test('on failure covers both a failure and a timeout', async () => {
  for (const status of ['failed', 'timed-out']) {
    const { scheduler, runs, runner } = harness([
      makeJob('backup'),
      afterJob('warn', 'backup', 'failure'),
    ])
    await scheduler.start()
    runs.length = 0

    ended(scheduler, runner, 'backup', status)
    assert.deepEqual(runs, [{ jobId: 'warn', trigger: 'after' }], `for ${status}`)
  }
})

test('on any covers success and failure alike', async () => {
  for (const status of ['success', 'failed', 'timed-out']) {
    const { scheduler, runs, runner } = harness([
      makeJob('backup'),
      afterJob('log', 'backup', 'any'),
    ])
    await scheduler.start()
    runs.length = 0

    ended(scheduler, runner, 'backup', status)
    assert.equal(runs.length, 1, `for ${status}`)
  }
})

test('a run that never happened is not an ending', async () => {
  const { scheduler, runs, runner } = harness([makeJob('backup'), afterJob('log', 'backup', 'any')])
  await scheduler.start()
  runs.length = 0

  ended(scheduler, runner, 'backup', 'skipped-already-running')
  assert.deepEqual(runs, [], 'it did not run, so nothing follows it')
})

test('a run somebody stopped by hand starts nothing', async () => {
  const { scheduler, runs, runner } = harness([makeJob('backup'), afterJob('log', 'backup', 'any')])
  await scheduler.start()
  runs.length = 0

  // Whoever pressed stop was already watching; reacting would be talking over
  // them.
  ended(scheduler, runner, 'backup', 'cancelled')
  assert.deepEqual(runs, [])
})

test('one hop, never a chain', async () => {
  const { scheduler, runs, runner } = harness([
    makeJob('a'),
    afterJob('b', 'a', 'any'),
    afterJob('c', 'b', 'any'),
  ])
  await scheduler.start()
  runs.length = 0

  ended(scheduler, runner, 'a', 'success')
  // b runs, and b's own ending — carrying the `after` label — starts nothing.
  assert.deepEqual(runs, [{ jobId: 'b', trigger: 'after' }])
})

test('two jobs waiting on each other cannot loop', async () => {
  const { scheduler, runs, runner } = harness([afterJob('a', 'b', 'any'), afterJob('b', 'a', 'any')])
  await scheduler.start()
  runs.length = 0

  ended(scheduler, runner, 'a', 'success')
  // b runs once. Its ending is an `after` ending, so it does not start a back.
  assert.deepEqual(runs, [{ jobId: 'b', trigger: 'after' }])
})

test('a paused scheduler reacts to nothing', async () => {
  const { scheduler, runs, runner } = harness([makeJob('backup'), afterJob('upload', 'backup')], {
    paused: true,
  })
  await scheduler.start()
  runs.length = 0

  ended(scheduler, runner, 'backup', 'success')
  assert.deepEqual(runs, [])
})

test('a disabled job and a disabled trigger are both ignored', async () => {
  const { scheduler, runs, runner } = harness([
    makeJob('backup'),
    afterJob('off', 'backup', 'any'),
    makeJob('muted', { triggers: [{ type: 'after', job: 'backup', on: 'any', enabled: false }] }),
    afterJob('live', 'backup', 'any'),
  ])
  await scheduler.start()
  // The one that must be skipped is disabled after the harness built it.
  scheduler.store.getJobs()[1].enabled = false
  runs.length = 0

  ended(scheduler, runner, 'backup', 'success')
  assert.deepEqual(runs, [{ jobId: 'live', trigger: 'after' }])
})

test('a stopped scheduler has let go of the runner', async () => {
  const { scheduler, runs, runner } = harness([makeJob('backup'), afterJob('upload', 'backup')])
  await scheduler.start()
  scheduler.stop()
  runs.length = 0

  ended(scheduler, runner, 'backup', 'success')
  assert.deepEqual(runs, [])
})

// --- the path trigger -----------------------------------------------------------
//
// Real files in a real directory: a watcher is one of the few things worth
// testing against the actual system, because what it does depends on the
// platform's event coalescing rather than on our code.

const fsp = require('node:fs')
const os = require('node:os')
const nodePath = require('node:path')

const SETTLE = 0.05 // seconds — the same rule, at a speed a test can wait for

function watchedDir(t) {
  const dir = fsp.mkdtempSync(nodePath.join(os.tmpdir(), 'rota-watch-'))
  t.after(() => fsp.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * The harness, with the scheduler guaranteed to let go of its watchers.
 *
 * An open fs.watch handle keeps the process alive, so a stop() written after
 * the assertions turns any failing test into a hung run — which is what the
 * first version of this file did.
 */
function watching(t, jobs, options) {
  const built = harness(jobs, options)
  t.after(() => built.scheduler.stop())
  return built
}

const pathJob = (id, path, overrides = {}) =>
  makeJob(id, { triggers: [{ type: 'path', path, settleSeconds: SETTLE }], ...overrides })

const settled = () => new Promise((resolve) => setTimeout(resolve, SETTLE * 1000 + 250))

// A watcher ignores its first settle window on purpose — see watch-path.js —
// so anything written before it has warmed up describes the state we found
// rather than a change.
const warmedUp = settled

test('writing into a watched directory starts the job', async (t) => {
  const dir = watchedDir(t)
  const { scheduler, runs } = watching(t, [pathJob('sort', dir)])
  await scheduler.start()
  runs.length = 0

  await warmedUp()
  fsp.writeFileSync(nodePath.join(dir, 'invoice.pdf'), 'x')
  await settled()

  assert.deepEqual(runs, [{ jobId: 'sort', trigger: 'path' }])
})

test('a burst of files is one execution, not one per file', async (t) => {
  const dir = watchedDir(t)
  const { scheduler, runs } = watching(t, [pathJob('sort', dir)])
  await scheduler.start()
  runs.length = 0

  await warmedUp()
  // What unpacking an archive looks like from here.
  for (let index = 0; index < 40; index++) {
    fsp.writeFileSync(nodePath.join(dir, `file-${index}`), 'x')
  }
  await settled()

  assert.equal(runs.length, 1, `expected one run, got ${runs.length}`)
})

test('a file written a level down still counts', async (t) => {
  const dir = watchedDir(t)
  fsp.mkdirSync(nodePath.join(dir, 'nested'))
  const { scheduler, runs } = watching(t, [pathJob('sort', dir)])
  await scheduler.start()
  runs.length = 0

  await warmedUp()
  fsp.writeFileSync(nodePath.join(dir, 'nested', 'deep.txt'), 'x')
  await settled()

  assert.equal(runs.length, 1, 'a directory is watched recursively')
})

test('nothing happens while nothing is written', async (t) => {
  const dir = watchedDir(t)
  const { scheduler, runs } = watching(t, [pathJob('sort', dir)])
  await scheduler.start()
  runs.length = 0

  await settled()
  assert.deepEqual(runs, [])
})

test('a paused scheduler watches nothing', async (t) => {
  const dir = watchedDir(t)
  const { scheduler, runs } = watching(t, [pathJob('sort', dir)], { paused: true })
  await scheduler.start()
  runs.length = 0

  await warmedUp()
  fsp.writeFileSync(nodePath.join(dir, 'x'), 'x')
  await settled()

  assert.deepEqual(runs, [])
  assert.equal(scheduler.watchers.size, 0, 'and it did not even open a handle')
})

test('stopping lets go of the watchers', async (t) => {
  const dir = watchedDir(t)
  const { scheduler, runs } = watching(t, [pathJob('sort', dir)])
  await scheduler.start()
  assert.equal(scheduler.watchers.size, 1)

  scheduler.stop()
  assert.equal(scheduler.watchers.size, 0)

  runs.length = 0
  await warmedUp()
  fsp.writeFileSync(nodePath.join(dir, 'after-stop'), 'x')
  await settled()
  assert.deepEqual(runs, [])
})

test('a path that is not there is reported, and does not take the rest down', async (t) => {
  const dir = watchedDir(t)
  const { scheduler, runs } = watching(t, [
    pathJob('missing', nodePath.join(dir, 'nowhere')),
    pathJob('live', dir),
  ])
  await scheduler.start()

  assert.equal(scheduler.unwatchable.size, 1, 'the absent one is named')
  assert.equal(scheduler.watchers.size, 1, 'the other one is still watched')

  runs.length = 0
  await warmedUp()
  fsp.writeFileSync(nodePath.join(dir, 'x'), 'x')
  await settled()
  assert.deepEqual(runs, [{ jobId: 'live', trigger: 'path' }])
})

test('a watcher is not rebuilt on every sync', async (t) => {
  const dir = watchedDir(t)
  const { scheduler } = watching(t, [pathJob('sort', dir)])
  await scheduler.start()

  const before = scheduler.watchers.get('sort::0') ?? [...scheduler.watchers.values()][0]
  scheduler.sync()
  scheduler.sync()
  const after = [...scheduler.watchers.values()][0]

  // Tearing an inotify handle down and rebuilding it every time any job's state
  // moved would be a lot of syscalls for no change.
  assert.equal(before, after, 'the same watcher is kept')
})

test('a watcher does not report the state it found', async (t) => {
  const dir = watchedDir(t)
  // Written before anything watches it. On macOS fs.watch delivers the recent
  // past when it attaches, so without the warm-up this file would arrive as if
  // it had just landed — and every restart of the scheduler would run every
  // path job.
  fsp.writeFileSync(nodePath.join(dir, 'was-already-here'), 'x')

  const { scheduler, runs } = watching(t, [pathJob('sort', dir)])
  await scheduler.start()
  runs.length = 0

  await warmedUp()
  await settled()
  assert.deepEqual(runs, [], 'nothing happened while we were watching')

  // And it is warm now, not deaf.
  fsp.writeFileSync(nodePath.join(dir, 'landed-since'), 'x')
  await settled()
  assert.equal(runs.length, 1)
})
