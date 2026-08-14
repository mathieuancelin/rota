'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { StateStore } = require('../src/state-store')

async function freshState(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-state-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return { filePath: path.join(dir, 'state.json'), dir }
}

test('a missing file gives a blank state', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)

  await store.load()

  assert.deepEqual(store.state, { lastRuns: {}, recentErrors: [], acknowledgedErrorsAt: null })
})

test('the recorded executions survive a restart', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()

  store.recordRun('sync', { at: '2026-07-31T12:00:00.000Z', status: 'success', durationMs: 120 })
  await store.flush()

  const reloaded = new StateStore(filePath)
  await reloaded.load()

  assert.deepEqual(reloaded.getLastRun('sync'), {
    at: '2026-07-31T12:00:00.000Z',
    status: 'success',
    durationMs: 120,
  })
})

test('a corrupt state.json does not stop the startup', async (t) => {
  const { filePath } = await freshState(t)
  await fs.writeFile(filePath, '{ truncated')
  const store = new StateStore(filePath)

  await store.load()

  assert.deepEqual(store.getLastRun('sync'), null)
})

test('the recent errors are stacked, the most recent first', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()

  store.recordError({ jobId: 'a', name: 'A', at: '2026-07-31T10:00:00.000Z', executionId: '1', status: 'failed' })
  store.recordError({ jobId: 'b', name: 'B', at: '2026-07-31T11:00:00.000Z', executionId: '2', status: 'timed-out' })

  assert.deepEqual(
    store.getRecentErrors().map((e) => e.jobId),
    ['b', 'a'],
  )
})

test('the list of recent errors is bounded', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()

  for (let i = 0; i < 50; i++) {
    store.recordError({ jobId: 'a', name: 'A', at: new Date(i).toISOString(), executionId: `${i}`, status: 'failed' })
  }

  assert.equal(store.getRecentErrors().length, 20)
})

test('acknowledging stamps when it was taken in', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()
  assert.equal(store.getAcknowledgedAt(), null)

  store.acknowledgeErrors()

  assert.ok(Date.parse(store.getAcknowledgedAt()) > 0)
})

test('prune removes the state of the jobs that are gone', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()
  store.recordRun('sync', { at: '2026-07-31T12:00:00.000Z', status: 'success', durationMs: 1 })
  store.recordRun('backup', { at: '2026-07-31T12:00:00.000Z', status: 'success', durationMs: 1 })
  store.recordError({ jobId: 'backup', name: 'B', at: '2026-07-31T12:00:00.000Z', executionId: '1', status: 'failed' })

  store.prune(['sync'])

  assert.ok(store.getLastRun('sync'))
  assert.equal(store.getLastRun('backup'), null)
  assert.equal(store.getRecentErrors().length, 0)
})

test('the writes are grouped rather than immediate', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()

  // A job on a short interval must not cause one write per cycle.
  store.recordRun('sync', { at: '2026-07-31T12:00:00.000Z', status: 'success', durationMs: 1 })
  await assert.rejects(() => fs.access(filePath), 'no immediate write')

  await store.flush()
  await fs.access(filePath)
})

test('clearing the recent failures empties the list and marks them seen', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()

  store.recordError({ jobId: 'backup', name: 'Backup', at: new Date().toISOString(), status: 'failed' })
  store.recordError({ jobId: 'sync', name: 'Sync', at: new Date().toISOString(), status: 'timed-out' })
  assert.equal(store.getRecentErrors().length, 2)

  store.clearErrors()

  assert.deepEqual(store.getRecentErrors(), [], 'the shortcut list is empty')
  assert.ok(store.getAcknowledgedAt(), 'and the badge in the header goes with it')
})

test('clearing an already empty list changes nothing', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()
  const before = store.getAcknowledgedAt()

  store.clearErrors()

  assert.deepEqual(store.getRecentErrors(), [])
  assert.equal(store.getAcknowledgedAt(), before, 'no write for nothing')
})

test('a failure after a clear comes back', async (t) => {
  const { filePath } = await freshState(t)
  const store = new StateStore(filePath)
  await store.load()
  store.recordError({ jobId: 'backup', name: 'Backup', at: new Date().toISOString(), status: 'failed' })
  store.clearErrors()

  store.recordError({ jobId: 'backup', name: 'Backup', at: new Date().toISOString(), status: 'failed' })
  assert.equal(store.getRecentErrors().length, 1, 'clearing forgets, it does not mute')
})
