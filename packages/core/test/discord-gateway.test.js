'use strict'

// The Gateway connection, with a doubled WebSocket.
//
// What is exercised here is exactly what separates a bot that lasts the week
// from one that drops out overnight: the heartbeat and its acknowledgement,
// session resumption after a cut, and the refusal to retry a fatal close — an
// invalid token replayed every five seconds ends in an IP ban.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createGateway, OP, INTENTS } = require('../src/discord/gateway')

const TOKEN = 'token-de-test'
const HEARTBEAT_MS = 41_250

/** Doubled WebSocket: we drive the events, we read back what is sent. */
function fakeSocket(url) {
  return {
    url,
    readyState: 1,
    sent: [],
    closedWith: null,
    send(data) {
      this.sent.push(JSON.parse(data))
    },
    close(code) {
      this.closedWith = code
      this.readyState = 3
    },
  }
}

/**
 * Mounts a gateway on doubled sockets. `sockets` accumulates every connection
 * opened: that is how a reconnection is observed.
 */
function harness({ onMessage = () => {} } = {}) {
  const sockets = []
  const statuses = []
  const gateway = createGateway({
    token: TOKEN,
    onMessage,
    onStatus: (status) => statuses.push(status),
    createSocket: (url) => {
      const socket = fakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  return { gateway, sockets, statuses, last: () => sockets.at(-1) }
}

const hello = (socket) =>
  socket.onmessage({ data: JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: HEARTBEAT_MS } }) })

const ready = (socket, overrides = {}) =>
  socket.onmessage({
    data: JSON.stringify({
      op: OP.DISPATCH,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'session-abc',
        resume_gateway_url: 'wss://reprise.discord.gg',
        user: { id: '111', username: 'Rota' },
        ...overrides,
      },
    }),
  })

const opsOf = (socket) => socket.sent.map((payload) => payload.op)

// --- opening ------------------------------------------------------------------

test('IDENTIFY goes out after HELLO, never before', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last } = harness()

  gateway.start()
  last().onopen()
  assert.deepEqual(opsOf(last()), [], 'nothing until Discord has announced its interval')

  hello(last())
  assert.deepEqual(opsOf(last()), [OP.IDENTIFY])
})

test('IDENTIFY carries the token and the intents needed, and no privileged one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last } = harness()

  gateway.start()
  last().onopen()
  hello(last())

  const identify = last().sent.find((payload) => payload.op === OP.IDENTIFY)
  assert.equal(identify.d.token, TOKEN)
  assert.equal(identify.d.intents, INTENTS)
  // MESSAGE_CONTENT (1 << 15) would require authorisation from Discord, and is
  // not needed: the content of a message mentioning the bot is delivered.
  assert.equal((identify.d.intents & (1 << 15)) === 0, true, 'no privileged intent')
})

test('READY makes the gateway connected and names the bot', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, statuses } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  ready(last())

  assert.equal(gateway.status().state, 'connected')
  assert.equal(gateway.botUserId(), '111')
  assert.equal(statuses.at(-1).user, 'Rota')
})

// A token holds for the application, not for a server: a bot never invited
// connects perfectly and never hears anything. The state must say so.
test("READY counts the bot's servers", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, statuses } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  ready(last(), { guilds: [{ id: '42', unavailable: true }] })

  assert.equal(statuses.at(-1).guilds, 1)
})

test('a bot in no server is connected, but says so', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, statuses } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  ready(last(), { guilds: [] })

  assert.equal(statuses.at(-1).state, 'connected')
  assert.equal(statuses.at(-1).guilds, 0)
})

// --- heartbeat ----------------------------------------------------------------

test('the beat follows the announced interval', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last } = harness()

  gateway.start()
  last().onopen()
  hello(last())

  // The first heartbeat is offset at random *within* the interval: past that,
  // it has necessarily happened.
  t.mock.timers.tick(HEARTBEAT_MS)
  const beats = () => last().sent.filter((payload) => payload.op === OP.HEARTBEAT).length
  assert.equal(beats(), 1)

  last().onmessage({ data: JSON.stringify({ op: OP.HEARTBEAT_ACK }) })
  t.mock.timers.tick(HEARTBEAT_MS)
  assert.equal(beats(), 2)
})

// A missing acknowledgement signals a dead connection the system still believes
// open: without this check, the bot stays silent until the restart.
test('without an acknowledgement, the connection is considered dead and closed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last } = harness()

  gateway.start()
  last().onopen()
  hello(last())

  const first = last()
  t.mock.timers.tick(HEARTBEAT_MS) // battement, sans ACK
  t.mock.timers.tick(HEARTBEAT_MS) // le suivant constate le silence

  assert.equal(first.closedWith, 4000)
})

test('Discord may ask for a beat off cadence', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  last().onmessage({ data: JSON.stringify({ op: OP.HEARTBEAT }) })

  assert.ok(last().sent.some((payload) => payload.op === OP.HEARTBEAT))
})

// --- resumption ---------------------------------------------------------------

test('after a cut, the session is resumed rather than replayed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, sockets } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  ready(last())

  last().onclose({ code: 1006 })
  t.mock.timers.tick(60_000)

  assert.equal(sockets.length, 2, 'une nouvelle connexion est ouverte')
  assert.ok(last().url.startsWith('wss://reprise.discord.gg'), last().url)

  last().onopen()
  const resume = last().sent.find((payload) => payload.op === OP.RESUME)
  assert.equal(resume.d.session_id, 'session-abc')
  assert.equal(resume.d.seq, 1)
  assert.equal(last().sent.some((payload) => payload.op === OP.IDENTIFY), false)
})

test('a session invalidated beyond resuming starts over', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  ready(last())

  last().onmessage({ data: JSON.stringify({ op: OP.INVALID_SESSION, d: false }) })
  t.mock.timers.tick(60_000)

  last().onopen()
  hello(last())
  assert.ok(last().sent.some((payload) => payload.op === OP.IDENTIFY))
  assert.equal(last().sent.some((payload) => payload.op === OP.RESUME), false)
})

test('a reconnection asked for by Discord is honoured', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, sockets } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  ready(last())

  last().onmessage({ data: JSON.stringify({ op: OP.RECONNECT }) })
  t.mock.timers.tick(60_000)

  assert.equal(sockets.length, 2)
})

// --- fatal closes -------------------------------------------------------------

// Retrying a refused token ends in an IP ban.
test('a refused token stops everything, with no further attempt', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, sockets } = harness()

  gateway.start()
  last().onopen()
  last().onclose({ code: 4004 })
  t.mock.timers.tick(600_000)

  assert.equal(sockets.length, 1, 'aucune reconnexion')
  assert.equal(gateway.status().state, 'failed')
  assert.ok(gateway.status().error.includes('token'))
})

test('intents that are not allowed are said, and do not loop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, sockets } = harness()

  gateway.start()
  last().onopen()
  last().onclose({ code: 4014 })
  t.mock.timers.tick(600_000)

  assert.equal(sockets.length, 1)
  assert.ok(gateway.status().error.includes('intents'))
})

test('reconnections space out rather than hammering', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, sockets } = harness()

  gateway.start()
  last().onclose({ code: 1006 })
  t.mock.timers.tick(2000)
  assert.equal(sockets.length, 2, 'first retry: 2 s')

  last().onclose({ code: 1006 })
  t.mock.timers.tick(2000)
  assert.equal(sockets.length, 2, 'the second waits longer')
  t.mock.timers.tick(2000)
  assert.equal(sockets.length, 3)
})

// --- messages -----------------------------------------------------------------

test('MESSAGE_CREATE is handed on as it is', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const received = []
  const { gateway, last } = harness({ onMessage: (message) => received.push(message) })

  gateway.start()
  last().onopen()
  hello(last())
  ready(last())
  last().onmessage({
    data: JSON.stringify({
      op: OP.DISPATCH,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: { content: 'salut', channel_id: '42' },
    }),
  })

  assert.deepEqual(received, [{ content: 'salut', channel_id: '42' }])
})

test('an unreadable message does not take the connection down', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last } = harness()

  gateway.start()
  last().onopen()
  assert.doesNotThrow(() => last().onmessage({ data: 'ceci n’est pas du json' }))
})

test('stop closes cleanly and does not reconnect', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { gateway, last, sockets } = harness()

  gateway.start()
  last().onopen()
  hello(last())
  const socket = last()
  gateway.stop()

  assert.equal(socket.closedWith, 1000)
  socket.onclose({ code: 1000 })
  t.mock.timers.tick(600_000)
  assert.equal(sockets.length, 1)
  assert.equal(gateway.status().state, 'stopped')
})
