'use strict'

// Chaining the steps of a workflow.
//
// What is at stake here comes down to three rules, and each is costly when it
// breaks: the steps run in the order written, the first that fails stops the
// chain, and nothing they do lands in the history outside the workflow's entry.
// That last one is the least visible: a referenced job writing its own line
// would appear to have run on its own, with its notification, when nobody
// scheduled it.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { Runner, STATUS } = require('../src/runner')
const { createWorkflowTranscript, describeWorkflow, runSteps } = require('../src/runner/workflow')

const DEFAULT_EXECUTION = {
  timeoutSeconds: 10,
  allowConcurrentRuns: false,
  runOnStartup: false,
  catchUpOnWake: true,
  maxOutputBytes: 1048576,
  sandbox: { enabled: false, image: 'oven/bun:1', network: false, mountWorkingDirectory: true },
}

const workflowJob = (steps, overrides = {}) => ({
  id: 'chain',
  name: 'Chain',
  enabled: true,
  triggers: [],
  runner: { type: 'workflow', workflow: { steps }, args: [], environment: {} },
  execution: { ...DEFAULT_EXECUTION, ...overrides.execution },
  notifications: { onStart: false, onSuccess: false, onError: true },
  history: { enabled: true, retainExecutions: 500 },
})

/**
 * An execution double: it returns the entry a step would have produced, without
 * starting anything. What is exercised here is the chaining, not the spawn —
 * that one has its own tests, and running them here would make these slow and
 * brittle.
 */
function harness(outcomes) {
  const seen = []
  const transcript = createWorkflowTranscript()

  const execute = async (stepJob, options) => {
    const outcome = outcomes[seen.length] ?? {}
    seen.push({ id: stepJob.id, name: stepJob.name, type: stepJob.runner.type, ...options })
    options.onOutput?.('stdout', outcome.stdout ?? '')
    return {
      status: outcome.status ?? 'success',
      durationMs: outcome.durationMs ?? 10,
      error: outcome.error ?? null,
    }
  }

  return { seen, transcript, execute }
}

const run = (job, outcomes = [], { jobs = {} } = {}) => {
  const { seen, transcript, execute } = harness(outcomes)
  const stderr = []
  return runSteps({
    job,
    transcript,
    execute,
    resolveJob: (id) => jobs[id] ?? null,
    signal: new AbortController().signal,
    onStderr: (text) => stderr.push(text),
  }).then((result) => ({ result, seen, stderr, text: transcript.text() }))
}

// --- chaining -----------------------------------------------------------------

test('the steps go in the order they were written', async () => {
  const job = workflowJob([
    { name: 'one', runner: { type: 'bun-inline', code: 'a' } },
    { name: 'two', runner: { type: 'bun-inline', code: 'b' } },
    { name: 'three', runner: { type: 'bun-inline', code: 'c' } },
  ])

  const { result, seen } = await run(job)

  assert.equal(result.ok, true)
  assert.equal(seen.length, 3)
  assert.deepEqual(
    seen.map((step) => step.name),
    ['Chain — one', 'Chain — two', 'Chain — three'],
  )
})

test('the first failed step stops the chain', async () => {
  const job = workflowJob([
    { name: 'one', runner: { type: 'bun-inline', code: 'a' } },
    { name: 'two', runner: { type: 'bun-inline', code: 'b' } },
    { name: 'three', runner: { type: 'bun-inline', code: 'c' } },
  ])

  const { result, seen, text } = await run(job, [
    { status: 'success' },
    { status: 'failed', error: 'exit 1' },
  ])

  assert.equal(result.ok, false)
  assert.equal(result.failedAt, 1)
  assert.equal(seen.length, 2, 'the third one was not started')
  assert.match(result.error, /Step 2 \(two\) failed: exit 1/)
  assert.match(text, /2 of 3 steps ran, stopped at step 2\./)
})

// A step one knows may fail without consequence — a cleanup, an optional
// publication — must not take the rest down with it.
test('continueOnError lets a failed step through', async () => {
  const job = workflowJob([
    { name: 'un', runner: { type: 'bun-inline', code: 'a' }, continueOnError: true },
    { name: 'deux', runner: { type: 'bun-inline', code: 'b' } },
  ])

  const { result, seen } = await run(job, [{ status: 'failed', error: 'tant pis' }])

  assert.equal(result.ok, true)
  assert.equal(seen.length, 2)
})

// A job already running is not a failure of the chain: it was started elsewhere,
// what the step wanted is happening.
test('a step skipped because it is already running breaks nothing', async () => {
  const job = workflowJob([
    { job: 'tests' },
    { name: 'suite', runner: { type: 'bun-inline', code: 'b' } },
  ])
  const jobs = { tests: { id: 'tests', name: 'Tests', runner: { type: 'shell' } } }

  const { result, seen, text } = await run(
    job,
    [{ status: 'skipped-already-running', error: 'A previous execution is still running.' }],
    { jobs },
  )

  assert.equal(result.ok, true)
  assert.equal(seen.length, 2)
  assert.match(text, /· skipped —/)
})

// --- referenced steps -----------------------------------------------------------

test('a referenced step runs the definition of the job it names', async () => {
  const job = workflowJob([{ job: 'tests' }])
  const jobs = { tests: { id: 'tests', name: 'Tests', runner: { type: 'shell' } } }

  const { seen, text } = await run(job, [], { jobs })

  assert.equal(seen[0].id, 'tests')
  assert.equal(seen[0].skipConcurrency, false, 'sa propre concurrence continue de s’appliquer')
  assert.match(text, /step 1\/1 · Tests \(job "tests"\)/)
})

// A step written on the spot carries the workflow's identifier: the concurrency
// guard would see the workflow itself, running, and would skip every step.
test('a step written on the spot does not collide with the workflow carrying it', async () => {
  const job = workflowJob([{ runner: { type: 'bun-inline', code: 'a' } }])

  const { seen } = await run(job)

  assert.equal(seen[0].id, 'chain')
  assert.equal(seen[0].skipConcurrency, true)
})

test('a named job that does not exist stops the chain, and says so', async () => {
  const job = workflowJob([{ job: 'fantome' }, { runner: { type: 'bun-inline', code: 'b' } }])

  const { result, seen, text } = await run(job)

  assert.equal(result.ok, false)
  assert.equal(seen.length, 0, 'nothing was started')
  assert.match(result.error, /unknown job: fantome/)
  assert.match(text, /unknown job: fantome/)
})

// --- the trail ------------------------------------------------------------------

test("a step's output is copied as it is under its heading", async () => {
  const job = workflowJob([{ name: 'build', runner: { type: 'bun-inline', code: 'a' } }])

  const { text } = await run(job, [{ stdout: 'compilation…\n2 fichiers\n' }])

  assert.match(text, /── step 1\/1 · build ──\ncompilation…\n2 fichiers\n✓ succeeded/)
})

// The change marker must survive the passage through the trail: it is what
// decides whether the notification goes out, and it is written by the step, not by us.
test("a step's change marker stays readable in the trail", async () => {
  const job = workflowJob([{ runner: { type: 'bun-inline', code: 'a' } }])

  const { text } = await run(job, [{ stdout: '::rota:changed:: 3 pushed\n' }])

  assert.match(text, /^::rota:changed:: 3 pushed$/m)
})

// The output arrives in chunks, which do not stop on newlines: without a buffer,
// a line cut in two becomes two.
test('a line cut between two chunks stays one line', async () => {
  const transcript = createWorkflowTranscript()
  transcript.output('start of a li')
  transcript.output('ne\nnext\n')
  transcript.output('no trailing newline')
  transcript.final('done')

  const lines = transcript.text().split('\n')

  assert.ok(lines.includes('start of a line'), transcript.text())
  assert.ok(lines.includes('next'))
  assert.ok(lines.includes('no trailing newline'))
})

test('describeWorkflow enumerates the steps in order', () => {
  const job = workflowJob([
    { name: 'build', runner: { type: 'bun-inline', code: 'a' } },
    { job: 'tests' },
    { runner: { type: 'shell', script: '/x.sh' } },
  ])

  assert.equal(describeWorkflow(job), 'workflow: build → tests → shell')
})

// --- end to end, with real processes ---------------------------------------------

async function realRunner(t, job, jobs = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-workflow-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const entries = []
  const runner = new Runner({
    store: {
      getConfig: () => ({ runners: { bunPath: null } }),
      getJob: (id) => (id === job.id ? job : (jobs[id] ?? null)),
      paths: { inlineDir: dir },
    },
    history: {
      append: async (entry) => {
        entries.push(entry)
        return entry
      },
    },
  })
  return { runner, entries, dir }
}

const script = async (dir, name, body) => {
  const filePath = path.join(dir, name)
  await fs.writeFile(filePath, body, { mode: 0o755 })
  return filePath
}

test('a workflow of scripts produces one history entry', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-scripts-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const un = await script(dir, 'un.sh', '#!/bin/sh\necho first\n')
  const deux = await script(dir, 'deux.sh', '#!/bin/sh\necho second\n')

  const job = workflowJob([
    { name: 'un', runner: { type: 'shell', script: un, interpreter: 'sh', args: [], environment: {} } },
    { name: 'deux', runner: { type: 'shell', script: deux, interpreter: 'sh', args: [], environment: {} } },
  ])
  const { runner, entries } = await realRunner(t, job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entries.length, 1, "one entry only, the workflow's")
  assert.equal(entry.status, STATUS.SUCCESS)
  assert.equal(entry.exitCode, 0)
  assert.match(entry.stdout, /first/)
  assert.match(entry.stdout, /second/)
  assert.match(entry.stdout, /2 steps completed\./)
})

test('a referenced step does not write an entry of its own', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-ref-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const cible = {
    id: 'cible',
    name: 'Cible',
    enabled: true,
    triggers: [],
    runner: {
      type: 'shell',
      script: await script(dir, 'target.sh', '#!/bin/sh\necho from the target\n'),
      interpreter: 'sh',
      args: [],
      environment: {},
    },
    execution: { ...DEFAULT_EXECUTION },
    notifications: { onStart: false, onSuccess: false, onError: true },
    history: { enabled: true, retainExecutions: 500 },
  }

  const job = workflowJob([{ job: 'cible' }])
  const { runner, entries } = await realRunner(t, job, { cible })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.deepEqual(
    entries.map((written) => written.jobId),
    ['chain'],
  )
  assert.match(entry.stdout, /from the target/)
})

test('a failed script fails the workflow, and says so', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-fail-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const job = workflowJob([
    {
      name: 'breaks',
      runner: {
        type: 'shell',
        script: await script(dir, 'ko.sh', '#!/bin/sh\necho before >&2\nexit 3\n'),
        interpreter: 'sh',
        args: [],
        environment: {},
      },
    },
    {
      name: 'never',
      runner: {
        type: 'shell',
        script: await script(dir, 'ok.sh', '#!/bin/sh\necho after\n'),
        interpreter: 'sh',
        args: [],
        environment: {},
      },
    },
  ])
  const { runner } = await realRunner(t, job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.equal(entry.exitCode, 1)
  assert.match(entry.error, /Step 1 \(breaks\)/)
  assert.match(entry.stderr, /before/, "the step's error output comes back")
  assert.ok(!entry.stdout.includes('after'), 'the second step did not run')
})

// The list of running executions shows only the workflow: it is the one watched
// and the one stopped. The concurrency guard, on the other hand, sees the steps.
test('the steps do not appear among the running executions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-vue-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const job = workflowJob([
    {
      name: 'lente',
      runner: {
        type: 'shell',
        script: await script(dir, 'lente.sh', '#!/bin/sh\nsleep 0.3\n'),
        interpreter: 'sh',
        args: [],
        environment: {},
      },
    },
  ])
  const { runner } = await realRunner(t, job)

  const pending = runner.run(job, { trigger: 'manual' })
  await new Promise((resolve) => setTimeout(resolve, 120))

  const visible = runner.runningExecutions()
  assert.deepEqual(
    visible.map((execution) => execution.jobId),
    ['chain'],
  )
  assert.equal(runner.runningByJob().get('chain'), 1)

  await pending
})

// --- what a step receives from the previous ones ---------------------------------
//
// Steps used to share nothing at all — not even an execution identifier, since
// each one gets its own. Collecting the results of a chain meant writing files to
// a directory keyed on the job id and hoping nothing stale was left in it.

const { withPreviousSteps, stepsAsJson, stepsAsText, STEPS_PAYLOAD_LIMIT } = require('../src/runner/workflow')

const scriptJob = (environment = {}) => ({
  id: 'chain',
  runner: { type: 'bun-inline', code: 'a', environment },
})

const record = (name, output, status = 'success') => ({ name, status, durationMs: 100, output })

// A script parses it; testing for the variable's absence first would be one more
// thing to get right in every step.
test('the first step receives an empty list, not nothing at all', () => {
  const prepared = withPreviousSteps(scriptJob(), [])

  assert.equal(prepared.runner.environment.ROTA_STEPS, '[]')
})

test('a script step receives the previous ones as JSON', () => {
  const prepared = withPreviousSteps(scriptJob(), [record('services', '200 example.com')])

  const steps = JSON.parse(prepared.runner.environment.ROTA_STEPS)
  assert.deepEqual(steps, [
    { name: 'services', status: 'success', durationMs: 100, output: '200 example.com' },
  ])
})

test('the variables the job declares are kept', () => {
  const prepared = withPreviousSteps(scriptJob({ TOKEN: 'x' }), [record('a', 'b')])

  assert.equal(prepared.runner.environment.TOKEN, 'x')
  assert.ok(prepared.runner.environment.ROTA_STEPS)
})

// A model reads a paragraph better than an escaped array, and has no environment
// to read anyway.
test('an agent step receives them in its prompt, as prose', () => {
  const agent = {
    id: 'chain',
    runner: { type: 'agent', agent: { prompt: 'Fais un rapport.', model: 'x' } },
  }

  const prepared = withPreviousSteps(agent, [record('services', '200 example.com')])

  assert.match(prepared.runner.agent.prompt, /^Fais un rapport\./)
  assert.match(prepared.runner.agent.prompt, /# What the previous steps produced/)
  assert.match(prepared.runner.agent.prompt, /## Step 1 — services \(success, 0\.1 s\)/)
  assert.match(prepared.runner.agent.prompt, /200 example\.com/)
  assert.equal(prepared.runner.agent.environment, undefined, 'rien ne part dans l’environnement')
})

test('an agent in first position gets no empty section glued to its prompt', () => {
  const agent = { id: 'c', runner: { type: 'agent', agent: { prompt: 'Fais.', model: 'x' } } }

  assert.equal(withPreviousSteps(agent, []).runner.agent.prompt, 'Fais.')
})

// The definition of a referenced job belongs to the store: writing into it would
// leak one execution's context into the next.
test('the original definition is not modified', () => {
  const original = scriptJob({ TOKEN: 'x' })

  withPreviousSteps(original, [record('a', 'b')])

  assert.equal(original.runner.environment.ROTA_STEPS, undefined)
})

// The environment of a child process goes through ARG_MAX: one chatty step would
// otherwise be enough to stop every step after it from starting at all.
test('a chatty step does not overflow the environment', () => {
  const enorme = 'x'.repeat(200_000)
  const previous = Array.from({ length: 40 }, (_, i) => record(`etape-${i}`, enorme))

  const json = stepsAsJson(previous)

  assert.ok(json.length <= STEPS_PAYLOAD_LIMIT, `${json.length} octets`)
})

// What gets dropped is the oldest: the last step's output is the one the next
// step is most likely to be working from. It takes a long chain to get there —
// per-step clipping alone keeps a handful of steps well under the ceiling.
test('what is dropped is the oldest, and it says so', () => {
  const enorme = 'x'.repeat(50_000)
  const longue = Array.from({ length: 40 }, (_, i) => record(`etape-${i}`, enorme))

  const steps = JSON.parse(stepsAsJson(longue))

  assert.match(steps[0].output, /dropped/, 'the oldest is sacrificed')
  assert.ok(steps.at(-1).output.startsWith('xxx'), 'la last est intacte')
})

test("a step's output is clipped, and says so", () => {
  const steps = JSON.parse(stepsAsJson([record('bavarde', 'y'.repeat(10_000))]))

  assert.match(steps[0].output, /\[…truncated\]$/)
  assert.ok(steps[0].output.length < 5000)
})

test('stepsAsText names every step, its status and its duration', () => {
  const text = stepsAsText([record('a', 'output a'), record('b', '', 'failed')])

  assert.match(text, /## Step 1 — a \(success, 0\.1 s\)\n\noutput a/)
  assert.match(text, /## Step 2 — b \(failed, 0\.1 s\)\n\n\(no output\)/)
})

// End to end: the second step reads what the first printed.
test("a step really reads the previous one's output", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-passe-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const job = workflowJob([
    {
      name: 'produced',
      runner: { type: 'bun-inline', code: "console.log('forty-two')\n", args: [], environment: {} },
    },
    {
      name: 'consumes',
      runner: {
        type: 'bun-inline',
        args: [],
        environment: {},
        code:
          'const steps = JSON.parse(process.env.ROTA_STEPS)\n' +
          'console.log(`received from ${steps[0].name}: ${steps[0].output}`)\n',
      },
    },
  ])
  const { runner } = await realRunner(t, job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS, entry.error ?? '')
  assert.match(entry.stdout, /received from produced: forty-two/)
})

// A step that has no use for the chain should not carry it: an agent pays for
// that text on every round trip, and a script would hold an environment variable
// it never reads.

test('a step may refuse what the previous ones produced', () => {
  const prepared = withPreviousSteps(scriptJob(), [record('a', 'b')], { receives: false })

  assert.equal(prepared.runner.environment.ROTA_STEPS, undefined)
})

// Absence rather than an empty list: one asked not to receive them.
test('a refusal does not leave an empty list behind it', () => {
  const prepared = withPreviousSteps(scriptJob(), [], { receives: false })

  assert.equal(prepared.runner.environment.ROTA_STEPS, undefined)
})

test('an agent that refuses keeps its prompt intact', () => {
  const agent = { id: 'c', runner: { type: 'agent', agent: { prompt: 'Fais.', model: 'x' } } }

  const prepared = withPreviousSteps(agent, [record('a', 'b')], { receives: false })

  assert.equal(prepared.runner.agent.prompt, 'Fais.')
})

test('receiving them stays the default', () => {
  const prepared = withPreviousSteps(scriptJob(), [record('a', 'b')])

  assert.ok(prepared.runner.environment.ROTA_STEPS)
})

// End to end: the flag set on the step is indeed read by the chain.
test('receivesPreviousSteps: false cuts the injection for that step alone', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-refus-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const sonde = {
    type: 'bun-inline',
    args: [],
    environment: {},
    code: "console.log('ROTA_STEPS=' + (process.env.ROTA_STEPS ?? 'absent'))\n",
  }
  const job = workflowJob([
    { name: 'premiere', runner: { type: 'bun-inline', args: [], environment: {}, code: "console.log('ok')\n" } },
    { name: 'refuse', receivesPreviousSteps: false, runner: sonde },
    { name: 'accepte', runner: sonde },
  ])
  const { runner } = await realRunner(t, job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS, entry.error ?? '')
  // The split gives the header, then one part per step.
  const [, , refuse, accepte] = entry.stdout.split('── step ')
  assert.match(refuse, /ROTA_STEPS=absent/)
  assert.match(accepte, /ROTA_STEPS=\[/)
})

// --- the working directory ---------------------------------------------------
//
// `spawn` returns ENOENT for a missing executable and for a missing current
// directory alike, and by the time the error is raised the two cannot be told
// apart. A forgotten `mkdir` used to send people off to check their Bun install.

test('a working directory that is not there is named, and nothing else', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-cwd-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const job = workflowJob([
    {
      name: 'perdue',
      runner: {
        type: 'bun-inline',
        args: [],
        environment: {},
        workingDirectory: path.join(dir, 'nulle-part'),
        code: "console.log('jamais')\n",
      },
    },
  ])
  const { runner } = await realRunner(t, job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.match(entry.stdout, /Working directory not found: .*nulle-part/)
  assert.ok(!entry.stdout.includes('Bun installation'), 'plus de fausse piste vers Bun')
})

// A workflow is where steps meet: its directory is the one they share, so it is
// created rather than demanded.
test('the directory a workflow declares is created', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-mkdir-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const partage = path.join(dir, 'a', 'creer')

  const job = workflowJob([
    { name: 'written', runner: { type: 'bun-inline', args: [], environment: {}, code: "require('node:fs').writeFileSync('trace.txt', 'ok')\nconsole.log(process.cwd())\n" } },
    { name: 'relit', runner: { type: 'bun-inline', args: [], environment: {}, code: "console.log(require('node:fs').readFileSync('trace.txt', 'utf8'))\n" } },
  ])
  job.runner.workingDirectory = partage
  const { runner } = await realRunner(t, job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS, entry.error ?? '')
  assert.match(entry.stdout, /a\/creer/, 'the steps run there')
  assert.match(entry.stdout, /^ok$/m, 'and find each other again from one step to the next')
  assert.equal(await fs.readFile(path.join(partage, 'trace.txt'), 'utf8'), 'ok')
})

// Creating it silently where a typo deserved a refusal is the trade; it stops at
// the workflow's own directory, and a step declaring its own is on its own.
test('a step declaring its own directory must still have it created', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-etape-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const job = workflowJob([
    {
      name: 'apart',
      runner: {
        type: 'bun-inline', args: [], environment: {},
        workingDirectory: path.join(dir, 'pas-la'),
        code: "console.log('jamais')\n",
      },
    },
  ])
  job.runner.workingDirectory = path.join(dir, 'partage')
  const { runner } = await realRunner(t, job)

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.match(entry.stdout, /Working directory not found: .*pas-la/)
})

// --- reports written by a step ------------------------------------------------
//
// Same reasoning as the change marker: a step's output is copied verbatim into
// the trail, so the workflow finds the markers there. The step, being nested,
// delivers nothing — otherwise the same report would be given twice.

const { REPORT, END } = require('../src/runner/markers')

test('a report written by a step is delivered once, by the workflow', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-wf-report-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const etape = await script(
    dir,
    'report.sh',
    `#!/bin/sh\necho "${REPORT} Bilan"\necho "deux fichiers"\necho "${END}"\n`,
  )
  const job = workflowJob([{ name: 'produire', runner: { type: 'shell', script: etape, interpreter: 'sh', args: [], environment: {} } }])

  const windows = []
  const runner = new Runner({
    store: {
      getConfig: () => ({ runners: { bunPath: null }, integrations: {} }),
      getJob: (id) => (id === job.id ? job : null),
      paths: { inlineDir: dir },
    },
    history: { append: async (entry) => entry },
    ui: { async report(payload) { windows.push(payload) }, async ask() { return {} }, async confirm() { return {} } },
  })

  const entry = await runner.run(job)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.deepEqual(windows, [{ title: 'Bilan', markdown: 'deux fichiers' }])
})
