#!/usr/bin/env node
'use strict'

// rotactl — driving Rota from a terminal.
//
// Two ways in, and the help says which is which for every command. Reading
// commands link the engine directly and go to the files, so they answer with
// nothing running — which is exactly when you want to ask what a job is
// supposed to do. Acting commands go through the API, because starting a job
// means asking the thing that owns the scheduler, not writing a file and hoping.

const path = require('node:path')

const { logger, resolvePaths } = require('@rota/core')

const commands = require('./commands')
const { ApiError } = require('./api')
const { byName, commandHelp, usage } = require('./help')
const { createStyle } = require('./render')

const VERSION = require('../package.json').version

const FLAGS = new Set(['--json', '--remote', '--no-colour', '--no-color'])
const VALUED = new Set(['--config-dir', '--token', '--url', '--limit', '--input', '--id'])

/**
 * Hand-written, and small enough to read in one sitting. The alternative is a
 * dependency in a binary whose whole appeal is that it has none.
 */
function parseArguments(argv) {
  const options = {
    configDir: null,
    token: null,
    url: null,
    limit: null,
    input: null,
    id: null,
    json: false,
    remote: false,
    colour: null,
  }
  const positional = []
  let help = false
  let version = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]

    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '-v' || arg === '--version') {
      version = true
      continue
    }

    if (VALUED.has(arg)) {
      const value = argv[++index]
      if (value === undefined) return { error: `${arg} needs a value` }
      if (arg === '--config-dir') options.configDir = value
      else if (arg === '--token') options.token = value
      else if (arg === '--url') options.url = value
      else if (arg === '--input') options.input = value
      else if (arg === '--id') options.id = value
      else if (arg === '--limit') {
        const limit = Number.parseInt(value, 10)
        if (!Number.isInteger(limit) || limit <= 0) return { error: `--limit wants a positive number, got "${value}"` }
        options.limit = limit
      }
      continue
    }

    if (FLAGS.has(arg)) {
      if (arg === '--json') options.json = true
      else if (arg === '--remote') options.remote = true
      else options.colour = false
      continue
    }

    if (arg.startsWith('-')) return { error: `unknown option: ${arg}` }
    positional.push(arg)
  }

  const [name, ...args] = positional
  // How many a command takes is the command's business — `work` has
  // sub-commands, everything else takes one identifier — so the arity is
  // checked once the name has been resolved, not here.
  const arity = byName.get(name)?.arity ?? 1
  if (args.length > arity) return { error: `unexpected argument: ${args[arity]}` }

  return { name, argument: args[0] ?? null, arguments: args, options, help, version }
}

async function main(argv = process.argv.slice(2), io = {}) {
  const write = io.write ?? ((text) => process.stdout.write(`${text}\n`))
  const writeError = io.writeError ?? ((text) => process.stderr.write(`${text}\n`))

  // The engine logs as it works — a job enabled, a token unresolved. That is
  // right for a daemon and wrong here: this process prints one answer, and
  // anything else on stdout belongs to whatever is parsing it.
  logger.setConsoleEcho(false)

  const parsed = parseArguments(argv)
  if (parsed.error) {
    writeError(parsed.error)
    writeError('')
    writeError(usage())
    return 2
  }

  const { name, argument, options, help, version } = parsed

  if (version) {
    write(VERSION)
    return 0
  }
  if (!name) {
    write(usage())
    return help ? 0 : 2
  }
  if (help) {
    const text = commandHelp(name)
    if (!text) {
      writeError(`unknown command: ${name}`)
      return 2
    }
    write(text)
    return 0
  }

  const command = byName.get(name)
  if (!command) {
    writeError(`unknown command: ${name}`)
    writeError('')
    writeError(usage())
    return 2
  }

  // Colour is decoration: off when it is not a terminal, off when NO_COLOR
  // says so, off when asked. Nobody greps for escape sequences.
  const colour =
    options.colour ??
    (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb')

  const context = {
    paths: resolvePaths(options.configDir ? path.resolve(options.configDir) : undefined),
    argument,
    // Everything after the command name. Only `work` reads past the first.
    arguments: parsed.arguments ?? [],
    options,
    style: createStyle(colour && !options.json),
    exitCode: 0,
    out(value, { raw = false } = {}) {
      if (raw) return write(String(value))
      write(options.json && typeof value !== 'string' ? JSON.stringify(value, null, 2) : String(value))
    },
    fail(message) {
      writeError(message)
      context.exitCode = 1
    },
  }

  try {
    await commands[name](context)
  } catch (err) {
    if (err instanceof ApiError) {
      writeError(err.message)
      if (err.hint) writeError(`  ${err.hint}`)
      return 1
    }
    if (err.code === 'ENOENT') {
      writeError(`${err.path ?? 'a file the command needed'} does not exist`)
      writeError(`  configuration directory: ${context.paths.root}`)
      return 1
    }
    throw err
  }

  return context.exitCode
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err?.stack ?? err}\n`)
      process.exit(1)
    },
  )
}

module.exports = { main, parseArguments }
