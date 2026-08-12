'use strict'

// Migrating definitions from one version of the schema to the next.
//
// What these tests protect is not the translation — it fits in three lines — but
// what surrounds it: never lose a file, never overwrite what the user wrote by
// hand, and leave alone what we cannot read. A migration that fails costs a
// definition, and a lost definition is not found again.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { migrateJob, migrateJobsDir } = require('../src/config/migrate')
const { validateJob } = require('../src/config/validate')

const LEGACY = {
  $schema: 'https://rota.local/schemas/job.schema.json',
  id: 'sync-notes',
  name: 'Notes sync',
  enabled: true,
  schedule: { type: 'interval', every: 5, unit: 'minutes' },
  runner: { type: 'bun', script: '/Users/me/scripts/sync.js' },
}

async function freshDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-migrate-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

const write = (dir, id, content) =>
  fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(content, null, 2))

const read = async (dir, id) =>
  JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'))

// --- translation --------------------------------------------------------------

test('a schedule becomes the first trigger', () => {
  const { changed, value } = migrateJob(LEGACY)

  assert.equal(changed, true)
  assert.deepEqual(value.triggers, [{ type: 'interval', every: 5, unit: 'minutes' }])
  assert.equal('schedule' in value, false)
})

test('the migrated definition is accepted by the current schema', () => {
  const result = validateJob(migrateJob(LEGACY).value)

  assert.equal(result.ok, true, result.errors?.join(' | '))
})

// `triggers` reads where `schedule` read — above `runner`. A Git diff then shows
// a changed line in its place, and not a field appended at the end of a file
// whose order meant something.
test('the key replaces the old one in place, without reordering the rest', () => {
  const keys = Object.keys(migrateJob(LEGACY).value)

  assert.deepEqual(keys, ['$schema', 'id', 'name', 'enabled', 'triggers', 'runner'])
})

test('a definition already up to date is not touched', () => {
  const current = { ...LEGACY, schedule: undefined, triggers: [{ type: 'webhook' }] }
  delete current.schedule

  assert.equal(migrateJob(current).changed, false)
})

// Both shapes at once: `triggers` was written by hand, it prevails. Guessing the
// intention by merging would produce a trigger nobody asked for — and that would
// start the job.
test('both shapes together: the new one wins, the old one goes', () => {
  const { changed, value } = migrateJob({ ...LEGACY, triggers: [{ type: 'webhook' }] })

  assert.equal(changed, true)
  assert.deepEqual(value.triggers, [{ type: 'webhook' }])
  assert.equal('schedule' in value, false)
})

test('what is not an object goes through unharmed', () => {
  for (const raw of [null, 42, 'text', []]) {
    assert.equal(migrateJob(raw).changed, false)
  }
})

// --- the directory ------------------------------------------------------------

test('the directory is migrated and the original kept as .bak', async (t) => {
  const dir = await freshDir(t)
  await write(dir, 'sync-notes', LEGACY)

  const { migrated, failed } = await migrateJobsDir(dir)

  assert.deepEqual(migrated, ['sync-notes'])
  assert.deepEqual(failed, [])
  assert.deepEqual((await read(dir, 'sync-notes')).triggers, [
    { type: 'interval', every: 5, unit: 'minutes' },
  ])

  const backup = JSON.parse(await fs.readFile(path.join(dir, 'sync-notes.json.bak'), 'utf8'))
  assert.deepEqual(backup.schedule, LEGACY.schedule)
})

// Broken JSON is repaired by hand, with the message the load gives. Touching it
// here would amount to guessing, and to overwriting what we guessed wrong.
test('an unreadable file is left exactly where it is', async (t) => {
  const dir = await freshDir(t)
  const broken = path.join(dir, 'casse.json')
  await fs.writeFile(broken, '{ ceci ne se lit pas')

  const { migrated } = await migrateJobsDir(dir)

  assert.deepEqual(migrated, [])
  assert.equal(await fs.readFile(broken, 'utf8'), '{ ceci ne se lit pas')
  await assert.rejects(() => fs.access(`${broken}.bak`))
})

test('an already migrated definition produces neither a write nor a backup', async (t) => {
  const dir = await freshDir(t)
  await write(dir, 'a-jour', { ...LEGACY, schedule: undefined, triggers: [{ type: 'webhook' }] })

  const { migrated } = await migrateJobsDir(dir)

  assert.deepEqual(migrated, [])
  await assert.rejects(() => fs.access(path.join(dir, 'a-jour.json.bak')))
})

// The backup does not end in .json: the load that follows does not read it as a
// job, and the old definition does not reappear as a duplicate.
test('the backup is not read back as a job', async (t) => {
  const dir = await freshDir(t)
  await write(dir, 'sync-notes', LEGACY)
  await migrateJobsDir(dir)

  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'))

  assert.deepEqual(files, ['sync-notes.json'])
})

test('a missing directory is not an error', async (t) => {
  const dir = await freshDir(t)

  const result = await migrateJobsDir(path.join(dir, 'nulle-part'))

  assert.deepEqual(result, { migrated: [], failed: [] })
})

test('migrating twice in a row changes nothing the second time', async (t) => {
  const dir = await freshDir(t)
  await write(dir, 'sync-notes', LEGACY)

  await migrateJobsDir(dir)
  const after = await read(dir, 'sync-notes')
  const second = await migrateJobsDir(dir)

  assert.deepEqual(second.migrated, [])
  assert.deepEqual(await read(dir, 'sync-notes'), after)
})
