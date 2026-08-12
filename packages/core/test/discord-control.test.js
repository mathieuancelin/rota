'use strict'

// The bridge between Discord and Rota.
//
// The access control fits in one line — only the designated channel is listened
// to — and it is therefore the line to exercise. A direct message, another
// channel, a message from a bot: none of that must start anything.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createDiscordControl } = require('../src/discord')

const TOKEN = 'token-de-test'
const CHANNEL = '123456789012345678'
const BOT_ID = '111111111111111111'

function makeControl(integrations, { onRun = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-discord-'))
  const sent = []
  let gateway = null

  const control = createDiscordControl({
    store: {
      paths: { envFile: path.join(root, '.env') },
      getConfig: () => ({ integrations }),
      getJobs: () => [{ id: 'sync', name: 'Synchro', enabled: true }],
    },
    scheduler: {
      isPaused: () => false,
      nextRunByJob: () => new Map(),
      runNow: async (id) => {
        onRun(id)
        return { ok: true }
      },
    },
    runner: { isRunning: () => false, runningExecutions: () => [], liveOutput: () => ({ ok: false }) },
    state: { lastRunByJob: () => new Map() },
    history: { read: async () => ({ entries: [] }) },
    setPaused: async () => {},
    fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) })
      return new Response(null, { status: 204 })
    },
    createGatewayImpl: (options) => {
      gateway = {
        ...options,
        started: false,
        stopped: false,
        start() {
          this.started = true
        },
        stop() {
          this.stopped = true
        },
        status: () => ({ state: 'connected' }),
        botUserId: () => BOT_ID,
      }
      return gateway
    },
  })

  return { control, sent, gateway: () => gateway, root }
}

const message = (overrides = {}) => ({
  channel_id: CHANNEL,
  content: `<@${BOT_ID}> run sync`,
  author: { username: 'moi', bot: false },
  ...overrides,
})

const ACTIF = {
  discordControlEnabled: true,
  discordBotToken: TOKEN,
  discordChannelId: CHANNEL,
  discordWebhookUrl: null,
}

// --- conditional opening ----------------------------------------------------

// Pasting a token must not be enough to open a remote control onto your machine.
test('without the flag, no connection is opened', () => {
  const { control, gateway } = makeControl({ ...ACTIF, discordControlEnabled: false })
  control.sync()

  assert.equal(gateway(), null)
  assert.equal(control.status().state, 'disabled')
})

test('with no channel, control stays closed', () => {
  const { control, gateway } = makeControl({ ...ACTIF, discordChannelId: null })
  control.sync()
  assert.equal(gateway(), null)
})

test('with the flag, a token and a channel, the connection opens', () => {
  const { control, gateway } = makeControl(ACTIF)
  control.sync()

  assert.equal(gateway().started, true)
  assert.equal(gateway().token, TOKEN)
})

test('sync is idempotent: nothing moves while the settings do not', () => {
  const { control, gateway } = makeControl(ACTIF)
  control.sync()
  const first = gateway()
  control.sync()

  assert.equal(gateway(), first, 'the connection was not reopened')
  assert.equal(first.stopped, false)
})

test('a token missing from the environment is said, with no connection', () => {
  const { control, gateway } = makeControl({ ...ACTIF, discordBotToken: '${DISCORD_TOKEN}' })
  control.sync()

  assert.equal(gateway(), null)
  assert.equal(control.status().state, 'failed')
  assert.ok(control.status().error.includes('DISCORD_TOKEN'))
})

// --- access control ---------------------------------------------------------

test('a command from the designated channel runs, and the answer comes back to it', async () => {
  const started = []
  const { control, sent, gateway } = makeControl(ACTIF, { onRun: (id) => started.push(id) })
  control.sync()

  await gateway().onMessage(message())
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(started, ['sync'])
  assert.equal(sent.length, 1)
  assert.ok(sent[0].url.includes(`/channels/${CHANNEL}/messages`))
  assert.ok(sent[0].body.content.includes('started'))
})

// A direct message would bypass the only lock there is.
test('another channel is ignored, with no answer', async () => {
  const started = []
  const { control, sent, gateway } = makeControl(ACTIF, { onRun: (id) => started.push(id) })
  control.sync()

  await gateway().onMessage(message({ channel_id: '999' }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(started, [], 'nothing started')
  assert.deepEqual(sent, [], 'nothing answered: one teaches nothing to whoever probes the bot')
})

test('a message from a bot is ignored', async () => {
  const started = []
  const { control, gateway } = makeControl(ACTIF, { onRun: (id) => started.push(id) })
  control.sync()

  await gateway().onMessage(message({ author: { username: 'autre', bot: true } }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(started, [])
})

test('a message that does not mention the bot is ignored', async () => {
  const started = []
  const { control, sent, gateway } = makeControl(ACTIF, { onRun: (id) => started.push(id) })
  control.sync()

  await gateway().onMessage(message({ content: 'run sync' }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(started, [])
  assert.deepEqual(sent, [])
})

// --- sending -----------------------------------------------------------------

test('the bridge is a sending destination for the agents too', async () => {
  const { control, sent } = makeControl({ ...ACTIF, discordWebhookUrl: null })

  assert.equal(control.hasDestination(), true, 'le bot suffit')
  const result = await control.send({ text: 'rapport', from: 'Veille' })

  assert.equal(result.ok, true, result.error)
  assert.ok(sent[0].body.content.includes('**Veille**'))
})

test('with no destination at all, sending fails and says so', async () => {
  const { control } = makeControl({
    discordControlEnabled: false,
    discordBotToken: null,
    discordChannelId: null,
    discordWebhookUrl: null,
  })

  assert.equal(control.hasDestination(), false)
  assert.equal((await control.send({ text: 'x' })).ok, false)
})

// --- shutdown ----------------------------------------------------------------

test('stop closes the connection and puts the state back', () => {
  const { control, gateway } = makeControl(ACTIF)
  control.sync()
  const ouverte = gateway()
  control.stop()

  assert.equal(ouverte.stopped, true)
  assert.equal(control.status().state, 'disabled')
})

test('changing channel reopens the connection', () => {
  const integrations = { ...ACTIF }
  const { control, gateway } = makeControl(integrations)
  control.sync()
  const first = gateway()

  integrations.discordChannelId = '222222222222222222'
  control.sync()

  assert.equal(first.stopped, true)
  assert.notEqual(gateway(), first)
})

// The callers that mirror a report test `available` — that is what a sender
// built on the spot exposes. The control bridge takes its place in the
// application: without that property, the mirror never went out.
test('the control bridge exposes available, like a sender', () => {
  const { control } = makeControl({ ...ACTIF, discordWebhookUrl: 'https://discord.com/api/webhooks/1/x' })

  assert.equal(control.available, true)
})

test('available follows the settings with no restart', () => {
  const integrations = { discordControlEnabled: false }
  const { control } = makeControl(integrations)

  assert.equal(control.available, false)
  integrations.discordWebhookUrl = 'https://discord.com/api/webhooks/1/x'
  assert.equal(control.available, true, 'a destination set must take effect at once')
})
