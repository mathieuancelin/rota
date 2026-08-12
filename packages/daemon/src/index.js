#!/usr/bin/env node
'use strict'

// rotad — the engine, running with nobody attached.
//
// The same engine the application builds, composed here around a signal handler
// instead of a tray icon. What is missing is not a feature: an agent that wants
// to ask a question is told there is nobody to ask, learns that from the
// refusal, and carries on. Everything else — schedules, runs, history, Discord,
// the HTTP API — behaves identically, because it is the same code.

const path = require('node:path')

const { acquireInstanceLock, createEngine, logger, resolvePaths } = require('@rota/core')

const { watchPower } = require('./power')
const { installationNotes, launchdPlist, systemdUnit } = require('./service')

const VERSION = require('../package.json').version

const USAGE = `rotad — Rota without a screen

Usage:
  rotad run [--config-dir <dir>]
  rotad service <launchd|systemd> [--config-dir <dir>] [--binary <path>]
  rotad --version
  rotad --help

Options:
  --config-dir <dir>  Which configuration directory to open.
                      Defaults to $ROTA_CONFIG_DIR, then ~/.config/rota.
  --binary <path>     Path to record in the unit file. Defaults to this binary.

One daemon per configuration directory: starting a second on the same one is
refused, by name and by process id, rather than quietly running two schedulers.
`

async function main(argv = process.argv.slice(2)) {
  const { command, options, error } = parseArguments(argv)

  if (error) {
    process.stderr.write(`${error}\n\n${USAGE}`)
    return 2
  }
  if (command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (command === 'service') return printService(options)
  return run(options)
}

/**
 * Deliberately hand-written, and deliberately small: a daemon with four
 * switches does not need an argument parser, and one more dependency in the
 * compiled binary would have to earn its place.
 */
function parseArguments(argv) {
  const options = { configDir: null, binary: null }
  const positional = []

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { command: 'help', options }
    if (arg === '--version' || arg === '-v') return { command: 'version', options }

    if (arg === '--config-dir' || arg === '--binary') {
      const value = argv[++index]
      if (value === undefined) return { error: `${arg} needs a value`, options }
      options[arg === '--config-dir' ? 'configDir' : 'binary'] = value
      continue
    }

    if (arg.startsWith('-')) return { error: `unknown option: ${arg}`, options }
    positional.push(arg)
  }

  const [command = 'run', ...rest] = positional
  if (command === 'run') {
    if (rest.length > 0) return { error: `unexpected argument: ${rest[0]}`, options }
    return { command: 'run', options }
  }
  if (command === 'service') {
    const kind = rest[0]
    if (!kind) return { error: 'service needs a kind: launchd or systemd', options }
    if (kind !== 'launchd' && kind !== 'systemd') {
      return { error: `unknown service kind: ${kind} (launchd or systemd)`, options }
    }
    return { command: 'service', options: { ...options, kind } }
  }

  return { error: `unknown command: ${command}`, options }
}

function printService({ kind, configDir, binary }) {
  const paths = resolvePaths(configDir ? path.resolve(configDir) : undefined)
  // process.execPath is the compiled binary when this ships as one, and the
  // node binary when it does not — in which case naming it would produce a unit
  // that starts a REPL. Ask for --binary rather than print something wrong.
  const target = binary ?? (isCompiled() ? process.execPath : null)

  if (!target) {
    process.stderr.write(
      'Running from source: pass --binary <path to rotad> so the unit file ' +
        'names something that exists on this machine.\n',
    )
    return 2
  }

  const unit =
    kind === 'launchd'
      ? launchdPlist({ binary: target, configDir: paths.root, logsDir: paths.logsDir })
      : systemdUnit({ binary: target, configDir: paths.root })

  process.stdout.write(unit)
  process.stderr.write(`${installationNotes(kind, { configDir: paths.root })}\n`)
  return 0
}

/** True when this is a `bun build --compile` binary rather than node running a file. */
function isCompiled() {
  return !/(^|[\\/])(node|bun)(\.exe)?$/.test(process.execPath)
}

async function run({ configDir }) {
  const paths = resolvePaths(configDir ? path.resolve(configDir) : undefined)

  // Before anything is created: the whole point is that a second engine on this
  // directory never gets as far as loading a job.
  let lock
  try {
    lock = acquireInstanceLock(paths, { role: 'rotad' })
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 1
  }

  // No ui of its own: an agent's questions go out over the event stream, to
  // whatever interface is attached, and are refused when none is.
  const engine = await createEngine({ paths })
  const power = watchPower(engine.scheduler)

  let stopping = null
  const stop = (signal) => {
    // Two Ctrl-Cs should not start two shutdowns; the second is a request to
    // stop waiting, which is what the process exiting will do anyway.
    if (stopping) return stopping
    logger.info(`${signal} received: stopping`)
    stopping = (async () => {
      power.close()
      await engine.stop()
      lock.release()
    })()
    return stopping
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      stop(signal).then(
        () => process.exit(0),
        (err) => {
          logger.error('stopping failed', err)
          process.exit(1)
        },
      )
    })
  }

  // A crash must not leave a lock file naming a process that is gone. It would
  // be treated as stale on the next start anyway, but only after a refusal
  // message nobody should have to read.
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', err)
    lock.release()
    process.exit(1)
  })

  await engine.start()
  logger.info(`rotad ${VERSION} ready — ${engine.store.getJobs().length} job(s), pid ${process.pid}`)

  // Nothing left to do on this stack: the scheduler's timers and the servers
  // keep the loop alive, and the signal handlers end it.
  return new Promise(() => {})
}

if (require.main === module) {
  main().then(
    (code) => {
      if (typeof code === 'number') process.exit(code)
    },
    (err) => {
      process.stderr.write(`${err?.stack ?? err}\n`)
      process.exit(1)
    },
  )
}

module.exports = { main, parseArguments, isCompiled }
