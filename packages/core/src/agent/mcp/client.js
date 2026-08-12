'use strict'

// MCP client: handshake, tool inventory, tool call.
//
// Independent of the transport — that is what allows the protocol to be tested
// without starting a process or opening a connection.
//
// One point deserves saying because it is easily missed: MCP has **two** ways of
// reporting an error. A protocol error arrives in the JSON-RPC `error` field —
// unknown tool, invalid arguments. An execution error arrives in a perfectly
// valid result, with `isError: true`. Confusing the two means either swallowing
// real failures, or treating an exceeded quota as a connection breakdown.

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'rota', title: 'Rota', version: '0.1.0' }

// A server may expose hundreds: beyond that, the list would eat the model's
// context without it being able to do anything with them.
const MAX_TOOLS = 64
const MAX_PAGES = 20

/**
 * @param {object} options
 * @param {object} options.transport request/notify/close
 * @param {number} options.timeoutMs
 */
function createMcpClient({ transport, timeoutMs }) {
  let nextId = 1

  async function call(method, params, { signal } = {}) {
    const id = nextId++
    const response = await transport.request(
      { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
      { timeoutMs, signal },
    )

    if (response?.error) {
      const { code, message } = response.error
      throw new Error(`${message ?? 'error'}${code === undefined ? '' : ` (${code})`}`)
    }
    return response?.result ?? {}
  }

  return {
    /**
     * Handshake. The version the server returns may differ from the one asked
     * for: it is the one that counts afterwards, and the one sent in the HTTP header.
     */
    async initialize({ signal } = {}) {
      const result = await call(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          // No roots, no sampling, no elicitation: Rota renders none of these
          // services, and announcing them would make a server that used them
          // fail.
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        { signal },
      )

      transport.setProtocolVersion?.(result.protocolVersion ?? PROTOCOL_VERSION)
      await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, { signal })

      return {
        protocolVersion: result.protocolVersion ?? null,
        serverInfo: result.serverInfo ?? null,
        capabilities: result.capabilities ?? {},
        instructions: result.instructions ?? null,
      }
    },

    /** Inventory, pagination included. */
    async listTools({ signal } = {}) {
      const tools = []
      let cursor
      let truncated = false

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await call('tools/list', cursor ? { cursor } : undefined, { signal })
        for (const tool of result.tools ?? []) {
          if (tools.length >= MAX_TOOLS) {
            truncated = true
            break
          }
          tools.push(tool)
        }
        cursor = result.nextCursor
        if (!cursor || truncated) break
      }

      return { tools, truncated }
    },

    /**
     * Calling a tool.
     * @returns {Promise<{ok: boolean, text: string}>} `ok:false` on isError
     */
    async callTool(name, args, { signal } = {}) {
      const result = await call('tools/call', { name, arguments: args ?? {} }, { signal })
      return { ok: result.isError !== true, text: flatten(result) }
    },
  }
}

/**
 * Reduces a tool result to text.
 *
 * The model's API only carries text: an image or a sound is announced rather
 * than attached, which beats pasting three hundred thousand characters of
 * base64 into the context.
 */
function flatten(result) {
  const parts = []

  for (const item of result.content ?? []) {
    if (item?.type === 'text') parts.push(item.text ?? '')
    else if (item?.type === 'image' || item?.type === 'audio') {
      parts.push(`[${item.type} ${item.mimeType ?? 'unknown'}, not passed through]`)
    } else if (item?.type === 'resource_link') {
      parts.push(`[resource ${item.uri}${item.description ? ` — ${item.description}` : ''}]`)
    } else if (item?.type === 'resource') {
      const resource = item.resource ?? {}
      parts.push(resource.text ?? `[resource ${resource.uri ?? 'no URI'}, not text]`)
    } else if (item) {
      parts.push(`[content of type ${item.type ?? 'unknown'}]`)
    }
  }

  // A server that returns structured content should also serialise it as text,
  // but not all do: with no text, we take the structured form.
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2))
  }

  return parts.join('\n').trim() || '(no content)'
}

module.exports = { createMcpClient, flatten, PROTOCOL_VERSION, CLIENT_INFO, MAX_TOOLS, MAX_PAGES }
