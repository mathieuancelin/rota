'use strict'

// Tool registry.
//
// Nothing is offered to the model that is not listed in `tools.enabled`: what is
// not declared does not exist, and a model cannot ask for a tool whose existence
// it ignores. Two entries are groups — `todo` and `memory` — because their tools
// make no sense apart.

const { hasDestination } = require('../../discord/send')
const { reportDiscord } = require('./discord')
const { runJob } = require('./jobs')
const { fetchTool } = require('./net')
const { exec, shell } = require('./system')
const { fileRead, fileList, fileWrite, fileDel } = require('./files')
const { todoRead, todoAdd, todoDel, todoClear } = require('./todo')
const { memoryList, memoryRead, memoryWrite, memoryDel } = require('./memory')
const { report, askUser, confirm, signalChange } = require('./interact')
const { subAgent } = require('./subagent')

const CATALOG = {
  fetch: [fetchTool],
  exec: [exec],
  shell: [shell],
  file_read: [fileRead],
  file_list: [fileList],
  file_write: [fileWrite],
  file_del: [fileDel],
  todo: [todoRead, todoAdd, todoDel, todoClear],
  memory: [memoryList, memoryRead, memoryWrite, memoryDel],
  report: [report],
  report_discord: [reportDiscord],
  ask_user: [askUser],
  confirm: [confirm],
  signal_change: [signalChange],
  run_job: [runJob],
  sub_agent: [subAgent],
}

// Tools that suspend the execution waiting for a human answer. `report` is not
// one: it displays and hands back, and published to Discord it ends up read.
const BLOCKING = new Set(['ask_user', 'confirm'])

/**
 * Selects the tools of an execution.
 *
 * Withdrawals are announced rather than silent: an agent deprived of `fetch`
 * will fail, and the reason must be in the transcript, not deduced.
 *
 * @param {object} job validated definition
 * @param {{integrations?: object, unattended?: boolean}} [options] global
 *        settings some tools depend on, and the absence of a human
 * @returns {{tools: object[], notices: string[]}}
 */
function selectTools(job, { integrations = {}, unattended = false } = {}) {
  const { agent } = job.runner
  const { sandbox } = job.execution
  const tools = []
  const notices = []

  for (const name of agent.tools.enabled) {
    // Nobody in front of the screen: a question would wait out its timeout for
    // nothing, and a `confirm` with no answer counts as a refusal. Not offering
    // it beats letting it fail slowly.
    if (unattended && BLOCKING.has(name)) {
      notices.push(`${name} withdrawn: nobody is at the screen for this turn`)
      continue
    }
    // The `fetch` tool goes out from the main process, not from the container:
    // offering it while the sandbox cuts the network would open exactly the hole
    // that "network off" claims to close.
    if (name === 'fetch' && sandbox.enabled && !sandbox.network) {
      notices.push('fetch withdrawn: the sandbox cuts the network (execution.sandbox.network)')
      continue
    }
    if (name === 'memory' && !agent.memory.enabled) {
      notices.push('memory withdrawn: memory is disabled for this job')
      continue
    }
    // A tool the model could only ever be refused is worse than an absent one:
    // it will keep trying, and each attempt costs a turn.
    if (name === 'sub_agent' && (agent.tools.subagents?.maxDepth ?? 1) === 0) {
      notices.push('sub_agent withdrawn: delegation is off (tools.subagents.maxDepth)')
      continue
    }
    // Better not to offer it than to let it fail at the moment the agent finally
    // has something to report.
    if (name === 'report_discord' && !hasDestination(integrations)) {
      notices.push('report_discord withdrawn: no Discord destination in Rota settings')
      continue
    }
    tools.push(...(CATALOG[name] ?? []))
  }

  return { tools, notices }
}

/** Declarations in the format the API expects. */
function toolDefinitions(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      // Rota's tools are strict; those of an MCP server keep the schema it
      // published — tightening it would make valid calls be refused.
      parameters: {
        ...tool.parameters,
        additionalProperties: tool.parameters.additionalProperties ?? false,
      },
    },
  }))
}

const byName = (tools) => new Map(tools.map((tool) => [tool.name, tool]))

module.exports = { CATALOG, BLOCKING, selectTools, toolDefinitions, byName }
