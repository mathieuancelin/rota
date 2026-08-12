'use strict'

// Discord's Gateway connection, written by hand.
//
// The protocol comes down to a handful of opcodes, and a library would bring
// hundreds of kilobytes for the nine tenths this project has no use for — voice,
// permissions, entity caching, component builders. Same reasoning as for the
// cron parser and the icon rasteriser: the format is small and frozen.
//
// What really matters comes down to three points, and that is where the
// difference lies between a bot that lasts the week and one that drops out
// overnight:
//
//   * the heartbeat, which must be sent at the announced interval and whose
//     missing acknowledgement means a dead connection believed alive;
//   * resumption (RESUME), which reattaches the session after a cut instead of
//     replaying everything — Discord regularly closes connections itself;
//   * fatal close codes, which must above all not be retried in a loop: an
//     invalid token retried every five seconds ends in an IP ban.
//
// No command is interpreted here: this module returns raw messages.

const logger = require('../lib/logger')

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

// Channel messages are enough. MESSAGE_CONTENT (1 << 15) is a privileged intent
// that requires authorisation from Discord — and that we do not need: the
// content of a message mentioning the bot is delivered without it.
const INTENTS = 1 << 9 // GUILD_MESSAGES

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/**
 * Closures there is no point retrying: the configuration is at fault, not the
 * network.
 */
const FATAL_CLOSE = {
  4004: 'bot token refused',
  4010: 'invalid shard',
  4011: 'the bot must be split across several shards',
  4012: 'invalid Gateway version',
  4013: 'invalid intents',
  4014: 'intents not allowed — check the bot settings at Discord',
}

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 120_000

/**
 * @param {object} options
 * @param {string} options.token the bot's token, already resolved
 * @param {(message: object) => void} options.onMessage MESSAGE_CREATE
 * @param {(status: object) => void} [options.onStatus] for the interface
 * @param {(url: string, protocols?: any) => object} [options.createSocket]
 */
function createGateway({ token, onMessage, onStatus = () => {}, createSocket }) {
  const open = createSocket ?? ((url) => new WebSocket(url))

  let socket = null
  let heartbeat = null
  let reconnectTimer = null
  let attempts = 0
  let stopped = false

  let sequence = null
  let sessionId = null
  let resumeUrl = null
  let acknowledged = true
  let botUser = null

  let status = { state: 'stopped', since: null, error: null, user: null }

  const setStatus = (next) => {
    status = { ...status, ...next, since: new Date().toISOString() }
    onStatus(status)
  }

  const send = (payload) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(payload))
  }

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  /**
   * A missing acknowledgement signals a dead connection the operating system
   * still believes open. Without this check, the bot would stay silent until
   * the next restart.
   */
  const startHeartbeat = (intervalMs) => {
    stopHeartbeat()
    acknowledged = true
    const beat = () => {
      if (!acknowledged) {
        logger.warn('discord: no acknowledgement, connection considered dead')
        closeSocket(4000)
        return
      }
      acknowledged = false
      send({ op: OP.HEARTBEAT, d: sequence })
    }
    // The first heartbeat is offset at random within the interval, as Discord
    // asks: without that, every bot in the world beats together.
    setTimeout(() => {
      if (stopped) return
      beat()
      heartbeat = setInterval(beat, intervalMs)
      heartbeat.unref?.()
    }, Math.floor(intervalMs * Math.random()))
  }

  const closeSocket = (code = 1000) => {
    stopHeartbeat()
    if (!socket) return
    const previous = socket
    socket = null
    try {
      previous.close(code)
    } catch {
      /* already closed */
    }
  }

  const scheduleReconnect = (reason) => {
    if (stopped || reconnectTimer) return
    attempts += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS)
    setStatus({ state: 'reconnecting', error: reason })
    logger.info(`discord: reconnecting in ${Math.round(delay / 1000)} s (${reason})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    reconnectTimer.unref?.()
  }

  function connect() {
    if (stopped) return
    stopHeartbeat()

    // `resume_gateway_url` is specific to the session: going back to it is what
    // distinguishes a resumption from a full reconnection.
    const url = sessionId && resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : GATEWAY_URL
    setStatus({ state: 'connecting', error: null })

    try {
      socket = open(url)
    } catch (err) {
      scheduleReconnect(`connection failed: ${err.message}`)
      return
    }

    socket.onopen = () => {
      if (sessionId && sequence !== null) {
        send({ op: OP.RESUME, d: { token, session_id: sessionId, seq: sequence } })
      }
      // Otherwise IDENTIFY goes out on receiving HELLO, not before: Discord
      // announces the heartbeat interval first.
    }

    socket.onmessage = (event) => {
      let payload
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (payload.s !== null && payload.s !== undefined) sequence = payload.s
      handle(payload)
    }

    socket.onerror = () => {
      // `onclose` always follows: that is where the decision is made.
    }

    socket.onclose = (event) => {
      stopHeartbeat()
      socket = null
      if (stopped) return

      const fatal = FATAL_CLOSE[event.code]
      if (fatal) {
        setStatus({ state: 'failed', error: fatal })
        logger.error(`discord: ${fatal} (code ${event.code}) — the bot will not be restarted`)
        return
      }
      // 4007 and 4009 invalidate the session: resuming would fail in a loop.
      if (event.code === 4007 || event.code === 4009) {
        sessionId = null
        sequence = null
      }
      scheduleReconnect(`close ${event.code}`)
    }
  }

  function handle(payload) {
    switch (payload.op) {
      case OP.HELLO:
        startHeartbeat(payload.d.heartbeat_interval)
        if (!sessionId) {
          send({
            op: OP.IDENTIFY,
            d: {
              token,
              intents: INTENTS,
              properties: { os: process.platform, browser: 'rota', device: 'rota' },
            },
          })
        }
        break

      case OP.HEARTBEAT:
        // Discord may ask for one off-cadence.
        send({ op: OP.HEARTBEAT, d: sequence })
        break

      case OP.HEARTBEAT_ACK:
        acknowledged = true
        break

      case OP.RECONNECT:
        closeSocket(4000)
        scheduleReconnect('reconnect requested by Discord')
        break

      case OP.INVALID_SESSION:
        // `d` says whether the session is resumable. Otherwise, start over.
        if (!payload.d) {
          sessionId = null
          sequence = null
        }
        closeSocket(4000)
        scheduleReconnect('session invalidated')
        break

      case OP.DISPATCH:
        dispatch(payload)
        break

      default:
        break
    }
  }

  function dispatch(payload) {
    if (payload.t === 'READY') {
      attempts = 0
      sessionId = payload.d.session_id
      resumeUrl = payload.d.resume_gateway_url
      botUser = payload.d.user
      // READY enumerates the bot's servers. A token holds for the application,
      // not for a server: a bot never invited connects perfectly and never hears
      // anything. Saying so here saves looking elsewhere.
      const guilds = payload.d.guilds?.length ?? 0
      setStatus({ state: 'connected', error: null, user: botUser?.username ?? null, guilds })
      logger.info(`discord: connected as ${botUser?.username} (${guilds} server(s))`)
      if (guilds === 0) {
        logger.warn('discord: the bot is in no server — invite it from the OAuth2 URL of your application')
      }
      return
    }
    if (payload.t === 'RESUMED') {
      attempts = 0
      setStatus({ state: 'connected', error: null })
      logger.info('discord: session resumed')
      return
    }
    if (payload.t === 'MESSAGE_CREATE') onMessage(payload.d)
  }

  return {
    start() {
      if (!stopped && socket) return
      stopped = false
      attempts = 0
      connect()
    },

    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      closeSocket(1000)
      setStatus({ state: 'stopped', error: null })
    },

    status: () => status,
    botUserId: () => botUser?.id ?? null,
  }
}

module.exports = { createGateway, OP, INTENTS, FATAL_CLOSE, GATEWAY_URL }
