'use strict'

// MCP connectors of an agent job.
//
// Every declared connector is opened at the start of the execution, its tool
// inventory is requested, and each becomes an ordinary agent tool — same shape,
// same transcript, same iteration counter.
//
// Two decisions shape the rest:
//
//   * **Names are prefixed** with the connector's. Two servers will happily
//     expose a `search` or a `read`, and the model's API has only a flat
//     namespace. `github__search` also says where the call goes.
//   * **A connector that refuses to open does not fail the execution.** It is
//     reported in the transcript and the others carry on: an auxiliary server
//     being unavailable must not take down a job that did not depend on it.
//
// On the sandbox: a stdio server is a process started on the host, outside the
// container. That is not a breach but a choice of perimeter — the user declares
// their servers in the job definition, as they declare their model's address.
// The sandbox contains what the agent decides, not what the user put at its
// disposal.

const logger = require('../../lib/logger')
const { resolveHeaders, resolveReferences } = require('../../config/env')
const { createMcpClient } = require('./client')
const { createHttpTransport } = require('./transport-http')
const { createStdioTransport } = require('./transport-stdio')

const SEPARATOR = '__'

// The model's API bounds function names to 64 characters, restricted charset.
const MAX_NAME = 64
const NAME_SAFE = /[^a-zA-Z0-9_-]/g

/** Name exposed to the model, unique and acceptable to the API. */
function toolName(connector, tool) {
  const clean = tool.replace(NAME_SAFE, '_')
  return `${connector}${SEPARATOR}${clean}`.slice(0, MAX_NAME)
}

/** Resolves the ${VARIABLE}s of a set of values, or says which are missing. */
function resolveValues(values, env, field) {
  const resolved = {}
  const missing = []
  for (const [key, value] of Object.entries(values)) {
    const result = resolveReferences(value, env)
    if (result.ok) resolved[key] = result.value
    else missing.push(...result.missing)
  }
  return missing.length > 0
    ? { ok: false, error: `${field}: missing variable(s): ${[...new Set(missing)].join(', ')}` }
    : { ok: true, values: resolved }
}

/**
 * Opens a connector and returns its tools.
 *
 * @param {object} connector validated definition
 * @param {object} options
 * @returns {Promise<{ok: true, tools: object[], close: Function, server: object} | {ok: false, error: string}>}
 */
async function connect(connector, { env, workspace, fetchImpl, signal }) {
  const timeoutMs = connector.timeoutSeconds * 1000

  let transport
  try {
    if (connector.transport === 'stdio') {
      const environment = resolveValues(connector.environment, env, 'environment')
      if (!environment.ok) return { ok: false, error: environment.error }

      transport = createStdioTransport({
        command: connector.command,
        args: connector.args,
        environment: environment.values,
        cwd: workspace,
      })
    } else {
      const headers = resolveHeaders(connector.headers, env)
      if (!headers.ok) return { ok: false, error: headers.errors.join(' | ') }

      transport = createHttpTransport({ url: connector.url, headers: headers.headers, fetchImpl })
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }

  const client = createMcpClient({ transport, timeoutMs })

  try {
    const server = await client.initialize({ signal })
    const { tools, truncated } = await client.listTools({ signal })

    const allow = connector.tools.allow
    const kept = tools.filter((tool) => allow.length === 0 || allow.includes(tool.name))

    return {
      ok: true,
      server,
      truncated,
      close: () => transport.close(),
      tools: kept.map((tool) => describe(connector, tool, client)),
    }
  } catch (err) {
    // The process's error output often says what the failure does not: module
    // not found, token refused, Node version too old.
    const journal = transport.stderr?.()
    await transport.close().catch(() => {})
    return { ok: false, error: err.message + (journal ? `\n${journal}` : '') }
  }
}

/** Wraps an MCP tool in the shape the loop expects. */
function describe(connector, tool, client) {
  return {
    name: toolName(connector.name, tool.name),
    description:
      `[${connector.name}] ${tool.description ?? tool.title ?? 'MCP tool with no description.'}`,
    // The schema comes from the server: it is passed on as it is, otherwise the
    // model would call blind.
    parameters:
      tool.inputSchema && tool.inputSchema.type === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    async run(args, ctx) {
      try {
        const result = await client.callTool(tool.name, args, { signal: ctx.signal })
        // An execution error returned by the server is not a breakdown: it is
        // returned to the model as such, and it is up to the model to draw the
        // consequences.
        return result.ok
          ? { ok: true, summary: `${connector.name}/${tool.name}`, content: result.text }
          : { ok: false, error: result.text }
      } catch (err) {
        return { ok: false, error: `${connector.name} : ${err.message}` }
      }
    },
  }
}

/**
 * Opens every declared connector.
 *
 * @returns {Promise<{tools: object[], notices: string[], close: Function}>}
 */
async function connectAll(connectors, options) {
  const tools = []
  const notices = []
  const closers = []

  for (const connector of connectors) {
    if (connector.enabled === false) continue

    const result = await connect(connector, options)
    if (!result.ok) {
      // An auxiliary server being unavailable must not take down a job that did
      // not depend on it: we say so, and carry on.
      notices.push(`MCP connector "${connector.name}" unavailable: ${result.error}`)
      logger.warn(`mcp: ${connector.name} unavailable — ${result.error}`)
      continue
    }

    closers.push(result.close)
    tools.push(...result.tools)
    if (result.truncated) {
      notices.push(`MCP connector "${connector.name}": tool list truncated`)
    }
    logger.info(
      `mcp: ${connector.name} connected (${result.server.serverInfo?.name ?? 'unnamed'}), ` +
        `${result.tools.length} tool(s)`,
    )
  }

  return {
    tools,
    notices,
    async close() {
      await Promise.all(closers.map((closer) => closer().catch(() => {})))
    },
  }
}

module.exports = { connect, connectAll, toolName, describe, SEPARATOR, MAX_NAME }
