'use strict'

// Where an agent's commands run: the host, or a container.
//
// The loop and the tools ignore which of the two. They call
// `runCommand(command, arguments)` and receive an exit code and outputs; the
// rest is here.

const logger = require('../lib/logger')
const { buildEnv, buildDockerEnv } = require('../runner/env')
const { resolveDocker } = require('../runner/resolve-bun')
const { runCommand } = require('./exec')
const { buildStartCommand, buildExecCommand, buildRemoveCommand, sandboxEnv } = require('./sandbox')

const START_TIMEOUT_MS = 60_000
const REMOVE_TIMEOUT_MS = 15_000

/**
 * @param {object} options
 * @param {object} options.job validated definition
 * @param {string} options.executionId
 * @param {string} options.workspace working directory, already created
 * @param {string|null} [options.dockerPath] configured path, null to resolve
 * @param {() => AbortSignal|undefined} [options.getSignal] signal of the current
 *        turn, read again on every command: a conversation chains several,
 *        each with its own stop button
 * @returns {Promise<{ok: true, environment: object} | {ok: false, error: string}>}
 */
async function createEnvironment({
  job,
  executionId,
  workspace,
  dockerPath = null,
  getSignal = () => undefined,
}) {
  const { system } = job.runner.agent.tools
  const limits = { timeoutMs: system.timeoutSeconds * 1000, maxBytes: system.maxOutputBytes }

  if (!job.execution.sandbox.enabled) {
    const env = buildEnv(job, { executionId })
    return {
      ok: true,
      environment: {
        sandboxed: false,
        describe: () => workspace,
        runCommand: (command, args = []) =>
          runCommand({ command, args, cwd: workspace, env, signal: getSignal(), ...limits }),
        dispose: async () => {},
      },
    }
  }

  const docker = resolveDocker(dockerPath)
  if (!docker.ok) return { ok: false, error: docker.error }

  const containerEnv = sandboxEnv(job, { executionId })
  const dockerEnv = buildDockerEnv()
  const start = buildStartCommand({
    job,
    dockerPath: docker.path,
    executionId,
    workspace,
    environment: containerEnv,
  })

  const started = await runCommand({
    ...start,
    cwd: workspace,
    env: dockerEnv,
    timeoutMs: START_TIMEOUT_MS,
    maxBytes: 8192,
    signal: getSignal(),
  })

  if (started.exitCode !== 0) {
    const detail = started.error ?? started.stderr.trim() ?? ''
    return { ok: false, error: `container could not be started: ${detail || 'docker run failed'}` }
  }

  const remove = buildRemoveCommand(docker.path, executionId)
  let disposed = false

  return {
    ok: true,
    environment: {
      sandboxed: true,
      describe: () => `${job.execution.sandbox.image} (container)`,
      runCommand: (command, args = []) => {
        const exec = buildExecCommand({
          dockerPath: docker.path,
          executionId,
          command,
          args,
          // The variables are already in the container; passing them again on
          // every exec covers the case of an image whose shell resets them.
          environment: job.runner.environment,
        })
        return runCommand({ ...exec, cwd: workspace, env: dockerEnv, signal: getSignal(), ...limits })
      },
      // Never in the cancellation path itself: `signal` is already aborted when
      // we get here, and the cleanup must complete anyway.
      dispose: async () => {
        if (disposed) return
        disposed = true
        const result = await runCommand({
          ...remove,
          cwd: workspace,
          env: dockerEnv,
          timeoutMs: REMOVE_TIMEOUT_MS,
          maxBytes: 4096,
        })
        if (result.exitCode !== 0) {
          logger.warn(`container ${executionId} not cleaned up: ${result.stderr.trim() || result.error}`)
        }
      },
    },
  }
}

module.exports = { createEnvironment }
