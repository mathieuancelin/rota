'use strict'

// System commands.
//
// Two tools, and the distinction is not cosmetic. `exec` receives an executable
// and an argument array: that is the rule the rest of the engine never breaks,
// and nothing in it is interpreted. `shell` receives a command line handed to
// `sh -c`, with pipes, redirections and chaining — so with everything that comes
// with them.
//
// This is the only place in the project where a string is handed to a shell. The
// rule is lifted knowingly: the string is not assembled by Rota out of
// uncontrolled values, it *is* the request. `shell` stays out of the default
// list, and gets sandboxed like the rest.

const formatResult = (result, label) => {
  const parts = []
  if (result.error) parts.push(`failure: ${result.error}`)
  if (result.timedOut) parts.push('timed out, command stopped')
  if (result.aborted) parts.push('execution interrupted')
  parts.push(`exit code: ${result.exitCode ?? 'none'}${result.signal ? ` (signal ${result.signal})` : ''}`)
  if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`)
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`)
  if (!result.stdout && !result.stderr) parts.push('(no output)')

  return {
    ok: true,
    summary: `${label} → ${result.timedOut ? 'timed out' : `code ${result.exitCode ?? '?'}`}`,
    content: parts.join('\n'),
  }
}

const exec = {
  name: 'exec',
  description:
    "Runs a command with its arguments, without a shell: no pipes, no redirections, no globs. " +
    "The current directory is the job's working directory.",
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: "Executable, for example \"git\"." },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments, one per element.',
      },
    },
    required: ['command'],
  },
  async run({ command, args = [] }, ctx) {
    if (typeof command !== 'string' || command.trim() === '') {
      return { ok: false, error: 'command is required' }
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      return { ok: false, error: 'args must be an array of strings' }
    }

    const result = await ctx.runCommand(command, args)
    return formatResult(result, [command, ...args].join(' '))
  },
}

const shell = {
  name: 'shell',
  description:
    "Runs a command line with \"sh -c\": pipes, redirections and chaining are available. " +
    "The current directory is the job's working directory.",
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: "Full command line, for example \"ls -la | head -20\".",
      },
    },
    required: ['command'],
  },
  async run({ command }, ctx) {
    if (typeof command !== 'string' || command.trim() === '') {
      return { ok: false, error: 'command is required' }
    }

    const result = await ctx.runCommand('sh', ['-c', command])
    return formatResult(result, command)
  },
}

module.exports = { exec, shell, formatResult }
