'use strict'

// Assembling the full state sent to the renderer and to the tray menu.
//
// The renderer holds no business state: it consumes this snapshot. This is
// therefore the only place where the shape of the state is defined.

const { resolveWorkspace } = require('./agent/workspace')
const { listTemplates } = require('./config/templates')
const { describeRunner, describeTriggers } = require('./config/validate')
const { buildCommand, formatCommand } = require('./runner/command')
const { inlineScriptPath } = require('./runner/inline')
const { buildSandboxCommand, sandboxEnv } = require('./runner/sandbox')
const { describeWorkflow } = require('./runner/workflow')

/**
 * @param {object} deps
 * @param {import('./config/store').ConfigStore} deps.store
 * @param {import('./scheduler').Scheduler|null} [deps.scheduler]
 * @param {import('./runner').Runner|null} [deps.runner]
 * @param {import('./state-store').StateStore|null} [deps.state]
 * @param {{supported: boolean, active: boolean, reason: string|null}|null} [deps.autostart]
 * @param {{getStatus: () => object}|null} [deps.notifier]
 * @param {{status: () => object}|null} [deps.discord]
 * @param {{status: () => object}|null} [deps.http]
 * @param {{countsByJob: () => Map<string, object>}|null} [deps.work]
 */
function buildSnapshot({
  store,
  scheduler = null,
  runner = null,
  state = null,
  work = null,
  autostart = null,
  notifier = null,
  discord = null,
  http = null,
}) {
  const config = store.getConfig()
  const jobs = store.getJobs()

  const runningByJob = runner?.runningByJob() ?? new Map()
  const nextRunByJob = scheduler?.nextRunByJob() ?? new Map()
  const lastRunByJob = scheduler?.lastRunByJob() ?? new Map()
  const deferredJobIds = scheduler?.deferredJobIds() ?? new Set()
  // Counts, never the items themselves: this snapshot is rebuilt on every state
  // change and published four times a second, and a queue of a thousand items
  // would ride along with each one. The view reads the list from /api/work.
  const workByJob = work?.countsByJob() ?? new Map()

  const decoratedJobs = jobs.map((job) => ({
    ...job,
    triggerLabel: describeTriggers(job.triggers),
    runnerLabel: describeRunner(job.runner),
    commandPreview: previewCommand(job, store.paths, config),
    running: runningByJob.get(job.id) ?? 0,
    nextRunAt: nextRunByJob.get(job.id) ?? null,
    lastRun: lastRunByJob.get(job.id) ?? null,
    deferredUntilUnlock: deferredJobIds.has(job.id),
    work: workByJob.get(job.id) ?? null,
  }))

  const paused = Boolean(scheduler ? scheduler.isPaused() : config.schedulerPaused)

  const nextRuns = decoratedJobs
    .filter((job) => job.enabled && job.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
    .map((job) => ({ jobId: job.id, name: job.name, at: job.nextRunAt }))

  const recentErrors = state?.getRecentErrors() ?? []
  const acknowledgedAt = state?.getAcknowledgedAt() ?? null

  return {
    scheduler: {
      paused,
      sessionLocked: Boolean(scheduler?.isSessionLocked()),
      running: decoratedJobs.reduce((total, job) => total + job.running, 0),
    },
    jobs: decoratedJobs,
    runningExecutions: runner?.runningExecutions() ?? [],
    nextRuns,
    // The whole queue in four numbers, for the navigation badge.
    work: [...workByJob.values()].reduce(
      (total, counts) => ({
        pending: total.pending + counts.pending,
        running: total.running + counts.claimed + counts.running,
        failed: total.failed + counts.failed,
        done: total.done + counts.done,
      }),
      { pending: 0, running: 0, failed: 0, done: 0 },
    ),
    recentErrors,
    hasUnacknowledgedError: recentErrors.some(
      (error) => !acknowledgedAt || Date.parse(error.at) > Date.parse(acknowledgedAt),
    ),
    // Small, and read by the list, the job form's picker and the editor alike.
    // Each carries the jobs leaning on it: that is what one checks before
    // changing a system prompt several of them share.
    profiles: store.getProfiles().map((profile) => ({
      ...profile,
      usedBy: store.jobsUsingProfile(profile.id),
    })),
    issues: store.getIssues(),
    jobTemplates: listTemplates(),
    autostart: autostart ?? { supported: false, active: false, reason: null },
    notifications: notifier?.getStatus() ?? { supported: false, lastFailure: null },
    discord: discord?.status() ?? { state: 'disabled', error: null, user: null },
    http: http?.status() ?? { state: 'disabled', error: null, url: null },
    config,
    paths: {
      root: store.paths.root,
      jobsDir: store.paths.jobsDir,
      configFile: store.paths.configFile,
    },
  }
}

/**
 * Command displayed by the interface. Must never be executed: the container of
 * a sandboxed job appears there unnamed, since the name comes from the
 * execution and there is none yet.
 */
function previewCommand(job, paths, config) {
  // A workflow does not start a command either: what informs is the chain of
  // steps.
  if (job.runner.type === 'workflow') return describeWorkflow(job)

  // An agent job starts no command: what informs is who it talks to and where
  // it works.
  if (job.runner.type === 'agent') {
    const { agent } = job.runner
    const workspace = resolveWorkspace(job, paths)
    const place = job.execution.sandbox.enabled
      ? `${job.execution.sandbox.image} sur ${workspace}`
      : workspace
    return `agent ${agent.model} @ ${agent.api.baseUrl} — ${place}`
  }

  const scriptPath =
    job.runner.type === 'bun-inline' ? inlineScriptPath(paths, job.id) : job.runner.script

  if (job.execution.sandbox.enabled) {
    return formatCommand(
      buildSandboxCommand({
        job,
        dockerPath: config.runners.dockerPath ?? 'docker',
        scriptPath,
        environment: sandboxEnv(job, { executionId: '…' }),
      }),
    )
  }

  return formatCommand(
    buildCommand(job, { bunPath: config.runners.bunPath ?? 'bun', scriptPath }),
  )
}

module.exports = { buildSnapshot }
