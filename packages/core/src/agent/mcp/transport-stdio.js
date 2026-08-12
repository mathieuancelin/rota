'use strict'

// stdio transport of the MCP protocol.
//
// The server is a child process; JSON-RPC messages travel in the clear on its
// standard input and output, one line per message, with no newline inside. The
// specification is explicit on two points that bite in practice:
//
//   * the server must write **nothing** to `stdout` that is not a message —
//     but plenty of them write something at startup anyway, and an unreadable
//     line must not take down the connection;
//   * `stderr` is a log, to be captured or ignored. We keep its tail: that is
//     where a server refusing to start says why.
//
// Shutdown follows the prescribed order: close the input, wait, then SIGTERM,
// then SIGKILL. A server holding a lock or a database is entitled to close
// itself cleanly.

const { spawn } = require('node:child_process')

const logger = require('../../lib/logger')
const { killGroup } = require('../../lib/process')
const { ENV_ALLOWLIST } = require('../../runner/env')
const { childPath } = require('../../runner/resolve-bun')
const { createLiveTail } = require('../../runner/live')

const SHUTDOWN_GRACE_MS = 2000
const SIGKILL_GRACE_MS = 2000

function buildEnv(environment) {
  const env = { PATH: childPath() }
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] != null) env[key] = process.env[key]
  }
  return { ...env, ...environment }
}

/**
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {Record<string, string>} options.environment
 * @param {string} options.cwd
 * @returns {{request: Function, notify: Function, close: Function, stderr: Function}}
 */
function createStdioTransport({ command, args = [], environment = {}, cwd }) {
  let child
  try {
    child = spawn(command, args, {
      cwd,
      env: buildEnv(environment),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (err) {
    throw new Error(`launch failed: ${err.message}`)
  }

  /** @type {Map<number, {resolve: Function, reject: Function, timer: object}>} */
  const pending = new Map()
  const errors = createLiveTail({ maxChars: 4096 })
  let buffer = ''
  let closed = null

  const failAll = (reason) => {
    closed ??= reason
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    pending.clear()
  }

  child.on('error', (err) => failAll(`process failed: ${err.message}`))
  child.on('close', (code, signal) =>
    failAll(`server stopped (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})`),
  )

  child.stderr.on('data', (chunk) => errors.push(chunk))

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue

      let message
      try {
        message = JSON.parse(line)
      } catch {
        // A server chatty on stdout is out of specification, but common: we
        // ignore it rather than break the connection.
        logger.warn(`mcp: unreadable line on stdout — ${line.slice(0, 120)}`)
        continue
      }

      const waiter = pending.get(message.id)
      if (!waiter) continue // server notification, or orphaned response
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
  })

  const write = (message) => {
    if (closed) throw new Error(closed)
    // The specification forbids newlines inside a message: JSON.stringify
    // already escapes them, but the invariant deserves stating.
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  return {
    request(message, { timeoutMs, signal }) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('call interrupted'))
          return
        }
        const timer = setTimeout(() => {
          pending.delete(message.id)
          reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
        timer.unref?.()

        pending.set(message.id, { resolve, reject, timer })
        try {
          write(message)
        } catch (err) {
          pending.delete(message.id)
          clearTimeout(timer)
          reject(err)
        }
      })
    },

    async notify(message) {
      write(message)
    },

    /** Tail of the error output: that is where a server says why it refuses. */
    stderr: () => errors.read().text.trim(),

    async close() {
      failAll('connection closed')
      // The prescribed order: close the input, let it leave, then insist.
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }

      // Already exited — a server not found, for instance. Waiting for a "close"
      // that has already happened would never hand back.
      if (child.exitCode !== null || child.signalCode !== null) return

      await new Promise((resolve) => {
        // This timeout is not decorated with an `unref`: it is short, bounded,
        // and it is what guarantees the shutdown completes.
        const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS)
        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })

      if (child.exitCode === null && child.signalCode === null) {
        killGroup(child, 'SIGTERM')
        // The escalation, on the other hand, is cleanup: it must not hold back
        // the application's shutdown.
        setTimeout(() => killGroup(child, 'SIGKILL'), SIGKILL_GRACE_MS).unref?.()
      }
    },
  }
}

module.exports = { createStdioTransport, buildEnv }
