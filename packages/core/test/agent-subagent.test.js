'use strict'

// Delegation: an agent handing a task to a second one.
//
// What is exercised here is the part that would be expensive to get wrong. A
// sub-agent runs the same loop with the same tools on the same machine, so the
// interesting questions are not "does it work" but "where does it stop": how
// deep, how many, with which tools, and what comes back to the caller.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runAgent, createSession } = require('../src/agent')
const { validateJob } = require('../src/config/validate')
const { resolvePaths } = require('../src/config/paths')
const memory = require('../src/agent/memory')

const makePaths = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-subagent-'))
  const paths = resolvePaths(root)
  for (const dir of [paths.agentsDir, paths.memoryDir]) fs.mkdirSync(dir, { recursive: true })
  return paths
}

const makeJob = (agent = {}) => {
  const result = validateJob({
    id: 'demo',
    name: 'Demo',
    runner: {
      type: 'agent',
      agent: { prompt: 'Do the work.', model: 'gemma4:latest', temperature: 0.3, ...agent },
    },
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

/** One scripted answer per call; the last repeats. */
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

const delegates = (task, context) => ({
  role: 'assistant',
  content: '',
  tool_calls: [toolCall('sub_agent', context ? { task, context } : { task })],
})

const concludes = (content) => ({ role: 'assistant', content })

/** The tool names offered on request number `n`, in order. */
const offered = (server, n) => server.seen[n].tools.map((tool) => tool.function.name)

// --- what comes back ---------------------------------------------------------------

test('a sub-agent answers, and only its answer reaches the caller', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'todo'] } })
  const server = scriptedServer([
    delegates('Count the notes.'),
    // The sub-agent works, then concludes.
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['look'] })] },
    concludes('Seventeen notes, all from last week.'),
    concludes('There are seventeen.'),
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.equal(result.ok, true, result.error)
  assert.equal(server.seen.length, 4)

  // The caller received the sub-agent's final message as the tool result, and
  // nothing of how it got there.
  const back = server.seen[3].messages.at(-1)
  assert.equal(back.role, 'tool')
  assert.equal(back.name, 'sub_agent')
  assert.equal(back.content, 'Seventeen notes, all from last week.')
  assert.ok(!back.content.includes('todo_add'))
})

test('the sub-agent sees the task, not the conversation that produced it', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent'] } })
  const server = scriptedServer([
    delegates('Count the notes.', 'They are in notes/, one file per day.'),
    concludes('Seventeen.'),
    concludes('done'),
  ])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const child = server.seen[1].messages
  assert.deepEqual(
    child.map((message) => message.role),
    ['system', 'user'],
  )
  assert.ok(child[1].content.startsWith('Count the notes.'))
  assert.ok(child[1].content.includes('They are in notes/, one file per day.'))
  // Nothing of the caller's own instructions or turns.
  assert.ok(!child[1].content.includes('Do the work.'))

  // And it is told what its answer is for.
  assert.ok(child[0].content.includes('# You were given this task by another agent'))
  assert.ok(child[0].content.includes('your final message is all it gets back'))
})

test('it inherits the model, the temperature and the API of the job', async () => {
  const paths = makePaths()
  const job = makeJob({
    temperature: 0.7,
    reasoningEffort: 'high',
    tools: { enabled: ['sub_agent'] },
  })
  const server = scriptedServer([delegates('Go.'), concludes('done'), concludes('ok')])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const parent = server.seen[0]
  const child = server.seen[1]
  assert.equal(child.model, parent.model)
  assert.equal(child.temperature, 0.7)
  assert.equal(child.reasoning_effort, 'high')
})

test('a sub-agent that concludes without saying anything is a failure, not an empty answer', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent'] } })
  const server = scriptedServer([delegates('Go.'), concludes('   '), concludes('ok')])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const back = server.seen[2].messages.at(-1)
  assert.ok(back.content.startsWith('Error: the sub-agent finished without saying anything'))
})

test('a sub-agent that never concludes is reported to the caller, which carries on', async () => {
  const paths = makePaths()
  const job = makeJob({
    maxIterations: 6,
    tools: { enabled: ['sub_agent', 'todo'], subagents: { maxIterations: 2 } },
  })
  const server = scriptedServer([
    delegates('Go round in circles.'),
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['a'] })] },
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['b'] })] },
    concludes('I gave up on it.'),
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  // Two turns for the sub-agent, then back to the caller — the job's own budget
  // of six was not what bounded it.
  assert.equal(server.seen.length, 4)
  const back = server.seen[3].messages.at(-1)
  assert.ok(back.content.includes('the sub-agent did not conclude'))
  assert.ok(back.content.includes('within 2 turns'))
  assert.equal(result.ok, true, 'the caller still concluded')
})

// --- where it stops -----------------------------------------------------------------

test('by default a sub-agent cannot delegate in turn', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'todo'] } })
  const server = scriptedServer([delegates('Go.'), concludes('done'), concludes('ok')])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  // The order is the one the job declares, not the catalogue's.
  assert.deepEqual(offered(server, 0), ['sub_agent', 'todo_read', 'todo_add', 'todo_del', 'todo_clear'])
  // The tool is not offered rather than offered and refused: a tool it could
  // only ever be refused costs a turn every time it tries.
  assert.deepEqual(offered(server, 1), ['todo_read', 'todo_add', 'todo_del', 'todo_clear'])
})

test('a deeper budget lets one more level through, and stops at it', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent'], subagents: { maxDepth: 2 } } })
  const server = scriptedServer([
    delegates('Level one.'),
    delegates('Level two.'),
    concludes('the deepest'),
    concludes('back up'),
    concludes('done'),
  ])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.deepEqual(offered(server, 0), ['sub_agent'])
  assert.deepEqual(offered(server, 1), ['sub_agent'])
  // Left with nothing at all, the third level is sent no `tools` field: an empty
  // array would tell the model it has tools, but none of them.
  assert.equal(server.seen[2].tools, undefined, 'the third level must not be able to delegate')
})

test('maxDepth 0 withdraws the tool and says so in the transcript', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'todo'], subagents: { maxDepth: 0 } } })
  const server = scriptedServer([concludes('nothing to delegate')])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.deepEqual(offered(server, 0), ['todo_read', 'todo_add', 'todo_del', 'todo_clear'])
  assert.ok(result.stdout.includes('⚠ sub_agent withdrawn: delegation is off'))
})

test('the ceiling counts the whole execution, not one agent', async () => {
  const paths = makePaths()
  const job = makeJob({
    maxIterations: 12,
    tools: { enabled: ['sub_agent'], subagents: { maxDepth: 2, maxPerRun: 2 } },
  })
  const server = scriptedServer([
    delegates('one'), // caller, first
    delegates('two'), // the sub-agent delegates in turn: second
    concludes('deepest'),
    delegates('three'), // back in the sub-agent: refused, the budget is spent
    concludes('gave up'),
    delegates('four'), // and the caller is refused too
    concludes('done'),
  ])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const refusedInChild = server.seen[4].messages.at(-1)
  assert.ok(refusedInChild.content.includes('already 2 sub-agents for this execution'))
  const refusedInParent = server.seen[6].messages.at(-1)
  assert.ok(refusedInParent.content.includes('already 2 sub-agents for this execution'))
})

test('deny withdraws tools from sub-agents and leaves the caller its own', async () => {
  const paths = makePaths()
  const job = makeJob({
    tools: {
      enabled: ['sub_agent', 'file_read', 'file_write', 'run_job'],
      subagents: { deny: ['file_write', 'run_job'] },
    },
  })
  const server = scriptedServer([delegates('Read it.'), concludes('read'), concludes('ok')])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.deepEqual(offered(server, 0), ['sub_agent', 'file_read', 'file_write', 'run_job'])
  assert.deepEqual(offered(server, 1), ['file_read'])
})

test('denying everything a job has is refused at validation, not at run time', () => {
  const refused = validateJob({
    id: 'demo',
    name: 'Demo',
    runner: {
      type: 'agent',
      agent: {
        prompt: 'p',
        model: 'm',
        tools: { enabled: ['sub_agent', 'file_read'], subagents: { deny: ['sub_agent', 'file_read'] } },
      },
    },
  })
  assert.equal(refused.ok, false)
  assert.ok(refused.errors.some((error) => error.includes('no tool at all')))

  // Denying a tool the job has not switched on is fine: it is how a definition
  // stays safe when the tool is switched on later.
  const allowed = validateJob({
    id: 'demo',
    name: 'Demo',
    runner: {
      type: 'agent',
      agent: {
        prompt: 'p',
        model: 'm',
        tools: { enabled: ['sub_agent', 'file_read'], subagents: { deny: ['shell'] } },
      },
    },
  })
  assert.equal(allowed.ok, true, allowed.errors?.join(' | '))
})

// --- what is shared -----------------------------------------------------------------

test('what a sub-agent memorises, the job finds again', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'memory'] } })
  const server = scriptedServer([
    delegates('Find out and remember.'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('memory_write', { key: 'notes/count', value: 'seventeen' })],
    },
    concludes('Seventeen, remembered.'),
    concludes('done'),
  ])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  const stored = await memory.load(paths.memoryDir, 'demo')
  assert.equal(stored.entries['notes/count'].value, 'seventeen')
})

test('an effect reported by a sub-agent is an effect of the execution', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'signal_change'] } })
  const server = scriptedServer([
    delegates('Fix it.'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('signal_change', { message: '3 notes rewritten' })],
    },
    concludes('Fixed.'),
    concludes('done'),
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })
  assert.equal(result.change, '3 notes rewritten')
})

test('the task list is its own, so it does not tidy the caller’s', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'todo'] } })
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['mine'] })] },
    delegates('Go.'),
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_read', {})] },
    concludes('nothing on my list'),
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_read', {})] },
    concludes('done'),
  ])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  // The sub-agent's list was empty…
  assert.ok(server.seen[3].messages.at(-1).content.includes('(empty list)'))
  // …and the caller's was untouched.
  assert.ok(server.seen[5].messages.at(-1).content.includes('1. mine'))
})

// --- what it leaves behind ------------------------------------------------------------

test('the sub-agent’s turns are in the transcript, one level in', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'todo'] } })
  const server = scriptedServer([
    delegates('Count them.'),
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['look'] })] },
    concludes('Seventeen.'),
    concludes('There are seventeen.'),
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })
  const lines = result.stdout.split('\n')

  assert.ok(lines.includes('── turn 1 ──'))
  assert.ok(lines.some((line) => line.startsWith('▸ sub_agent {"task":"Count them."}')))
  assert.ok(lines.includes('│ ── sub-agent turn 1 ──'))
  assert.ok(lines.some((line) => line.startsWith('│ ▸ todo_add')))
  assert.ok(lines.includes('│ · answer'))
  assert.ok(lines.includes('│     Seventeen.'))
  // Back out for the result of the call, and the caller's own conclusion.
  assert.ok(lines.some((line) => line === '  ✓ 2 turn(s)'))
  assert.ok(result.stdout.endsWith('── result ──\nThere are seventeen.\n'))
})

test('the execution reports its own turns, not everything under it', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent'] } })
  const server = scriptedServer([
    delegates('Go.'),
    concludes('a'),
    concludes('b'),
  ])

  const result = await runAgent({ job, paths, fetchImpl: server.fetchImpl })
  assert.equal(result.iterations, 2, 'the caller took two turns; the sub-agent’s are its own')
})

test('a stop reaches the sub-agent, not only the agent that called it', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'todo'] } })
  const controller = new AbortController()

  const server = scriptedServer([
    delegates('Go.'),
    { role: 'assistant', content: '', tool_calls: [toolCall('todo_add', { items: ['a'] })] },
    concludes('never reached'),
  ])
  const stopping = {
    fetchImpl: async (url, options) => {
      // Interrupted while the sub-agent is working.
      if (server.seen.length === 1) controller.abort()
      return server.fetchImpl(url, options)
    },
  }

  const result = await runAgent({
    job,
    paths,
    fetchImpl: stopping.fetchImpl,
    signal: controller.signal,
  })

  assert.equal(result.aborted, true)
  assert.equal(result.ok, false)
})

test('the stop button reaches the tools of both agents, not only the loop', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent', 'fetch'] } })
  const controller = new AbortController()

  // What a tool is handed, at each level. `fetch` is the one that would keep a
  // socket open past a stop if the signal did not reach it.
  const seenSignals = []
  const server = scriptedServer([
    { role: 'assistant', content: '', tool_calls: [toolCall('fetch', { url: 'https://x.test/' })] },
    delegates('Go.'),
    { role: 'assistant', content: '', tool_calls: [toolCall('fetch', { url: 'https://y.test/' })] },
    concludes('done'),
    concludes('ok'),
  ])

  await runAgent({
    job,
    paths,
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      // The model's own calls go to the scripted server; the agent's `fetch`
      // tool is what we are watching.
      if (String(url).endsWith('.test/')) {
        seenSignals.push(options.signal)
        return new Response('ok', { status: 200 })
      }
      return server.fetchImpl(url, options)
    },
  })

  assert.equal(seenSignals.length, 2, 'both agents called fetch')
  for (const [level, signal] of seenSignals.entries()) {
    assert.equal(signal, controller.signal, `level ${level} was handed no stop button`)
  }
})

test('a session opened for a conversation delegates too', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent'] } })
  const server = scriptedServer([delegates('Go.'), concludes('found it'), concludes('done')])

  const opened = await createSession({ job, paths, trigger: 'chat', fetchImpl: server.fetchImpl })
  const turn = await opened.session.runTurn({ content: 'have a look' })
  await opened.session.dispose()

  assert.equal(turn.ok, true, turn.error)
  assert.equal(server.seen[2].messages.at(-1).content, 'found it')
})

// --- delegating to a reusable agent -----------------------------------------------------
//
// The other half of the tool: instead of a second agent like the caller, the
// task goes to somebody else — another model, other instructions, its own
// memory. What matters here is the boundary, because a sub-agent runs inside the
// caller's execution: what it may borrow, and what it may not.

const { validateProfile } = require('../src/config/validate')

const makeProfile = (overrides = {}) => {
  const result = validateProfile({
    id: 'relecteur',
    name: 'Relecteur',
    model: 'qwen:7b',
    systemPrompt: 'Tu relis, tu ne corriges pas.',
    tools: { enabled: ['file_read'] },
    ...overrides,
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.profile
}

/** A job allowed to delegate to the profiles named. */
const jobDelegatingTo = (allow, agent = {}) =>
  makeJob({
    tools: { enabled: ['sub_agent', 'todo'], subagents: { allow }, ...(agent.tools ?? {}) },
    ...agent,
  })

const delegatesTo = (id, task = 'Relis le dossier.') => ({
  role: 'assistant',
  content: '',
  tool_calls: [toolCall('sub_agent', { task, agent: id })],
})

const lookup = (...profiles) => (id) => profiles.find((p) => p.id === id) ?? null

test('the named agent answers with its own model and instructions', async () => {
  const paths = makePaths()
  const job = jobDelegatingTo(['relecteur'])
  const server = scriptedServer([
    delegatesTo('relecteur'),
    concludes('Trois coquilles.'),
    concludes('Il en reste trois.'),
  ])

  const result = await runAgent({
    job,
    paths,
    fetchImpl: server.fetchImpl,
    getProfile: lookup(makeProfile()),
  })

  assert.equal(result.ok, true, result.error)
  // The sub-agent's request carries the profile's model, not the job's.
  assert.equal(server.seen[1].model, 'qwen:7b')
  assert.equal(server.seen[0].model, 'gemma4:latest')
  assert.ok(server.seen[1].messages[0].content.includes('Tu relis, tu ne corriges pas.'))
  // And its answer comes back like any other sub-agent's.
  assert.equal(server.seen[2].messages.at(-1).content, 'Trois coquilles.')
})

test('it is equipped from the profile, not from the caller', async () => {
  const paths = makePaths()
  const job = jobDelegatingTo(['relecteur'])
  const server = scriptedServer([delegatesTo('relecteur'), concludes('lu'), concludes('ok')])

  await runAgent({
    job,
    paths,
    fetchImpl: server.fetchImpl,
    getProfile: lookup(makeProfile({ tools: { enabled: ['file_read', 'file_list'] } })),
  })

  const its = offered(server, 1)
  assert.deepEqual(its.sort(), ['file_list', 'file_read'])
  // The caller's own tools are not lent to it.
  assert.ok(!its.includes('todo'))
})

// The reason the allowlist exists: a sub-agent runs in the caller's execution
// and its results come back into the caller's conversation.
test('an agent that is not allowed is refused, and the allowed ones are named', async () => {
  const paths = makePaths()
  const job = jobDelegatingTo(['relecteur'])
  const server = scriptedServer([delegatesTo('sysadmin'), concludes('tant pis')])

  await runAgent({
    job,
    paths,
    fetchImpl: server.fetchImpl,
    getProfile: lookup(makeProfile(), makeProfile({ id: 'sysadmin', name: 'Sysadmin' })),
  })

  const back = server.seen[1].messages.at(-1)
  assert.equal(back.role, 'tool')
  assert.match(back.content, /not one of the agents this job may delegate to/)
  assert.match(back.content, /relecteur/)
  // Two requests only: the refusal costs no delegation.
  assert.equal(server.seen.length, 2)
})

test('a job that lists none may delegate to none', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent'] } })
  const server = scriptedServer([delegatesTo('relecteur'), concludes('tant pis')])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl, getProfile: lookup(makeProfile()) })

  assert.match(server.seen[1].messages.at(-1).content, /none is listed in tools\.subagents\.allow/)
})

test('an agent allowed but absent from profiles/ says so', async () => {
  const paths = makePaths()
  const job = jobDelegatingTo(['disparu'])
  const server = scriptedServer([delegatesTo('disparu'), concludes('tant pis')])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl, getProfile: lookup() })

  assert.match(server.seen[1].messages.at(-1).content, /no reusable agent named "disparu"/)
})

// `deny` is the only say the caller keeps over what it invites into its own
// execution.
test('deny still applies to what the profile brings', async () => {
  const paths = makePaths()
  const job = makeJob({
    tools: {
      enabled: ['sub_agent'],
      subagents: { allow: ['relecteur'], deny: ['file_list'] },
    },
  })
  const server = scriptedServer([delegatesTo('relecteur'), concludes('lu'), concludes('ok')])

  await runAgent({
    job,
    paths,
    fetchImpl: server.fetchImpl,
    getProfile: lookup(makeProfile({ tools: { enabled: ['file_read', 'file_list'] } })),
  })

  assert.deepEqual(offered(server, 1), ['file_read'])
})

test('it writes into the agent’s memory, not the job’s', async () => {
  const paths = makePaths()
  const job = jobDelegatingTo(['relecteur'])
  const server = scriptedServer([
    delegatesTo('relecteur'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [toolCall('memory_write', { key: 'convention', value: 'tabs' })],
    },
    concludes('noté'),
    concludes('ok'),
  ])

  await runAgent({
    job,
    paths,
    fetchImpl: server.fetchImpl,
    getProfile: lookup(makeProfile({ tools: { enabled: ['memory'] } })),
  })

  assert.equal((await memory.load(paths.memoryDir, 'relecteur')).entries.convention.value, 'tabs')
  assert.equal((await memory.load(paths.memoryDir, 'demo')).entries.convention, undefined)
})

// Without this the model has no way of knowing what to pass: the parameter takes
// an identifier it cannot guess.
test('the instructions name the agents the job may delegate to', async () => {
  const paths = makePaths()
  const job = jobDelegatingTo(['relecteur'])
  const server = scriptedServer([concludes('rien à faire')])

  await runAgent({
    job,
    paths,
    fetchImpl: server.fetchImpl,
    getProfile: lookup(makeProfile({ description: 'Relit sans corriger.' })),
  })

  const instructions = server.seen[0].messages[0].content
  assert.match(instructions, /# Agents you may delegate to/)
  assert.match(instructions, /relecteur — Relecteur: Relit sans corriger\./)
})

test('a job that may delegate to nobody is told nothing about it', async () => {
  const paths = makePaths()
  const job = makeJob({ tools: { enabled: ['sub_agent'] } })
  const server = scriptedServer([concludes('rien à faire')])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl })

  assert.ok(!server.seen[0].messages[0].content.includes('# Agents you may delegate to'))
})

test('delegating still spends the execution’s budget', async () => {
  const paths = makePaths()
  const job = makeJob({
    tools: { enabled: ['sub_agent'], subagents: { allow: ['relecteur'], maxPerRun: 1 } },
  })
  const server = scriptedServer([
    delegatesTo('relecteur', 'première'),
    concludes('un'),
    delegatesTo('relecteur', 'seconde'),
    concludes('deux'),
  ])

  await runAgent({ job, paths, fetchImpl: server.fetchImpl, getProfile: lookup(makeProfile()) })

  // The second is refused by the same ceiling that bounds an ordinary sub-agent.
  const refusal = server.seen[3].messages.at(-1)
  assert.match(refusal.content, /already 1 sub-agents for this execution/)
})

// --- the connectors a profile brings ------------------------------------------------------
//
// Opened for one delegation and closed after it. This is the part that leaks if
// it is wrong: a connector is a process, and one left running outlives the
// execution that asked for it — invisibly, until there are forty of them.

const MCP_SERVER = `
require('node:fs').writeFileSync(process.argv[2], String(process.pid))
const answer = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
let rest = ''
process.stdin.on('data', (chunk) => {
  rest += chunk.toString('utf8')
  let index
  while ((index = rest.indexOf('\\n')) !== -1) {
    const line = rest.slice(0, index)
    rest = rest.slice(index + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      answer(message.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      })
    } else if (message.method === 'tools/list') {
      answer(message.id, { tools: [] })
    }
  }
})
`

/** A profile whose connector records the pid it runs under. */
function profileWithConnector(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-mcp-sub-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const server = path.join(dir, 'serveur.js')
  const pidFile = path.join(dir, 'pid')
  fs.writeFileSync(server, MCP_SERVER)

  return {
    pidFile,
    profile: makeProfile({
      mcp: [
        {
          name: 'fixture',
          transport: 'stdio',
          command: process.execPath,
          args: [server, pidFile],
          timeoutSeconds: 10,
        },
      ],
    }),
  }
}

const stillRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('the connectors of the delegated agent are closed with it', async (t) => {
  const paths = makePaths()
  const { profile, pidFile } = profileWithConnector(t)
  const server = scriptedServer([delegatesTo('relecteur'), concludes('lu'), concludes('ok')])

  await runAgent({
    job: jobDelegatingTo(['relecteur']),
    paths,
    fetchImpl: server.fetchImpl,
    getProfile: lookup(profile),
  })

  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(Number.isInteger(pid) && pid > 0, 'the connector must have started')
  assert.equal(stillRunning(pid), false, 'and must not have outlived the delegation')
})

// The `finally` earns its keep here: a delegation that fails is exactly when one
// forgets to clean up.
test('they are closed too when the delegation fails', async (t) => {
  const paths = makePaths()
  const { profile, pidFile } = profileWithConnector(t)

  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls += 1
    // The caller delegates; the agent it delegated to cannot reach its model.
    if (calls === 1) {
      return new Response(
        JSON.stringify({ choices: [{ message: delegatesTo('relecteur') }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (calls === 2) return new Response('boom', { status: 500 })
    return new Response(JSON.stringify({ choices: [{ message: concludes('tant pis') }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  await runAgent({ job: jobDelegatingTo(['relecteur']), paths, fetchImpl, getProfile: lookup(profile) })

  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(stillRunning(pid), false)
})
