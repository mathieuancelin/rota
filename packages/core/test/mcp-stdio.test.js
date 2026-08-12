'use strict'

// The stdio transport against a real server.
//
// The previous tests double the transport; this one starts a process and speaks
// the protocol for real. That is what checks what no double can check: the line
// splitting, surviving noise on stdout, and a shutdown that leaves no process
// behind.
//
// The server is written right here, in about thirty lines: depending on a
// package from the registry would make the suite fail offline.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { connect } = require('../src/agent/mcp')
const { validateJob } = require('../src/config/validate')

const SERVER = `
const lines = []
process.stdin.on('data', (chunk) => {
  lines.push(chunk.toString('utf8'))
  const text = lines.join('')
  lines.length = 0
  let rest = text
  let index
  while ((index = rest.indexOf('\\n')) !== -1) {
    const line = rest.slice(0, index)
    rest = rest.slice(index + 1)
    if (line.trim() === '') continue
    handle(JSON.parse(line))
  }
  if (rest !== '') lines.push(rest)
})

// Out of specification, but common: a server that greets on stdout.
process.stdout.write('the server is starting\\n')
process.stderr.write('log: ready\\n')

const answer = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')

function handle(message) {
  if (message.method === 'initialize') {
    answer(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1.0.0' },
    })
  } else if (message.method === 'tools/list') {
    answer(message.id, {
      tools: [
        {
          name: 'echo',
          description: 'Gives back what it is given.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
        { name: 'boom', description: 'Always fails.', inputSchema: { type: 'object' } },
      ],
    })
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params
    if (name === 'boom') {
      answer(message.id, { content: [{ type: 'text', text: 'it failed' }], isError: true })
    } else {
      answer(message.id, { content: [{ type: 'text', text: 'echo: ' + args.text }] })
    }
  }
  // Notifications get no reply.
}
`

function serverPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-mcp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'serveur.js')
  fs.writeFileSync(file, SERVER)
  return { file, dir }
}

function connector(file, overrides = {}) {
  const result = validateJob({
    id: 'demo',
    name: 'Demo',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: {
      type: 'agent',
      agent: {
        prompt: 'x',
        model: 'm',
        mcp: [
          {
            name: 'test',
            transport: 'stdio',
            command: process.execPath,
            args: [file],
            timeoutSeconds: 10,
            ...overrides,
          },
        ],
      },
    },
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job.runner.agent.mcp[0]
}

test('handshake, inventory and call against a real server', async (t) => {
  const { file, dir } = serverPath(t)

  const opened = await connect(connector(file), { env: {}, workspace: dir, fetchImpl: fetch })
  assert.equal(opened.ok, true, opened.error)
  t.after(() => opened.close())

  assert.equal(opened.server.serverInfo.name, 'test-server')
  assert.deepEqual(opened.tools.map((tool) => tool.name), ['test__echo', 'test__boom'])

  // The server's schema passes through as it is: without it, the model would
  // call blind.
  const echo = opened.tools[0]
  assert.deepEqual(echo.parameters.required, ['text'])

  const result = await echo.run({ text: 'hello' }, { signal: undefined })
  assert.deepEqual(result, { ok: true, summary: 'test/echo', content: 'echo: hello' })
})

// The server greets on stdout before any message: out of specification, but
// common enough that a client not surviving it would be unusable.
test('noise on stdout does not break the connection', async (t) => {
  const { file, dir } = serverPath(t)
  const opened = await connect(connector(file), { env: {}, workspace: dir, fetchImpl: fetch })

  assert.equal(opened.ok, true, opened.error)
  await opened.close()
})

test('an execution error from the server is handed to the model', async (t) => {
  const { file, dir } = serverPath(t)
  const opened = await connect(connector(file), { env: {}, workspace: dir, fetchImpl: fetch })
  t.after(() => opened.close())

  const result = await opened.tools[1].run({}, { signal: undefined })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'it failed')
})

test('the list of tools kept filters the inventory', async (t) => {
  const { file, dir } = serverPath(t)
  const opened = await connect(connector(file, { tools: { allow: ['echo'] } }), {
    env: {},
    workspace: dir,
    fetchImpl: fetch,
  })
  t.after(() => opened.close())

  assert.deepEqual(opened.tools.map((tool) => tool.name), ['test__echo'])
})

// The error output often says what the failure does not: module not found,
// token refused, version too old.
test('a server that does not exist is reported without taking the caller down', async (t) => {
  const { dir } = serverPath(t)
  const opened = await connect(connector('/inexistant/serveur.js'), {
    env: {},
    workspace: dir,
    fetchImpl: fetch,
  })

  assert.equal(opened.ok, false)
  assert.ok(opened.error.length > 0)
})

test("the connector's ${…} variables are resolved before the launch", async (t) => {
  const { file, dir } = serverPath(t)
  const opened = await connect(connector(file, { environment: { JETON: '${MON_JETON}' } }), {
    env: { MON_JETON: 'secret' },
    workspace: dir,
    fetchImpl: fetch,
  })
  t.after(() => opened.close())

  assert.equal(opened.ok, true, opened.error)
})

test('a missing variable prevents the launch, naming it', async (t) => {
  const { file, dir } = serverPath(t)
  const opened = await connect(connector(file, { environment: { JETON: '${ABSENTE}' } }), {
    env: {},
    workspace: dir,
    fetchImpl: fetch,
  })

  assert.equal(opened.ok, false)
  assert.ok(opened.error.includes('ABSENTE'))
})
