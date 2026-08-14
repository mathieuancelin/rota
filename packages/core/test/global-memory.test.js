'use strict'

// Global memory: what every agent job finds again.
//
// It answers a need a job's memory does not cover — who the user is, on which
// machine, with which conventions — and which, copied into every system prompt,
// would age job by job.
//
// The rule that matters is the conflict one: at equal keys, the local wins. A
// job that has learnt something more precise on its own ground knows better than
// the general setting, and must not be contradicted by it on every execution.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const memory = require('../src/agent/memory')
const { memoryList, memoryRead, memoryDel } = require('../src/agent/tools/memory')
const { buildSystemPrompt } = require('../src/agent/prompt')

async function freshDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-memoire-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

const withEntries = (entries) => ({
  version: 1,
  updatedAt: null,
  entries: Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [key, { value, updatedAt: '2026-08-01T10:00:00.000Z' }]),
  ),
  // A session that wrote these. `save` folds into the file rather than
  // replacing it, and what it folds in is what was touched — a memory built by
  // hand has to say as much, or it describes a session that wrote nothing.
  touched: new Set(Object.keys(entries)),
})

// --- merging ------------------------------------------------------------------

test('both memories read together, sorted by key', () => {
  const merged = memory.mergedEntries(withEntries({ statut: 'ok' }), withEntries({ machine: 'MBP' }))

  assert.deepEqual(
    merged.map((entry) => [entry.key, entry.scope]),
    [
      ['machine', 'global'],
      ['statut', 'job'],
    ],
  )
})

test("at equal keys the job's wins — and appears only once", () => {
  const merged = memory.mergedEntries(
    withEntries({ tone: 'technical' }),
    withEntries({ tone: 'general' }),
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].value, 'technical')
  assert.equal(merged[0].scope, 'job')
})

test('with no global memory, nothing changes for a job', () => {
  const local = withEntries({ statut: 'ok' })

  assert.equal(memory.render(local), '- statut : ok')
  assert.equal(memory.renderEntry(local, 'statut'), '- statut : ok')
})

// The marking is for the agent: a global key reads like the others, but is
// written elsewhere — and it cannot write it.
test('a global entry is returned as such', () => {
  const rendu = memory.render(memory.empty(), withEntries({ machine: 'MBP M3' }))

  assert.equal(rendu, '- machine (global) : MBP M3')
})

test('the announced keys carry their origin and their date', () => {
  const keys = memory.renderKeys(withEntries({ statut: 'ok' }), withEntries({ machine: 'MBP' }))

  assert.match(keys, /- machine \(global, updated 2026-08-01T10:00:00\.000Z\)/)
  assert.match(keys, /- statut \(updated 2026-08-01T10:00:00\.000Z\)/)
})

// --- the file -----------------------------------------------------------------

test('the global memory reads back as it was written', async (t) => {
  const dir = await freshDir(t)
  const state = memory.empty()
  memory.write(state, 'machine', 'MBP M3', { maxEntries: 100 })

  await memory.saveGlobal(dir, state)
  const relue = await memory.loadGlobal(dir)

  assert.equal(relue.entries.machine.value, 'MBP M3')
})

test('a missing global memory is empty, not an error', async (t) => {
  const dir = await freshDir(t)

  assert.deepEqual((await memory.loadGlobal(dir)).entries, {})
})

// The file name does not end in ".mem.json": the orphan sweep only touches
// those, and "global" is a perfectly valid job identifier — the two would have
// collided.
test('sweeping the jobs that are gone does not touch the global memory', async (t) => {
  const dir = await freshDir(t)
  await memory.saveGlobal(dir, withEntries({ machine: 'MBP' }))
  await memory.save(dir, 'disparue', withEntries({ statut: 'ok' }))

  await memory.prune(dir, [])

  assert.equal((await memory.loadGlobal(dir)).entries.machine.value, 'MBP')
  assert.deepEqual((await memory.load(dir, 'disparue')).entries, {})
})

test('a job named "global" has a memory of its own', async (t) => {
  const dir = await freshDir(t)
  await memory.saveGlobal(dir, withEntries({ shared: 'yes' }))
  await memory.save(dir, 'global', withEntries({ own: "the job's own" }))

  assert.equal((await memory.loadGlobal(dir)).entries.shared.value, 'yes')
  assert.equal((await memory.load(dir, 'global')).entries.own.value, "the job's own")
})

// --- the tools ----------------------------------------------------------------

const context = (local, global) => ({
  memory: local,
  globalMemory: global,
  memoryConfig: { maxEntries: 100 },
  saveMemory: async () => {},
})

test('memory_list announces the keys of both memories', async () => {
  const result = await memoryList.run({}, context(withEntries({ statut: 'ok' }), withEntries({ machine: 'MBP' })))

  assert.equal(result.ok, true)
  assert.equal(result.summary, '2 key(s)')
  assert.match(result.content, /machine \(global/)
})

test('memory_read finds a global key', async () => {
  const result = await memoryRead.run(
    { key: 'machine' },
    context(memory.empty(), withEntries({ machine: 'MBP M3' })),
  )

  assert.equal(result.ok, true)
  assert.match(result.content, /MBP M3/)
})

// The agent mostly gets the name wrong: every known key must be there, global
// ones included, otherwise it rewrites one under another name.
test('an unknown key recalls those that exist, global ones included', async () => {
  const result = await memoryRead.run(
    { key: 'machin' },
    context(withEntries({ statut: 'ok' }), withEntries({ machine: 'MBP' })),
  )

  assert.equal(result.ok, false)
  assert.match(result.error, /machine/)
  assert.match(result.error, /statut/)
})

test('memory_del refuses a global key and says why', async () => {
  const result = await memoryDel.run(
    { key: 'machine' },
    context(memory.empty(), withEntries({ machine: 'MBP' })),
  )

  assert.equal(result.ok, false)
  assert.match(result.error, /global/)
})

test('memory_del does nothing to a key that exists nowhere', async () => {
  const result = await memoryDel.run({ key: 'rien' }, context(memory.empty(), memory.empty()))

  assert.equal(result.ok, false)
  assert.match(result.error, /no entry/)
})

// A local key of the same name gets deleted, and the global one then reappears:
// that is the direct consequence of "the local wins", and it is intended.
test('deleting the local key hands back to the global one', async () => {
  const local = withEntries({ tone: 'technical' })
  const global = withEntries({ tone: 'general' })

  await memoryDel.run({ key: 'tone' }, context(local, global))

  assert.equal(memory.renderEntry(local, 'tone', global), '- tone (global) : general')
})

// --- the prompt ---------------------------------------------------------------

const agentJob = {
  id: 'veille',
  name: 'Veille',
  runner: {
    type: 'agent',
    agent: { systemPrompt: 'Consignes.', prompt: 'Fais quelque chose.', model: 'x' },
  },
}

test('the instructions announce the global keys alongside the others', () => {
  const prompt = buildSystemPrompt({
    job: agentJob,
    memory: withEntries({ statut: 'ok' }),
    globalMemory: withEntries({ machine: 'MBP' }),
    trigger: 'schedule',
    sandboxed: false,
    toolNames: ['memory_read', 'memory_list'],
  })

  assert.match(prompt, /- machine \(global/)
  assert.match(prompt, /- statut \(updated/)
  assert.ok(!prompt.includes('MBP'), 'les values ne partent toujours pas dans les consignes')
})

test('with no memory tool, the instructions say no more about it', () => {
  const prompt = buildSystemPrompt({
    job: agentJob,
    memory: memory.empty(),
    globalMemory: withEntries({ machine: 'MBP' }),
    trigger: 'schedule',
    sandboxed: false,
    toolNames: ['fetch'],
  })

  assert.ok(!prompt.includes('# Memory'))
})
