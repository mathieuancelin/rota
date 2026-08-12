'use strict'

// Delegating a task to a second agent of the same job.
//
// The machinery is in ../subagent.js; here, only the conversation with the
// model — and the one thing worth saying to it plainly: the sub-agent does not
// see this conversation. A task written as "do that too" delegates nothing.

const { refusal, settingsOf } = require('../subagent')

const subAgent = {
  name: 'sub_agent',
  description:
    "Hands a task to a second agent, and waits for what it concludes. " +
    "It has your model, your tools, your working directory and your memory, but not your " +
    "conversation: state the task in full, it sees nothing of what was said here. " +
    "Use it for work whose detail you do not need — reading a lot to answer a little, " +
    "exploring a lead that may go nowhere. Only its final answer comes back to you.",
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: "What it must do, stated in full, and what you expect back.",
      },
      context: {
        type: 'string',
        description: "What it needs to know from here that it has no way of finding out.",
      },
    },
    required: ['task'],
  },
  async run({ task, context }, ctx) {
    if (typeof task !== 'string' || task.trim() === '') {
      return { ok: false, error: 'task is required' }
    }
    if (context !== undefined && typeof context !== 'string') {
      return { ok: false, error: 'context must be a string' }
    }

    const settings = settingsOf(ctx.config.subagents)
    const refused = refusal({
      depth: ctx.subAgents.depth,
      count: ctx.subAgents.count,
      settings,
    })
    if (refused) return { ok: false, error: refused }

    // Counted before the run, not after: a sub-agent that fails still consumed
    // the budget, and one that hangs must not leave the ceiling unenforced for
    // whatever the caller tries next.
    ctx.subAgents.count += 1

    const result = await ctx.spawnSubAgent({ task: task.trim(), context: context?.trim() || null })

    if (!result.ok) {
      return { ok: false, error: `the sub-agent did not conclude: ${result.error}` }
    }
    const answer = result.content?.trim()
    if (!answer) {
      return {
        ok: false,
        error: 'the sub-agent finished without saying anything; state the task more precisely',
      }
    }

    return {
      ok: true,
      summary: `${result.iterations} turn(s)`,
      content: answer,
    }
  },
}

module.exports = { subAgent }
