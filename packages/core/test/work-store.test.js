'use strict'

// The work queue.
//
// What is being tested here is mostly durability: an item is the one thing in
// Rota whose loss loses work rather than merely shifting a schedule. Hence the
// restart tests, which stop at nothing more subtle than building a second store
// over the same directory — that is exactly what a daemon restart is.
//
// The other half is the backoff, because it is not an optimisation: it is what
// stops a worker from spinning on an item that fails instantly.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { WorkStore, STATUS } = require('../src/work/store')

async function freshStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-work-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = new WorkStore(path.join(dir, 'work'))
  await store.load()
  return { store, dir }
}

/** A second store over the same directory: what a restart amounts to. */
async function restart(dir) {
  const store = new WorkStore(path.join(dir, 'work'))
  await store.load()
  return store
}

// --- the file -------------------------------------------------------------------

test('an item reads back as it was written', async (t) => {
  const { store, dir } = await freshStore(t)

  const created = await store.create({ jobId: 'dev', input: { issue: 421 } })
  assert.equal(created.ok, true)

  const after = await restart(dir)
  const item = after.get(created.item.id)

  assert.equal(item.jobId, 'dev')
  assert.deepEqual(item.input, { issue: 421 })
  assert.equal(item.status, STATUS.PENDING)
  assert.equal(item.attempts, 0)
})

test('an identifier given by the caller makes creation idempotent', async (t) => {
  const { store } = await freshStore(t)

  const first = await store.create({ jobId: 'dev', id: 'gh-issue-421', input: {} })
  const second = await store.create({ jobId: 'dev', id: 'gh-issue-421', input: {} })

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.match(second.error, /already exists/)
  assert.equal(store.list({ jobId: 'dev' }).length, 1)
})

test('an identifier that is not one path segment is refused', async (t) => {
  const { store } = await freshStore(t)

  for (const id of ['../escape', 'has/slash', '', '.hidden']) {
    const result = await store.create({ jobId: 'dev', id, input: {} })
    assert.equal(result.ok, false, `${id} should be refused`)
  }
})

test('an oversized input is refused rather than stored', async (t) => {
  const { store } = await freshStore(t)

  const result = await store.create({ jobId: 'dev', input: { blob: 'x'.repeat(40 * 1024) } })

  assert.equal(result.ok, false)
  assert.match(result.error, /exceeds/)
})

// --- serving ---------------------------------------------------------------------

test('items are served oldest first', async (t) => {
  const { store } = await freshStore(t)

  await store.create({ jobId: 'dev', id: 'a', input: {} })
  await store.create({ jobId: 'dev', id: 'b', input: {} })
  await store.create({ jobId: 'dev', id: 'c', input: {} })

  const first = await store.claim('dev')
  const second = await store.claim('dev')

  assert.equal(first.id, 'a')
  assert.equal(second.id, 'b')
})

test('a claimed item is not served twice', async (t) => {
  const { store } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'only', input: {} })

  const first = await store.claim('dev')
  const second = await store.claim('dev')

  assert.equal(first.id, 'only')
  assert.equal(second, null)
})

test('a job only ever sees its own queue', async (t) => {
  const { store } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'for-dev', input: {} })
  await store.create({ jobId: 'ops', id: 'for-ops', input: {} })

  assert.equal((await store.claim('dev')).id, 'for-dev')
  assert.equal((await store.claim('dev')), null)
  assert.equal((await store.claim('ops')).id, 'for-ops')
})

test('hasAvailable answers without building the list', async (t) => {
  const { store } = await freshStore(t)

  assert.equal(store.hasAvailable('dev'), false)
  await store.create({ jobId: 'dev', id: 'a', input: {} })
  assert.equal(store.hasAvailable('dev'), true)
  await store.claim('dev')
  assert.equal(store.hasAvailable('dev'), false)
})

// --- failure and backoff -----------------------------------------------------------

test('a failed item comes back, but not before its backoff', async (t) => {
  const { store } = await freshStore(t)
  const now = Date.parse('2026-08-14T10:00:00.000Z')

  await store.create({ jobId: 'dev', id: 'flaky', input: {} })
  const claimed = await store.claim('dev', { now })
  await store.markRunning(claimed.id, 'exec-1')
  await store.fail(claimed.id, { error: 'boom', maxAttempts: 3, backoffSeconds: 60, now })

  const item = store.get('flaky')
  assert.equal(item.status, STATUS.PENDING)
  assert.equal(item.attempts, 1)
  assert.equal(item.error, 'boom')

  // Still held back one second before its time, served one second after.
  assert.equal(store.hasAvailable('dev', { now: now + 59_000 }), false)
  assert.equal(store.hasAvailable('dev', { now: now + 61_000 }), true)
})

test('the backoff doubles from one attempt to the next', async (t) => {
  const { store } = await freshStore(t)
  let now = Date.parse('2026-08-14T10:00:00.000Z')

  await store.create({ jobId: 'dev', id: 'flaky', input: {} })

  const delays = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await store.claim('dev', { now })
    await store.markRunning(claimed.id, `exec-${attempt}`)
    await store.fail(claimed.id, { error: 'boom', maxAttempts: 5, backoffSeconds: 60, now })
    const item = store.get('flaky')
    delays.push(Date.parse(item.availableAt) - now)
    now = Date.parse(item.availableAt)
  }

  assert.deepEqual(delays, [60_000, 120_000, 240_000])
})

test('past the ceiling the item fails for good', async (t) => {
  const { store } = await freshStore(t)
  let now = Date.parse('2026-08-14T10:00:00.000Z')

  await store.create({ jobId: 'dev', id: 'doomed', input: {} })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await store.claim('dev', { now })
    assert.ok(claimed, `attempt ${attempt} should have found the item`)
    await store.markRunning(claimed.id, `exec-${attempt}`)
    await store.fail(claimed.id, { error: 'boom', maxAttempts: 3, backoffSeconds: 60, now })
    now += 10 * 60 * 1000
  }

  const item = store.get('doomed')
  assert.equal(item.status, STATUS.FAILED)
  assert.equal(item.attempts, 3)
  assert.equal(item.availableAt, null)
  assert.equal(store.hasAvailable('dev', { now: now + 86_400_000 }), false)
})

test('a released item does not spend an attempt', async (t) => {
  const { store } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'stopped', input: {} })

  const claimed = await store.claim('dev')
  await store.markRunning(claimed.id, 'exec-1')
  await store.release(claimed.id)

  const item = store.get('stopped')
  assert.equal(item.status, STATUS.PENDING)
  assert.equal(item.attempts, 0)
  assert.equal(item.executionId, null)
  assert.equal(store.hasAvailable('dev'), true)
})

test('a manual retry gives a failed item its chances back', async (t) => {
  const { store } = await freshStore(t)
  let now = Date.parse('2026-08-14T10:00:00.000Z')

  await store.create({ jobId: 'dev', id: 'doomed', input: {} })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await store.claim('dev', { now })
    await store.markRunning(claimed.id, `exec-${attempt}`)
    await store.fail(claimed.id, { error: 'boom', maxAttempts: 3, backoffSeconds: 60, now })
    now += 10 * 60 * 1000
  }
  assert.equal(store.get('doomed').status, STATUS.FAILED)

  await store.retry('doomed')

  const item = store.get('doomed')
  assert.equal(item.status, STATUS.PENDING)
  assert.equal(item.attempts, 0)
  assert.equal(item.error, null)
  assert.equal(store.hasAvailable('dev', { now }), true)
})

// --- restart ----------------------------------------------------------------------

test('a pending item survives a restart and is still claimable', async (t) => {
  const { store, dir } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'waiting', input: { repository: 'acme/api' } })

  const after = await restart(dir)

  assert.equal(after.get('waiting').status, STATUS.PENDING)
  const claimed = await after.claim('dev')
  assert.equal(claimed.id, 'waiting')
  assert.deepEqual(claimed.input, { repository: 'acme/api' })
})

test('an item interrupted mid-run goes back to pending on restart', async (t) => {
  const { store, dir } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'interrupted', input: {} })
  const claimed = await store.claim('dev')
  await store.markRunning(claimed.id, 'exec-1')
  assert.equal(store.get('interrupted').status, STATUS.RUNNING)

  const after = await restart(dir)

  const item = after.get('interrupted')
  assert.equal(item.status, STATUS.PENDING)
  assert.equal(item.executionId, null)
  // The attempt is kept: it did start, and it is the ceiling's business to know.
  assert.equal(item.attempts, 1)
  assert.equal(after.hasAvailable('dev'), true)
})

test('a finished item is not resurrected by a restart', async (t) => {
  const { store, dir } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'finished', input: {} })
  const claimed = await store.claim('dev')
  await store.markRunning(claimed.id, 'exec-1')
  await store.complete(claimed.id, 'all good')

  const after = await restart(dir)

  assert.equal(after.get('finished').status, STATUS.DONE)
  assert.equal(after.get('finished').result, 'all good')
  assert.equal(after.hasAvailable('dev'), false)
})

test('an unreadable item does not cost us the rest of the queue', async (t) => {
  const { store, dir } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'good', input: {} })
  await fs.writeFile(path.join(dir, 'work', 'dev', 'broken.json'), '{ not json', 'utf8')

  const after = await restart(dir)

  assert.equal(after.get('good').status, STATUS.PENDING)
  assert.equal(after.get('broken'), null)
})

// --- housekeeping -------------------------------------------------------------------

test('the queue of a job that no longer exists is removed', async (t) => {
  const { store, dir } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'kept', input: {} })
  await store.create({ jobId: 'gone', id: 'dropped', input: {} })

  await store.prune(['dev'])

  assert.equal(store.get('kept').status, STATUS.PENDING)
  assert.equal(store.get('dropped'), null)
  await assert.rejects(() => fs.access(path.join(dir, 'work', 'gone')))
})

test('counts are reported per job and per status', async (t) => {
  const { store } = await freshStore(t)
  await store.create({ jobId: 'dev', id: 'a', input: {} })
  await store.create({ jobId: 'dev', id: 'b', input: {} })
  await store.create({ jobId: 'ops', id: 'c', input: {} })
  const claimed = await store.claim('dev')
  await store.markRunning(claimed.id, 'exec-1')
  await store.complete(claimed.id, null)

  const counts = store.countsByJob()

  assert.equal(counts.get('dev').pending, 1)
  assert.equal(counts.get('dev').done, 1)
  assert.equal(counts.get('ops').pending, 1)
})

test('creation announces itself, which is what wakes a worker', async (t) => {
  const { store } = await freshStore(t)
  const seen = []
  store.on('created', (item) => seen.push(item.id))

  await store.create({ jobId: 'dev', id: 'wake-me', input: {} })

  assert.deepEqual(seen, ['wake-me'])
})
