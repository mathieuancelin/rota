'use strict'

// One job triggering another.
//
// The intended use: a job that works through a queue item by item and
// reschedules itself at the end, until there is nothing left. What is exercised
// here is therefore above all what stops that loop going off the rails —
// self-waiting, the launch ceiling, the allowlist.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createJobLauncher, MAX_TRIGGERS_PER_RUN } = require('../src/agent/jobs')
const { runJob } = require('../src/agent/tools/jobs')
const { selectTools, byName } = require('../src/agent/tools')
const { validateJob } = require('../src/config/validate')

const makeJob = (id, tools = {}) => {
  const result = validateJob({
    id,
    name: id,
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: {
      type: 'agent',
      agent: { prompt: 'x', model: 'm', tools: { enabled: ['run_job'], ...tools } },
    },
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

const ENTRY = {
  status: 'success',
  durationMs: 1234,
  exitCode: 0,
  stdout: 'three issues handled\n',
  stderr: '',
  error: null,
}

function makeLauncher({ jobs = ['depile', 'autre'], entry = ENTRY } = {}) {
  const calls = []
  const launcher = createJobLauncher({
    store: {
      getJob: (id) => (jobs.includes(id) ? makeJob(id) : null),
      getJobs: () => jobs.map((id) => ({ id })),
    },
    scheduler: {
      runNow: async (id, options) => {
        calls.push(['runNow', id, options?.trigger])
        return { ok: true }
      },
    },
    runner: {
      run: async (job, options) => {
        calls.push(['run', job.id, options.trigger])
        return entry
      },
    },
  })
  return { launcher, calls }
}

const context = (job, launcher, overrides = {}) => ({
  job,
  config: job.runner.agent.tools,
  jobs: launcher,
  triggers: { count: 0, max: MAX_TRIGGERS_PER_RUN },
  signal: undefined,
  ...overrides,
})

// --- immediate launch ---------------------------------------------------------

test('without waiting, the job is started and the hand given straight back', async () => {
  const { launcher, calls } = makeLauncher()
  const ctx = context(makeJob('depile'), launcher)

  const result = await runJob.run({ job: 'autre' }, ctx)

  assert.equal(result.ok, true, result.error)
  // The trigger is recorded as coming from an agent, not from a human.
  assert.deepEqual(calls, [['runNow', 'autre', 'agent']])
  assert.ok(result.content.includes('has been started'))
})

test("when it waits, the job's result is handed to the model", async () => {
  const { launcher, calls } = makeLauncher()
  const ctx = context(makeJob('depile'), launcher)

  const result = await runJob.run({ job: 'autre', wait: true }, ctx)

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(calls, [['run', 'autre', 'agent']])
  assert.ok(result.content.includes('success'))
  assert.ok(result.content.includes('1234 ms'))
  assert.ok(result.content.includes('three issues handled'))
})

test('a failure of the called job is returned with its cause', async () => {
  const { launcher } = makeLauncher({
    entry: { ...ENTRY, status: 'failed', exitCode: 1, error: 'The script exited with code 1.' },
  })
  const result = await runJob.run({ job: 'autre', wait: true }, context(makeJob('depile'), launcher))

  assert.equal(result.ok, true, "the tool worked; it is the job that failed")
  assert.ok(result.content.includes('failed'))
  assert.ok(result.content.includes('code 1'))
})

// --- rescheduling -------------------------------------------------------------

// The use that motivated the tool: restarting once the current work is done.
test('a deferred launch hands back without waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { launcher, calls } = makeLauncher()
  const ctx = context(makeJob('depile'), launcher)

  const result = await runJob.run({ job: 'depile', delaySeconds: 60 }, ctx)

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(calls, [], 'nothing is started right away')
  assert.ok(result.content.includes('60 seconds'))
  assert.ok(result.content.includes('does not survive'), 'the ceiling is said to the model')

  t.mock.timers.tick(60_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [['runNow', 'depile', 'agent']])
})

// Either the job refuses simultaneous executions and the launch is ignored, or it
// accepts them and nested executions stack up to the maximum delay.
test('a job cannot wait on its own launch', async () => {
  const { launcher, calls } = makeLauncher()
  const result = await runJob.run({ job: 'depile', wait: true }, context(makeJob('depile'), launcher))

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('its own launch'))
  assert.ok(result.error.includes('without waiting'), 'the right way is pointed at')
  assert.deepEqual(calls, [])
})

test('starting again without waiting stays possible', async () => {
  const { launcher, calls } = makeLauncher()
  const result = await runJob.run({ job: 'depile' }, context(makeJob('depile'), launcher))

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(calls, [['runNow', 'depile', 'agent']])
})

// --- guards --------------------------------------------------------------------

// An agent stacking up launches would do more damage than one that loops: the
// loop, at least, is bounded by maxIterations.
test('the number of launches per execution has a ceiling', async () => {
  const { launcher, calls } = makeLauncher()
  const ctx = context(makeJob('depile'), launcher)

  for (let index = 0; index < MAX_TRIGGERS_PER_RUN; index += 1) {
    assert.equal((await runJob.run({ job: 'autre' }, ctx)).ok, true, `lancement ${index + 1}`)
  }
  const trop = await runJob.run({ job: 'autre' }, ctx)

  assert.equal(trop.ok, false)
  assert.ok(trop.error.includes('maximum'))
  assert.equal(calls.length, MAX_TRIGGERS_PER_RUN)
})

test('the allow list restricts what can be triggered', async () => {
  const { launcher, calls } = makeLauncher()
  const job = makeJob('depile', { jobs: { allow: ['autorisee'] } })

  const refus = await runJob.run({ job: 'autre' }, context(job, launcher))
  assert.equal(refus.ok, false)
  assert.ok(refus.error.includes('tools.jobs.allow'))
  assert.deepEqual(calls, [])
})

test('empty, the list forbids nothing', async () => {
  const { launcher, calls } = makeLauncher()
  await runJob.run({ job: 'autre' }, context(makeJob('depile'), launcher))
  assert.equal(calls.length, 1)
})

test('an unknown job is reported along with those that exist', async () => {
  const { launcher } = makeLauncher()
  const result = await runJob.run({ job: 'fantome' }, context(makeJob('depile'), launcher))

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('unknown job'))
  assert.ok(result.error.includes('depile'))
})

test('malformed arguments are refused before anything is started', async () => {
  const { launcher, calls } = makeLauncher()
  const ctx = context(makeJob('depile'), launcher)

  assert.equal((await runJob.run({ job: '  ' }, ctx)).ok, false)
  assert.equal((await runJob.run({ job: 'autre', delaySeconds: -5 }, ctx)).ok, false)
  assert.equal((await runJob.run({ job: 'autre', delaySeconds: 1.5 }, ctx)).ok, false)
  assert.deepEqual(calls, [])
})

test('an outsized delay is brought back to the bound, not refused', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { launcher, calls } = makeLauncher()

  const result = await runJob.run(
    { job: 'autre', delaySeconds: 999_999 },
    context(makeJob('depile'), launcher),
  )

  assert.equal(result.ok, true, result.error)
  t.mock.timers.tick(86_400_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
})

// --- availability --------------------------------------------------------------

test('the tool is offered only if it is declared', () => {
  const avec = byName(selectTools(makeJob('depile')).tools)
  assert.ok(avec.has('run_job'))

  const sans = byName(selectTools(makeJob('depile', { enabled: ['todo'] })).tools)
  assert.equal(sans.has('run_job'), false)
})
