'use strict'

// Talking to a running engine.
//
// The address and the token both come from the configuration directory by
// default. That is the whole point: the application generated a token and wrote
// it down, and there is no reason to ask anybody to keep a second copy of it.
// `--url` and `--token` override, and `ROTA_TOKEN` sits between the two —
// an environment variable beats a file, an argument beats everything.

const { loadEnv, resolveReferences } = require('@rota/core')

class ApiError extends Error {
  constructor(message, { status = null, hint = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.hint = hint
  }
}

/**
 * Where to reach the engine, and with what.
 *
 * @param {object} store a loaded ConfigStore
 * @param {{url?: string, token?: string, env?: object}} overrides
 */
function resolveEndpoint(store, { url = null, token = null, env = process.env } = {}) {
  const http = store.getConfig().http

  if (!url && !http.enabled) {
    throw new ApiError('the HTTP server is disabled in this configuration', {
      hint: 'enable it in the settings, or pass --url if it runs somewhere else',
    })
  }
  if (!url && !http.apiEnabled) {
    throw new ApiError('the HTTP server is on, but the API is not', {
      hint: 'the API is a separate switch from the webhook: turn it on in the settings',
    })
  }

  const base = url ?? `http://${normaliseHost(http.listen)}:${http.port}`
  const resolved = token ?? env.ROTA_TOKEN ?? env.TICKTRAY_TOKEN ?? resolveConfiguredToken(store, http)

  if (!resolved) {
    throw new ApiError('no token to present', {
      hint: 'set one in the settings, or pass --token / $ROTA_TOKEN',
    })
  }

  return { base: base.replace(/\/$/, ''), token: resolved }
}

/**
 * 0.0.0.0 is an address to listen on, not one to call. A client that dialled it
 * would reach something on some machines and nothing on others.
 */
function normaliseHost(listen) {
  if (listen === '0.0.0.0' || listen === '::') return '127.0.0.1'
  return listen.includes(':') ? `[${listen}]` : listen
}

function resolveConfiguredToken(store, http) {
  if (!http.token) return null
  const resolved = resolveReferences(http.token, loadEnv(store.paths.envFile))
  if (!resolved.ok) {
    throw new ApiError(`the configured token references ${resolved.missing.join(', ')}, which .env does not define`, {
      hint: 'define it in the configuration directory’s .env, or pass --token',
    })
  }
  return resolved.value
}

function createClient({ base, token }) {
  const headers = { authorization: `Bearer ${token}` }

  async function request(method, path, body = null) {
    let response
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      // The overwhelmingly common case, and the one worth a sentence: nothing is
      // listening. Saying "fetch failed" would send somebody to their network
      // settings for what is usually a daemon that is not running.
      throw new ApiError(`no answer from ${base}`, {
        hint: `is the engine running? (${err.cause?.code ?? err.message})`,
      })
    }

    if (response.status === 401) {
      throw new ApiError('the token was refused', {
        status: 401,
        hint: 'it is the one in config.json unless --token or $ROTA_TOKEN says otherwise',
      })
    }
    if (response.status === 404) {
      throw new ApiError('not found', {
        status: 404,
        hint: 'either the identifier does not exist, or the API is switched off',
      })
    }

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(payload?.error ?? `the engine answered ${response.status}`, {
        status: response.status,
      })
    }
    return payload
  }

  return {
    base,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),

    /**
     * Reads /api/events until the caller stops caring.
     *
     * Hand-rolled rather than an EventSource polyfill: the format is four lines
     * and a blank one, and a dependency that parses it would still need
     * teaching about the bearer token.
     *
     * @param {(event: {event: string, data: any}) => void} onEvent
     * @param {AbortSignal} [signal]
     */
    async stream(onEvent, signal) {
      let response
      try {
        response = await fetch(`${base}/api/events`, { headers, signal })
      } catch (err) {
        if (err.name === 'AbortError') return
        throw new ApiError(`no answer from ${base}`, {
          hint: `is the engine running? (${err.cause?.code ?? err.message})`,
        })
      }

      if (response.status === 401) {
        throw new ApiError('the token was refused', { status: 401 })
      }
      if (!response.ok) {
        throw new ApiError(`the engine answered ${response.status}`, { status: response.status })
      }

      const decoder = new TextDecoder()
      let buffer = ''

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })

        // Frames are separated by a blank line; anything after the last one is
        // an incomplete frame and waits for more bytes.
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseFrame(frame)
          if (parsed) onEvent(parsed)
          boundary = buffer.indexOf('\n\n')
        }
      }
    },
  }
}

/** @returns {{event: string, data: any}|null} null for keep-alive comments. */
function parseFrame(frame) {
  let event = 'message'
  const data = []

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }

  if (data.length === 0) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) }
  } catch {
    return { event, data: data.join('\n') }
  }
}

module.exports = { createClient, resolveEndpoint, parseFrame, normaliseHost, ApiError }
