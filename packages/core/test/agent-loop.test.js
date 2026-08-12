'use strict'

// The tool loop, with a doubled server.
//
// What is exercised here is what breaks an autonomous execution: a model that
// does not conclude, stumbled argument JSON, a tool that does not exist, an
// interruption halfway. In all these cases the agent must return something
// readable rather than stopping with no explanation.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runAgent, createSession, parseArguments } = require('../src/agent')
const { validateJob } = require('../src/config/validate')
const { resolvePaths } = require('../src/config/paths')

const makePaths = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-agent-'))
  const paths = resolvePaths(root)
  for (const dir of [paths.agentsDir, paths.memoryDir]) fs.mkdirSync(dir, { recursive: true })
  return paths
}

const makeJob = (agent = {}) => {
  const result = validateJob({
    id: 'demo',
    name: 'Demo',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: {
      type: 'agent',
      agent: { prompt: 'Fais le travail.', model: 'gemma4:latest', ...agent },
    },
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

/** Doubled server: one scripted answer per call. */
function scriptedServer(turns) {
  const seen = []
  return {
    seen,
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body))
      const turn = turns[Math.min(seen.length - 1, turns.length - 1)]
      return new Response(JSON.stringify({ choices: [{ message: turn }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  }
}

const toolCall = (name, args, id = 'call_1') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

// --- parsing the arguments ------------------------------------------------------

test('the arguments are read as a string and as an object alike', () => {
  assert.deepEqual(parseArguments('{"a":1}'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseArguments({ a: 1 }), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseArguments(''), { ok: true, value: {} })
  assert.deepEqual(parseArguments(undefined), { ok: true, value: {} })
  assert.deepEqual(parseArguments('"a string"'), { ok: true, value: {} })
  assert.equal(parseArguments('{ pas du json').ok, false)
})

// --- nominal run ----------------------------------------------------------------

test('a tool turn then a final message', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['write it up'] })] },
    { role: 'assistant', content: 'Work finished.' },
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.iterations, 2)
  assert.ok(result.stdout.includes('▸ todo_add'))
  assert.ok(result.stdout.includes('Work finished.'))
  assert.equal(result.stderr, '')

  // The second call must report the tool call and its result.
  const second = server.seen[1].messages
  assert.equal(second.at(-2).role, 'assistant')
  assert.equal(second.at(-2).tool_calls[0].function.name, 'todo_add')
  assert.equal(second.at(-1).role, 'tool')
  assert.equal(second.at(-1).tool_call_id, 'call_1')
})

test('the transcript carries the header, the turns and the result', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([{ role: 'assistant', content: 'Nothing to do.' }])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.ok(result.stdout.includes('Agent "Demo" — gemma4:latest @ http://127.0.0.1:11434/v1'))
  assert.ok(result.stdout.includes('Tools: todo_read, todo_add, todo_del, todo_clear'))
  assert.ok(result.stdout.includes('── turn 1 ──'))
  assert.ok(result.stdout.includes('── result ──'))
})

test("the job's prompt really is the message sent", async () => {
  const paths = makePaths()
  const job = makeJob()
  const server = scriptedServer([{ role: 'assistant', content: 'ok' }])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const [system, user] = server.seen[0].messages
  assert.equal(system.role, 'system')
  assert.equal(user.role, 'user')
  assert.equal(user.content, 'Fais le travail.')
})

// --- default instructions ---------------------------------------------------------

test("${defaults.system_prompt} is replaced by Rota's own instructions", async () => {
  const paths = makePaths()
  const job = makeJob({ systemPrompt: 'Before.\n\n${defaults.system_prompt}\n\nAfter.' })
  const server = scriptedServer([{ role: 'assistant', content: 'ok' }])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const system = server.seen[0].messages[0].content
  assert.ok(system.includes('You are an autonomous agent of Rota'), system.slice(0, 200))
  assert.ok(system.indexOf('Avant.') < system.indexOf('You are an autonomous agent'))
  assert.ok(system.indexOf('You are an autonomous agent') < system.indexOf('After.'))
  assert.equal(system.includes('${defaults.system_prompt}'), false, 'rien ne doit rester du token')
})

// It is the field's default value: a job that says nothing receives them.
test('a job with no system prompt still receives the default instructions', async () => {
  const paths = makePaths()
  const server = scriptedServer([{ role: 'assistant', content: 'ok' }])

  await runAgent({ job: makeJob(), paths, fetchImpl: server.fetchImpl })

  assert.ok(server.seen[0].messages[0].content.includes('You are an autonomous agent of Rota'))
})

test("instructions entirely one's own replace ours, without dragging them along", async () => {
  const paths = makePaths()
  const job = makeJob({ systemPrompt: 'Answer only yes or no.' })
  const server = scriptedServer([{ role: 'assistant', content: 'ok' }])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const system = server.seen[0].messages[0].content
  assert.ok(system.startsWith('Answer only yes or no.'))
  assert.equal(system.includes('You are an autonomous agent of Rota'), false)
  // What depends on the execution stays appended, whatever the job says.
  assert.ok(system.includes('Job "Demo"'))
  assert.ok(system.includes('Finish with a message and no tool call'))
})

test("the reference holds in the job's prompt too", async () => {
  const paths = makePaths()
  const job = makeJob({ prompt: 'Rappel : ${defaults.system_prompt}' })
  const server = scriptedServer([{ role: 'assistant', content: 'ok' }])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.ok(server.seen[0].messages[1].content.includes('You are an autonomous agent of Rota'))
})

test("the instructions recall the memory's keys, not the values", async () => {
  const paths = makePaths()
  fs.writeFileSync(
    path.join(paths.memoryDir, 'demo.mem.json'),
    JSON.stringify({ version: 1, entries: { 'dernier-scan': { value: '2026-08-01' } } }),
  )
  const job = makeJob({ tools: { enabled: ['memory', 'file_read'] } })
  const server = scriptedServer([{ role: 'assistant', content: 'ok' }])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const system = server.seen[0].messages[0].content
  // The key is announced; the value is not — it would read as an instruction, and
  // a hundred entries of four thousand characters would not fit anyway.
  assert.ok(system.includes('- dernier-scan'), system)
  assert.equal(system.includes('2026-08-01'), false, 'la valeur reste hors des consignes')
  assert.ok(system.includes('memory_read'), 'les consignes disent comment la lire')
  assert.ok(system.includes('relative to your working directory'))
})

test('with no file tool, the instructions say nothing about paths', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([{ role: 'assistant', content: 'ok' }])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(server.seen[0].messages[0].content.includes('Working directory'), false)
})

test('the default working directory is created under agents/', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['file_write'] } })
  const server = scriptedServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('file_write', { path: 'output.txt', content: 'bonjour' })],
    },
    { role: 'assistant', content: 'Written.' },
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(result.ok, true, result.error)
  assert.equal(fs.readFileSync(path.join(paths.agentsDir, 'demo', 'output.txt'), 'utf8'), 'bonjour')
})

// --- what breaks -----------------------------------------------------------------

test('a model that never concludes is stopped, and says so', async () => {
  const paths = makePaths()
  const job = makeJob({ maxIterations: 3, tools: { enabled: ['todo'] } })
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_read', {})] },
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(result.ok, false)
  assert.equal(result.iterations, 3)
  assert.ok(result.error.includes('3 turns'))
  assert.ok(result.stderr.includes('3 turns'))
})

test('an unknown tool is handed to the model, without stopping the loop', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [toolCall('rm_rf', { path: '/' })] },
    { role: 'assistant', content: 'Compris, je fais autrement.' },
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(result.ok, true)
  assert.ok(server.seen[1].messages.at(-1).content.includes('unknown tool: rm_rf'))
  assert.ok(result.stdout.includes('✗ unknown tool'))
})

test('unreadable arguments are handed to the model rather than thrown', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'todo_add', arguments: '{ items: [' } }],
    },
    { role: 'assistant', content: 'Je reprends.' },
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(result.ok, true)
  assert.ok(server.seen[1].messages.at(-1).content.includes('unreadable arguments'))
})

test('a call with no identifier is given one, and the result attaches to it', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'todo_read', arguments: '{}' } }] },
    { role: 'assistant', content: 'Vu.' },
  ])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const messages = server.seen[1].messages
  assert.equal(messages.at(-2).tool_calls[0].id, 'call_0')
  assert.equal(messages.at(-1).tool_call_id, 'call_0')
})

test('a breakdown of the server is returned as it is', async () => {
  const paths = makePaths()
  const job = makeJob()

  const result = await runAgent({
    job,
    paths,
    fetchImpl: async () => new Response('service indisponible', { status: 503 }),
  })

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('503'))
  assert.ok(result.stdout.includes('── result ──'), 'le transcript reste exploitable')
})

test('an interruption is told apart from a failure', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const controller = new AbortController()
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_read', {})] },
  ])

  const fetchImpl = async (url, options) => {
    if (server.seen.length >= 1) controller.abort()
    return server.fetchImpl(url, options)
  }

  const result = await runAgent({ job, paths, fetchImpl, signal: controller.signal })

  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
})

// --- effects and memory ----------------------------------------------------------

test('signal_change comes back as a real effect of the execution', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['signal_change'] } })
  const server = scriptedServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('signal_change', { message: '3 files tidied' })],
    },
    { role: 'assistant', content: 'Fini.' },
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(result.change, '3 files tidied')
})

test('with no signal_change, the execution claims no effect', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([{ role: 'assistant', content: "Nothing had moved." }])

  assert.equal((await runAgent({ job, paths, fetchImpl: server.fetchImpl })).change, null)
})

test('what is memorised is there on the next run', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['memory'] } })

  await runAgent({
    job,
    paths,
    fetchImpl: scriptedServer([
      {
        role: 'assistant',
        content: '',
        tool_calls: [toolCall('memory_write', { key: 'state', value: 'green' })],
      },
      { role: 'assistant', content: 'Noted.' },
    ]).fetchImpl,
  })

  const second = scriptedServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('memory_read', { key: 'state' })],
    },
    { role: 'assistant', content: 'ok' },
  ])
  await runAgent({ job, paths, fetchImpl: second.fetchImpl })

  // The next execution sees the key in its instructions…
  assert.ok(second.seen[0].messages[0].content.includes('- state'))
  // … and the value comes to it from the tool, not from the prompt.
  const toolResult = second.seen[1].messages.find((message) => message.role === 'tool')
  assert.ok(toolResult.content.includes('state : green'), toolResult.content)
})

// --- multi-turn session -------------------------------------------------------------

test('a session chains the turns, keeping the previous messages', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([{ role: 'assistant', content: 'oui' }])

  const opened = await createSession({ job, paths, trigger: 'chat', fetchImpl: server.fetchImpl })
  assert.equal(opened.ok, true, opened.error)

  await opened.session.runTurn({ content: 'first question' })
  await opened.session.runTurn({ content: 'second question' })
  await opened.session.dispose()

  const messages = server.seen[1].messages
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  )
  assert.equal(messages[1].content, 'first question')
  assert.equal(messages[3].content, 'second question')
  assert.ok(messages[0].content.includes('triggered by a conversation with the user'))
})

test('the task list survives from one turn to the next of the same session', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['todo'] } })
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['a'] })] },
    { role: 'assistant', content: 'added' },
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_read', {})] },
    { role: 'assistant', content: 'relu' },
  ])

  const opened = await createSession({ job, paths, fetchImpl: server.fetchImpl })
  await opened.session.runTurn({ content: 'ajoute a' })
  await opened.session.runTurn({ content: 'relis' })
  await opened.session.dispose()

  assert.deepEqual(
    opened.session.todo.items.map((item) => item.text),
    ['a'],
  )
  assert.ok(server.seen[3].messages.at(-1).content.includes('1. a'))
})
