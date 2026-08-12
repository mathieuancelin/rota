'use strict'

// Migration of job definitions from one version of the schema to the next.
//
// The principle: the file on disk is the truth, and it is what gets updated —
// rather than translating a shape the schema no longer documents on every load.
// A definition opened in the editor must look like what the schema describes,
// otherwise completion and error messages talk about a format the file does not
// use.
//
// Two precautions, because these are files the user maintains by hand: the
// original is copied to `.bak` before any rewrite, and a file we cannot read is
// left exactly where it is. A migration that fails must never cost a definition.

const fs = require('node:fs/promises')
const path = require('node:path')

const logger = require('../lib/logger')
const { readJson, writeJsonAtomic } = require('../lib/json-file')

/**
 * `schedule` → `triggers[]`.
 *
 * Scheduling used to be the only possible trigger, and therefore lived in the
 * singular at the root. Now that a job can also start on an HTTP call or a
 * Discord keyword, it is only one trigger among others.
 *
 * The key is replaced in place rather than appended: `triggers` reads where
 * `schedule` read, above `runner`, and a Git diff shows a changed line where the
 * user expects one.
 *
 * @param {object} raw definition as it stands in the file
 * @returns {{changed: boolean, value: object}}
 */
function scheduleToTriggers(raw) {
  const schedule = raw.schedule
  if (schedule === null || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return { changed: false, value: raw }
  }

  // Both shapes at once: `triggers` was written by hand and prevails. The old
  // key is dropped without taking anything from it, rather than adding a trigger
  // nobody asked for.
  const keepBoth = Array.isArray(raw.triggers)

  const value = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (key !== 'schedule') {
      value[key] = entry
      continue
    }
    if (!keepBoth) value.triggers = [schedule]
  }

  return { changed: true, value }
}

const MIGRATIONS = [scheduleToTriggers]

/**
 * Applies the known migrations to a definition.
 * Pure function: this is what the tests exercise.
 *
 * @param {unknown} raw
 * @returns {{changed: boolean, value: unknown}}
 */
function migrateJob(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { changed: false, value: raw }
  }

  let value = raw
  let changed = false
  for (const migration of MIGRATIONS) {
    const result = migration(value)
    if (!result.changed) continue
    value = result.value
    changed = true
  }
  return { changed, value }
}

/**
 * Migrates the whole jobs/ directory, once, at startup.
 *
 * What is not migrated is not reported as an error: the load that follows takes
 * care of that, with its messages and its problem view. Here we only rewrite
 * what we know how to rewrite.
 *
 * @param {string} jobsDir
 * @returns {Promise<{migrated: string[], failed: Array<{id: string, error: string}>}>}
 */
async function migrateJobsDir(jobsDir) {
  const migrated = []
  const failed = []

  let entries
  try {
    entries = await fs.readdir(jobsDir, { withFileTypes: true })
  } catch {
    // No directory: nothing to migrate. Creating it is ensureStructure()'s job.
    return { migrated, failed }
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  for (const fileName of files) {
    const id = path.basename(fileName, '.json')
    const filePath = path.join(jobsDir, fileName)

    const read = await readJson(filePath)
    // Broken JSON is repaired by hand, with the message the load gives. Touching
    // it here would amount to guessing.
    if (!read.ok) continue

    const result = migrateJob(read.value)
    if (!result.changed) continue

    try {
      await fs.copyFile(filePath, `${filePath}.bak`)
      await writeJsonAtomic(filePath, result.value)
      migrated.push(id)
    } catch (err) {
      failed.push({ id, error: err.message })
      logger.error(`migrating ${id} failed`, err)
    }
  }

  if (migrated.length > 0) {
    logger.info(
      `migrated to triggers: ${migrated.join(', ')} — previous versions kept as <id>.json.bak`,
    )
  }

  return { migrated, failed }
}

module.exports = { migrateJob, migrateJobsDir, scheduleToTriggers }
