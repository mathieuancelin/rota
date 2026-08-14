'use strict'

// Turning the two ways of describing an agent into the one the code reads.
//
// A job either writes its agent out in full, or names a profile from profiles/
// and adds what it wants different. Both end up as the same object under
// `runner.agent`, and that is the whole point: eleven files read that object —
// the session, the client, the prompt, the sub-agents, the chat, the workflow
// runner, the validator, the snapshot — and none of them has to learn that
// there are now two spellings.
//
// The resolution happens in the store, before anything downstream sees a job.
// What stays on disk is what the user wrote; what circulates is the merge.
//
// **Defaults are applied here rather than by the job's schema.** Making
// `runner.agent` accept a string as well as an object means putting it behind a
// `oneOf`, and ajv silently ignores `default` inside one — an inline agent would
// quietly lose maxIterations, its tool list and the rest, which the rest of the
// code assumes a validated job carries. So both forms come through this file and
// leave it complete.

/** Values that replace rather than blend: a half-inherited list is unguessable. */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Merges an override onto a base.
 *
 * Objects go one level deeper — `{ api: { timeoutSeconds: 300 } }` keeps the
 * profile's baseUrl — while arrays and scalars replace outright. Enabling one
 * more tool means writing the list you want, because a list that was half
 * inherited and half declared could not be read off the file.
 */
function merge(base, override) {
  if (!isPlainObject(override)) return override
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? merge(base[key], value) : value
  }
  return result
}

/**
 * The agent of one runner, resolved.
 *
 * @param {object} runner as written, its `agent` a string or an object
 * @param {Map<string, object>} profiles by identifier
 * @param {{field?: string}} [options] where to say the error happened
 * @returns {{ok: true, agent: object, profileId: string|null} | {ok: false, errors: string[]}}
 */
function resolveRunnerAgent(runner, profiles, { field = 'runner' } = {}) {
  const reference = runner.agent

  if (isPlainObject(reference)) {
    // Written out in full. The two keys that only mean something beside a
    // profile are refused rather than ignored: a maxIterations left in
    // agentOverrides after switching back to an inline agent would have no
    // effect, and that is exactly what takes half an hour to find.
    const errors = []
    if (runner.prompt !== undefined) {
      errors.push(
        `${field}.prompt: belongs beside a profile — an agent written out here carries its own prompt`,
      )
    }
    if (runner.agentOverrides !== undefined) {
      errors.push(`${field}.agentOverrides: there is no profile to override here`)
    }
    if (errors.length > 0) return { ok: false, errors }
    return { ok: true, agent: reference, profileId: null }
  }

  const id = String(reference)
  const profile = profiles.get(id)
  if (!profile) {
    const known = [...profiles.keys()]
    return {
      ok: false,
      errors: [
        `${field}.agent: no profile named "${id}" in profiles/` +
          (known.length > 0 ? ` (known: ${known.join(', ')})` : ''),
      ],
    }
  }

  // The identity, then what this job wants different, then the task. The prompt
  // is last and unconditional: it is the one thing a profile never carries.
  const { id: _id, name: _name, description: _description, $schema: _schema, ...identity } = profile
  const agent = merge(merge(identity, runner.agentOverrides ?? {}), { prompt: runner.prompt })

  return { ok: true, agent, profileId: id }
}

/**
 * Resolves every agent of a job — its own, and those of its workflow steps.
 *
 * The job is modified in place: it is already a clone at this point, and the
 * caller wants the resolved version rather than a second copy of a definition
 * that is not small.
 *
 * @param {object} job validated definition, cloned
 * @param {Map<string, object>} profiles
 * @returns {{ok: true, job: object} | {ok: false, errors: string[]}}
 */
function resolveJobAgents(job, profiles) {
  const errors = []

  const runners = [{ runner: job.runner, field: 'runner' }]
  for (const [index, step] of (job.runner.workflow?.steps ?? []).entries()) {
    if (step.runner) runners.push({ runner: step.runner, field: `runner.workflow.steps.${index}.runner` })
  }

  for (const { runner, field } of runners) {
    if (runner.type !== 'agent') continue

    const resolved = resolveRunnerAgent(runner, profiles, { field })
    if (!resolved.ok) {
      errors.push(...resolved.errors)
      continue
    }

    runner.agent = resolved.agent
    // Kept on the resolved runner, never written back to disk: it is what lets
    // the interface say where these values come from, and what keys the memory
    // this agent carries from one job to the next.
    runner.agentProfile = resolved.profileId
    delete runner.prompt
    delete runner.agentOverrides
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, job }
}

module.exports = { resolveJobAgents, resolveRunnerAgent, merge }
