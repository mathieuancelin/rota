'use strict'

// Application log: one line per event in logs/rota.log, echoed to the
// console in development.

const fs = require('node:fs')

let stream = null

// A long-running shell echoes its log: that is how you follow a daemon, and how
// the application's output reads in development. A command line must not — its
// stdout is an answer somebody is about to parse, and a stray "job x disabled"
// in the middle of a JSON document is a bug in whatever reads it.
let echoToConsole = true

function init(logFilePath) {
  stream = fs.createWriteStream(logFilePath, { flags: 'a' })
  stream.on('error', (err) => {
    // The log must never bring the application down.
    if (echoToConsole) console.error('[rota] writing to the log failed:', err.message)
    stream = null
  })
}

/** Whether log lines are also written to stdout and stderr. */
function setConsoleEcho(enabled) {
  echoToConsole = Boolean(enabled)
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : inspect(a)))
    .join(' ')}`
  if (stream) stream.write(`${line}\n`)
  if (!echoToConsole) return
  if (level === 'error') console.error(line)
  else console.log(line)
}

function inspect(value) {
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

module.exports = {
  init,
  setConsoleEcho,
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
}
