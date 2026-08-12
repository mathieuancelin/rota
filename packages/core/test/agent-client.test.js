'use strict'

// Calling the model. No server is started: `fetch` is doubled, and what is
// checked is the body sent and the message recomposed — the part one can read
// back, where a real execution depends on a loaded model.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  chatCompletionsUrl,
  buildRequestBody,
  createSseParser,
  createDeltaAccumulator,
  createClient,
} = require('../src/agent/client')
const { validateJob } = require('../src/config/validate')

const agentOf = (overrides = {}) => {
  const result = validateJob({
    id: 'demo',
    name: 'Demo',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: {
      type: 'agent',
      agent: { prompt: 'Fais quelque chose.', model: 'gemma4:latest', ...overrides },
    },
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job.runner.agent
}

const MESSAGES = [{ role: 'user', content: 'bonjour' }]
const TOOLS = [{ type: 'function', function: { name: 'todo_read', parameters: { type: 'object' } } }]

/** Minimal JSON response of an OpenAI-compatible server. */
const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

const sseResponse = (chunks) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
  )

// --- building the request ---------------------------------------------------

test('the endpoint URL is derived from the root, with or without a trailing slash', () => {
  assert.equal(chatCompletionsUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(chatCompletionsUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1/chat/completions')
})

test('the minimal body carries only what was asked for', () => {
  const body = buildRequestBody({ agent: agentOf(), messages: MESSAGES })

  assert.deepEqual(body, { model: 'gemma4:latest', messages: MESSAGES })
  assert.equal('tools' in body, false, 'un tableau vide signalerait des outils inexistants')
  assert.equal('temperature' in body, false)
  assert.equal('reasoning_effort' in body, false)
})

test('the tools are declared with tool_choice', () => {
  const body = buildRequestBody({ agent: agentOf(), messages: MESSAGES, tools: TOOLS })

  assert.deepEqual(body.tools, TOOLS)
  assert.equal(body.tool_choice, 'auto')
})

test('the reasoning level goes out as reasoning_effort, and can be withdrawn', () => {
  const agent = agentOf({ reasoningEffort: 'high', temperature: 0.2 })

  assert.equal(buildRequestBody({ agent, messages: MESSAGES }).reasoning_effort, 'high')
  assert.equal(buildRequestBody({ agent, messages: MESSAGES }).temperature, 0.2)
  assert.equal(
    'reasoning_effort' in buildRequestBody({ agent, messages: MESSAGES, reasoningEffort: false }),
    false,
  )
})

test('extraBody is merged last: the explicit wins', () => {
  const agent = agentOf({ temperature: 0.9, api: { extraBody: { temperature: 0.1, top_p: 0.5 } } })
  const body = buildRequestBody({ agent, messages: MESSAGES })

  assert.equal(body.temperature, 0.1)
  assert.equal(body.top_p, 0.5)
})

// --- blocking response ------------------------------------------------------

test('complete sends the resolved headers and returns the message', async () => {
  let seen = null
  const client = createClient({
    agent: agentOf({ api: { headers: { Authorization: 'Bearer ${CLE}' } } }),
    env: { CLE: 'secret' },
    fetchImpl: async (url, options) => {
      seen = { url, options }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'salut' } }] })
    },
  })

  const result = await client.complete({ messages: MESSAGES, tools: TOOLS })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.message.content, 'salut')
  assert.deepEqual(result.message.tool_calls, [])
  assert.equal(seen.url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(seen.options.headers.Authorization, 'Bearer secret')
  assert.equal(seen.options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(seen.options.body).tools, TOOLS)
})

test('a missing variable stops before any network call', async () => {
  let called = false
  const client = createClient({
    agent: agentOf({ api: { headers: { Authorization: 'Bearer ${ABSENTE}' } } }),
    env: {},
    fetchImpl: async () => {
      called = true
      return jsonResponse({})
    },
  })

  const result = await client.complete({ messages: MESSAGES })

  assert.equal(result.ok, false)
  assert.equal(called, false, 'un 401 aurait fait accuser le serveur')
  assert.ok(result.error.includes('ABSENTE'))
})

test('the tool calls are handed on as they are', async () => {
  const toolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'todo_add', arguments: '{"items":["a"]}' },
  }
  const client = createClient({
    agent: agentOf(),
    env: {},
    fetchImpl: async () =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
      }),
  })

  const result = await client.complete({ messages: MESSAGES, tools: TOOLS })

  assert.equal(result.ok, true)
  assert.equal(result.message.content, '', 'a null content becomes an empty string')
  assert.deepEqual(result.message.tool_calls, [toolCall])
  assert.equal(result.message.finishReason, 'tool_calls')
})

test('an HTTP error is returned with its detail, not swallowed', async () => {
  const client = createClient({
    agent: agentOf(),
    env: {},
    fetchImpl: async () => new Response('unknown model', { status: 404 }),
  })

  const result = await client.complete({ messages: MESSAGES })

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('404'))
  assert.ok(result.error.includes('unknown model'))
})

// The field is not normalised everywhere: rather than guessing the server from
// its URL, we ask it once and remember its answer.
test('a server refusing reasoning_effort has it withdrawn, once', async () => {
  const bodies = []
  const client = createClient({
    agent: agentOf({ reasoningEffort: 'medium' }),
    env: {},
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      bodies.push(body)
      if ('reasoning_effort' in body) {
        return new Response('unknown field: reasoning_effort', { status: 400 })
      }
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] })
    },
  })

  const first = await client.complete({ messages: MESSAGES })
  assert.equal(first.ok, true, first.error)
  assert.equal(bodies.length, 2, 'refus puis reprise')

  const second = await client.complete({ messages: MESSAGES })
  assert.equal(second.ok, true)
  assert.equal(bodies.length, 3, 'the question is not asked again')
  assert.equal('reasoning_effort' in bodies[2], false)
})

test('an unrelated 400 is not replayed', async () => {
  let calls = 0
  const client = createClient({
    agent: agentOf({ reasoningEffort: 'medium' }),
    env: {},
    fetchImpl: async () => {
      calls += 1
      return new Response('messages: too long', { status: 400 })
    },
  })

  const result = await client.complete({ messages: MESSAGES })

  assert.equal(result.ok, false)
  assert.equal(calls, 1)
})

// --- streaming ---------------------------------------------------------------

// An HTTP stream is not cut on logical boundaries: that is the case that always
// breaks, so the one that must be exercised.
test('the SSE parser reassembles events cut anywhere', () => {
  const complete = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'

  for (const size of [1, 3, 7, 13, complete.length]) {
    const parser = createSseParser()
    const events = []
    for (let at = 0; at < complete.length; at += size) {
      events.push(...parser.push(complete.slice(at, at + size)))
    }
    assert.deepEqual(events, [{ a: 1 }, { b: 2 }], `split by ${size}`)
  }
})

test('the SSE parser ignores comments and unreadable fragments', () => {
  const parser = createSseParser()
  const events = parser.push(': keep-alive\n\ndata: pas du json\n\ndata: {"ok":true}\n\n')

  assert.deepEqual(events, [{ ok: true }])
})

test('the deltas reassemble content, reasoning and tool calls', () => {
  const accumulator = createDeltaAccumulator()
  const emitted = []

  const push = (delta, finish) =>
    emitted.push(accumulator.push({ choices: [{ delta, finish_reason: finish ?? null }] }))

  push({ role: 'assistant', content: 'Bon' })
  push({ content: 'jour' })
  push({ reasoning: 'thinking it over' })
  push({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'file_', arguments: '{"pa' } }] })
  push({ tool_calls: [{ index: 0, function: { name: 'read', arguments: 'th":"a.txt"}' } }] })
  push({}, 'tool_calls')

  assert.deepEqual(accumulator.result(), {
    role: 'assistant',
    content: 'Bonjour',
    reasoning: 'thinking it over',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
    ],
    finishReason: 'tool_calls',
  })
  assert.deepEqual(emitted[1], { content: 'jour' }, 'every piece is emitted as it comes')
})

test('stream returns the reassembled message and emits the pieces', async () => {
  const client = createClient({
    agent: agentOf(),
    env: {},
    fetchImpl: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Bon"}}]}\n\ndata: {"choices":[{"delta":',
        '{"content":"jour"}}]}\n\ndata: [DONE]\n\n',
      ]),
  })

  const morceaux = []
  const result = await client.stream({
    messages: MESSAGES,
    onDelta: (delta) => morceaux.push(delta.content),
  })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.message.content, 'Bonjour')
  assert.deepEqual(morceaux, ['Bon', 'jour'])
})

test('stream really asks the server for a stream', async () => {
  let body = null
  const client = createClient({
    agent: agentOf(),
    env: {},
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body)
      return sseResponse(['data: [DONE]\n\n'])
    },
  })

  await client.stream({ messages: MESSAGES })

  assert.equal(body.stream, true)
})

// "fetch failed" tells nobody anything, and an Ollama one forgot to start is by
// far the most frequent failure.
test('a server that is down is named as such, not as "fetch failed"', async () => {
  const client = createClient({
    agent: agentOf(),
    env: {},
    fetchImpl: async () => {
      const error = new TypeError('fetch failed')
      error.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      throw error
    },
  })

  const result = await client.complete({ messages: MESSAGES })

  assert.equal(result.ok, false)
  assert.ok(result.error.includes('unreachable'), result.error)
  assert.ok(result.error.includes('http://127.0.0.1:11434/v1/chat/completions'))
  assert.equal(result.error.includes('fetch failed'), false)
})

test('a breakdown with no known code keeps the original message', async () => {
  const client = createClient({
    agent: agentOf(),
    env: {},
    fetchImpl: async () => {
      const error = new TypeError('fetch failed')
      error.cause = new Error('quelque chose de nouveau')
      throw error
    },
  })

  const result = await client.complete({ messages: MESSAGES })

  assert.ok(result.error.includes('quelque chose de nouveau'))
})

test('an interruption is told apart from a breakdown', async () => {
  const controller = new AbortController()
  const client = createClient({
    agent: agentOf(),
    env: {},
    fetchImpl: async (_url, options) => {
      controller.abort()
      options.signal.throwIfAborted()
      return jsonResponse({})
    },
  })

  const result = await client.complete({ messages: MESSAGES, signal: controller.signal })

  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
})
