'use strict'

// The HTTP server: what it allows, and above all what it refuses.
//
// This is the most exposed surface of the project — an open port, possibly on
// the network, that starts jobs able to run shell. The tests that matter most
// here are therefore not those of the routes, but those of the three locks: each
// surface's flag, the token, and the webhook trigger a job must declare to be
// startable that way.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { generateToken, presentedToken, tokenMatches } = require('../src/http/auth')
const { handle } = require('../src/http/router')

const TOKEN = 'tt_0123456789abcdef0123456789abcdef'

const HTTP_DEFAULTS = {
  enabled: true,
  listen: '127.0.0.1',
  port: 47823,
  token: TOKEN,
  apiEnabled: true,
  webhookEnabled: true,
}

const job = (overrides = {}) => ({
  id: 'sync-notes',
  name: 'Notes sync',
  description: '',
  enabled: true,
  triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
  runner: { type: 'bun', script: '/x.js', interpreter: 'sh' },
  ...overrides,
})

const workItem = (overrides = {}) => ({
  id: 'sync-notes',
  jobId: 'sync-notes',
  status: 'pending',
  input: { page: 3 },
  result: null,
  error: null,
  attempts: 0,
  availableAt: null,
  executionId: null,
  createdAt: '2026-08-05T09:00:00.000Z',
  updatedAt: '2026-08-05T09:00:00.000Z',
  ...overrides,
})

/**
 * An in-memory stand-in for the queue: the router only ever calls these six.
 *
 * The item is named after the job on purpose — the test that replays every
 * described operation substitutes one identifier everywhere, and an item that
 * did not answer to it would look like a route that is described but not
 * served.
 */
function makeWork(items = [workItem()]) {
  const byId = new Map(items.map((item) => [item.id, item]))
  return {
    byId,
    list: ({ jobId = null, status = null } = {}) =>
      [...byId.values()].filter(
        (item) => (!jobId || item.jobId === jobId) && (!status || item.status === status),
      ),
    get: (id) => byId.get(id) ?? null,
    create: async ({ jobId, input, id }) => {
      const chosen = id ?? 'generated'
      if (byId.has(chosen)) {
        return { ok: false, error: `A work item named "${chosen}" already exists` }
      }
      const item = workItem({ id: chosen, jobId, input })
      byId.set(chosen, item)
      return { ok: true, item }
    },
    remove: async (id) => byId.delete(id),
    retry: async (id) => ({ ...byId.get(id), status: 'pending', attempts: 0 }),
    cancel: async (id) => ({ ...byId.get(id), status: 'cancelled' }),
  }
}

function makeDeps({ http = {}, jobs = [job()], envFile = '/nowhere/.env', work = makeWork() } = {}) {
  const calls = []
  return {
    calls,
    store: {
      paths: { envFile },
      getConfig: () => ({ http: { ...HTTP_DEFAULTS, ...http } }),
      getJobs: () => jobs,
      getJob: (id) => jobs.find((candidate) => candidate.id === id) ?? null,
      setJobEnabled: async (id, enabled) => {
        calls.push(['setJobEnabled', id, enabled])
        return { ok: true }
      },
    },
    scheduler: {
      isPaused: () => false,
      isSessionLocked: () => false,
      nextRunByJob: () => new Map([['sync-notes', '2026-08-05T09:00:00.000Z']]),
      runNow: async (id, options) => {
        calls.push(['runNow', id, options.trigger])
        return { ok: true }
      },
    },
    runner: {
      runningByJob: () => new Map(),
      runningExecutions: () => [],
      liveOutput: () => ({ ok: true, stdout: { text: '' }, stderr: { text: '' } }),
      cancel: (executionId) => calls.push(['cancel', executionId]),
    },
    work,
    state: { lastRunByJob: () => new Map() },
    history: {
      read: async () => ({
        entries: [
          {
            executionId: 'exec-1',
            trigger: 'schedule',
            startedAt: '2026-08-04T09:00:00.000Z',
            finishedAt: '2026-08-04T09:00:02.000Z',
            durationMs: 2000,
            status: 'success',
            exitCode: 0,
            stdout: 'tout va bien\n',
            stderr: '',
            error: null,
          },
        ],
      }),
    },
    chat: null,
    setPaused: async (paused) => calls.push(['setPaused', paused]),
  }
}

const call = (method, url, deps, { token = TOKEN, body = null, headers = {} } = {}) => {
  const parsed = new URL(url, 'http://localhost')
  return handle(
    {
      method,
      pathname: parsed.pathname,
      query: parsed.searchParams,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body,
    },
    deps,
  )
}

// --- the token ------------------------------------------------------------------

test('the token comparison refuses anything that does not match exactly', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true)
  assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false)
  assert.equal(tokenMatches(TOKEN.slice(0, -1), TOKEN), false)
  assert.equal(tokenMatches('', ''), false, 'un token vide n’ouvre rien')
  assert.equal(tokenMatches(null, TOKEN), false)
  assert.equal(tokenMatches(TOKEN, null), false)
})

// Some webhook senders do not let you choose the authorization header: refusing
// their only option would amount to refusing the webhook.
test('the token is read from Authorization as from X-Rota-Token', () => {
  assert.equal(presentedToken({ authorization: `Bearer ${TOKEN}` }), TOKEN)
  assert.equal(presentedToken({ authorization: `bearer ${TOKEN}` }), TOKEN)
  assert.equal(presentedToken({ 'x-rota-token': TOKEN }), TOKEN)
  assert.equal(presentedToken({ authorization: TOKEN }), null, 'without the scheme, nothing')
  assert.equal(presentedToken({}), null)
})

test('the drawn tokens are unique and long enough for the schema', () => {
  const tokens = new Set(Array.from({ length: 50 }, () => generateToken()))

  assert.equal(tokens.size, 50)
  for (const token of tokens) assert.ok(token.length >= 16)
})

test('with no token, the API refuses', async () => {
  const response = await call('GET', '/api/jobs', makeDeps(), { token: null })

  assert.equal(response.status, 401)
})

test('with a wrong token, the API refuses just the same', async () => {
  const response = await call('GET', '/api/jobs', makeDeps(), { token: 'tt_faux' })

  assert.equal(response.status, 401)
})

// The flag is read before the token: an API that is off answers like an address
// that does not exist, which is what it is.
test('API off: 404, even with the right token', async () => {
  const response = await call('GET', '/api/jobs', makeDeps({ http: { apiEnabled: false } }))

  assert.equal(response.status, 404)
})

test('a server with no token configured opens nothing', async () => {
  const response = await call('GET', '/api/jobs', makeDeps({ http: { token: null } }), {
    token: null,
  })

  assert.equal(response.status, 401)
})

// --- API routes -----------------------------------------------------------------

test('the job list shows neither code nor prompt', async () => {
  const response = await call('GET', '/api/jobs', makeDeps())

  assert.equal(response.status, 200)
  assert.equal(response.body.jobs.length, 1)
  const [described] = response.body.jobs
  assert.equal(described.id, 'sync-notes')
  assert.equal(described.runner, 'bun')
  assert.equal(described.triggerLabel, 'every 5 minutes')
  assert.equal(described.script, undefined, 'le path du script ne sort pas')
  assert.equal(described.code, undefined)
})

test('starting a job answers 202 and tells the scheduler', async () => {
  const deps = makeDeps()
  const response = await call('POST', '/api/jobs/sync-notes/run', deps)

  assert.equal(response.status, 202)
  assert.deepEqual(deps.calls, [['runNow', 'sync-notes', 'api']])
})

test('an unknown job is a 404, whatever the action', async () => {
  for (const [method, url] of [
    ['GET', '/api/jobs/fantome'],
    ['POST', '/api/jobs/fantome/run'],
    ['GET', '/api/jobs/fantome/logs'],
  ]) {
    const response = await call(method, url, makeDeps())
    assert.equal(response.status, 404, `${method} ${url}`)
  }
})

test('stopping a job that is not running is a conflict, not a success', async () => {
  const response = await call('POST', '/api/jobs/sync-notes/stop', makeDeps())

  assert.equal(response.status, 409)
})

test('enabling and disabling go through the store', async () => {
  const deps = makeDeps()

  await call('POST', '/api/jobs/sync-notes/disable', deps)
  await call('POST', '/api/jobs/sync-notes/enable', deps)

  assert.deepEqual(deps.calls, [
    ['setJobEnabled', 'sync-notes', false],
    ['setJobEnabled', 'sync-notes', true],
  ])
})

test('the history bounds itself, even asked for a thousand', async () => {
  const response = await call('GET', '/api/jobs/sync-notes/history?limit=100000', makeDeps())

  assert.equal(response.status, 200)
  assert.equal(response.body.entries[0].executionId, 'exec-1')
})

test('the logs return the last execution when nothing is running', async () => {
  const response = await call('GET', '/api/jobs/sync-notes/logs', makeDeps())

  assert.equal(response.status, 200)
  assert.equal(response.body.running, false)
  assert.match(response.body.stdout, /tout va bien/)
})

test('the logs of a running execution win over the history', async () => {
  const deps = makeDeps()
  deps.runner.runningExecutions = () => [{ executionId: 'live-1', jobId: 'sync-notes' }]
  deps.runner.liveOutput = () => ({ ok: true, stdout: { text: 'en cours…' }, stderr: { text: '' } })

  const response = await call('GET', '/api/jobs/sync-notes/logs', deps)

  assert.equal(response.body.running, true)
  assert.equal(response.body.stdout, 'en cours…')
})

test('pausing the scheduler goes through the same door as the interface', async () => {
  const deps = makeDeps()

  await call('POST', '/api/scheduler/pause', deps)
  await call('POST', '/api/scheduler/resume', deps)

  assert.deepEqual(deps.calls, [['setPaused', true], ['setPaused', false]])
})

test('a method that does not go with the route is a 404', async () => {
  const response = await call('GET', '/api/jobs/sync-notes/run', makeDeps())

  assert.equal(response.status, 404)
})

// --- chatting with an agent -------------------------------------------------------

test("the conversation returns the turn's answer", async () => {
  const deps = makeDeps()
  deps.chat = {
    open: () => ({ ok: true, chatId: 'chat-1', busy: false }),
    post: async () => ({ ok: true, turn: { ok: true, content: 'there you go.' } }),
  }

  const response = await call('POST', '/api/jobs/sync-notes/chat', deps, {
    body: { message: 'quoi de neuf ?' },
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.reply, 'there you go.')
})

test('an empty message is refused before anything is opened', async () => {
  const deps = makeDeps()
  deps.chat = {
    open: () => assert.fail('nothing was to be opened'),
    post: async () => assert.fail('nothing was to be sent'),
  }

  const response = await call('POST', '/api/jobs/sync-notes/chat', deps, {
    body: { message: '   ' },
  })

  assert.equal(response.status, 422)
})

// One turn occupies the conversation: two messages crossing would stack up on the
// same context.
test('a second message during a turn is refused, not queued', async () => {
  const deps = makeDeps()
  deps.chat = { open: () => ({ ok: true, chatId: 'chat-1', busy: true }), post: async () => ({}) }

  const response = await call('POST', '/api/jobs/sync-notes/chat', deps, {
    body: { message: 'et maintenant ?' },
  })

  assert.equal(response.status, 409)
})

// --- webhook --------------------------------------------------------------------

const withWebhook = (extra = {}) =>
  job({ triggers: [{ type: 'webhook', ...extra }] })

test('a job declaring a webhook starts through its address', async () => {
  const deps = makeDeps({ jobs: [withWebhook()] })
  const response = await call('POST', '/webhook/sync-notes', deps)

  assert.equal(response.status, 202)
  assert.deepEqual(deps.calls, [['runNow', 'sync-notes', 'webhook']])
})

// That is what distinguishes the webhook from the API: an address given to a
// third-party service only starts what one declared wanting to start that way.
test('a job with no webhook trigger cannot be started through the webhook', async () => {
  const deps = makeDeps()
  const response = await call('POST', '/webhook/sync-notes', deps)

  assert.equal(response.status, 404)
  assert.deepEqual(deps.calls, [])
})

test('a disabled job does not start through the webhook either', async () => {
  const deps = makeDeps({ jobs: [withWebhook(), job({ enabled: false })].slice(1) })
  deps.store.getJobs = () => [{ ...withWebhook(), enabled: false }]
  deps.store.getJob = () => ({ ...withWebhook(), enabled: false })

  const response = await call('POST', '/webhook/sync-notes', deps)

  assert.equal(response.status, 404)
  assert.deepEqual(deps.calls, [])
})

test('a webhook trigger switched off does not answer', async () => {
  const deps = makeDeps({ jobs: [withWebhook({ enabled: false })] })
  const response = await call('POST', '/webhook/sync-notes', deps)

  assert.equal(response.status, 404)
})

test('webhook off in the settings: 404 everywhere', async () => {
  const deps = makeDeps({ jobs: [withWebhook()], http: { webhookEnabled: false } })
  const response = await call('POST', '/webhook/sync-notes', deps)

  assert.equal(response.status, 404)
})

test('the webhook accepts POST only', async () => {
  const deps = makeDeps({ jobs: [withWebhook()] })
  const response = await call('GET', '/webhook/sync-notes', deps)

  assert.equal(response.status, 405)
})

test('with no token, the webhook refuses like the rest', async () => {
  const deps = makeDeps({ jobs: [withWebhook()] })
  const response = await call('POST', '/webhook/sync-notes', deps, { token: null })

  assert.equal(response.status, 401)
  assert.deepEqual(deps.calls, [])
})

// An address one hands out deserves a secret that holds for it alone: the
// server's token opens the API, the trigger's opens that job.
test("a trigger with a token of its own refuses the server's", async () => {
  const propre = 'tt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const deps = makeDeps({ jobs: [withWebhook({ token: propre })] })

  assert.equal((await call('POST', '/webhook/sync-notes', deps, { token: TOKEN })).status, 401)
  assert.equal((await call('POST', '/webhook/sync-notes', deps, { token: propre })).status, 202)
})

test("a trigger's token goes through the .env file", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-http-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const envFile = path.join(dir, '.env')
  await fs.writeFile(envFile, 'DEPLOY_TOKEN=tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n')

  const deps = makeDeps({ jobs: [withWebhook({ token: '${DEPLOY_TOKEN}' })], envFile })

  const response = await call('POST', '/webhook/sync-notes', deps, {
    token: 'tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  })

  assert.equal(response.status, 202)
})

// A missing variable must not let a comparison be made against the string
// "${DEPLOY_TOKEN}", which a caller could guess by reading the definition.
test('a missing variable refuses rather than comparing the reference', async () => {
  const deps = makeDeps({ jobs: [withWebhook({ token: '${ABSENTE}' })] })

  const response = await call('POST', '/webhook/sync-notes', deps, { token: '${ABSENTE}' })

  assert.equal(response.status, 500)
  assert.deepEqual(deps.calls, [])
})

// --- what does not exist ------------------------------------------------------

test('an address outside both surfaces is a 404', async () => {
  for (const url of ['/', '/admin', '/api', '/apis/jobs', '/webhook']) {
    const response = await call('GET', url, makeDeps())
    assert.equal(response.status, 404, url)
  }
})

// --- the server itself ---------------------------------------------------------
//
// The routing is testable without a socket, as the above shows. What remains is
// the plumbing and what it alone can break: parsing the body, reading the
// headers, and opening then closing the port.

const { createHttpServer } = require('../src/http')

async function listening(t, deps) {
  const server = createHttpServer({ ...deps, onStatusChange: () => {} })
  server.sync()
  t.after(() => server.stop())

  // Listening is asynchronous: we wait for the status to carry an address.
  for (let attempt = 0; attempt < 100 && server.status().state !== 'listening'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(server.status().state, 'listening', server.status().error ?? '')
  return server.status().url
}

test('the server really answers on its port', async (t) => {
  const deps = makeDeps({ http: { port: 0 } })
  const url = await listening(t, deps)

  const response = await fetch(`${url}/api/status`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })

  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).jobs, 1)
})

test('a malformed JSON body is refused without taking the server down', async (t) => {
  const deps = makeDeps({ http: { port: 0 } })
  deps.chat = { open: () => ({ ok: true, chatId: 'c', busy: false }), post: async () => ({}) }
  const url = await listening(t, deps)

  const refused = await fetch(`${url}/api/jobs/sync-notes/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: '{ pas du json',
  })
  assert.equal(refused.status, 400)

  // And the server is still there.
  const after = await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(after.status, 200)
})

// Nobody writes "curl -X POST -d '{}'" first time: a POST with no body must work
// where no data is expected.
test('a POST with no body is accepted where nothing is expected', async (t) => {
  const deps = makeDeps({ http: { port: 0 } })
  const url = await listening(t, deps)

  const response = await fetch(`${url}/api/jobs/sync-notes/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  })

  assert.equal(response.status, 202)
})

test('with no flag, the server opens no port', async (t) => {
  const deps = makeDeps({ http: { enabled: false, port: 0 } })
  const server = createHttpServer({ ...deps, onStatusChange: () => {} })
  t.after(() => server.stop())

  server.sync()

  assert.equal(server.status().state, 'disabled')
})

test('with no token, the server opens no port either', async (t) => {
  const deps = makeDeps({ http: { token: null, port: 0 } })
  const server = createHttpServer({ ...deps, onStatusChange: () => {} })
  t.after(() => server.stop())

  server.sync()

  assert.equal(server.status().state, 'disabled')
})

// --- the OpenAPI description ------------------------------------------------------
//
// A description that ages without anyone noticing is worse than none: it sends
// people calling addresses that have gone. So it is checked from both ends —
// every operation it describes must exist, and every action the router handles
// must be described.

// --- the queues ---------------------------------------------------------------------

// The route the whole feature exists for: something outside Rota puts work on a
// queue, and a worker picks it up without anybody being at the screen.
test('work can be queued for a job over HTTP', async () => {
  const deps = makeDeps()

  const response = await call('POST', '/api/work', deps, {
    body: { jobId: 'sync-notes', id: 'gh-421', input: { issue: 421 } },
  })

  assert.equal(response.status, 201)
  assert.equal(response.body.jobId, 'sync-notes')
  assert.deepEqual(response.body.input, { issue: 421 })
  assert.equal(deps.work.byId.has('gh-421'), true)
})

// An integration replaying the same event must not queue the work twice, and
// has to be able to tell that is what happened.
test('an identifier already taken answers 409, not a second item', async () => {
  const deps = makeDeps()
  await call('POST', '/api/work', deps, { body: { jobId: 'sync-notes', id: 'gh-421' } })

  const again = await call('POST', '/api/work', deps, { body: { jobId: 'sync-notes', id: 'gh-421' } })

  assert.equal(again.status, 409)
  assert.equal(deps.work.byId.size, 2)
})

// A queue nobody reads is work quietly lost.
test('work for a job that does not exist is refused', async () => {
  const response = await call('POST', '/api/work', makeDeps(), {
    body: { jobId: 'nowhere', input: {} },
  })

  assert.equal(response.status, 422)
  assert.match(response.body.error, /unknown job/)
})

test('the queue can be listed, and filtered', async () => {
  const deps = makeDeps({
    work: makeWork([workItem({ id: 'a' }), workItem({ id: 'b', status: 'done' })]),
  })

  const all = await call('GET', '/api/work', deps)
  const done = await call('GET', '/api/work?status=done', deps)

  assert.equal(all.body.items.length, 2)
  assert.deepEqual(
    done.body.items.map((item) => item.id),
    ['b'],
  )
})

test('an unknown item is a 404, like anything else that is not there', async () => {
  const response = await call('GET', '/api/work/nope', makeDeps())

  assert.equal(response.status, 404)
})

test('the queue routes are behind the token like the rest', async () => {
  const response = await call('GET', '/api/work', makeDeps(), { token: null })

  assert.equal(response.status, 401)
})

const { buildSpec, OPERATIONS } = require('../src/http/openapi')

test('the description is served behind the token, like the rest', async () => {
  assert.equal((await call('GET', '/api/openapi.json', makeDeps(), { token: null })).status, 401)

  const response = await call('GET', '/api/openapi.json', makeDeps())
  assert.equal(response.status, 200)
  assert.equal(response.body.openapi, '3.1.0')
})

test('API off: neither description nor page', async () => {
  const deps = makeDeps({ http: { apiEnabled: false } })

  assert.equal((await call('GET', '/api/openapi.json', deps)).status, 404)
  assert.equal((await call('GET', '/api/docs', deps)).status, 404)
})

// A browser cannot set a header by following a link. The page carries nothing the
// open port does not already reveal, and asks for the token itself.
test('the reading page opens with no token, the description does not', async () => {
  const page = await call('GET', '/api/docs', makeDeps(), { token: null })

  assert.equal(page.status, 200)
  assert.match(page.contentType, /text\/html/)
  assert.match(page.body, /Token from Settings/)
  assert.ok(!page.body.includes(TOKEN), 'and it obviously carries no token')
})

test('the configured listen address is the one the description announces', () => {
  const spec = buildSpec({ listen: '0.0.0.0', port: 9000 })

  assert.equal(spec.servers[0].url, 'http://0.0.0.0:9000')
})

// Every documented operation must resolve to something other than "no such
// route". 404 on a known job would mean the path is described but not served.
test('every described operation really exists', async () => {
  const deps = makeDeps({ jobs: [withWebhook()] })

  for (const { method, path } of OPERATIONS) {
    const url = path.replace('{id}', 'sync-notes')
    const response = await call(method.toUpperCase(), url, deps, { body: { message: 'x' } })
    assert.notEqual(response.status, 404, `${method.toUpperCase()} ${url} est dwrittene mais absente`)
  }
})

// The other direction: an action added to the router without being described
// would be invisible to anyone reading the description.
test('no action of the router is missing from the description', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'http', 'router.js'),
    'utf8',
  )
  const servies = new Set(
    [...source.matchAll(/action === '([a-z]+)'/g)].map((match) => match[1]),
  )
  const decrites = new Set(
    OPERATIONS.flatMap(({ path }) => path.split('/').filter(Boolean).slice(-1)),
  )

  for (const action of servies) {
    assert.ok(decrites.has(action), `le routeur sert « ${action} », la description l’ignore`)
  }
  assert.ok(servies.size >= 6, `inventaire suspect : ${[...servies].join(', ')}`)
})

test('the webhook is described, though it lives behind a flag of its own', () => {
  const webhook = OPERATIONS.find((operation) => operation.path.startsWith('/webhook'))

  assert.ok(webhook, 'the address one gives a third party is the one to describe')
  assert.match(webhook.description, /declaring a webhook trigger/)
})
