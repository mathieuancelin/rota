'use strict'

// Running a job inside a disposable Docker container.
//
// The principle is to change nothing else: the execution path is not replaced,
// it is wrapped. `spawn` still receives an executable and an argument array, the
// child still runs in its own process group, outputs are collected the same way.
// Only the command changes.
//
// What the container sees of the disk, and nothing else:
//
//   * the script, mounted alone and read-only — it cannot rewrite itself;
//   * the job's working directory, if declared, read-write.
//
// What it does not see, and that is the point: the rest of the disk, the SSH
// agent, the keychain, the host's PATH, HOME. A sandboxed job therefore cannot
// push to a remote repository over SSH — that is the price of the isolation,
// not an oversight.
//
// The network is off by default. "Sandbox" without that cut would not mean
// much, and a job that needs it says so.

const path = require('node:path')

const { buildCommand } = require('./command')

// Mount point of the script, and current directory failing anything else.
const SCRIPT_MOUNT = '/rota'
const WORKDIR_MOUNT = '/workspace'

// Variables handed to the container. Deliberately shorter than the one for a
// normal execution: HOME, USER, TMPDIR and PATH designate host paths that do
// not exist inside, and SSH_AUTH_SOCK a socket we do not mount.
const SANDBOX_ENV_ALLOWLIST = ['LANG', 'LC_ALL', 'TZ']

/** Container name, so that it can be killed if the timeout is exceeded. */
function containerName(executionId) {
  return `rota-${executionId}`
}

/**
 * Wraps a job's command in a `docker run`.
 *
 * @param {object} options
 * @param {object} options.job validated definition
 * @param {string} options.dockerPath resolved docker binary
 * @param {string} options.scriptPath path of the script on the host
 * @param {string|null} options.executionId null for a preview: the container is
 *        then left unnamed, since it will not be started
 * @param {Record<string, string>} options.environment the job's variables
 * @returns {{command: string, args: string[]}}
 */
function buildSandboxCommand({ job, dockerPath, scriptPath, executionId = null, environment = {} }) {
  const { sandbox } = job.execution
  const mountedScript = path.posix.join(SCRIPT_MOUNT, path.basename(scriptPath))

  const args = ['run', '--rm']
  if (executionId) args.push('--name', containerName(executionId))

  args.push('-v', `${scriptPath}:${mountedScript}:ro`)

  const workingDirectory = job.runner.workingDirectory
  if (workingDirectory && sandbox.mountWorkingDirectory) {
    args.push('-v', `${workingDirectory}:${WORKDIR_MOUNT}`, '-w', WORKDIR_MOUNT)
  } else {
    args.push('-w', SCRIPT_MOUNT)
  }

  if (!sandbox.network) args.push('--network', 'none')

  for (const [key, value] of Object.entries(environment)) {
    args.push('-e', `${key}=${value}`)
  }

  args.push(sandbox.image)

  // Inside the container, bun and sh are on the PATH: we do not carry the host's
  // paths over, and the script is designated by its mount point.
  const inner = buildCommand(job, { bunPath: 'bun', scriptPath: mountedScript })
  args.push(inner.command, ...inner.args)

  return { command: dockerPath, args }
}

/**
 * Environment of the container.
 *
 * @param {object} job
 * @param {{executionId: string}} context
 * @param {Record<string, string|undefined>} [source] the host's environment
 */
function sandboxEnv(job, { executionId }, source = process.env) {
  const env = {}
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    if (source[key] != null) env[key] = source[key]
  }
  env.ROTA_JOB_ID = job.id
  env.ROTA_EXECUTION_ID = executionId
  // The same pair of names inside the container as outside it: a job that moves
  // into a sandbox must not discover that its variables were renamed on the way.
  env.TICKTRAY_JOB_ID = job.id
  env.TICKTRAY_EXECUTION_ID = executionId
  return { ...env, ...job.runner.environment }
}

/** Command to force the container to stop, if the timeout is exceeded. */
function buildKillCommand(dockerPath, executionId) {
  return { command: dockerPath, args: ['kill', containerName(executionId)] }
}

module.exports = {
  buildSandboxCommand,
  buildKillCommand,
  sandboxEnv,
  containerName,
  SANDBOX_ENV_ALLOWLIST,
  SCRIPT_MOUNT,
  WORKDIR_MOUNT,
}
