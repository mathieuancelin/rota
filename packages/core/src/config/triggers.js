'use strict'

// Reading a job's triggers.
//
// What the scheduler does with timed triggers is its own business; this module
// serves the other two — the webhook and the Discord keyword — which compute no
// occurrence and merely answer "does this job accept being started from there?".
//
// The answer is always no for a disabled job. Disabling means "do not start on
// your own": an HTTP address that kept starting it would empty the word of its
// meaning, and that is the kind of nuance one discovers at the wrong moment.

/** Active triggers of a given type. */
function triggersOfType(job, type) {
  if (!job.enabled) return []
  return (job.triggers ?? []).filter(
    (trigger) => trigger.type === type && trigger.enabled !== false,
  )
}

/**
 * A job's webhook trigger, if it has one.
 * @returns {object|null} the first declared; a second would add nothing.
 */
function webhookTrigger(job) {
  return triggersOfType(job, 'webhook')[0] ?? null
}

/**
 * The job a keyword designates.
 *
 * Two jobs on the same word cannot be told apart — validation refuses the
 * duplicate within one definition, but nothing stops two files from each
 * claiming it. The first in alphabetical order wins, and the caller says so:
 * picking at random would be worse.
 *
 * @param {object[]} jobs
 * @param {string} keyword
 * @returns {{job: object, ambiguous: string[]}|null}
 */
function jobForKeyword(jobs, keyword) {
  const matching = jobs.filter((job) => triggersOfType(job, 'discord').some((trigger) => trigger.keyword === keyword))
  if (matching.length === 0) return null
  return { job: matching[0], ambiguous: matching.slice(1).map((job) => job.id) }
}

/** Declared Discord keywords, for the bot's help. */
function keywordsOf(jobs) {
  return jobs
    .flatMap((job) => triggersOfType(job, 'discord').map((trigger) => ({ keyword: trigger.keyword, jobId: job.id })))
    .sort((a, b) => a.keyword.localeCompare(b.keyword, 'en'))
}

module.exports = { triggersOfType, webhookTrigger, jobForKeyword, keywordsOf }
