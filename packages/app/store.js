'use strict'

// Source of truth for job definitions and the global configuration.
//
// Central rule: an invalid JSON file never replaces the definition held in
// memory. The job keeps running on its last valid version, flagged "stale", and
// the error surfaces in the interface. A typo in an editor must not make a job
// disappear.

const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const path = require('node:path')

const logger = require('../lib/logger')
const { readJson, writeJsonAtomic, writeJsonNew } = require('../lib/json-file')
const { resolvePaths, DEFAULT_CONFIG } = require('./paths')
const { buildFromTemplate } = require('./templates')
const { validateJob, validateProfile, validateConfig } = require('./validate')

class ConfigStore extends EventEmitter {
  constructor(paths = resolvePaths()) {
    super()
    this.paths = paths
    /** @type {Map<string, object>} last valid definition, indexed by id */
    this.jobs = new Map()
    /** @type {Map<string, object>} reusable agents, indexed by id */
    this.profiles = new Map()
    /** @type {Set<string>} ids whose file is currently invalid */
    this.staleIds = new Set()
    /** @type {Array<{scope: string, file: string|null, id: string|null, errors: string[], at: string}>} */
    this.issues = []
    this.config = structuredClone(DEFAULT_CONFIG)
  }

  getConfig() {
    return this.config
  }

  /** Jobs sorted by name, with the stale flag. */
  getJobs() {
    return [...this.jobs.values()]
      .map((job) => ({ ...job, stale: this.staleIds.has(job.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }

  getJob(id) {
    const job = this.jobs.get(id)
    return job ? { ...job, stale: this.staleIds.has(id) } : null
  }

  getIssues() {
    return this.issues
  }

  /** Reusable agents, sorted by name. */
  getProfiles() {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }

  getProfile(id) {
    return this.profiles.get(id) ?? null
  }

  /** Identifiers of the jobs pointing at a profile — what the interface asks. */
  jobsUsingProfile(id) {
    return this.getJobs()
      .filter((job) => usedProfiles(job).has(id))
      .map((job) => job.id)
  }

  /** Reloads config.json, profiles/ and the whole of jobs/. Emits "change". */
  async reload() {
    const issues = []
    await this.#reloadConfig(issues)
    // Before the jobs, which resolve against them: a job naming a profile that
    // has not been read yet would be refused for the length of one reload.
    await this.#reloadProfiles(issues)
    await this.#reloadJobs(issues)
    this.issues = issues
    this.emit('change', { config: this.config, jobs: this.getJobs(), issues })
    return { config: this.config, jobs: this.getJobs(), issues }
  }

  async #reloadConfig(issues) {
    const read = await readJson(this.paths.configFile)
    if (!read.ok) {
      // File absent: we start from the defaults, that is not an error.
      if (read.missing) {
        this.config = structuredClone(DEFAULT_CONFIG)
        return
      }
      issues.push(
        issue('config', this.paths.configFile, null, [`Unreadable JSON: ${read.error.message}`]),
      )
      return // we keep the previous configuration
    }

    const result = validateConfig(read.value)
    if (!result.ok) {
      issues.push(issue('config', this.paths.configFile, null, result.errors))
      return // we keep the previous configuration
    }
    this.config = result.config
  }

  /**
   * Reloads profiles/.
   *
   * Unlike a job, a broken profile is dropped rather than kept in its last valid
   * form. A job that survives on an old definition still does what it did
   * yesterday; a profile that did so would silently lend an out-of-date identity
   * to every job pointing at it, and nothing on screen would say which version
   * was running. The jobs go stale instead, each naming the profile.
   */
  async #reloadProfiles(issues) {
    let entries
    try {
      entries = await fs.readdir(this.paths.profilesDir, { withFileTypes: true })
    } catch (err) {
      // Absent is the ordinary case: an installation that uses no profile has
      // no such directory, and that is not a problem to report.
      if (err.code !== 'ENOENT') {
        issues.push(issue('profiles', this.paths.profilesDir, null, [`Directory unreadable: ${err.message}`]))
      }
      this.profiles.clear()
      return
    }

    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()

    const loaded = new Map()
    for (const fileName of files) {
      const id = path.basename(fileName, '.json')
      const filePath = path.join(this.paths.profilesDir, fileName)

      const read = await readJson(filePath)
      if (!read.ok) {
        issues.push(issue('profile', filePath, id, [`Unreadable JSON: ${read.error.message}`]))
        continue
      }

      const result = validateProfile(read.value)
      if (!result.ok) {
        issues.push(issue('profile', filePath, id, result.errors))
        continue
      }
      // As for a job: the file name is what everything else designates it by —
      // the reference in a job, and the memory it carries.
      if (result.profile.id !== id) {
        issues.push(
          issue('profile', filePath, id, [
            `id: "${result.profile.id}" does not match the file name (expected "${id}")`,
          ]),
        )
        continue
      }

      loaded.set(id, result.profile)
    }

    this.profiles = loaded
  }

  async #reloadJobs(issues) {
    let entries
    try {
      entries = await fs.readdir(this.paths.jobsDir, { withFileTypes: true })
    } catch (err) {
      issues.push(issue('jobs', this.paths.jobsDir, null, [`Directory unreadable: ${err.message}`]))
      return
    }

    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()

    const seen = new Set()

    for (const fileName of files) {
      const id = path.basename(fileName, '.json')
      const filePath = path.join(this.paths.jobsDir, fileName)
      seen.add(id)

      const read = await readJson(filePath)
      if (!read.ok) {
        this.#markInvalid(id, issues, filePath, [`Unreadable JSON: ${read.error.message}`])
        continue
      }

      const result = validateJob(read.value, { profiles: this.profiles })
      if (!result.ok) {
        this.#markInvalid(id, issues, filePath, result.errors)
        continue
      }

      // The file name is authoritative: it is what indexes the history.
      if (result.job.id !== id) {
        this.#markInvalid(id, issues, filePath, [
          `id: "${result.job.id}" does not match the file name (expected "${id}")`,
        ])
        continue
      }

      this.jobs.set(id, result.job)
      this.staleIds.delete(id)
    }

    // A deleted file removes the job: that is a deliberate action, not an error.
    for (const id of [...this.jobs.keys()]) {
      if (!seen.has(id)) {
        this.jobs.delete(id)
        this.staleIds.delete(id)
      }
    }
  }

  #markInvalid(id, issues, filePath, errors) {
    issues.push(issue('job', filePath, id, errors))
    if (this.jobs.has(id)) this.staleIds.add(id)
  }

  /**
   * Writes a job definition after validation.
   * @param {string} id
   * @param {unknown} raw JSON content already parsed
   * @returns {Promise<{ok: true} | {ok: false, errors: string[]}>}
   */
  async saveJob(id, raw) {
    const result = validateJob(raw, { profiles: this.profiles })
    if (!result.ok) return result
    if (result.job.id !== id) {
      return { ok: false, errors: [`id: "${result.job.id}" does not match "${id}"`] }
    }
    await writeJsonAtomic(path.join(this.paths.jobsDir, `${id}.json`), raw)
    return { ok: true }
  }

  /**
   * Deletes a job's file.
   *
   * The rest follows by itself: the watcher reloads, the scheduler disarms its
   * timer, and the orphan sweep removes state, history, generated code and
   * memory. What matters here is therefore to leave nothing half done — hence a
   * single operation, on a single file.
   *
   * @param {string} id
   * @returns {Promise<{ok: true} | {ok: false, errors: string[]}>}
   */
  async deleteJob(id) {
    try {
      await fs.rm(path.join(this.paths.jobsDir, `${id}.json`), { force: false })
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, errors: [`Unknown job: ${id}`] }
      return { ok: false, errors: [`Delete failed: ${err.message}`] }
    }
    logger.info(`job ${id} deleted`)
    return { ok: true }
  }

  /**
   * Turns a job's scheduling on or off.
   *
   * The file is re-read then rewritten with that one field changed, rather than
   * serialised from the in-memory definition: that one carries the defaults
   * applied at load time, and writing them would freeze into the file settings
   * the user never asked for.
   *
   * @param {string} id
   * @param {boolean} enabled
   * @returns {Promise<{ok: true} | {ok: false, errors: string[]}>}
   */
  async setJobEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') return { ok: false, errors: ['Expected value: boolean'] }

    const filePath = path.join(this.paths.jobsDir, `${id}.json`)
    const read = await readJson(filePath)
    if (!read.ok) return { ok: false, errors: [`Read failed: ${read.error.message}`] }

    // Normalised rewrite: the file's original indentation is not preserved.
    await writeJsonAtomic(filePath, { ...read.value, enabled })
    logger.info(`job ${id} ${enabled ? 'enabled' : 'disabled'}`)
    return { ok: true }
  }

  /**
   * Creates a job from a template.
   *
   * Refuses to overwrite: an identifier already taken would designate the same
   * job, whose definition would be lost and whose history would be silently
   * reassigned.
   *
   * @param {string} id identifier, already validated on its shape by the caller
   * @param {string} templateId
   * @returns {Promise<{ok: true, job: object} | {ok: false, errors: string[]}>}
   */
  async createJob(id, templateId) {
    const raw = buildFromTemplate(templateId, id, {
      scriptsDir: this.paths.scriptsDir,
      agentsDir: this.paths.agentsDir,
    })
    if (!raw) return { ok: false, errors: [`Unknown template: ${templateId}`] }

    const result = validateJob(raw)
    // A template that does not produce a valid definition is a Rota bug, not
    // an input error: it is covered by a test.
    if (!result.ok) return result

    try {
      await writeJsonNew(path.join(this.paths.jobsDir, `${id}.json`), raw)
    } catch (err) {
      if (err.code === 'EEXIST') {
        return { ok: false, errors: [`A job "${id}" already exists.`] }
      }
      return { ok: false, errors: [`Write failed: ${err.message}`] }
    }
    return { ok: true, job: result.job }
  }

  /** Updates a subset of the global configuration and writes it to disk. */
  async patchConfig(patch) {
    const merged = { ...this.config, ...patch }
    const result = validateConfig(merged)
    if (!result.ok) return result
    this.config = result.config
    await writeJsonAtomic(this.paths.configFile, this.config)
    return { ok: true }
  }
}

function issue(scope, file, id, errors) {
  return { scope, file, id, errors, at: new Date().toISOString() }
}

/**
 * Profiles a resolved job leans on — its own agent, and its steps'.
 *
 * Read off the resolved definition rather than the file: a workflow step naming
 * a profile counts as much as the job itself, and the resolution has already
 * been through both.
 */
function usedProfiles(job) {
  const found = new Set()
  const runners = [job.runner, ...(job.runner?.workflow?.steps ?? []).map((step) => step.runner)]
  for (const runner of runners) {
    if (runner?.agentProfile) found.add(runner.agentProfile)
  }
  return found
}

module.exports = { ConfigStore, usedProfiles }
