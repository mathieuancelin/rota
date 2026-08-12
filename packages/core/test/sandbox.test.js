'use strict'

// Building the `docker run` command.
//
// These tests start no container: they check what is asked of the daemon, which
// reads back and can be reasoned about, where a real execution depends on a
// downloaded image and a running daemon.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildSandboxCommand,
  buildKillCommand,
  sandboxEnv,
  containerName,
} = require('../src/runner/sandbox')
const { formatCommand } = require('../src/runner/command')

const SANDBOX = { enabled: true, image: 'oven/bun:1', network: false, mountWorkingDirectory: true }

function job(overrides = {}) {
  return {
    id: 'demo',
    runner: {
      type: 'bun',
      script: '/Users/moi/.config/rota/scripts/demo.js',
      args: [],
      environment: {},
      ...overrides.runner,
    },
    execution: { sandbox: { ...SANDBOX, ...overrides.sandbox } },
  }
}

const build = (definition, options = {}) =>
  buildSandboxCommand({
    job: definition,
    dockerPath: '/usr/local/bin/docker',
    scriptPath: definition.runner.script ?? '/tmp/inline/demo.js',
    executionId: 'exec-1',
    ...options,
  })

// --- shape of the command ------------------------------------------------------

test('the command is a throwaway docker run, never a shell string', () => {
  const { command, args } = build(job())

  assert.equal(command, '/usr/local/bin/docker')
  assert.equal(args[0], 'run')
  assert.ok(args.includes('--rm'))
  assert.ok(Array.isArray(args))
})

test('the container is named after the execution, so it can be killed', () => {
  const { args } = build(job())
  const index = args.indexOf('--name')

  assert.notEqual(index, -1)
  assert.equal(args[index + 1], containerName('exec-1'))
})

test('with no execution identifier, the container is not named', () => {
  // The case of the preview shown by the interface: it will not be started.
  const { args } = build(job(), { executionId: null })
  assert.ok(!args.includes('--name'))
})

test('the script is mounted alone and read-only', () => {
  const { args } = build(job())

  assert.ok(
    args.includes('/Users/moi/.config/rota/scripts/demo.js:/rota/demo.js:ro'),
    args.join(' '),
  )
})

test("bun is the image's, not the host's", () => {
  const { args } = build(job())
  const image = args.indexOf('oven/bun:1')

  assert.deepEqual(args.slice(image + 1), ['bun', 'run', '/rota/demo.js'])
})

test('a shell job uses the interpreter inside the container', () => {
  const definition = job({
    runner: { type: 'shell', interpreter: 'bash', script: '/tmp/scripts/backup.sh' },
  })
  const { args } = build(definition)
  const image = args.indexOf('oven/bun:1')

  assert.deepEqual(args.slice(image + 1), ['bash', '/rota/backup.sh'])
})

test("the job's arguments follow the script, without being concatenated", () => {
  const definition = job({ runner: { args: ['--dry-run', '; rm -rf /'] } })
  const { args } = build(definition)

  assert.deepEqual(args.slice(-2), ['--dry-run', '; rm -rf /'])
})

// --- isolation ------------------------------------------------------------------

test('the network is cut by default', () => {
  const { args } = build(job())
  const index = args.indexOf('--network')

  assert.notEqual(index, -1, 'the sandbox cuts the network')
  assert.equal(args[index + 1], 'none')
})

test('the network can be reopened explicitly', () => {
  const { args } = build(job({ sandbox: { network: true } }))
  assert.ok(!args.includes('--network'))
})

test('the working directory is mounted writable, and becomes the current one', () => {
  const definition = job({ runner: { workingDirectory: '/Users/moi/depot' } })
  const { args } = build(definition)

  assert.ok(args.includes('/Users/moi/depot:/workspace'))
  assert.equal(args[args.indexOf('-w') + 1], '/workspace')
})

test('with no working directory mounted, nothing is writable', () => {
  const definition = job({
    runner: { workingDirectory: '/Users/moi/depot' },
    sandbox: { mountWorkingDirectory: false },
  })
  const { args } = build(definition)

  assert.ok(!args.some((arg) => arg.includes('/Users/moi/depot')))
  assert.equal(args[args.indexOf('-w') + 1], '/rota')
})

test("with no declared directory, the current one is the script's mount point", () => {
  const { args } = build(job())
  assert.equal(args[args.indexOf('-w') + 1], '/rota')
})

// --- environment ----------------------------------------------------------------

test("the SSH agent and the host's paths do not cross the border", () => {
  const env = sandboxEnv(job(), { executionId: 'exec-1' }, {
    SSH_AUTH_SOCK: '/private/tmp/agent.sock',
    HOME: '/Users/moi',
    TMPDIR: '/var/folders/x',
    PATH: '/usr/bin',
    LANG: 'fr_FR.UTF-8',
  })

  // The list is exhaustive on purpose: what crosses into a container is a thing
  // to state, not to infer. The TICKTRAY_ pair are the deprecated aliases of the
  // two above them — see legacy-name.test.js — and they carry nothing the ROTA_
  // names do not.
  assert.deepEqual(Object.keys(env).sort(), [
    'LANG',
    'ROTA_EXECUTION_ID',
    'ROTA_JOB_ID',
    'TICKTRAY_EXECUTION_ID',
    'TICKTRAY_JOB_ID',
  ])
  assert.equal(env.SSH_AUTH_SOCK, undefined, 'a sandbox does not push over SSH')
  assert.equal(env.HOME, undefined, "nor does the host's home")
  assert.equal(env.PATH, undefined, 'nor its PATH')
})

test('the variables the job declares are handed to the container', () => {
  const definition = job({ runner: { environment: { MA_VARIABLE: 'valeur' } } })
  const { args } = build(definition, {
    environment: sandboxEnv(definition, { executionId: 'exec-1' }, {}),
  })

  assert.ok(args.includes('MA_VARIABLE=valeur'))
  assert.ok(args.includes('ROTA_JOB_ID=demo'))
})

test('the variables go through -e, never glued to the command', () => {
  const definition = job({ runner: { environment: { A: 'un' } } })
  const { args } = build(definition, { environment: { A: 'un' } })

  assert.equal(args[args.indexOf('A=un') - 1], '-e')
})

// --- forced stop ----------------------------------------------------------------

test('the forced stop aims at the container by name', () => {
  assert.deepEqual(buildKillCommand('/usr/local/bin/docker', 'exec-1'), {
    command: '/usr/local/bin/docker',
    args: ['kill', 'rota-exec-1'],
  })
})

// --- display --------------------------------------------------------------------

test('the command stays readable in the interface', () => {
  const line = formatCommand(build(job(), { executionId: null }))

  assert.match(line, /^\/usr\/local\/bin\/docker run --rm/)
  assert.match(line, /oven\/bun:1 bun run \/rota\/demo\.js$/)
})
