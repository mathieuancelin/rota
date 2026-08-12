'use strict'

// Sending a report to Discord.
//
// The remote counterpart of `report`: the window assumes someone in front of the
// screen, whereas a scheduled job mostly runs when nobody is. A channel, on the
// other hand, waits to be read.
//
// The destination comes from the global settings, never from the model — that is
// what distinguishes this tool from `fetch`, and what allows leaving it
// available in the sandbox: the choice is the user's, as is the model's server
// itself. Global rather than per job, because a channel usually serves every job
// on a machine, and because a job file gets shared — a webhook URL should not.
//
// The sending itself is in ../../discord/send.js, shared with the control
// bridge.

const reportDiscord = {
  name: 'report_discord',
  description:
    "Sends a markdown report to Discord, in the channel configured for Rota. " +
    "Does not wait for an answer. Use it when the report must be read even if nobody is " +
    "in front of the machine.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title, bolded at the top of the message.' },
      markdown: { type: 'string', description: 'Report content, in markdown.' },
    },
    required: ['markdown'],
  },
  async run({ title, markdown }, ctx) {
    if (typeof markdown !== 'string' || markdown.trim() === '') {
      return { ok: false, error: 'markdown is required' }
    }
    return publish({ title, markdown }, ctx)
  },
}

/**
 * Publishes a report. Shared with `report`, which uses it for its mirror.
 *
 * @returns {{ok: true, summary: string, content: string} | {ok: false, error: string}}
 */
async function publish({ title, markdown }, ctx) {
  const heading = title?.trim() ? `**${title.trim()}**\n` : ''
  const result = await ctx.discord.send({
    text: `${heading}${markdown.trim()}`,
    from: ctx.job.name,
    signal: ctx.signal,
  })

  if (!result.ok) return { ok: false, error: result.error }

  return {
    ok: true,
    summary: `${result.messages} message(s) sent`,
    content:
      `Report sent to Discord in ${result.messages} message(s).` +
      (result.dropped > 0
        ? ` ${result.dropped} more would have been needed: the report was cut, be shorter.`
        : ''),
  }
}

module.exports = { reportDiscord, publish }
