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
  work: 'an item waiting in its queue',
}

// What a job writes to say where the queue item goes in its own words. The
// dotted name cannot collide with a ${VARIABLE} secret, whose pattern refuses
// the dot — the two resolvers can therefore ignore each other.
const WORK_INPUT_TOKEN = '${work.input}'
const WORK_ID_TOKEN = '${work.id}'

// Said rather than left blank: a job whose prompt reads "process ${work.input}"
// and is then run by hand must not send the model a sentence with a hole in it.
const NO_WORK = '(no work item: this run did not come off the queue)'

/**
 * Replaces the ${work.*} references with the item this execution was handed.
 *
 * Expanded here rather than when the job is loaded, because the value is not a
 * property of the definition: the same job, run twice, holds two different
 * items. A text with no reference passes through untouched.
 *
 * @param {string} text
 * @param {{id: string, input: object}|null} work
 * @returns {string}
 */
function expandWork(text, work = null) {
  if (typeof text !== 'string') return text
  if (!text.includes(WORK_INPUT_TOKEN) && !text.includes(WORK_ID_TOKEN)) return text

  const input = work ? JSON.stringify(work.input ?? {}, null, 2) : NO_WORK
  const id = work ? work.id : NO_WORK
  return text.split(WORK_INPUT_TOKEN).join(input).split(WORK_ID_TOKEN).join(id)
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
 * @param {{id: string, input: object}|null} [options.work] the queue item, if any
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
  work = null,
}) {
  const sections = []

  const own = expandWork(expandDefaults(job.runner.agent.systemPrompt), work).trim()
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

module.exports = {
  buildSystemPrompt,
  expandWork,
  TRIGGER_LABELS,
  WORK_INPUT_TOKEN,
  WORK_ID_TOKEN,
  NO_WORK,
}
