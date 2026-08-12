'use strict'

// What the rename must not break.
//
// The project was called TickTray. Three of the names it used are not ours to
// change unilaterally, because they are read by things outside this repository:
// the configuration directory somebody's jobs and secrets live in, and the
// variables their scripts read. This file is what stops a later tidy-up from
// removing the compatibility without noticing whose afternoon it costs.
//
// When these are eventually dropped, delete this file in the same commit — a
// deprecation with no expiry is a permanent feature nobody admits to.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { isLegacyConfigDir, LEGACY_DIRNAME, resolveConfigDir } = require('../src/config/paths')
const { buildEnv } = require('../src/runner/env')
const { sandboxEnv } = require('../src/runner/sandbox')
const { withPreviousSteps } = require('../src/runner/workflow')

/** A filesystem that says yes to exactly the paths it was given. */
const filesystemWith = (...present) => ({ existsSync: (p) => present.includes(p) })

const job = {
  id: 'sync-notes',
  runner: { type: 'shell', script: '/x.sh', environment: {} },
  execution: { sandbox: { enabled: false } },
}

// --- the configuration directory ------------------------------------------------

test('a fresh installation gets the new directory', () => {
  const dir = resolveConfigDir({
    env: {},
    homedir: '/home/someone',
    fileSystem: filesystemWith(),
  })
  assert.equal(dir, '/home/someone/.config/rota')
})

test('an installation that predates the rename keeps its directory', () => {
  const dir = resolveConfigDir({
    env: {},
    homedir: '/home/someone',
    fileSystem: filesystemWith('/home/someone/.config/ticktray'),
  })
  assert.equal(dir, '/home/someone/.config/ticktray')
  assert.equal(isLegacyConfigDir(dir), true)
})

test('once both exist, the new one wins and the old is left alone', () => {
  // Somebody who copied rather than moved should not have two engines writing
  // into two histories without being told which one is live.
  const dir = resolveConfigDir({
    env: {},
    homedir: '/home/someone',
    fileSystem: filesystemWith('/home/someone/.config/rota', '/home/someone/.config/ticktray'),
  })
  assert.equal(dir, '/home/someone/.config/rota')
})

test('nothing is moved on the way past', (t) => {
  // The rename is the owner's to make, with mv, when they feel like it. A
  // scheduler that relocated somebody's secrets to tidy up its own name would
  // be caring about the wrong thing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-legacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const legacy = path.join(root, LEGACY_DIRNAME)
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}')

  assert.equal(resolveConfigDir({ env: { XDG_CONFIG_HOME: root } }), legacy)
  assert.equal(fs.existsSync(legacy), true, 'the old directory is still there')
  assert.equal(fs.existsSync(path.join(root, 'rota')), false, 'and nothing was created beside it')
})

test('the old environment variable still points the engine somewhere', () => {
  assert.equal(resolveConfigDir({ env: { TICKTRAY_CONFIG_DIR: '/tmp/old' } }), '/tmp/old')
  // The new name wins when both are set: an override somebody typed today beats
  // one left in a shell profile years ago.
  assert.equal(
    resolveConfigDir({ env: { ROTA_CONFIG_DIR: '/tmp/new', TICKTRAY_CONFIG_DIR: '/tmp/old' } }),
    '/tmp/new',
  )
})

// --- the variables a job's own scripts read ---------------------------------------

test('a script receives every variable under both names', () => {
  const env = buildEnv(job, { executionId: 'exec-1' })

  assert.equal(env.ROTA_JOB_ID, 'sync-notes')
  assert.equal(env.ROTA_EXECUTION_ID, 'exec-1')
  assert.equal(env.TICKTRAY_JOB_ID, 'sync-notes', 'a script written before the rename still works')
  assert.equal(env.TICKTRAY_EXECUTION_ID, 'exec-1')
})

test('the job’s own variables still win over both', () => {
  const declared = { ...job, runner: { ...job.runner, environment: { ROTA_JOB_ID: 'mine' } } }
  assert.equal(buildEnv(declared, { executionId: 'e' }).ROTA_JOB_ID, 'mine')
})

test('inside the sandbox, the same pair', () => {
  const env = sandboxEnv(job, { executionId: 'exec-2' })
  assert.equal(env.ROTA_JOB_ID, 'sync-notes')
  assert.equal(env.TICKTRAY_JOB_ID, 'sync-notes')
  assert.equal(env.ROTA_EXECUTION_ID, 'exec-2')
  assert.equal(env.TICKTRAY_EXECUTION_ID, 'exec-2')
})

test('a workflow step receives the previous ones under both names', () => {
  const scriptJob = () => ({
    id: 'chain',
    runner: { type: 'shell', script: '/one.sh', environment: {} },
    execution: { sandbox: { enabled: false } },
  })

  const first = withPreviousSteps(scriptJob(), [])
  assert.equal(first.runner.environment.ROTA_STEPS, '[]')
  assert.equal(first.runner.environment.TICKTRAY_STEPS, '[]')

  const previous = [{ id: 'one', status: 'success', durationMs: 1, stdout: 'out', stderr: '' }]
  const withHistory = withPreviousSteps(scriptJob(), previous)
  assert.equal(
    withHistory.runner.environment.TICKTRAY_STEPS,
    withHistory.runner.environment.ROTA_STEPS,
    'the two names carry the same JSON, not two versions of it',
  )
  assert.match(withHistory.runner.environment.TICKTRAY_STEPS, /"id":"one"/)
})
