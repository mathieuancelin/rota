'use strict'

// Tools that address the user.
//
// They are the reason the loop runs in the main process: opening a window and
// waiting for its answer is not something a child process knows how to do.
//
// `report` hands back immediately — a report is read whenever one wants.
// `ask_user` and `confirm` block, with a timeout: a scheduled job may well ask
// its question at three in the morning, and it must not sit there waiting for
// it. Once the timeout passes, the agent is told it got no answer and carries
// on — what to make of that is its decision.

const { publish } = require('./discord')

const report = {
  name: 'report',
  description:
    "Shows a markdown report to the user, in a separate window. " +
    "Does not wait for an answer: the execution continues immediately.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Window title.' },
      markdown: { type: 'string', description: 'Report content, in markdown.' },
    },
    required: ['markdown'],
  },
  async run({ title, markdown }, ctx) {
    if (typeof markdown !== 'string' || markdown.trim() === '') {
      return { ok: false, error: 'markdown is required' }
    }

    await ctx.ui.report({ title: title?.trim() || ctx.job.name, markdown })

    // Mirror to Discord: a window assumes someone in front of the screen, which
    // a scheduled job almost never has. The agent is told the fate of the mirror
    // without its failure compromising the report, which is displayed.
    let mirror = ''
    if (ctx.mirrorReports && ctx.discord.available) {
      const sent = await publish({ title, markdown }, ctx)
      mirror = sent.ok ? ' Also published to Discord.' : ` Discord mirror failed: ${sent.error}`
    }

    return {
      ok: true,
      summary: title?.trim() || '(untitled)',
      content:
        "Report displayed. The user will read it whenever they want; do not wait for them." + mirror,
    }
  },
}

const askUser = {
  name: 'ask_user',
  description:
    "Asks the user a question and waits for a written answer. " +
    "Blocks the execution. With no answer within the timeout, the tool says so and the run resumes.",
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: "The question asked." },
      defaultValue: { type: 'string', description: 'Answer proposed by default.' },
    },
    required: ['question'],
  },
  async run({ question, defaultValue }, ctx) {
    if (typeof question !== 'string' || question.trim() === '') {
      return { ok: false, error: 'question is required' }
    }

    const answer = await ctx.ui.ask({
      question: question.trim(),
      defaultValue: typeof defaultValue === 'string' ? defaultValue : '',
      timeoutSeconds: ctx.config.interaction.timeoutSeconds,
    })

    if (answer.answered) {
      return { ok: true, summary: answer.value, content: answer.value }
    }
    return {
      ok: false,
      error:
        answer.reason === 'timeout'
          ? `no answer within ${ctx.config.interaction.timeoutSeconds} seconds — nobody at the screen, carry on without one`
          : 'the user closed the question without answering',
    }
  },
}

const confirm = {
  name: 'confirm',
  description:
    "Asks the user to confirm or cancel an action. " +
    "Blocks the execution. With no answer within the timeout, the action counts as refused.",
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Action to confirm, in one sentence.' },
      detail: { type: 'string', description: "Details shown under the question." },
    },
    required: ['question'],
  },
  async run({ question, detail }, ctx) {
    if (typeof question !== 'string' || question.trim() === '') {
      return { ok: false, error: 'question is required' }
    }

    const answer = await ctx.ui.confirm({
      question: question.trim(),
      detail: typeof detail === 'string' ? detail : '',
      timeoutSeconds: ctx.config.interaction.timeoutSeconds,
    })

    if (answer.confirmed) return { ok: true, summary: 'confirmed', content: 'The user confirmed.' }
    return {
      ok: true,
      summary: answer.reason === 'timeout' ? 'no answer' : 'refused',
      content:
        answer.reason === 'timeout'
          ? 'No answer within the timeout: the action is refused. Do not insist, carry on another way.'
          : 'The user refused. Do not insist, carry on another way.',
    }
  },
}

const signalChange = {
  name: 'signal_change',
  description:
    "Reports that the execution had a real effect on the system, as opposed to a run that " +
    "had nothing to do. This is what triggers the \"onChange\" notification. " +
    "Call it once, and only if something actually changed.",
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: "What changed, in one line." },
    },
    required: ['message'],
  },
  async run({ message }, ctx) {
    if (typeof message !== 'string' || message.trim() === '') {
      return { ok: false, error: 'message is required' }
    }
    ctx.signalChange(message.trim())
    return { ok: true, summary: message.trim(), content: 'Effect reported.' }
  },
}

module.exports = { report, askUser, confirm, signalChange }
