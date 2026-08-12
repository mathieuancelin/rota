'use strict'

// Triggering another job — or its own.
//
// The use that motivated this tool: a job that works through a queue item by
// item and reschedules itself at the end, until there is nothing left. A fixed
// interval can neither stop when the queue is empty, nor speed up when it is
// full.
//
// The machinery is in ../jobs.js; here, only the conversation with the model.

const { MAX_DELAY_SECONDS } = require('../jobs')

// An excerpt is enough: the full transcript of the called job is in its own
// history, under its own execution identifier.
const OUTPUT_PREVIEW = 800

const runJob = {
  name: 'run_job',
  description:
    "Triggers a Rota job, by its identifier. " +
    "With \"wait\", waits for it to finish and returns its result; without, hands back immediately. " +
    "With \"delaySeconds\", the launch is deferred — this is how a job reschedules " +
    "itself: launch yourself without waiting, with a delay, right before concluding.",
  parameters: {
    type: 'object',
    properties: {
      job: { type: 'string', description: "Job identifier, as it appears in its file." },
      wait: {
        type: 'boolean',
        description: "Wait for the end and return the result. Default: no. Impossible on itself.",
      },
      delaySeconds: {
        type: 'integer',
        description: `Delay before launching, in seconds. 0 by default, ${MAX_DELAY_SECONDS} at most.`,
      },
    },
    required: ['job'],
  },
  async run({ job: id, wait = false, delaySeconds = 0 }, ctx) {
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'job is required' }
    }
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0) {
      return { ok: false, error: 'delaySeconds must be a positive integer' }
    }

    const allowed = ctx.config.jobs.allow
    if (allowed.length > 0 && !allowed.includes(id.trim())) {
      return {
        ok: false,
        error: `this job is not allowed to trigger "${id.trim()}" (see tools.jobs.allow)`,
      }
    }

    // Without a ceiling, an agent that gets it wrong stacks up dozens of
    // launches — far more lasting damage than a loop, which maxIterations bounds.
    if (ctx.triggers.count >= ctx.triggers.max) {
      return {
        ok: false,
        error: `already ${ctx.triggers.max} launches for this execution, that is the maximum`,
      }
    }
    ctx.triggers.count += 1

    const result = await ctx.jobs.trigger({
      id: id.trim(),
      wait,
      delaySeconds,
      callerJobId: ctx.job.id,
      signal: ctx.signal,
    })

    if (!result.ok) return result

    if (result.deferred) {
      return {
        ok: true,
        summary: `${id.trim()} in ${delaySeconds} s`,
        content:
          `"${id.trim()}" will start in ${delaySeconds} seconds. ` +
          'The launch lives inside Rota and does not survive quitting it.',
      }
    }

    if (!wait) {
      return { ok: true, summary: `${id.trim()} started`, content: `"${id.trim()}" has been started.` }
    }

    const { entry } = result
    const output = `${entry.stdout ?? ''}${entry.stderr ?? ''}`.trim()
    return {
      ok: true,
      summary: `${id.trim()} → ${entry.status}`,
      content: [
        `"${id.trim()}": ${entry.status} in ${entry.durationMs} ms` +
          (entry.exitCode === null ? '' : `, code ${entry.exitCode}`),
        entry.error ? `Cause: ${entry.error}` : '',
        output ? `--- output ---\n${output.slice(-OUTPUT_PREVIEW)}` : '(no output)',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  },
}

module.exports = { runJob, OUTPUT_PREVIEW }
