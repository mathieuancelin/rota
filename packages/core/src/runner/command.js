'use strict'

// Building a job's command.
//
// We always produce an (executable, argument array) pair meant for spawn. No
// shell string is ever assembled: formatCommand() is for display only, and its
// result is never reinterpreted.

/**
 * @param {object} job validated definition
 * @param {{bunPath?: string, inlineScript?: string, scriptPath?: string}} options
 *        inlineScript: file produced from runner.code, required for a
 *        bun-inline job.
 *        scriptPath: replaces the script's path. Used by the sandbox, where the
 *        script is seen at its mount point and not at its path on the host.
 * @returns {{command: string, args: string[]}}
 */
function buildCommand(job, { bunPath = 'bun', inlineScript = null, scriptPath = null } = {}) {
  const { runner } = job
  // An inline job starts like any other script: that is the whole point of
  // writing the code to disk rather than passing it as an argument.
  const fallback = runner.type === 'bun-inline' ? (inlineScript ?? '(code inline)') : runner.script
  const script = scriptPath ?? fallback

  if (runner.type === 'shell') {
    return { command: runner.interpreter, args: [script, ...runner.args] }
  }
  return { command: bunPath, args: ['run', script, ...runner.args] }
}

const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Readable rendering of a command, for the interface. Must never be executed. */
function formatCommand({ command, args }) {
  return [command, ...args].map(quoteForDisplay).join(' ')
}

function quoteForDisplay(value) {
  if (SAFE_ARGUMENT.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

module.exports = { buildCommand, formatCommand }
