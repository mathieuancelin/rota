'use strict'

// Building the `docker` commands of an agent job.
//
// As with the sandbox of the other types, no container is started: what reads
// back and can be reasoned about is what is asked of the daemon.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildStartCommand,
  buildExecCommand,
  buildRemoveCommand,
  containerName,
  sandboxEnv,
} = require('../src/agent/sandbox')
const { validateJob } = require('../src/config/validate')

const EXECUTION_ID = '0198f8a8-f477-7db7-8a6e-f13d409ab320'
const DOCKER = '/usr/local/bin/docker'
const WORKSPACE = '/Users/moi/.config/rota/agents/demo'

const makeJob = (sandbox = {}, runner = {}) => {
  const result = validateJob({
    id: 'demo',
    name: 'Demo',
    triggers: [{ type: 'interval', every: 5, unit: 'minutes' }],
    runner: { type: 'agent', agent: { prompt: 'x', model: 'm' }, ...runner },
    execution: { sandbox: { enabled: true, ...sandbox } },
  })
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

const start = (job, environment) =>
  buildStartCommand({
    job,
    dockerPath: DOCKER,
    executionId: EXECUTION_ID,
    workspace: WORKSPACE,
    environment,
  })

test('the container is opened detached, named, and stays alive', () => {
  const { command, args } = start(makeJob())

  assert.equal(command, DOCKER)
  assert.deepEqual(args, [
    'run',
    '-d',
    '--rm',
    '--name',
    `rota-${EXECUTION_ID}`,
    '-v',
    `${WORKSPACE}:/workspace`,
    '-w',
    '/workspace',
    '--network',
    'none',
    '--entrypoint',
    'sleep',
    'oven/bun:1',
    '2147483647',
  ])
})

// "sleep infinity" does not exist everywhere — BusyBox does not know it.
test('the sleep duration is a number, understood by every image', () => {
  const args = start(makeJob()).args
  assert.match(args.at(-1), /^\d+$/)
})

// oven/bun's entry point starts bun, which would not know what to do with sleep.
test("the image's entrypoint is short-circuited", () => {
  const args = start(makeJob()).args
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'sleep')
})

test('the network stays open when the job asks for it', () => {
  assert.equal(start(makeJob({ network: true })).args.includes('--network'), false)
})

test("the job's variables are passed to the container", () => {
  const job = makeJob({}, { environment: { TOKEN: 'abc' } })
  const args = start(job, sandboxEnv(job, { executionId: EXECUTION_ID }, {})).args

  assert.ok(args.includes('TOKEN=abc'))
  assert.ok(args.includes(`ROTA_EXECUTION_ID=${EXECUTION_ID}`))
  assert.ok(args.includes('ROTA_JOB_ID=demo'))
  assert.equal(args.some((arg) => arg.startsWith('SSH_AUTH_SOCK=')), false, "l'agent SSH ne suit pas")
})

test('a command goes through docker exec, in the mounted directory', () => {
  const { command, args } = buildExecCommand({
    dockerPath: DOCKER,
    executionId: EXECUTION_ID,
    command: 'sh',
    args: ['-c', 'ls | head -3'],
  })

  assert.equal(command, DOCKER)
  assert.deepEqual(args, [
    'exec',
    '-w',
    '/workspace',
    `rota-${EXECUTION_ID}`,
    'sh',
    '-c',
    'ls | head -3',
  ])
})

// `--rm` only cleans up a container that stops by itself: a named container left
// behind would stop the next execution from starting.
test('closing forces the removal', () => {
  assert.deepEqual(buildRemoveCommand(DOCKER, EXECUTION_ID), {
    command: DOCKER,
    args: ['rm', '-f', `rota-${EXECUTION_ID}`],
  })
})

test("the container's name is the engine's own", () => {
  assert.equal(containerName(EXECUTION_ID), `rota-${EXECUTION_ID}`)
})
