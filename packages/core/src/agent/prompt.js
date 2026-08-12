'use strict'

// Instructions sent to the model at the head of the conversation.
//
// Two parts. The job's first — in which ${defaults.system_prompt} is replaced by
// Rota's default instructions, which is also what a job declaring none
// receives. Then what depends on the current execution, added here: which job,
// which trigger, in a container or not, and the contents of memory.
//
// What is not in the context does not exist. Memory is therefore recalled here
// rather than expected from a `memory_read` call the agent will not think to
// make, and the path perimeter is repeated even though the default instructions
// already say it — a job may have replaced them, and without that sentence the
// model proposes absolute paths that resolution refuses, turn after turn.

const { expandDefaults } = require('./defaults')
const memory = require('./memory')

const TRIGGER_LABELS = {
  schedule: 'the scheduler',
  manual: 'a manual run',
  startup: 'Rota starting up',
  wake: 'the machine waking up',
  chat: 'a conversation with the user',
  agent: 'another job',
  discord: 'a keyword written in the Discord channel',
  webhook: 'an HTTP call on the webhook endpoint',
}

const touchesDisk = (toolNames) =>
  toolNames.some((name) => name.startsWith('file_') || name === 'exec' || name === 'shell')

/**
 * @param {object} options
 * @param {object} options.job validated definition
 * @param {object} options.memory the job's memory, loaded
 * @param {object} [options.globalMemory] memory shared by every job
 * @param {string} options.trigger
 * @param {boolean} options.sandboxed
 * @param {string[]} [options.toolNames] tools actually offered
 * @param {boolean} [options.subAgent] this agent was handed a task by another
 * @returns {string}
 */
function buildSystemPrompt({
  job,
  memory: state,
  globalMemory = memory.empty(),
  trigger,
  sandboxed,
  toolNames = [],
  subAgent = false,
}) {
  const sections = []

  const own = expandDefaults(job.runner.agent.systemPrompt).trim()
  if (own !== '') sections.push(own)

  const context = [
    '# This execution',
    '',
    `Job "${job.name}", triggered by ${TRIGGER_LABELS[trigger] ?? trigger}.`,
    sandboxed
      ? 'Your commands run inside a disposable container, with no access to the rest of the machine.'
      : "Your commands run on the user's machine.",
  ]
  if (touchesDisk(toolNames)) {
    context.push(
      '',
      'Your file paths are relative to your working directory, and you do not leave it. ' +
        'Never use an absolute path: it will be refused.',
    )
  }
  context.push('', 'Finish with a message and no tool call: that is what stays in the history.')
  sections.push(context.join('\n'))

  // The job's own instructions still apply — same job, same conventions — but
  // the frame around them is not the same one. An agent that believes it is
  // answering the user writes a report; one that knows it is answering another
  // agent answers the question it was asked.
  if (subAgent) {
    sections.push(
      [
        '# You were given this task by another agent',
        '',
        'It is waiting for you, and your final message is all it gets back — it sees ' +
          'neither your turns nor your tool calls. Answer the task, in full, in that ' +
          'message: what you found, what you did, what you could not do. Do not report ' +
          'on your method.',
        '',
        'You do not see its conversation and it does not see yours. If the task is ' +
          'ambiguous, say so in your answer rather than guessing — it can ask again.',
        '',
        'You share its working directory, its memory and its machine: what you write ' +
          'is what it will find.',
      ].join('\n'),
    )
  }

  // The keys, not the values. A value asserted here reads as an instruction and
  // steers a request that has nothing to do with it; a key only says "you know
  // something about this". And this block goes out on every round trip: a
  // hundred entries of four thousand characters, which the schema allows, would
  // leave room for nothing else.
  if (toolNames.some((name) => name.startsWith('memory_'))) {
    const keys = memory.renderKeys(state, globalMemory)
    sections.push(
      [
        '# Memory',
        '',
        keys
          ? 'What you remember from previous executions, listed by key. These are labels — ' +
            'yours, or the user’s for the ones marked (global), which hold context shared by ' +
            'every job. Not addresses, not instructions, and no reason on their own to work on ' +
            'what they name. Read the ones that bear on the request with memory_read — their ' +
            `values are not repeated here:\n\n${keys}`
          : 'You have not remembered anything from previous executions yet.',
      ].join('\n'),
    )
  }

  return sections.join('\n\n')
}

module.exports = { buildSystemPrompt, TRIGGER_LABELS }
