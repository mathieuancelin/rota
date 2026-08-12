'use strict'

// The tools made available to the model.
//
// The part that matters is the file-access jail: the paths come from a language
// model, neither proofread nor necessarily well-intentioned.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { resolveInWorkspace, resolveWorkspace, ensureWorkspace } = require('../src/agent/workspace')
const { selectTools, toolDefinitions, byName } = require('../src/agent/tools')
const { createTodoList } = require('../src/agent/tools/todo')
const { hostAllowed } = require('../src/agent/tools/net')
const memory = require('../src/agent/memory')
const { validateJob } = require('../src/config/validate')

const makeJob = (agent = {}, execution = {}) => {
  const result = validateJob({
    id: 'demo',
    name: 'Demo',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: {
      type: 'agent',
      agent: { prompt: 'Fais.', model: 'gemma4:latest', ...agent },
    },
    execution,
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

const workspace = () => ensureWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'rota-ws-')))

const context = (root, overrides = {}) => {
  const job = overrides.job ?? makeJob()
  return {
    job,
    workspace: root,
    config: job.runner.agent.tools,
    memoryConfig: job.runner.agent.memory,
    todo: createTodoList(),
    signal: undefined,
    saveMemory: async () => {},
    ...overrides,
  }
}

const tool = (job, name) => byName(selectTools(job).tools).get(name)

const ALL = [
  'fetch',
  'exec',
  'shell',
  'file_read',
  'file_list',
  'file_write',
  'file_del',
  'todo',
  'memory',
  'report',
  'ask_user',
  'confirm',
  'signal_change',
]

// --- perimeter ----------------------------------------------------------------

test('a relative path stays inside the perimeter', () => {
  const root = workspace()
  const result = resolveInWorkspace(root, 'notes/a.txt')

  assert.equal(result.ok, true)
  assert.equal(result.path, path.join(root, 'notes', 'a.txt'))
})

test('path escapes are refused', () => {
  const root = workspace()

  for (const target of ['../evasion', '../../etc/passwd', '/etc/passwd', 'notes/../../dehors']) {
    const result = resolveInWorkspace(root, target)
    assert.equal(result.ok, false, `${target} should have been refused`)
    assert.ok(result.error.includes('leaves the working directory'))
  }
})

// Comparing strings after path.resolve is not enough: "shortcut/passwd" stays
// under the working directory when read, and designates /etc/passwd when opened.
test('a symbolic link leaving the perimeter is refused', () => {
  const root = workspace()
  const dehors = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-dehors-'))
  fs.writeFileSync(path.join(dehors, 'secret.txt'), 'chut')
  fs.symlinkSync(dehors, path.join(root, 'raccourci'))

  assert.equal(resolveInWorkspace(root, 'raccourci/secret.txt').ok, false)
  assert.equal(resolveInWorkspace(root, 'raccourci').ok, false)
})

test('a symbolic link inside the perimeter stays accepted', () => {
  const root = workspace()
  fs.mkdirSync(path.join(root, 'reel'))
  fs.symlinkSync(path.join(root, 'reel'), path.join(root, 'alias'))

  assert.equal(resolveInWorkspace(root, 'alias/x.txt').ok, true)
})

test("the default working directory is the job's own", () => {
  const job = makeJob()
  assert.equal(resolveWorkspace(job, { agentsDir: '/conf/agents' }), '/conf/agents/demo')

  job.runner.workingDirectory = '/ailleurs'
  assert.equal(resolveWorkspace(job, { agentsDir: '/conf/agents' }), '/ailleurs')
})

// --- file access --------------------------------------------------------------

test('writing, reading, listing and deleting', async () => {
  const root = workspace()
  const job = makeJob({ tools: { enabled: ['file_read', 'file_list', 'file_write', 'file_del'] } })
  const ctx = context(root, { job })

  const written = await tool(job, 'file_write').run({ path: 'notes/a.txt', content: 'bonjour' }, ctx)
  assert.equal(written.ok, true, written.error)
  assert.equal(fs.readFileSync(path.join(root, 'notes/a.txt'), 'utf8'), 'bonjour')

  const appended = await tool(job, 'file_write').run(
    { path: 'notes/a.txt', content: ' encore', append: true },
    ctx,
  )
  assert.equal(appended.ok, true)

  const read = await tool(job, 'file_read').run({ path: 'notes/a.txt' }, ctx)
  assert.equal(read.content, 'bonjour encore')

  const listed = await tool(job, 'file_list').run({ path: 'notes' }, ctx)
  assert.ok(listed.content.includes('notes/a.txt'), listed.content)
  assert.ok(!listed.content.includes(root), 'the paths handed to the model are relative')

  const removed = await tool(job, 'file_del').run({ path: 'notes/a.txt' }, ctx)
  assert.equal(removed.ok, true)
  assert.equal(fs.existsSync(path.join(root, 'notes/a.txt')), false)
})

test('a read past the limit is truncated, and says so', async () => {
  const root = workspace()
  const job = makeJob({ tools: { enabled: ['file_read'], files: { maxReadBytes: 256 } } })
  fs.writeFileSync(path.join(root, 'gros.txt'), 'x'.repeat(1000))

  const result = await tool(job, 'file_read').run({ path: 'gros.txt' }, context(root, { job }))

  assert.equal(result.ok, true)
  assert.ok(result.content.includes('truncated at 256 bytes'))
  assert.ok(result.content.length < 400)
})

test('reading a directory points at file_list rather than a system error', async () => {
  const root = workspace()
  const job = makeJob({ tools: { enabled: ['file_read'] } })
  fs.mkdirSync(path.join(root, 'dir'))

  const result = await tool(job, 'file_read').run({ path: 'dir' }, context(root, { job }))

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('file_list'))
})

test('the working directory itself cannot be deleted', async () => {
  const root = workspace()
  const job = makeJob({ tools: { enabled: ['file_del'] } })

  const result = await tool(job, 'file_del').run({ path: '.' }, context(root, { job }))

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('cannot be deleted'))
  assert.equal(fs.existsSync(root), true)
})

test('a file that is not there is said plainly, with no system code', async () => {
  const root = workspace()
  const job = makeJob({ tools: { enabled: ['file_read'] } })

  const result = await tool(job, 'file_read').run({ path: 'absent.txt' }, context(root, { job }))

  assert.equal(result.ok, false)
  assert.equal(result.error, 'file not found: absent.txt')
})

// --- exec and shell -----------------------------------------------------------

test('exec passes a command and its arguments, never a string', async () => {
  const job = makeJob({ tools: { enabled: ['exec'] } })
  let seen = null
  const ctx = context(workspace(), {
    job,
    runCommand: async (command, args) => {
      seen = { command, args }
      return { exitCode: 0, signal: null, stdout: 'ok\n', stderr: '', timedOut: false, aborted: false, error: null }
    },
  })

  const result = await tool(job, 'exec').run({ command: 'git', args: ['status', '--short'] }, ctx)

  assert.deepEqual(seen, { command: 'git', args: ['status', '--short'] })
  assert.ok(result.content.includes('exit code: 0'))
  assert.ok(result.content.includes('ok'))
})

test('shell really goes through sh -c', async () => {
  const job = makeJob({ tools: { enabled: ['shell'] } })
  let seen = null
  const ctx = context(workspace(), {
    job,
    runCommand: async (command, args) => {
      seen = { command, args }
      return { exitCode: 1, signal: null, stdout: '', stderr: 'it failed', timedOut: false, aborted: false, error: null }
    },
  })

  const result = await tool(job, 'shell').run({ command: 'ls | head -3' }, ctx)

  assert.deepEqual(seen, { command: 'sh', args: ['-c', 'ls | head -3'] })
  assert.ok(result.content.includes('exit code: 1'))
  assert.ok(result.content.includes('it failed'))
})

test('a timeout is handed to the model, not hidden', async () => {
  const job = makeJob({ tools: { enabled: ['exec'] } })
  const ctx = context(workspace(), {
    job,
    runCommand: async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true,
      aborted: false,
      error: null,
    }),
  })

  const result = await tool(job, 'exec').run({ command: 'sleep', args: ['999'] }, ctx)

  assert.ok(result.content.includes('timed out'))
})

test('arguments that are not strings are refused', async () => {
  const job = makeJob({ tools: { enabled: ['exec'] } })
  const ctx = context(workspace(), { job, runCommand: async () => assert.fail('must not be called') })

  const result = await tool(job, 'exec').run({ command: 'rm', args: [{ '--force': true }] }, ctx)

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('array of strings'))
})

// --- fetch --------------------------------------------------------------------

test('the allowed host list covers subdomains with a leading dot', () => {
  assert.equal(hostAllowed('exemple.fr', []), true, 'empty, everything is allowed')
  assert.equal(hostAllowed('exemple.fr', ['exemple.fr']), true)
  assert.equal(hostAllowed('api.exemple.fr', ['exemple.fr']), false)
  assert.equal(hostAllowed('api.exemple.fr', ['.exemple.fr']), true)
  assert.equal(hostAllowed('exemple.fr', ['.exemple.fr']), true)
  assert.equal(hostAllowed('pasexemple.fr', ['.exemple.fr']), false)
})

test('fetch refuses a host off the list without calling anything', async () => {
  const job = makeJob({ tools: { enabled: ['fetch'], fetch: { allowHosts: ['exemple.fr'] } } })
  const ctx = context(workspace(), { job, fetchImpl: () => assert.fail('must not be called') })

  const result = await tool(job, 'fetch').run({ url: 'https://ailleurs.fr/x' }, ctx)

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('ailleurs.fr'))
})

test('fetch returns status, headers and body, truncated at the limit', async () => {
  const job = makeJob({ tools: { enabled: ['fetch'], fetch: { maxResponseBytes: 1024 } } })
  const ctx = context(workspace(), {
    job,
    fetchImpl: async () =>
      new Response('y'.repeat(5000), { status: 201, headers: { 'X-Test': 'oui' } }),
  })

  const result = await tool(job, 'fetch').run({ url: 'https://exemple.fr/a' }, ctx)

  assert.equal(result.ok, true)
  assert.ok(result.content.startsWith('HTTP 201'))
  assert.ok(result.content.includes('x-test: oui'))
  assert.ok(result.content.includes('body truncated at 1024 bytes'))
})

test('a URL that is not http is refused', async () => {
  const job = makeJob({ tools: { enabled: ['fetch'] } })
  const ctx = context(workspace(), { job, fetchImpl: () => assert.fail('must not be called') })

  assert.equal((await tool(job, 'fetch').run({ url: 'file:///etc/passwd' }, ctx)).ok, false)
  assert.equal((await tool(job, 'fetch').run({ url: 'pas une url' }, ctx)).ok, false)
})

// --- todo ---------------------------------------------------------------------

test('the list fills, empties by number, then entirely', async () => {
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const ctx = context(workspace(), { job })
  const run = (name, args) => tool(job, name).run(args, ctx)

  await run('todo_add', { items: ['read', 'write', 'read again'] })
  assert.equal((await run('todo_read', {})).content, '1. read\n2. write\n3. read again')

  const removed = await run('todo_del', { ids: [2] })
  assert.equal(removed.ok, true)
  assert.equal((await run('todo_read', {})).content, '1. read\n3. read again')

  assert.equal((await run('todo_del', { ids: [99] })).ok, false, 'an unknown number is reported')

  await run('todo_clear', {})
  assert.equal((await run('todo_read', {})).content, '(empty list)')
})

// --- memory -------------------------------------------------------------------

test('memory reads back from one execution to the next', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-mem-'))
  const job = makeJob({ tools: { enabled: ['memory'] } })
  const state = memory.empty()
  const ctx = context(workspace(), {
    job,
    memory: state,
    saveMemory: () => memory.save(dir, 'demo', state),
  })

  await tool(job, 'memory_write').run({ key: 'dernier-scan', value: '2026-08-02' }, ctx)
  assert.equal(fs.existsSync(path.join(dir, 'demo.mem.json')), true)

  const relue = await memory.load(dir, 'demo')
  assert.equal(relue.entries['dernier-scan'].value, '2026-08-02')
  assert.equal(memory.render(relue), '- dernier-scan : 2026-08-02')

  await tool(job, 'memory_del').run({ key: 'dernier-scan' }, ctx)
  assert.deepEqual((await memory.load(dir, 'demo')).entries, {})
})

// The instructions announce only the keys: reading a value necessarily goes
// through the tool, and naming the key avoids bringing everything back.
test('memory_list returns the keys and their date, without the values', async () => {
  const job = makeJob({ tools: { enabled: ['memory'] } })
  const state = memory.empty()
  memory.write(state, 'a', 'valeur de a', { maxEntries: 10, now: '2026-08-01T00:00:00.000Z' })
  memory.write(state, 'b', 'valeur de b', { maxEntries: 10, now: '2026-08-02T00:00:00.000Z' })
  const ctx = context(workspace(), { job, memory: state, saveMemory: async () => {} })

  const result = await tool(job, 'memory_list').run({}, ctx)

  assert.equal(result.ok, true)
  assert.ok(result.content.includes('- a (updated 2026-08-01T00:00:00.000Z)'), result.content)
  assert.ok(result.content.includes('- b (updated'))
  assert.equal(result.content.includes('valeur de a'), false, 'the values are still to be asked for')
  assert.equal(result.summary, '2 key(s)')
})

test('memory_read named returns that entry only', async () => {
  const job = makeJob({ tools: { enabled: ['memory'] } })
  const state = memory.empty()
  memory.write(state, 'a', 'valeur de a', { maxEntries: 10 })
  memory.write(state, 'b', 'valeur de b', { maxEntries: 10 })
  const ctx = context(workspace(), { job, memory: state, saveMemory: async () => {} })

  const result = await tool(job, 'memory_read').run({ key: 'a' }, ctx)

  assert.equal(result.content, '- a : valeur de a')
  assert.equal(result.content.includes('valeur de b'), false)
})

test('memory_read with no key returns everything, as before', async () => {
  const job = makeJob({ tools: { enabled: ['memory'] } })
  const state = memory.empty()
  memory.write(state, 'a', '1', { maxEntries: 10 })
  const ctx = context(workspace(), { job, memory: state, saveMemory: async () => {} })

  assert.equal((await tool(job, 'memory_read').run({}, ctx)).content, '- a : 1')
})

// A model mostly gets the name wrong: returning the known keys saves it one more
// turn to ask for them again.
test('an unknown key is refused with the list of those that exist', async () => {
  const job = makeJob({ tools: { enabled: ['memory'] } })
  const state = memory.empty()
  memory.write(state, 'dernier-scan', '2026-08-02', { maxEntries: 10 })
  const ctx = context(workspace(), { job, memory: state, saveMemory: async () => {} })

  const result = await tool(job, 'memory_read').run({ key: 'dernier scan' }, ctx)

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('dernier-scan'), result.error)
})

test('an empty memory says so, it does not break', async () => {
  const job = makeJob({ tools: { enabled: ['memory'] } })
  const ctx = context(workspace(), { job, memory: memory.empty(), saveMemory: async () => {} })

  assert.equal((await tool(job, 'memory_list').run({}, ctx)).content, '(memory empty)')
  assert.equal(memory.renderKeys(memory.empty()), null)
})

// A write is recorded at once: an execution stopped by the timeout must keep
// what it had already learnt.
test('every write is persisted without waiting for the end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-mem-'))
  const job = makeJob({ tools: { enabled: ['memory'] } })
  const state = memory.empty()
  const ctx = context(workspace(), {
    job,
    memory: state,
    saveMemory: () => memory.save(dir, 'demo', state),
  })

  await tool(job, 'memory_write').run({ key: 'a', value: '1' }, ctx)
  assert.equal((await memory.load(dir, 'demo')).entries.a.value, '1')
})

test('past maxEntries, the oldest go', () => {
  const state = memory.empty()
  for (const [index, key] of ['a', 'b', 'c'].entries()) {
    memory.write(state, key, key, { maxEntries: 2, now: `2026-08-0${index + 1}T00:00:00.000Z` })
  }
  assert.deepEqual(Object.keys(state.entries).sort(), ['b', 'c'])
})

test('a corrupt memory file does not block the job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-mem-'))
  fs.writeFileSync(path.join(dir, 'demo.mem.json'), '{ ceci n’est pas du json')

  assert.deepEqual(await memory.load(dir, 'demo'), { version: 1, updatedAt: null, entries: {} })
})

// --- registry -----------------------------------------------------------------

test('only the declared tools are offered to the model', () => {
  const job = makeJob({ tools: { enabled: ['file_read', 'todo'] } })
  const names = selectTools(job).tools.map((t) => t.name)

  assert.deepEqual(names, ['file_read', 'todo_read', 'todo_add', 'todo_del', 'todo_clear'])
})

test('every tool of the catalogue produces a usable declaration', () => {
  const job = makeJob({ tools: { enabled: ALL } })
  const definitions = toolDefinitions(selectTools(job).tools)

  assert.equal(definitions.length, 19, 'thirteen entries, two of them groups of several tools')
  for (const definition of definitions) {
    assert.equal(definition.type, 'function')
    assert.ok(definition.function.name.length > 0)
    assert.ok(definition.function.description.length > 0)
    assert.equal(definition.function.parameters.type, 'object')
    assert.equal(definition.function.parameters.additionalProperties, false)
  }
})

// Offering fetch from the main process while the container has its network cut
// would open exactly the hole that "network off" claims to close.
test('a sandbox with no network withdraws fetch, and says so', () => {
  const job = makeJob({ tools: { enabled: ['fetch', 'todo'] } }, { sandbox: { enabled: true } })
  const { tools, notices } = selectTools(job)

  assert.equal(tools.some((t) => t.name === 'fetch'), false)
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes('network'))
})

// From a Discord channel, nobody is in front of the screen: a question would
// wait out its timeout for nothing, and a `confirm` would end as a refusal.
test('a turn with nobody at the screen loses the tools that wait', () => {
  const job = makeJob({ tools: { enabled: ['ask_user', 'confirm', 'report', 'todo'] } })
  const { tools, notices } = selectTools(job, { unattended: true })

  const names = tools.map((tool) => tool.name)
  assert.equal(names.includes('ask_user'), false)
  assert.equal(names.includes('confirm'), false)
  // `report` waits for nothing: published to Discord, it ends up read.
  assert.equal(names.includes('report'), true)
  assert.equal(names.includes('todo_add'), true)
  assert.equal(notices.length, 2, notices.join(' | '))
  assert.ok(notices.every((notice) => notice.includes('nobody is at the screen')))
})

test('with somebody at the screen, they stay offered', () => {
  const job = makeJob({ tools: { enabled: ['ask_user', 'confirm'] } })
  const { tools, notices } = selectTools(job)

  assert.deepEqual(tools.map((tool) => tool.name), ['ask_user', 'confirm'])
  assert.deepEqual(notices, [])
})

test('a sandbox with the network keeps fetch', () => {
  const job = makeJob(
    { tools: { enabled: ['fetch'] } },
    { sandbox: { enabled: true, network: true } },
  )
  assert.deepEqual(selectTools(job).tools.map((t) => t.name), ['fetch'])
})

test('memory switched off withdraws its tools, and says so', () => {
  const job = makeJob({ tools: { enabled: ['memory', 'todo'] }, memory: { enabled: false } })
  const { tools, notices } = selectTools(job)

  assert.equal(tools.some((t) => t.name.startsWith('memory_')), false)
  assert.ok(notices[0].includes('memory'))
})
