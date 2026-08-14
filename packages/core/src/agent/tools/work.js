'use strict'

// The queue, as an agent sees it.
//
// Deliberately two tools and not eight. Claiming, starting and completing are
// Rota's, not the model's: the item is claimed before the job is launched and
// settled from how the execution ended, which is what lets a shell job be a
// worker just as well as an agent one. A model that had to remember to close
// its item would eventually forget, and the item would sit claimed forever.
//
// What is left is what only the agent can know: that there is more work to be
// queued, and that this particular item cannot be done at all.

const OUTPUT_PREVIEW = 200

const workCreate = {
  name: 'work_create',
  description:
    "Queues a piece of work for a Rota job — its own, or another. " +
    "The job takes it when it gets to it, one item at a time. " +
    "Use this to split what you found into pieces that will each be handled on their own.",
  parameters: {
    type: 'object',
    properties: {
      job: {
        type: 'string',
        description: "Job that will handle it. Its own identifier to queue for itself.",
      },
      input: {
        type: 'object',
        description:
          "What the job is handed. A reference to the work — an issue number, a path, a URL — " +
          "not the work itself.",
      },
      id: {
        type: 'string',
        description:
          "Name of your choosing. Queueing the same name twice is refused, which is how you " +
          "avoid queueing the same thing again on a later run.",
      },
    },
    required: ['job', 'input'],
  },
  async run({ job: id, input, id: itemId }, ctx) {
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'job is required' }
    }
    if (!ctx.workStore) {
      return { ok: false, error: 'the queues are not available in this execution' }
    }

    const target = id.trim()
    // The same allowlist that guards run_job: queueing work for a job is asking
    // it to run, only later. A door left open here would be the same door.
    const allowed = ctx.config.jobs.allow
    if (target !== ctx.job.id && allowed.length > 0 && !allowed.includes(target)) {
      return {
        ok: false,
        error: `this job is not allowed to queue work for "${target}" (see tools.jobs.allow)`,
      }
    }

    const created = await ctx.workStore.create({
      jobId: target,
      input: input ?? {},
      id: typeof itemId === 'string' && itemId.trim() !== '' ? itemId.trim() : null,
    })
    if (!created.ok) return created

    return {
      ok: true,
      summary: `${created.item.id} → ${target}`,
      content:
        `Queued as "${created.item.id}" for "${target}". ` +
        'It will be handled on its own, in its own execution.',
    }
  },
}

const workFail = {
  name: 'work_fail',
  description:
    "Gives up on the item you are working on, for good, with a reason. " +
    "For work that cannot be done at all — not for something that merely went wrong, " +
    "which is retried on its own. Nothing is retried after this.",
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: "Why it cannot be done, in one sentence." },
    },
    required: ['reason'],
  },
  async run({ reason }, ctx) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      return { ok: false, error: 'reason is required' }
    }
    if (!ctx.workStore) {
      return { ok: false, error: 'the queues are not available in this execution' }
    }
    if (!ctx.work) {
      return {
        ok: false,
        error: 'this execution is not working on a queue item, there is nothing to give up on',
      }
    }

    await ctx.workStore.giveUp(ctx.work.id, reason.trim().slice(0, OUTPUT_PREVIEW))

    return {
      ok: true,
      summary: reason.trim(),
      content:
        'The item is marked as given up on and will not be retried. ' +
        'Finish your turn: there is nothing more to do on it.',
    }
  },
}

module.exports = { workCreate, workFail }
