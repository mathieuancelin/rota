'use strict'

// One agent delegating a task to another.
//
// What it buys is context. An agent that has to read forty files to answer one
// question spends its whole turn budget filling its own window with what it will
// not need again; a sub-agent reads them in a window of its own and hands back
// the three lines that mattered. Same model, same tools, same working directory,
// same memory — a second reader, not a second job.
//
// It is therefore **not** `run_job`: that one starts another job, with its own
// definition, its own history entry and its own notifications. This one starts
// nothing the outside can see. There is one execution, one history entry, one
// transcript — the sub-agent's turns are written into it, indented.
//
// What is shared, and what is not:
//
//   * shared — the working directory, the container, the memory, the reported
//     changes, the Discord destination, the launch counter of `run_job`. It is
//     the same job doing the same work.
//   * its own — the conversation and the task list. A sub-agent that saw the
//     caller's exchange would be back to the context problem it exists to solve.
//
// Three guards, and each answers a way this goes wrong:
//
//   * **depth** — a sub-agent that can delegate in turn is a job that has
//     misunderstood its task growing a tree of them. One level, by default.
//   * **a total per execution** — not per agent: three agents allowed three each
//     is nine, and the number that matters is what the machine ends up running.
//   * **`deny`** — the tools a sub-agent does not inherit. This is where you hand
//     out a reader that cannot write, or keep `run_job` for yourself.

const DEFAULT_MAX_DEPTH = 1
const DEFAULT_MAX_PER_RUN = 3

/**
 * Settings of the tool, with the defaults the schema declares.
 * @param {object} [config] `runner.agent.tools.subagents`
 */
function settingsOf(config = {}) {
  return {
    maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxPerRun: config.maxPerRun ?? DEFAULT_MAX_PER_RUN,
    deny: config.deny ?? [],
    maxIterations: config.maxIterations ?? null,
  }
}

/**
 * Tools a sub-agent inherits.
 *
 * Everything the caller has, less what `deny` withdraws, less `sub_agent` itself
 * once the depth budget is spent — a tool it could only ever be refused is worse
 * than an absent one, because the model will keep trying.
 *
 * @param {object[]} tools the caller's own
 * @param {number} childDepth depth the sub-agent will run at, 1 for the first
 * @param {{maxDepth: number, deny: string[]}} settings
 * @returns {object[]}
 */
function inheritedTools(tools, childDepth, settings) {
  const denied = new Set(settings.deny)
  if (childDepth >= settings.maxDepth) denied.add('sub_agent')
  return tools.filter((tool) => !denied.has(tool.name))
}

/**
 * Why a delegation is refused, or null.
 *
 * The message is what the model reads: it says what the ceiling is, so the agent
 * can do the work itself rather than asking again in the next turn.
 */
function refusal({ depth, count, settings }) {
  if (settings.maxDepth === 0) {
    return 'delegation is disabled for this job (tools.subagents.maxDepth)'
  }
  if (depth >= settings.maxDepth) {
    return `you are already a sub-agent at the deepest level allowed (${settings.maxDepth}); do this one yourself`
  }
  if (count >= settings.maxPerRun) {
    return `already ${settings.maxPerRun} sub-agents for this execution, that is the maximum`
  }
  return null
}

/**
 * The task, as the sub-agent receives it.
 *
 * The context is part of the message rather than a second one: what the caller
 * knows and what it wants are one instruction, and splitting them invites the
 * model to answer the first half.
 */
function taskMessage({ task, context }) {
  if (!context) return task
  return `${task}\n\n# What the agent that asked you knows\n\n${context}`
}

module.exports = {
  settingsOf,
  inheritedTools,
  refusal,
  taskMessage,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PER_RUN,
}
