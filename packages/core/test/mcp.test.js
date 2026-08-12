'use strict'

// The MCP client, with no server.
//
// Two things are easily missed and are therefore exercised here:
//
//   * MCP has **two** ways of reporting an error — the JSON-RPC `error` field
//     for the protocol, `isError: true` in a valid result for the execution.
//     Confusing them means either swallowing real failures, or treating an
//     exceeded quota as a connection breakdown;
//   * over HTTP, the response arrives at the server's choice as JSON or as an
//     SSE stream, and a client reading only the first case works against half
//     the servers.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createMcpClient, flatten, PROTOCOL_VERSION, MAX_TOOLS } = require('../src/agent/mcp/client')
const { createHttpTransport } = require('../src/agent/mcp/transport-http')
const { toolName, describe: describeTool } = require('../src/agent/mcp')
const { validateJob } = require('../src/config/validate')

/** Doubled transport: we script the answers, we read back what is sent. */
function fakeTransport(handlers = {}) {
  const sent = []
  return {
    sent,
    version: null,
    async request(message) {
      sent.push(message)
      const handler = handlers[message.method]
      if (!handler) return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'inconnu' } }
      const result = typeof handler === 'function' ? handler(message) : handler
      return result.error ? { jsonrpc: '2.0', id: message.id, ...result } : { jsonrpc: '2.0', id: message.id, result }
    },
    async notify(message) {
      sent.push(message)
    },
    setProtocolVersion(version) {
      this.version = version
    },
    async close() {},
  }
}

const client = (transport) => createMcpClient({ transport, timeoutMs: 1000 })

// --- handshake -------------------------------------------------------------------

test('initialize announces the version and follows with a notification', async () => {
  const transport = fakeTransport({
    initialize: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'demo' } },
  })

  const server = await client(transport).initialize()

  const [initialize, initialized] = transport.sent
  assert.equal(initialize.method, 'initialize')
  assert.equal(initialize.params.protocolVersion, PROTOCOL_VERSION)
  assert.equal(initialize.params.clientInfo.name, 'rota')
  // No roots, no sampling: announcing them would fail a server that uses them.
  assert.deepEqual(initialize.params.capabilities, {})
  assert.equal(initialized.method, 'notifications/initialized')
  assert.equal(initialized.id, undefined, 'une notification n’a pas d’identifiant')
  assert.equal(server.serverInfo.name, 'demo')
})

// It is that one that goes out in the HTTP header afterwards: keeping the one we
// asked for rather than the one we received would get requests refused.
test('the version kept is the one the server returned', async () => {
  const transport = fakeTransport({ initialize: { protocolVersion: '2025-03-26' } })

  await client(transport).initialize()

  assert.equal(transport.version, '2025-03-26')
})

test('a refusal at initialisation comes back with its message', async () => {
  const transport = fakeTransport({
    initialize: { error: { code: -32602, message: 'Unsupported protocol version' } },
  })

  await assert.rejects(client(transport).initialize(), /Unsupported protocol version.*32602/)
})

// --- inventory -------------------------------------------------------------------

test('tools/list follows the pagination', async () => {
  let page = 0
  const transport = fakeTransport({
    'tools/list': () => {
      page += 1
      return page === 1
        ? { tools: [{ name: 'a' }], nextCursor: 'suite' }
        : { tools: [{ name: 'b' }] }
    },
  })

  const { tools } = await client(transport).listTools()

  assert.deepEqual(tools.map((tool) => tool.name), ['a', 'b'])
  assert.equal(transport.sent[1].params.cursor, 'suite')
})

// A server may expose hundreds: the list would eat the model's context without it
// being able to do anything with them.
test('an outsized inventory is truncated, and says so', async () => {
  const transport = fakeTransport({
    'tools/list': () => ({
      tools: Array.from({ length: MAX_TOOLS + 10 }, (_, index) => ({ name: `t${index}` })),
    }),
  })

  const { tools, truncated } = await client(transport).listTools()

  assert.equal(tools.length, MAX_TOOLS)
  assert.equal(truncated, true)
})

// --- calling a tool --------------------------------------------------------------

test("a successful call returns the content's text", async () => {
  const transport = fakeTransport({
    'tools/call': { content: [{ type: 'text', text: '22 °C' }] },
  })

  const result = await client(transport).callTool('meteo', { ville: 'Nantes' })

  assert.deepEqual(result, { ok: true, text: '22 °C' })
  assert.deepEqual(transport.sent[0].params, { name: 'meteo', arguments: { ville: 'Nantes' } })
})

// An execution error arrives in a perfectly valid result.
test('isError tells an execution failure from a protocol breakdown', async () => {
  const execution = fakeTransport({
    'tools/call': { content: [{ type: 'text', text: 'quota exceeded' }], isError: true },
  })
  const result = await client(execution).callTool('meteo', {})
  assert.deepEqual(result, { ok: false, text: 'quota exceeded' })

  const protocole = fakeTransport({
    'tools/call': { error: { code: -32602, message: 'Unknown tool' } },
  })
  await assert.rejects(client(protocole).callTool('absent', {}), /Unknown tool/)
})

// --- flattening the content ------------------------------------------------------

test('non-text content is announced rather than attached', () => {
  const text = flatten({
    content: [
      { type: 'text', text: 'avant' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource_link', uri: 'file:///a.rs', description: 'source' },
      { type: 'resource', resource: { uri: 'file:///b.txt', text: 'contenu' } },
    ],
  })

  assert.ok(text.includes('avant'))
  // Pasting three hundred thousand characters of base64 into the context would
  // help nobody.
  assert.ok(text.includes('[image image/png, not passed through]'))
  assert.equal(text.includes('AAAA'), false)
  assert.ok(text.includes('file:///a.rs'))
  assert.ok(text.includes('contenu'))
})

test('a structured result with no text is serialised', () => {
  assert.equal(flatten({ structuredContent: { a: 1 } }), '{\n  "a": 1\n}')
})

test('an empty result stays readable', () => {
  assert.equal(flatten({}), '(no content)')
  assert.equal(flatten({ content: [] }), '(no content)')
})

// --- naming ----------------------------------------------------------------------

// Two servers will happily expose a "search", and the model's API has only a
// flat namespace.
test("the names are prefixed with the connector's", () => {
  assert.equal(toolName('github', 'search'), 'github__search')
})

test('a name outside what the API allows is cleaned and bounded', () => {
  assert.equal(toolName('fs', 'read file!'), 'fs__read_file_')
  assert.ok(toolName('x'.repeat(30), 'y'.repeat(60)).length <= 64)
})

// --- tool wrapper ----------------------------------------------------------------

const connector = { name: 'demo', tools: { allow: [] } }

test('an MCP tool takes the shape of a Rota tool', async () => {
  const transport = fakeTransport({ 'tools/call': { content: [{ type: 'text', text: 'ok' }] } })
  const tool = describeTool(
    connector,
    { name: 'search', description: 'Cherche', inputSchema: { type: 'object', properties: { q: {} } } },
    client(transport),
  )

  assert.equal(tool.name, 'demo__search')
  assert.ok(tool.description.startsWith('[demo]'))
  assert.deepEqual(tool.parameters, { type: 'object', properties: { q: {} } })

  const result = await tool.run({ q: 'x' }, { signal: undefined })
  assert.deepEqual(result, { ok: true, summary: 'demo/search', content: 'ok' })
})

test('an input schema missing or fanciful becomes an empty object', () => {
  const tool = describeTool(connector, { name: 'x' }, client(fakeTransport()))
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} })
})

test('a breakdown of the server is handed to the model, not thrown', async () => {
  const tool = describeTool(connector, { name: 'x' }, client(fakeTransport()))
  const result = await tool.run({}, { signal: undefined })

  assert.equal(result.ok, false)
  assert.ok(result.error.startsWith('demo : '))
})

// --- HTTP transport --------------------------------------------------------------

const jsonResponse = (payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const sseResponse = (chunks) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )

test('the request announces it accepts both shapes of answer', async () => {
  let seen = null
  const transport = createHttpTransport({
    url: 'https://exemple.fr/mcp',
    fetchImpl: async (_url, options) => {
      seen = options
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} })
    },
  })

  await transport.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { timeoutMs: 1000 })

  assert.equal(seen.method, 'POST')
  assert.ok(seen.headers.Accept.includes('application/json'))
  assert.ok(seen.headers.Accept.includes('text/event-stream'))
})

// A client reading only the JSON works against half the servers.
test('a streamed answer is read, and the right one is found in it', async () => {
  const transport = createHttpTransport({
    url: 'https://exemple.fr/mcp',
    fetchImpl: async () =>
      sseResponse([
        // The server is entitled to emit something else before the response.
        'data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n',
        'data: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n',
      ]),
  })

  const response = await transport.request({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { timeoutMs: 1000 })

  assert.deepEqual(response.result, { tools: [] })
})

test('the session returned at initialisation is repeated afterwards', async () => {
  const vus = []
  const transport = createHttpTransport({
    url: 'https://exemple.fr/mcp',
    fetchImpl: async (_url, options) => {
      vus.push(options.headers)
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'Mcp-Session-Id': 'abc123' })
    },
  })

  await transport.request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { timeoutMs: 1000 })
  transport.setProtocolVersion('2025-06-18')
  await transport.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { timeoutMs: 1000 })

  assert.equal(vus[0]['Mcp-Session-Id'], undefined, 'inconnue au first appel')
  assert.equal(vus[1]['Mcp-Session-Id'], 'abc123')
  // Without this header, a server assumes a March 2025 version.
  assert.equal(vus[1]['MCP-Protocol-Version'], '2025-06-18')
})

test('an expired session is named as such', async () => {
  let first = true
  const transport = createHttpTransport({
    url: 'https://exemple.fr/mcp',
    fetchImpl: async () => {
      if (first) {
        first = false
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { 'Mcp-Session-Id': 'abc' })
      }
      return new Response('', { status: 404 })
    },
  })

  await transport.request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { timeoutMs: 1000 })
  await assert.rejects(
    transport.request({ jsonrpc: '2.0', id: 2, method: 'ping' }, { timeoutMs: 1000 }),
    /session expired/,
  )
})

test('an HTTP error is returned with its detail', async () => {
  const transport = createHttpTransport({
    url: 'https://exemple.fr/mcp',
    fetchImpl: async () => new Response('token refused', { status: 401 }),
  })

  await assert.rejects(
    transport.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { timeoutMs: 1000 }),
    /401.*token refused/,
  )
})

// --- declaration in a job --------------------------------------------------------

const agentJob = (mcp) =>
  validateJob({
    id: 'demo',
    name: 'Demo',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: { type: 'agent', agent: { prompt: 'x', model: 'm', mcp } },
  })

test('a stdio connector and an http connector are accepted, with their defaults', () => {
  const result = agentJob([
    { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'serveur'] },
    { name: 'api', transport: 'http', url: 'https://exemple.fr/mcp' },
  ])

  assert.equal(result.ok, true, result.errors?.join(' | '))
  const [stdio, http] = result.job.runner.agent.mcp
  assert.equal(stdio.timeoutSeconds, 60)
  assert.equal(stdio.enabled, true)
  assert.deepEqual(stdio.environment, {})
  assert.deepEqual(stdio.tools, { allow: [] })
  assert.deepEqual(http.headers, {})
})

test('no connector by default', () => {
  const result = agentJob(undefined)
  assert.equal(result.ok, true)
  assert.deepEqual(result.job.runner.agent.mcp, [])
})

test('every transport requires what it needs', () => {
  assert.equal(agentJob([{ name: 'fs', transport: 'stdio' }]).ok, false, 'command manquante')
  assert.equal(agentJob([{ name: 'api', transport: 'http' }]).ok, false, 'url manquante')
  assert.equal(agentJob([{ name: 'x', transport: 'carrier-pigeon' }]).ok, false)
})

// The name serves as a prefix and counts towards a tool name's 64 characters.
test('a connector name unusable as a prefix is refused', () => {
  assert.equal(agentJob([{ name: 'Mon Serveur', transport: 'http', url: 'x' }]).ok, false)
  assert.equal(agentJob([{ name: 'mon-serveur', transport: 'http', url: 'x' }]).ok, true)
})

test('an unknown field in a connector is refused rather than ignored', () => {
  const result = agentJob([{ name: 'fs', transport: 'stdio', command: 'x', shell: true }])
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('shell')))
})
