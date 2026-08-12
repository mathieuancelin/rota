'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { ConfigStore } = require('../src/config/store')
const { ensureStructure, resolvePaths } = require('../src/config/paths')

const VALID_JOB = {
  id: 'sync',
  name: 'Synchro',
  triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
  runner: { type: 'bun', script: '/tmp/sync.js' },
}

async function freshStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const paths = resolvePaths(dir)
  await ensureStructure(paths)
  return { store: new ConfigStore(paths), paths }
}

const writeJob = (paths, id, value) =>
  fs.writeFile(
    path.join(paths.jobsDir, `${id}.json`),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  )

test('loads the valid jobs of the jobs/ directory', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)
  await writeJob(paths, 'backup', { ...VALID_JOB, id: 'backup', name: 'Sauvegarde' })

  await store.reload()

  assert.deepEqual(
    store.getJobs().map((j) => j.id),
    ['backup', 'sync'],
    'the jobs are sorted by displayed name',
  )
  assert.equal(store.getIssues().length, 0)
})

test('a JSON gone invalid does not replace the definition in memory', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)
  await store.reload()
  assert.equal(store.getJob('sync').name, 'Synchro')

  // The user breaks the file while editing it.
  await writeJob(paths, 'sync', '{ "id": "sync", ')
  await store.reload()

  const job = store.getJob('sync')
  assert.equal(job.name, 'Synchro', 'the job stays loaded')
  assert.equal(job.stale, true, 'it is marked as running on its previous definition')
  assert.equal(store.getIssues().length, 1)
  assert.ok(store.getIssues()[0].errors[0].includes('Unreadable JSON'))
})

test('a job invalid against the schema is reported without losing the previous version', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)
  await store.reload()

  await writeJob(paths, 'sync', { ...VALID_JOB, triggers: [{ type: 'interval', every: 0, unit: 'minutes' }] })
  await store.reload()

  assert.equal(store.getJob('sync').triggers[0].every, 5)
  assert.equal(store.getJob('sync').stale, true)
  assert.equal(store.getIssues().length, 1)
})

test('a repaired file lifts the stale flag', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)
  await store.reload()
  await writeJob(paths, 'sync', 'broken')
  await store.reload()
  assert.equal(store.getJob('sync').stale, true)

  await writeJob(paths, 'sync', { ...VALID_JOB, name: 'Sync fixed' })
  await store.reload()

  assert.equal(store.getJob('sync').stale, false)
  assert.equal(store.getJob('sync').name, 'Sync fixed')
  assert.equal(store.getIssues().length, 0)
})

test('deleting a file removes the job with no error', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)
  await store.reload()

  await fs.rm(path.join(paths.jobsDir, 'sync.json'))
  await store.reload()

  assert.equal(store.getJobs().length, 0)
  assert.equal(store.getIssues().length, 0, 'a deletion is deliberate, not an error')
})

test('an id that does not match the file name is refused', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', { ...VALID_JOB, id: 'autre-chose' })

  await store.reload()

  assert.equal(store.getJobs().length, 0)
  assert.ok(store.getIssues()[0].errors[0].includes('does not match the file name'))
})

test('non-JSON files and hidden files are ignored', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)
  await fs.writeFile(path.join(paths.jobsDir, 'notes.txt'), 'nothing to see here')
  await fs.writeFile(path.join(paths.jobsDir, '.sync.json.swp'), "an editor's temporary")

  await store.reload()

  assert.equal(store.getJobs().length, 1)
  assert.equal(store.getIssues().length, 0)
})

// --- creation from a template ------------------------------------------------

test('createJob writes a loadable job, from a template', async (t) => {
  const { store, paths } = await freshStore(t)

  const result = await store.createJob('ma-job', 'bun')
  assert.equal(result.ok, true, result.errors?.join(' | '))

  await store.reload()
  assert.equal(store.getIssues().length, 0, 'the written file passes validation on reload')
  assert.equal(store.getJob('ma-job').runner.type, 'bun')
  assert.equal(store.getJob('ma-job').enabled, false)

  const written = JSON.parse(await fs.readFile(path.join(paths.jobsDir, 'ma-job.json'), 'utf8'))
  assert.ok(written.$schema, 'the $schema is there, for completion in the editor')
})

test('createJob refuses to overwrite an existing job', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)

  const result = await store.createJob('sync', 'bun')

  assert.equal(result.ok, false)
  assert.match(result.errors[0], /already exists/)
  const kept = JSON.parse(await fs.readFile(path.join(paths.jobsDir, 'sync.json'), 'utf8'))
  assert.equal(kept.name, 'Synchro', 'the original definition is intact')
})

test('createJob refuses an unknown template without writing anything', async (t) => {
  const { store, paths } = await freshStore(t)

  const result = await store.createJob('ma-job', 'fantome')

  assert.equal(result.ok, false)
  assert.deepEqual(await fs.readdir(paths.jobsDir), [])
})

test('an invalid global configuration keeps the previous one', async (t) => {
  const { store, paths } = await freshStore(t)
  await store.reload()
  assert.equal(store.getConfig().launchAtLogin, true)

  await fs.writeFile(paths.configFile, JSON.stringify({ launchAtLogin: 'oui' }))
  await store.reload()

  assert.equal(store.getConfig().launchAtLogin, true, 'the previous configuration is kept')
  assert.equal(store.getIssues().length, 1)
})

test('patchConfig validates before writing', async (t) => {
  const { store, paths } = await freshStore(t)
  await store.reload()

  assert.equal((await store.patchConfig({ schedulerPaused: 'maybe' })).ok, false)
  assert.equal((await store.patchConfig({ schedulerPaused: true })).ok, true)

  const written = JSON.parse(await fs.readFile(paths.configFile, 'utf8'))
  assert.equal(written.schedulerPaused, true)
})

test('saveJob refuses an invalid definition and writes nothing', async (t) => {
  const { store, paths } = await freshStore(t)

  const result = await store.saveJob('sync', { ...VALID_JOB, runner: { type: 'bun', script: 'relatif.js' } })

  assert.equal(result.ok, false)
  await assert.rejects(() => fs.access(path.join(paths.jobsDir, 'sync.json')))
})

test('reload emits a change event', async (t) => {
  const { store, paths } = await freshStore(t)
  await writeJob(paths, 'sync', VALID_JOB)

  const events = []
  store.on('change', (payload) => events.push(payload))
  await store.reload()

  assert.equal(events.length, 1)
  assert.equal(events[0].jobs.length, 1)
})
