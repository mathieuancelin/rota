'use strict'

// Sandbox of an agent job.
//
// The sandbox of the other types wraps a single command in a `docker run --rm`:
// the container is born and dies with it. An agent, on the other hand, chains
// dozens of commands that must see one another — a directory created, a package
// installed, an intermediate file. Each in its own disposable container, it
// would start from scratch every time.
//
// Hence a container open for the duration of the execution, and one `docker
// exec` per command. The rest does not change: same mounts, same network off by
// default, same allowlisted environment.

const { containerName, sandboxEnv, WORKDIR_MOUNT } = require('../runner/sandbox')

// "sleep infinity" does not exist everywhere — BusyBox does not know it. An
// explicit bound works on every image, and in any case the execution timeout
// arrives well before those sixty-eight years.
const KEEP_ALIVE_SECONDS = '2147483647'

/**
 * Opens the execution's container.
 *
 * `--entrypoint` short-circuits the image's entry point: `oven/bun`'s starts
 * `bun`, which would not know what to do with `sleep`. Commands then go through
 * `docker exec`, which does not borrow it either.
 */
function buildStartCommand({ job, dockerPath, executionId, workspace, environment = {} }) {
  const { sandbox } = job.execution
  const args = ['run', '-d', '--rm', '--name', containerName(executionId)]

  args.push('-v', `${workspace}:${WORKDIR_MOUNT}`, '-w', WORKDIR_MOUNT)
  if (!sandbox.network) args.push('--network', 'none')
  for (const [key, value] of Object.entries(environment)) {
    args.push('-e', `${key}=${value}`)
  }
  args.push('--entrypoint', 'sleep', sandbox.image, KEEP_ALIVE_SECONDS)

  return { command: dockerPath, args }
}

/** One of the agent's commands, in the already-open container. */
function buildExecCommand({ dockerPath, executionId, command, args = [], environment = {} }) {
  const execArgs = ['exec', '-w', WORKDIR_MOUNT]
  for (const [key, value] of Object.entries(environment)) {
    execArgs.push('-e', `${key}=${value}`)
  }
  execArgs.push(containerName(executionId), command, ...args)

  return { command: dockerPath, args: execArgs }
}

/**
 * Closing the container.
 *
 * `rm -f` rather than `kill`: `--rm` only cleans up a container that stops by
 * itself, and a daemon restarted at the wrong moment would otherwise leave a
 * named container that would stop the next execution from starting.
 */
function buildRemoveCommand(dockerPath, executionId) {
  return { command: dockerPath, args: ['rm', '-f', containerName(executionId)] }
}

module.exports = {
  buildStartCommand,
  buildExecCommand,
  buildRemoveCommand,
  containerName,
  sandboxEnv,
  KEEP_ALIVE_SECONDS,
}
