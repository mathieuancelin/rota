'use strict'

// Turning a job's inline agent into a reusable one.
//
// This is what makes profiles adoptable: nobody is going to rewrite by hand the
// agent jobs they already have, and a feature that only serves definitions
// written after it landed serves very little.
//
// The operation is meant to be invisible from the outside. The job keeps its
// prompt, its schedule, its working directory, its history — and its memory,
// which is the part that takes care: the memory belongs to the agent, so it
// moves to the profile's name. Leaving it behind would make the extraction quietly
// cost an agent everything it had observed, and nothing on screen would say so.
//
// Two precautions, the same ones migrate.js takes with the files it rewrites:
// the original is copied to `.bak` first, and nothing at all is written until
// every piece has been checked.

const fs = require('node:fs/promises')
const path = require('node:path')

const logger = require('../lib/logger')
const memory = require('../agent/memory')
const { readJson, writeJsonAtomic, writeJsonNew } = require('../lib/json-file')
const { validateJob, validateProfile } = require('./validate')

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

/**
 * Splits an inline agent into a profile and what stays with the job.
 *
 * The prompt is the only field that does not travel: it is what this job wants
 * done, not who does it, and it is the whole distinction the profile draws.
 */
function split(agent, { id, name, description }) {
  const { prompt, ...identity } = agent
  return {
    profile: {
      $schema: 'https://rota.local/schemas/profile.schema.json',
      id,
      name,
      ...(description ? { description } : {}),
      ...identity,
    },
    prompt,
  }
}

/**
 * Extracts the agent of a job into profiles/, and points the job at it.
 *
 * @param {object} options
 * @param {object} options.paths configuration directory
 * @param {string} options.jobId job to extract from
 * @param {string} [options.profileId] name of the profile. The job's own by default.
 * @param {string} [options.name] name shown in the interface
 * @returns {Promise<{ok: true, profileId: string, memoryMoved: boolean} | {ok: false, errors: string[]}>}
 */
async function extractProfile({ paths, jobId, profileId = jobId, name = null }) {
  if (!PROFILE_ID.test(profileId)) {
    return { ok: false, errors: [`"${profileId}" is not a usable profile name`] }
  }

  const jobFile = path.join(paths.jobsDir, `${jobId}.json`)
  const read = await readJson(jobFile)
  if (!read.ok) {
    return { ok: false, errors: [`${jobId}: ${read.missing ? 'no such job' : read.error.message}`] }
  }

  const raw = read.value
  const runner = raw?.runner
  if (runner?.type !== 'agent') {
    return { ok: false, errors: [`${jobId} is not an agent job`] }
  }
  if (typeof runner.agent === 'string') {
    return { ok: false, errors: [`${jobId} already points at the profile "${runner.agent}"`] }
  }
  if (runner.agent === null || typeof runner.agent !== 'object') {
    return { ok: false, errors: [`${jobId} carries no agent to extract`] }
  }

  const profileFile = path.join(paths.profilesDir, `${profileId}.json`)
  if (await exists(profileFile)) {
    return { ok: false, errors: [`a profile named "${profileId}" already exists`] }
  }

  const { profile, prompt } = split(runner.agent, {
    id: profileId,
    name: name ?? raw.name ?? profileId,
    description: raw.description,
  })

  // The job as it will read afterwards, with the reference where the block was
  // so that a diff shows a changed line rather than a moved one.
  const rewritten = { ...raw, runner: { ...runner, agent: profileId, prompt } }
  delete rewritten.runner.agentOverrides

  // Checked before anything is written: an extraction that half succeeded would
  // leave a job pointing at a profile that was refused.
  const profileCheck = validateProfile(profile)
  if (!profileCheck.ok) {
    return { ok: false, errors: profileCheck.errors.map((message) => `profile: ${message}`) }
  }
  const jobCheck = validateJob(rewritten, {
    profiles: new Map([[profileId, profileCheck.profile]]),
  })
  if (!jobCheck.ok) {
    return { ok: false, errors: jobCheck.errors.map((message) => `job: ${message}`) }
  }

  // The memory before the definitions: an agent that lost its memory but kept
  // its identity is worse than one that lost neither, and if this fails we have
  // still written nothing that changes behaviour.
  const from = memory.memoryFile(paths.memoryDir, jobId)
  const to = memory.memoryFile(paths.memoryDir, profileId)
  let memoryMoved = false
  if (from !== to && (await exists(from))) {
    if (await exists(to)) {
      return {
        ok: false,
        errors: [
          `a memory already exists under "${profileId}" — delete it, or extract under another name`,
        ],
      }
    }
    await fs.copyFile(from, `${from}.bak`)
    await fs.rename(from, to)
    memoryMoved = true
  }

  await writeJsonNew(profileFile, profile)
  await fs.copyFile(jobFile, `${jobFile}.bak`)
  await writeJsonAtomic(jobFile, rewritten)

  logger.info(
    `${jobId}: agent extracted as "${profileId}"` + (memoryMoved ? ', memory moved with it' : ''),
  )
  return { ok: true, profileId, memoryMoved }
}

module.exports = { extractProfile, split }
