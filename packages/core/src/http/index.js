'use strict'

// Local HTTP server.
//
// Three flags, and they stack on purpose. The first opens the port; the second
// exposes the API, which drives everything; the third exposes the webhook, which
// starts only the jobs declaring they expect one. Separating them lets a webhook
// address be given to a third-party service without opening the rest to it, and
// lets the API stay yours.
//
// The default port, 47823, is nothing well known: a common port would be taken,
// or worse, would answer in place of what you meant to reach.
//
// The plumbing lives here, the answers in router.js. It is the same separation
// as between the Discord gateway and its commands, and for the same reason: what
// decides is testable without opening a socket.

const http = require('node:http')

const logger = require('../lib/logger')
const { createEventStreams } = require('./events')
const { handle, resolveServerToken } = require('./router')
const { presentedToken, tokenMatches } = require('./auth')

// A request body is JSON, and nothing else. The bound stops a malformed — or
// hostile — upload from holding the main process's memory.
const MAX_BODY_BYTES = 1_048_576

/**
 * @param {object} deps store, scheduler, runner, state, history, chat, setPaused
 * @param {(status: object) => void} [deps.onStatusChange]
 */
function createHttpServer(deps) {
  const { store, onStatusChange = () => {}, snapshot = null, ui = null } = deps

  const streams = createEventStreams({ onEmpty: () => ui?.closeAll?.() })

  let server = null
  let signature = null
  let status = { state: 'disabled', error: null, url: null }

  const setStatus = (next) => {
    status = { ...status, ...next }
    onStatusChange(status)
  }

  /** What, when it changes, forces the port to be reopened. */
  function currentSignature() {
    const { enabled, listen, port, token } = store.getConfig().http
    // No token, no server: validation already refuses it, this is the net. What
    // a port with no password would open cannot be taken back.
    if (!enabled || !token) return null
    return `${listen} ${port}`
  }

  async function onRequest(request, response) {
    const send = ({ status: code, body, contentType }) => {
      // Everything is JSON except the reading page, the one thing here that a
      // browser displays rather than a program reads.
      const payload = contentType ? String(body) : JSON.stringify(body)
      response.writeHead(code, {
        'content-type': contentType ?? 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        // Nothing this API returns is meant to be read by a web page.
        'cache-control': 'no-store',
      })
      response.end(payload)
    }

    let url
    try {
      url = new URL(request.url, 'http://localhost')
    } catch {
      send({ status: 400, body: { error: 'malformed URL' } })
      return
    }

    // The stream is handled here rather than in the router, for the one reason
    // the router cannot handle it: it does not answer and finish, it takes the
    // response over and keeps it. Everything else about it — the flag, then the
    // token — is decided exactly as the router decides it.
    if (request.method === 'GET' && (url.pathname === '/api/events' || url.pathname === '/api/v1/events')) {
      const config = store.getConfig().http
      if (!config.apiEnabled) {
        send({ status: 404, body: { error: 'not found' } })
        return
      }
      const expected = resolveServerToken(store, config)
      if (!tokenMatches(presentedToken(request.headers), expected)) {
        send({ status: 401, body: { error: 'unauthorised' } })
        return
      }
      streams.attach(request, response, {
        initial: () => (snapshot ? { state: snapshot() } : {}),
      })
      return
    }

    let body = null
    try {
      body = await readJsonBody(request)
    } catch (err) {
      send({ status: err.status ?? 400, body: { error: err.message } })
      return
    }

    try {
      const result = await handle(
        {
          method: request.method,
          pathname: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          body,
        },
        deps,
      )
      send(result)
    } catch (err) {
      // A Rota defect: it goes to the logs whole, and to the caller reduced
      // to what they can do with it.
      logger.error(`http: ${request.method} ${url.pathname} failed`, err)
      send({ status: 500, body: { error: 'internal error' } })
    }
  }

  return {
    /** Opens, closes or reopens the port according to the settings. Idempotent. */
    sync() {
      const next = currentSignature()
      if (next === signature) return
      signature = next

      // Attached streams hold the socket open: closing the server without
      // hanging up on them first would wait for clients that have every reason
      // to stay.
      streams.closeAll()
      server?.close()
      server = null

      if (next === null) {
        setStatus({ state: 'disabled', error: null, url: null })
        return
      }

      const { listen, port } = store.getConfig().http
      server = http.createServer((request, response) => {
        onRequest(request, response).catch((err) => logger.error('http: request', err))
      })

      server.on('error', (err) => {
        // The common case is a port already taken. Saying so in the settings
        // beats letting a server that listens to nothing pass for active.
        const error = err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message
        logger.error(`http: ${error}`)
        setStatus({ state: 'failed', error, url: null })
        server?.close()
        server = null
        signature = null
      })

      server.listen(port, listen, () => {
        // The port actually obtained, not the one asked for: they differ when 0
        // is requested, and the address shown must be the one that answers.
        const bound = server.address()?.port ?? port
        const url = `http://${listen}:${bound}`
        logger.info(`http: listening on ${url}`)
        setStatus({ state: 'listening', error: null, url })
      })
    },

    stop() {
      // Before closing the server: a held-open stream would otherwise keep the
      // socket alive and `close()` would wait for a client that has no reason
      // to hang up.
      streams.closeAll()
      server?.close()
      server = null
      signature = null
      setStatus({ state: 'disabled', error: null, url: null })
    },

    status: () => status,

    /** Sends an event to everyone attached to /api/events. */
    publish: (event, data) => streams.publish(event, data),

    /** How many clients are attached — so an expensive payload is only built
     *  when there is somebody to send it to. */
    streamCount: () => streams.count(),
  }
}

/**
 * JSON body of a request, or null if there is none.
 *
 * An empty body is not an error: most routes expect none, and requiring "{}" on
 * a POST with no data would break the first `curl -X POST` everybody writes.
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('body too large')
        error.status = 413
        request.destroy()
        reject(error)
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('malformed JSON body'))
      }
    })

    request.on('error', reject)
  })
}

module.exports = { createHttpServer, MAX_BODY_BYTES }
