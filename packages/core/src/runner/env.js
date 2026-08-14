'use strict'

// Environment of child processes.
//
// An allowlist, never the main process's environment: that one carries
// everything Electron and the launching shell left in it, including paths and
// tokens that are none of a job's business.
//
// `SSH_AUTH_SOCK` is part of it, and that is not incidental: without it, a
// `git push` to an SSH remote waits for a passphrase that will never come.

const { childPath } = require('./resolve-bun')

const ENV_ALLOWLIST = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SSH_AUTH_SOCK']

// Every variable a job receives is handed to it twice: once under ROTA_ and once
// under the TICKTRAY_ name it had before the rename. Somebody's scripts read
// these, and those scripts are not in this repository — breaking them to tidy up
// our own prefix would be charging them for our decision. The old names are
// deprecated, not supported forever; they cost one line each until they go.
function withLegacyNames(env) {
  const legacy = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('ROTA_')) legacy[`TICKTRAY_${key.slice('ROTA_'.length)}`] = value
  }
  return legacy
}

/**
 * @param {object} job
 * @param {{executionId: string, work?: {id: string, input: object}|null}} context
 *   `work` is the queue item this execution was handed, when it came off one.
 */
function buildEnv(job, { executionId, work = null }) {
  const env = { PATH: childPath() }
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] != null) env[key] = process.env[key]
  }
  // Lets a script correlate its own traces with the history.
  env.ROTA_JOB_ID = job.id
  env.ROTA_EXECUTION_ID = executionId
  // Absent, rather than empty, when the run came from anywhere else: a script
  // tests for the variable to know whether it was handed something to work on.
  if (work) {
    env.ROTA_WORK_ITEM_ID = work.id
    env.ROTA_WORK_INPUT = JSON.stringify(work.input ?? {})
  }
  return { ...env, ...withLegacyNames(env), ...job.runner.environment }
}

/**
 * Environment of the `docker` process itself. The job's variables are not meant
 * for it: they are passed to the container through `-e`, and have no business
 * in the Docker client.
 */
function buildDockerEnv() {
  const env = { PATH: childPath() }
  for (const key of ['HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[key] != null) env[key] = process.env[key]
  }
  return env
}

module.exports = { ENV_ALLOWLIST, buildEnv, buildDockerEnv }
