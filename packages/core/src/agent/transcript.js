'use strict'

// Formatting the transcript of an agent execution.
//
// The transcript goes out on the `stdout` of the history entry: it thereby
// inherits truncation at `maxOutputBytes`, externalisation beyond 8 KiB and the
// history view, without inventing anything.
//
// What matters to whoever reads it back three weeks later: what the agent
// decided, what it started, what it got out of it. Arguments and results are
// therefore abbreviated — the full detail is reproducible, the chronology is
// not.
//
// A sub-agent's turns are written into the same transcript, one level in. There
// is one execution, so there is one record of it — and reading the caller's line
// and then the work it delegated, in order, is the whole point.

const ARGUMENT_LIMIT = 300
const RESULT_LIMIT = 800

// A rule rather than an indent: at the width these lines reach, two spaces are
// invisible and the reader loses which agent is speaking.
const NESTING = '│ '

const clip = (text, limit) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** Renders a block over several lines, indented under its heading. */
const indent = (text) =>
  String(text)
    .trimEnd()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')

/**
 * @param {{onLine?: (line: string) => void}} [options] called on every line
 *   written, for whoever watches the transcript while it happens
 */
function createTranscript({ onLine = null } = {}) {
  const lines = []
  let iteration = 0

  // `depth` is how many agents down the line was written: 0 for the one the job
  // started, 1 for what it delegated, and so on. A block already broken over
  // several lines is prefixed line by line — otherwise the rule would stop at
  // the first one, exactly where it matters most.
  const write = (line, depth = 0) => {
    const prefixed =
      depth > 0
        ? String(line)
            .split('\n')
            .map((piece) => `${NESTING.repeat(depth)}${piece}`)
            .join('\n')
        : line
    lines.push(prefixed)
    onLine?.(`${prefixed}\n`)
  }

  return {
    header({ job, model, baseUrl, environment, toolNames, notices }) {
      write(`Agent "${job.name}" — ${model} @ ${baseUrl}`)
      write(`Working directory: ${environment}`)
      write(`Tools: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}`)
      for (const notice of notices) write(`⚠ ${notice}`)
      write('')
    },

    turn(number, depth = 0) {
      // Only the agent the job started moves the counter: the history entry
      // reports the turns of the execution, not of everything under it.
      if (depth === 0) iteration = number
      write(depth > 0 ? `── sub-agent turn ${number} ──` : `── turn ${number} ──`, depth)
    },

    reasoning(text, depth = 0) {
      if (!text?.trim()) return
      write('· thinking', depth)
      write(indent(clip(text, RESULT_LIMIT)), depth)
    },

    assistant(text, depth = 0) {
      if (!text?.trim()) return
      write('· answer', depth)
      write(indent(text), depth)
    },

    toolCall(name, args, depth = 0) {
      write(`▸ ${name} ${clip(JSON.stringify(args ?? {}), ARGUMENT_LIMIT)}`, depth)
    },

    toolResult(result, depth = 0) {
      if (result.ok) {
        write(`  ✓ ${clip(result.summary ?? result.content ?? '', ARGUMENT_LIMIT)}`, depth)
      } else {
        write(`  ✗ ${clip(result.error, ARGUMENT_LIMIT)}`, depth)
      }
    },

    notice(text, depth = 0) {
      write(`⚠ ${text}`, depth)
    },

    final(text) {
      write('')
      write('── result ──')
      write(text?.trim() ? text.trim() : '(no final message)')
    },

    get iterations() {
      return iteration
    },

    text() {
      return `${lines.join('\n')}\n`
    },
  }
}

module.exports = { createTranscript, clip, indent }
