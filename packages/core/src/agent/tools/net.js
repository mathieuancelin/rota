'use strict'

// HTTP calls.
//
// A list of allowed hosts, empty by default, leaves the choice open: a watch
// agent must be able to query whatever its prompt names. It becomes useful as
// soon as you want an agent to talk only to what you know.

const MAX_BODY_PREVIEW = 400

/**
 * A host starting with a dot covers its subdomains: ".example.com" allows
 * "api.example.com" and "example.com", but not "notexample.com".
 */
function hostAllowed(hostname, allowHosts) {
  if (allowHosts.length === 0) return true
  return allowHosts.some((allowed) => {
    const pattern = allowed.toLowerCase()
    const host = hostname.toLowerCase()
    if (pattern.startsWith('.')) return host === pattern.slice(1) || host.endsWith(pattern)
    return host === pattern
  })
}

const fetchTool = {
  name: 'fetch',
  description:
    "Performs an HTTP call and returns the status, the headers and the response body. " +
    "The body is truncated beyond the configured limit.",
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL, http or https.' },
      method: { type: 'string', description: 'HTTP method. Default: GET.' },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: "Request headers.",
      },
      body: { type: 'string', description: "Request body, for POST, PUT or PATCH." },
    },
    required: ['url'],
  },
  async run({ url, method = 'GET', headers = {}, body }, ctx) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, error: `invalid URL: ${url}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'only http and https are accepted' }
    }

    const { allowHosts, maxResponseBytes } = ctx.config.fetch
    if (!hostAllowed(parsed.hostname, allowHosts)) {
      return {
        ok: false,
        error: `host ${parsed.hostname} is not allowed for this job (see tools.fetch.allowHosts)`,
      }
    }

    let response
    try {
      response = await ctx.fetchImpl(parsed.toString(), {
        method: method.toUpperCase(),
        headers,
        body: body ?? undefined,
        signal: ctx.signal,
        redirect: 'follow',
      })
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, error: 'call interrupted' }
      return { ok: false, error: `call failed: ${err.message}` }
    }

    let text = ''
    let truncated = false
    try {
      const buffer = Buffer.from(await response.arrayBuffer())
      truncated = buffer.length > maxResponseBytes
      text = buffer.subarray(0, maxResponseBytes).toString('utf8')
    } catch (err) {
      text = `[unreadable body: ${err.message}]`
    }

    const shown = Object.entries(Object.fromEntries(response.headers))
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n')

    return {
      ok: true,
      summary: `${method.toUpperCase()} ${parsed.host}${parsed.pathname} → ${response.status}`,
      content: [
        `HTTP ${response.status} ${response.statusText}`,
        shown,
        '',
        text,
        truncated ? `\n[… body truncated at ${maxResponseBytes} bytes]` : '',
      ]
        .join('\n')
        .trimEnd(),
    }
  },
}

module.exports = { fetchTool, hostAllowed, MAX_BODY_PREVIEW }
