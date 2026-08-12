'use strict'

// "Streamable HTTP" transport of the MCP protocol.
//
// Every message goes out in its own POST. The answer arrives in two ways — a
// JSON object, or an SSE stream from which the response carrying the right
// identifier must be extracted — and the specification requires the client to
// read both. That is the main trap: a client handling only `application/json`
// works against half the servers and fails against the other half.
//
// Two headers govern the rest:
//
//   * `Mcp-Session-Id`, returned at initialisation by servers that keep a
//     session, to be repeated on every request afterwards;
//   * `MCP-Protocol-Version`, mandatory after negotiation — without it, a
//     server assumes a March 2025 version and may refuse the request.

const { createSseParser } = require('../client')

const ACCEPT = 'application/json, text/event-stream'

/**
 * @param {object} options
 * @param {string} options.url MCP endpoint
 * @param {Record<string, string>} options.headers headers already resolved
 * @param {typeof fetch} [options.fetchImpl]
 */
function createHttpTransport({ url, headers = {}, fetchImpl = fetch }) {
  let sessionId = null
  let protocolVersion = null

  const outgoing = () => ({
    'Content-Type': 'application/json',
    Accept: ACCEPT,
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
    ...headers,
  })

  async function post(message, signal) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: outgoing(),
      body: JSON.stringify(message),
      signal,
    })

    // The server may open a session at initialisation; the header is returned
    // only once, and holds for every subsequent request.
    const given = response.headers.get('mcp-session-id')
    if (given) sessionId = given

    return response
  }

  /** Extracts from an SSE stream the response carrying the expected identifier. */
  async function readStream(response, id) {
    const parser = createSseParser()
    const decoder = new TextDecoder()

    for await (const chunk of response.body) {
      for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
        // The server is entitled to emit requests and notifications before the
        // response: anything not carrying our identifier is ignored.
        if (event.id === id) return event
      }
    }
    throw new Error('stream ended without an answer')
  }

  return {
    async request(message, { timeoutMs, signal }) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

      let response
      try {
        response = await post(message, combined)
      } catch (err) {
        if (err.name === 'TimeoutError') {
          throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)
        }
        if (err.name === 'AbortError') throw new Error('call interrupted')
        throw new Error(`call failed: ${err.cause?.message ?? err.message}`)
      }

      // An expired session is recognised by a 404: the specification asks to
      // start again from an initialisation, which the caller does by reopening
      // the connector. We say so plainly rather than returning "HTTP 404".
      if (response.status === 404 && sessionId) {
        sessionId = null
        throw new Error('session expired on the server side')
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
      }

      const type = response.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream')) return readStream(response, message.id)
      return response.json()
    },

    async notify(message, { signal } = {}) {
      const response = await post(message, signal)
      // 202 expected; any error code deserves reporting, a lost notification
      // leaving the session half initialised.
      if (!response.ok) {
        throw new Error(`notification rejected: HTTP ${response.status}`)
      }
    },

    /** Kept after initialisation, for the header of subsequent requests. */
    setProtocolVersion(version) {
      protocolVersion = version
    },

    sessionId: () => sessionId,
    stderr: () => '',

    async close() {
      if (!sessionId) return
      try {
        // A server is entitled to refuse (405): the session will expire by itself.
        await fetchImpl(url, { method: 'DELETE', headers: outgoing() })
      } catch {
        /* closing must never make an execution fail */
      }
      sessionId = null
    },
  }
}

module.exports = { createHttpTransport, ACCEPT }
