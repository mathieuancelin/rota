'use strict'

// Deleting a job.
//
// A single operation, on a single file: everything else — disarmed timer, state,
// history, generated code, memory — follows from the reload and the orphan
// sweep. What is exercised here is therefore that nothing is left behind,
// including the externalised outputs, whose name does not say which job they
// belong to.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { ConfigStore } = require('../src/config/store')
const { HistoryStore } = require('../src/history/store')
const { resolvePaths, ensureStructure } = require('../src/config/paths')

const JOB = {
  $schema: 'https://rota.local/schemas/job.schema.json',
  id: 'a-supprimer',
  name: 'To delete',
  triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
  runner: { type: 'bun', script: '/tmp/x.js' },
}

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rota-suppr-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const paths = resolvePaths(root)
  await ensureStructure(paths)
  await fsp.writeFile(path.join(paths.jobsDir, 'a-supprimer.json'), JSON.stringify(JOB))

  const store = new ConfigStore(paths)
  await store.reload()
  return { paths, store }
}

test('the definition goes, and the job with it', async (t) => {
  const { paths, store } = await setup(t)
  assert.equal(store.getJobs().length, 1)

  const result = await store.deleteJob('a-supprimer')
  assert.deepEqual(result, { ok: true })

  assert.equal(fs.existsSync(path.join(paths.jobsDir, 'a-supprimer.json')), false)
  await store.reload()
  assert.deepEqual(store.getJobs(), [])
})

test('deleting an unknown job is refused, without breaking anything', async (t) => {
  const { store } = await setup(t)

  const result = await store.deleteJob('fantome')

  assert.equal(result.ok, false)
  assert.ok(result.errors[0].includes('fantome'))
  assert.equal(store.getJobs().length, 1, 'les autres tâches sont intactes')
})

// Outputs too large live in files named after the execution: nothing in their
// name says which job they belong to. Without reading the JSONL before deleting
// it, they would stay on disk with nothing left to designate them.
test('the sweep takes the externalised outputs too', async (t) => {
  const { paths, store } = await setup(t)
  const history = new HistoryStore(paths, {
    // A ridiculous threshold forces externalisation.
    getDefaults: () => ({ maxOutputBytes: 1048576, inlineOutputBytes: 8, retainExecutions: 500 }),
  })

  const entry = await history.append(
    {
      executionId: '0198f8a8-f477-7db7-8a6e-f13d409ab320',
      jobId: 'a-supprimer',
      jobName: 'To delete',
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 5,
      status: 'success',
      exitCode: 0,
      signal: null,
      command: 'x',
      workingDirectory: '/tmp',
      stdout: 'une output bien plus longue que le seuil retenu',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      change: null,
      error: null,
    },
    store.getJob('a-supprimer'),
  )

  const output = path.join(paths.historyDir, entry.outputFiles.stdout)
  assert.equal(fs.existsSync(output), true, 'the output really was externalised')

  await store.deleteJob('a-supprimer')
  await store.reload()
  await history.prune(store.getJobs().map((job) => job.id))

  assert.equal(fs.existsSync(path.join(paths.historyDir, 'a-supprimer.jsonl')), false)
  assert.equal(fs.existsSync(output), false, 'the output must not outlive its job')
})

test('the sweep does not touch the jobs that still exist', async (t) => {
  const { paths, store } = await setup(t)
  const history = new HistoryStore(paths, {
    getDefaults: () => ({ maxOutputBytes: 1048576, inlineOutputBytes: 8192, retainExecutions: 500 }),
  })
  await fsp.writeFile(path.join(paths.historyDir, 'a-supprimer.jsonl'), '{"executionId":"x"}\n')

  await history.prune(['a-supprimer'])

  assert.equal(fs.existsSync(path.join(paths.historyDir, 'a-supprimer.jsonl')), true)
})
