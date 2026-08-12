'use strict'

// Running a command on behalf of an agent.
//
// Same discipline as the rest of the engine: `spawn` receives an executable and
// an argument array, the child runs in its own process group, the output is
// bounded. The difference is that here the caller is a language model: the
// command has not been proofread by a human, and its timeout is a tool's, not
// that of the whole execution.

const { spawn } = require('node:child_process')

const { killGroup } = require('../lib/process')
const { createOutputCollector } = require('../runner/output')

const SIGKILL_GRACE_MS = 3000

/**
 * @param {object} options
 * @param {string} options.command executable
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {Record<string, string>} options.env
 * @param {number} options.timeoutMs
 * @param {number} options.maxBytes bound on each stream
 * @param {AbortSignal} [options.signal] cancellation of the whole execution
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string,
 *   stderr: string, truncated: boolean, timedOut: boolean, aborted: boolean,
 *   error: string|null}>}
 */
function runCommand({ command, args, cwd, env, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) {
      resolve(failure(`launch failed: ${err.message}`))
      return
    }

    const stdout = createOutputCollector({ maxBytes })
    const stderr = createOutputCollector({ maxBytes })
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))

    let timedOut = false
    let aborted = false
    let killTimer = null

    const stop = () => {
      killGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), SIGKILL_GRACE_MS)
      killTimer.unref?.()
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)

    const onAbort = () => {
      aborted = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const settle = (result) => {
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)

      const out = stdout.result()
      const err = stderr.result()
      resolve({
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
        aborted,
        ...result,
      })
    }

    child.on('error', (err) =>
      settle({ exitCode: null, signal: null, error: describeSpawnError(err, command) }),
    )
    child.on('close', (code, closeSignal) =>
      settle({ exitCode: code, signal: closeSignal, error: null }),
    )
  })
}

function failure(error) {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    aborted: false,
    error,
  }
}

function describeSpawnError(err, command) {
  if (err.code === 'ENOENT') return `command not found: ${command}`
  if (err.code === 'EACCES') return `not allowed to run ${command}`
  return err.message
}

module.exports = { runCommand }
