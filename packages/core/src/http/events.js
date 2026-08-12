'use strict'

// The event stream, as server-sent events.
//
// The application never needed one: it had IPC, which is a channel that only
// exists because the renderer and the engine share a process. Anything that
// does not — a command line following a run, a window driving a daemon on
// another machine — needs this instead.
//
// SSE rather than a WebSocket: everything here travels one way, from the engine
// outwards, and the one thing that does not (a question an agent asks) is
// answered by an ordinary POST. A WebSocket would buy a return path we would
// have to secure separately, and cost a protocol upgrade that every proxy in
// between has an opinion about.
//
// The stream carries no history. A client that attaches learns the state now,
// and what happens next; it does not learn what it missed. Replaying would mean
// deciding how much to keep, and the answer for an execution's output is
// "already in the history, addressed by identifier".

// Long enough to be quiet, short enough to beat the idle timeout of anything
// that might sit in between.
const KEEPALIVE_MS = 25_000

/**
 * Holds the attached clients and writes to them.
 *
 * @returns {{attach: Function, publish: Function, count: Function, closeAll: Function}}
 */
function createEventStreams({ onEmpty = () => {} } = {}) {
  /** @type {Set<{response: object, timer: object}>} */
  const clients = new Set()

  function write(client, chunk) {
    try {
      client.response.write(chunk)
    } catch {
      // A client that went away mid-write is a client that has gone away; the
      // close handler will do the tidying.
      detach(client)
    }
  }

  function detach(client) {
    if (!clients.delete(client)) return
    clearInterval(client.timer)
    try {
      client.response.end()
    } catch {
      // Already closed by the other end, which is the usual way this happens.
    }
    // An interface is attached for exactly as long as its connection lives.
    // When the last one goes, whatever was waiting on it should be told now
    // rather than left to time out.
    if (clients.size === 0) onEmpty()
  }

  return {
    /**
     * Takes over a response and keeps it open. The caller has already decided
     * this request is allowed to be here.
     *
     * @param {object} request
     * @param {object} response
     * @param {{initial?: () => object}} [options] what to send before anything
     *   happens, so a client that attaches mid-flight is not blind until the
     *   next event.
     */
    attach(request, response, { initial = null } = {}) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Nagle would hold a small event back waiting for company.
        'x-accel-buffering': 'no',
      })
      request.socket?.setNoDelay?.(true)

      const client = { response, timer: null }
      // A comment line: legal SSE, ignored by every client, and enough to keep
      // an idle connection from being reaped as dead.
      client.timer = setInterval(() => write(client, ': keep-alive\n\n'), KEEPALIVE_MS)
      client.timer.unref?.()
      clients.add(client)

      request.on('close', () => detach(client))
      response.on('error', () => detach(client))

      write(client, ': attached\n\n')
      if (initial) {
        for (const [event, data] of Object.entries(initial())) {
          write(client, format(event, data))
        }
      }
      return { detach: () => detach(client) }
    },

    /** Sends one event to everyone attached. Cheap when nobody is. */
    publish(event, data) {
      if (clients.size === 0) return
      const chunk = format(event, data)
      for (const client of [...clients]) write(client, chunk)
    },

    count: () => clients.size,

    closeAll() {
      for (const client of [...clients]) detach(client)
    },
  }
}

/**
 * One SSE frame. The payload is JSON on a single line: a newline inside it would
 * end the frame, and the specification's answer — one `data:` per line — buys
 * nothing when the reader is going to `JSON.parse` the lot anyway.
 */
function format(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`
}

module.exports = { createEventStreams, format, KEEPALIVE_MS }
