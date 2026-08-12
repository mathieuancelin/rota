'use strict'

// Plugging an agent job into the runner.
//
// What is checked here is not the loop — it has its own tests — but the contract
// with the rest of the engine: an agent execution must be registered among the
// running executions, stop on request, and produce a history entry of the same
// shape as a script's.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Runner, STATUS } = require('../src/runner')
const { resolvePaths } = require('../src/config/paths')
const { validateJob } = require('../src/config/validate')

const CLES_HISTORIQUE = [
  'executionId',
  'jobId',
  'jobName',
  'trigger',
  'startedAt',
  'finishedAt',
  'durationMs',
  'status',
  'exitCode',
  'signal',
  'command',
  'workingDirectory',
  'stdout',
  'stderr',
  'stdoutTruncated',
  'stderrTruncated',
  'change',
  'error',
]

function makePaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-agentrun-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = resolvePaths(root)
  for (const dir of [paths.agentsDir, paths.memoryDir, paths.inlineDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return paths
}

function makeJob(agent = {}, execution = {}) {
  const result = validateJob({
    id: 'agent-demo',
    name: 'Demo agent',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: {
      type: 'agent',
      agent: { prompt: 'Fais le travail.', model: 'gemma4:latest', ...agent },
    },
    execution: { timeoutSeconds: 10, ...execution },
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

function makeRunner(job, paths) {
  const entries = []
  const runner = new Runner({
    store: {
      getConfig: () => ({ runners: { bunPath: null, dockerPath: null } }),
      getJob: () => job,
      paths,
    },
    history: {
      append: async (entry) => {
        entries.push(entry)
        return entry
      },
    },
  })
  return { runner, entries }
}

/**
 * A doubled server, placed on the global for the duration of the test: it is the
 * global `fetch` the loop uses when the runner calls it, with no injection point.
 */
function stubFetch(t, handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => {
    globalThis.fetch = original
  })
}

/**
 * A call that only hands back on interruption. The signal may already be
 * aborted when we get here — that is even the case in the cancellation test,
 * where the stop is requested from the double itself.
 */
const untilAborted = (signal) =>
  new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })

const answer = (message) =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

test("a successful execution produces an entry of the same shape as a script's", async (t) => {
  const paths = makePaths(t)
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const { runner, entries } = makeRunner(job, paths)
  stubFetch(t, async () => answer({ role: 'assistant', content: 'Tout est en ordre.' }))

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.status, STATUS.SUCCESS)
  assert.equal(entry.exitCode, 0)
  assert.equal(entry.signal, null)
  assert.equal(entry.error, null)
  assert.equal(entry.trigger, 'manual')
  assert.ok(entry.command.startsWith('agent gemma4:latest @ '))
  assert.equal(entry.workingDirectory, path.join(paths.agentsDir, 'agent-demo'))
  assert.ok(entry.stdout.includes('Tout est en ordre.'))
  assert.deepEqual(Object.keys(entry).sort(), [...CLES_HISTORIQUE].sort())
  assert.equal(entries.length, 1)
})

test('a failure of the loop gives a failed status and a readable cause', async (t) => {
  const paths = makePaths(t)
  const job = makeJob()
  const { runner } = makeRunner(job, paths)
  stubFetch(t, async () => new Response('unknown model', { status: 404 }))

  const entry = await runner.run(job, { trigger: 'schedule' })

  assert.equal(entry.status, STATUS.FAILED)
  assert.equal(entry.exitCode, 1)
  assert.ok(entry.error.includes('404'))
  assert.ok(entry.stderr.includes('404'))
})

test('the execution is visible among the running ones, and stops on request', async (t) => {
  const paths = makePaths(t)
  const job = makeJob()
  const { runner } = makeRunner(job, paths)

  let seen = null
  stubFetch(t, (_url, options) => {
    // By the time the model is called, the execution must already be registered.
    seen = runner.runningExecutions()
    runner.cancel(seen[0].executionId)
    return untilAborted(options.signal)
  })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].jobId, 'agent-demo')
  assert.equal(entry.status, STATUS.CANCELLED)
  assert.equal(entry.exitCode, null)
  assert.equal(entry.error, 'Stop requested from Rota.')
  assert.deepEqual(runner.runningExecutions(), [], 'nothing running afterwards')
})

test('the ceiling stops the agent and says so', async (t) => {
  const paths = makePaths(t)
  const job = makeJob({}, { timeoutSeconds: 1 })
  const { runner } = makeRunner(job, paths)

  stubFetch(t, (_url, options) => untilAborted(options.signal))

  const entry = await runner.run(job, { trigger: 'schedule' })

  assert.equal(entry.status, STATUS.TIMED_OUT)
  assert.ok(entry.error.includes('1 seconds'))
})

test('a second execution is skipped while the first is running', async (t) => {
  const paths = makePaths(t)
  const job = makeJob()
  const { runner } = makeRunner(job, paths)

  let libere
  const attente = new Promise((resolve) => {
    libere = resolve
  })
  stubFetch(t, async () => {
    await attente
    return answer({ role: 'assistant', content: 'fini' })
  })

  const premiere = runner.run(job, { trigger: 'schedule' })
  const seconde = await runner.run(job, { trigger: 'schedule' })

  assert.equal(seconde.status, STATUS.SKIPPED_ALREADY_RUNNING)
  libere()
  assert.equal((await premiere).status, STATUS.SUCCESS)
})

test("a reported effect comes back in the entry, like the scripts' marker", async (t) => {
  const paths = makePaths(t)
  const job = makeJob({ tools: { enabled: ['signal_change'] } })
  const { runner } = makeRunner(job, paths)

  let tour = 0
  stubFetch(t, async () => {
    tour += 1
    return tour === 1
      ? answer({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'c1',
              function: { name: 'signal_change', arguments: '{"message":"2 files tidied"}' },
            },
          ],
        })
      : answer({ role: 'assistant', content: 'Fini.' })
  })

  const entry = await runner.run(job, { trigger: 'schedule' })

  assert.deepEqual(entry.change, { changed: true, message: '2 files tidied' })
})

// An agent has no output stream: its transcript stands in for one, and must be
// watched scrolling past like a script's.
test('the transcript is emitted line by line during the execution', async (t) => {
  const paths = makePaths(t)
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const { runner } = makeRunner(job, paths)

  const seen = []
  runner.on('output', (event) => seen.push(event))

  let tour = 0
  stubFetch(t, async () => {
    // By the second call, the lines of the first turn must already have gone out:
    // they do not wait for the end of the execution.
    if (tour === 1) {
      assert.ok(
        seen.some((event) => event.chunk.includes('todo_add')),
        'the tool call of the first turn was not emitted',
      )
    }
    tour += 1
    return tour === 1
      ? answer({
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', function: { name: 'todo_add', arguments: '{"items":["a"]}' } },
          ],
        })
      : answer({ role: 'assistant', content: 'Fini.' })
  })

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.ok(seen.length > 0)
  assert.ok(seen.every((event) => event.stream === 'stdout' && event.jobId === 'agent-demo'))
  // What scrolled past and what is recorded are the same text.
  assert.equal(seen.map((event) => event.chunk).join(''), entry.stdout)
})

test("an over-long transcript is truncated like a script's output", async (t) => {
  const paths = makePaths(t)
  const job = makeJob({}, { maxOutputBytes: 1024 })
  const { runner } = makeRunner(job, paths)
  stubFetch(t, async () => answer({ role: 'assistant', content: 'z'.repeat(20_000) }))

  const entry = await runner.run(job, { trigger: 'manual' })

  assert.equal(entry.stdoutTruncated, true)
  assert.ok(entry.stdout.length < 2000)
})
