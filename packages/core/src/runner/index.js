'use strict'

// Running jobs in child processes.
//
// Points to watch:
// - `spawn` always receives a command and an argument array, never a shell
//   string, and `shell: true` is never used.
// - Children are started in their own process group, so that a shell script
//   delegating to other commands is killed entirely on timeout — otherwise we
//   leave orphans behind.
// - The environment is an allowlist, completed with the variables the job
//   declares. SSH_AUTH_SOCK is part of it: without it, a `git push` to an SSH
//   remote waits for a passphrase that will never come.
// - A sandboxed job does not take another path: its command is simply wrapped
//   in a `docker run`, and everything that follows is identical.

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { runAgent } = require('../agent')
const { createUnavailableUi } = require('../agent/ui')
const { createDiscordSender } = require('../discord/send')
const { resolveWorkspace } = require('../agent/workspace')
const logger = require('../lib/logger')
const { killGroup } = require('../lib/process')
const { buildCommand, formatCommand } = require('./command')
const { ENV_ALLOWLIST, buildEnv, buildDockerEnv } = require('./env')
const { writeInlineScript } = require('./inline')
const { createLiveTail } = require('./live')
const { parseChangeMarker, parseReports } = require('./markers')
const { createOutputCollector, truncateToBytes } = require('./output')
const { resolveBun, resolveDocker } = require('./resolve-bun')
const { buildKillCommand, buildSandboxCommand, sandboxEnv } = require('./sandbox')
const { createWorkflowTranscript, describeWorkflow, runSteps } = require('./workflow')

const SIGKILL_GRACE_MS = 5000

const STATUS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMED_OUT: 'timed-out',
  CANCELLED: 'cancelled',
  SKIPPED_ALREADY_RUNNING: 'skipped-already-running',
}

const isSandboxed = (job) => job.execution.sandbox.enabled

class Runner extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config/store').ConfigStore} deps.store
   * @param {{append: (entry: object) => Promise<object>}} deps.history
   * @param {{report: Function, ask: Function, confirm: Function}} [deps.ui]
   *        windows available to agent jobs
   * @param {import('../work/store').WorkStore|null} [deps.work] the queues, for
   *        the two tools that speak about them
   */
  constructor({ store, history, ui = createUnavailableUi(), discord = null, work = null }) {
    super()
    this.work = work
    this.store = store
    this.history = history
    this.ui = ui
    // Discord sending shared with the control bridge; null outside the
    // application, the tools then fall back on the settings alone.
    this.discord = discord
    // Job launcher, set afterwards: it needs the scheduler, which needs the
    // runner. `run_job` is only offered to the model if it is there.
    this.jobs = null
    /** @type {Map<string, {job: object, child: object, startedAt: number}>} */
    this.running = new Map()
    /**
     * Executions between the concurrency guard and the spawn. Writing the code
     * of an inline job is asynchronous: without this counter, two triggers in the
     * same tick would both pass the guard, each believing itself alone. That is
     * exactly what happens on wake-up, when a catch-up crosses an occurrence.
     * @type {Map<string, number>}
     */
    this.starting = new Map()
  }

  isRunning(jobId) {
    if (this.starting.has(jobId)) return true
    for (const execution of this.running.values()) {
      if (execution.job.id === jobId) return true
    }
    return false
  }

  #reserve(jobId) {
    this.starting.set(jobId, (this.starting.get(jobId) ?? 0) + 1)
  }

  #release(jobId) {
    const left = (this.starting.get(jobId) ?? 1) - 1
    if (left <= 0) this.starting.delete(jobId)
    else this.starting.set(jobId, left)
  }

  // The steps of a workflow are excluded from the two views below, but not from
  // `isRunning`: the interface shows the workflow, one thing to watch and one to
  // stop, while the concurrency guard needs to know a referenced job is running.

  runningByJob() {
    const counts = new Map()
    for (const execution of this.running.values()) {
      if (execution.nested) continue
      counts.set(execution.job.id, (counts.get(execution.job.id) ?? 0) + 1)
    }
    return counts
  }

  runningExecutions() {
    return [...this.running.entries()]
      .filter(([, execution]) => !execution.nested)
      .map(([executionId, execution]) => ({
        executionId,
        jobId: execution.job.id,
        jobName: execution.job.name,
        startedAt: new Date(execution.startedAt).toISOString(),
      }))
  }

  /**
   * Output already produced by a running execution.
   *
   * What a view claims on opening: without it, one would only see what arrives
   * afterwards, and a job silent for ten minutes would look dead.
   *
   * @param {string} executionId
   * @returns {{ok: true, stdout: object, stderr: object} | {ok: false, error: string}}
   */
  liveOutput(executionId) {
    const execution = this.running.get(executionId)
    if (!execution?.live) return { ok: false, error: 'no running execution under that identifier' }
    return {
      ok: true,
      jobId: execution.job.id,
      stdout: execution.live.stdout.read(),
      stderr: execution.live.stderr.read(),
    }
  }

  /** Emits nothing for a chunk that yields no readable character yet. */
  #emitOutput(executionId, job, stream, chunk) {
    if (chunk === '') return
    this.emit('output', { executionId, jobId: job.id, stream, chunk })
  }

  /**
   * Starts a job.
   *
   * @param {object} job validated definition
   * @param {object} [options]
   * @param {string} [options.trigger]
   * @param {object} [options.nested] workflow step: the execution enters neither
   *        the history, nor the notifications, nor the list of running executions
   *        — the workflow carries all of that for it. It nevertheless stays in
   *        `running`, so that a referenced job's concurrency guard keeps seeing it.
   * @param {{id: string, input: object}|null} [options.work] the queue item this
   *        run was handed. It reaches a script as two environment variables and
   *        an agent as ${work.input}; the runner itself does no more with it than
   *        carry it, and it is the scheduler that decides the item's fate from
   *        the outcome.
   * @returns {Promise<object>} history entry
   */
  async run(job, { trigger = 'schedule', nested = null, work = null } = {}) {
    if (
      !nested?.skipConcurrency &&
      !job.execution.allowConcurrentRuns &&
      this.isRunning(job.id)
    ) {
      return this.#finalize(
        this.#syntheticEntry(job, trigger, {
          status: STATUS.SKIPPED_ALREADY_RUNNING,
          error: 'A previous execution is still running.',
        }),
        nested,
      )
    }

    const executionId = randomUUID()

    // The slot is taken right away, and handed over on entering #spawn, which
    // registers the execution in `running` without going back through the event
    // loop: the relay happens with no gap.
    this.#reserve(job.id)
    try {
      // An agent job has neither a command nor a script: its loop runs here, in
      // the main process, because it must be able to open windows and wait for
      // the answer.
      if (job.runner.type === 'agent') {
        return this.#runAgent(job, { trigger, executionId, nested, work })
      }

      // A workflow has no command either: what it starts are other executions,
      // one after the other.
      if (job.runner.type === 'workflow') {
        return this.#runWorkflow(job, { trigger, executionId, nested, work })
      }

      // The inline code is written first of all: it is the file the command will
      // designate, and that the existence check must find.
      let inlineScript = null
      if (job.runner.type === 'bun-inline') {
        try {
          inlineScript = await writeInlineScript(this.store.paths, job)
        } catch (err) {
          return this.#finalize(
            this.#syntheticEntry(job, trigger, {
              executionId,
              status: STATUS.FAILED,
              error: `Writing the inline code failed: ${err.message}`,
            }),
            nested,
          )
        }
      }

      const resolved = this.#resolveCommand(job, inlineScript, executionId, work)
      if (!resolved.ok) {
        return this.#finalize(
          this.#syntheticEntry(job, trigger, {
            executionId,
            status: STATUS.FAILED,
            error: resolved.error,
          }),
          nested,
        )
      }

      const scriptPath = inlineScript ?? job.runner.script
      if (!fs.existsSync(scriptPath)) {
        return this.#finalize(
          this.#syntheticEntry(job, trigger, {
            executionId,
            status: STATUS.FAILED,
            command: formatCommand(resolved.command),
            error: `Script not found: ${scriptPath}`,
          }),
          nested,
        )
      }

      return this.#spawn(job, {
        trigger,
        executionId,
        nested,
        work,
        command: resolved.command,
        scriptPath,
        dockerPath: resolved.dockerPath ?? null,
      })
    } finally {
      this.#release(job.id)
    }
  }

  #resolveCommand(job, inlineScript, executionId, work = null) {
    const scriptPath = inlineScript ?? job.runner.script

    if (isSandboxed(job)) {
      // Bun is not resolved on the host: it is the image's that runs.
      const docker = resolveDocker(this.store.getConfig().runners.dockerPath)
      if (!docker.ok) return { ok: false, error: docker.error }
      return {
        ok: true,
        dockerPath: docker.path,
        command: buildSandboxCommand({
          job,
          dockerPath: docker.path,
          scriptPath,
          executionId,
          environment: sandboxEnv(job, { executionId, work }),
        }),
      }
    }

    if (job.runner.type === 'shell') {
      return { ok: true, command: buildCommand(job) }
    }
    const bun = resolveBun(this.store.getConfig().runners.bunPath)
    if (!bun.ok) return { ok: false, error: bun.error }
    return { ok: true, command: buildCommand(job, { bunPath: bun.path, inlineScript }) }
  }

  #spawn(
    job,
    { trigger, executionId, command, scriptPath, dockerPath = null, nested = null, work = null },
  ) {
    const startedAt = Date.now()
    const commandLine = formatCommand(command)
    // With no declared directory, the script's — for an inline job, the folder of
    // generated files. In the sandbox, it is the container that carries the
    // working directory, through -w: on the host side only the docker client runs
    // here, and we place it in a folder we know exists.
    const cwd = dockerPath
      ? path.dirname(scriptPath)
      : (job.runner.workingDirectory ?? path.dirname(scriptPath))

    // `spawn` returns ENOENT both for a missing executable and for a working
    // directory that does not exist, and `describeFailure` can no longer tell
    // them apart once the error is raised. We decide here, while we still know
    // which of the two is missing: without this, a forgotten folder sends people
    // checking their Bun installation.
    if (!fs.existsSync(cwd)) {
      return this.#finalize(
        this.#syntheticEntry(job, trigger, {
          executionId,
          status: STATUS.FAILED,
          command: commandLine,
          error: `Working directory not found: ${cwd}`,
        }),
        nested,
      )
    }

    let child
    try {
      child = spawn(command.command, command.args, {
        cwd,
        env: dockerPath ? buildDockerEnv() : buildEnv(job, { executionId, work }),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Dedicated process group: allows killing the whole descent.
        detached: true,
      })
    } catch (err) {
      return this.#finalize(
        this.#syntheticEntry(job, trigger, {
          executionId,
          status: STATUS.FAILED,
          command: commandLine,
          error: `Launch failed: ${err.message}`,
        }),
        nested,
      )
    }

    const maxBytes = job.execution.maxOutputBytes
    const stdout = createOutputCollector({ maxBytes })
    const stderr = createOutputCollector({ maxBytes })
    const live = { stdout: createLiveTail(), stderr: createLiveTail() }

    // A step hands its output back to the workflow, which carries it in its own:
    // two live streams for a single visible execution would get in each other's way.
    const publish = (stream, chunk) => {
      if (nested) nested.onOutput(stream, chunk.toString())
      else this.#emitOutput(executionId, job, stream, live[stream].push(chunk))
    }

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      publish('stdout', chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk)
      publish('stderr', chunk)
    })

    this.running.set(executionId, { job, child, startedAt, live, nested: Boolean(nested) })
    if (!nested) {
      this.emit('started', {
        executionId,
        jobId: job.id,
        jobName: job.name,
        trigger,
        startedAt: new Date(startedAt).toISOString(),
        command: commandLine,
      })
    }
    logger.info(`▶ ${job.id} (${trigger}) — ${commandLine}`)

    return new Promise((resolve) => {
      let outcome = null // 'timeout' | 'cancel'
      let killTimer = null

      const escalate = () => {
        killTimer = setTimeout(() => {
          // Killing the docker client does not stop the container: it runs in the
          // daemon, outside our process group. Without this `docker kill`, an
          // exceeded timeout would let the job run indefinitely, which is
          // precisely what the timeout must prevent.
          if (dockerPath) this.#killContainer(dockerPath, executionId)
          killGroup(child, 'SIGKILL')
        }, SIGKILL_GRACE_MS)
        killTimer.unref?.()
      }

      const timeoutTimer = setTimeout(() => {
        outcome = 'timeout'
        logger.warn(`⏱ ${job.id} exceeded ${job.execution.timeoutSeconds} s, stop requested`)
        killGroup(child, 'SIGTERM')
        escalate()
      }, job.execution.timeoutSeconds * 1000)

      const finish = async (code, signal, spawnError) => {
        clearTimeout(timeoutTimer)
        if (killTimer) clearTimeout(killTimer)
        this.running.delete(executionId)

        const finishedAt = Date.now()
        const out = stdout.result()
        const err = stderr.result()

        let status
        if (outcome === 'timeout') status = STATUS.TIMED_OUT
        else if (outcome === 'cancel') status = STATUS.CANCELLED
        else if (spawnError) status = STATUS.FAILED
        else if (code === 0) status = STATUS.SUCCESS
        else status = STATUS.FAILED

        const entry = {
          executionId,
          jobId: job.id,
          jobName: job.name,
          trigger,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
          status,
          exitCode: code ?? null,
          signal: signal ?? null,
          command: commandLine,
          workingDirectory: cwd,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          // Real effect reported by the script, if it did.
          change: parseChangeMarker(out.text),
          error: describeFailure({ status, code, signal, spawnError, job }),
        }

        resolve(await this.#finalize(entry, nested, parseReports(out.text)))
      }

      child.on('error', (err) => finish(null, null, err))
      child.on('close', (code, signal) => finish(code, signal, null))

      const cancel = () => {
        outcome = 'cancel'
        killGroup(child, 'SIGTERM')
        escalate()
      }
      this.running.get(executionId).cancel = cancel
      // The workflow holds what it takes to stop the running step: it is the one
      // stopped from the interface, and the stop must go down to the process.
      nested?.onCancelable?.(cancel)
    })
  }

  /**
   * Execution of an agent job.
   *
   * Same contract as `#spawn` — registration in `running` before any `await`, a
   * `started` event, a history entry of the same shape — but with no child
   * process: here the stop is an `AbortController`, and the exit code is a
   * convention rather than a real process status.
   */
  #runAgent(job, { trigger, executionId, nested = null, work = null }) {
    const startedAt = Date.now()
    const { agent } = job.runner
    const commandLine = `agent ${agent.model} @ ${agent.api.baseUrl}`
    const workspace = resolveWorkspace(job, this.store.paths)

    const controller = new AbortController()
    let outcome = null // 'timeout' | 'cancel'

    // An agent has no output stream: its transcript stands in for one, line by
    // line, and is watched scrolling past like a script's.
    const live = { stdout: createLiveTail(), stderr: createLiveTail() }

    // Registered without going back through the event loop, like #spawn: the
    // relay with `run`'s reservation happens with no gap.
    const cancel = () => {
      outcome = 'cancel'
      controller.abort()
    }
    this.running.set(executionId, {
      job,
      child: null,
      startedAt,
      live,
      cancel,
      nested: Boolean(nested),
    })
    nested?.onCancelable?.(cancel)
    if (!nested) {
      this.emit('started', {
        executionId,
        jobId: job.id,
        jobName: job.name,
        trigger,
        startedAt: new Date(startedAt).toISOString(),
        command: commandLine,
      })
    }
    logger.info(`▶ ${job.id} (${trigger}) — ${commandLine}`)

    const timeoutTimer = setTimeout(() => {
      outcome = 'timeout'
      logger.warn(`⏱ ${job.id} exceeded ${job.execution.timeoutSeconds} s, stop requested`)
      controller.abort()
    }, job.execution.timeoutSeconds * 1000)

    return (async () => {
      let result
      try {
        result = await runAgent({
          job,
          paths: this.store.paths,
          executionId,
          trigger,
          work,
          workStore: this.work,
          ui: this.ui,
          // Nobody at the screen means the tools that wait for an answer are
          // withdrawn before the turn rather than failing in the middle of it,
          // and the transcript says which and why. A ui that does not know how
          // to answer the question counts as attended, which is what every
          // interface built before this was.
          unattended: this.ui?.attached ? !this.ui.attached() : false,
          dockerPath: this.store.getConfig().runners.dockerPath,
          integrations: this.store.getConfig().integrations,
          discord: this.discord,
          jobs: this.jobs,
          signal: controller.signal,
          onLine: (line) =>
            nested
              ? nested.onOutput('stdout', line)
              : this.#emitOutput(executionId, job, 'stdout', live.stdout.push(line)),
        })
      } catch (err) {
        // A Rota defect, not the job's: it must stay readable in the history
        // rather than disappearing into a rejected promise.
        logger.error(`agent loop of ${job.id} failed`, err)
        result = {
          ok: false,
          stdout: '',
          stderr: `${err.stack ?? err.message}\n`,
          change: null,
          iterations: 0,
          error: `internal agent failure: ${err.message}`,
          aborted: false,
        }
      } finally {
        clearTimeout(timeoutTimer)
        this.running.delete(executionId)
      }

      let status
      if (outcome === 'timeout') status = STATUS.TIMED_OUT
      else if (outcome === 'cancel') status = STATUS.CANCELLED
      else if (result.ok) status = STATUS.SUCCESS
      else status = STATUS.FAILED

      const maxBytes = job.execution.maxOutputBytes
      const stdout = truncateToBytes(result.stdout, maxBytes)
      const stderr = truncateToBytes(result.stderr, maxBytes)
      const finishedAt = Date.now()

      return this.#record({
        executionId,
        jobId: job.id,
        jobName: job.name,
        trigger,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        status,
        // A loop has no exit code: 0 when it went to its end, 1 otherwise.
        // Nothing killed a process, so no signal.
        exitCode: status === STATUS.SUCCESS ? 0 : status === STATUS.FAILED ? 1 : null,
        signal: null,
        command: commandLine,
        workingDirectory: workspace,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        change: result.change ? { changed: true, message: result.change } : null,
        error: describeAgentFailure({ status, job, result }),
      })
    })()
  }

  /**
   * Execution of a workflow job: its steps, one after the other.
   *
   * Same contract as the two above, and the same entry shape — but what it
   * starts are other executions, which write nothing on their side. The stop
   * goes down to the running step: stopping a workflow without stopping the
   * process it waits on would not stop it.
   */
  #runWorkflow(job, { trigger, executionId, nested = null, work = null }) {
    const startedAt = Date.now()
    const steps = job.runner.workflow.steps
    const commandLine = describeWorkflow(job)

    // Steps that declare none inherit this one: it is where they meet, and a
    // chain whose every step fails for want of a `mkdir` teaches nobody
    // anything. An agent job already does the same.
    if (job.runner.workingDirectory) {
      try {
        fs.mkdirSync(job.runner.workingDirectory, { recursive: true })
      } catch (err) {
        return this.#finalize(
          this.#syntheticEntry(job, trigger, {
            executionId,
            status: STATUS.FAILED,
            command: commandLine,
            error: `Unusable working directory: ${err.message}`,
          }),
          nested,
        )
      }
    }

    const live = { stdout: createLiveTail(), stderr: createLiveTail() }
    const controller = new AbortController()
    let outcome = null // 'timeout' | 'cancel'
    let stopStep = null

    const cancel = () => {
      outcome = 'cancel'
      controller.abort()
      // The running step has its own process: interrupting the chain does not
      // touch it, it has to be asked.
      stopStep?.()
    }

    this.running.set(executionId, {
      job,
      child: null,
      startedAt,
      live,
      cancel,
      nested: Boolean(nested),
    })
    nested?.onCancelable?.(cancel)
    if (!nested) {
      this.emit('started', {
        executionId,
        jobId: job.id,
        jobName: job.name,
        trigger,
        startedAt: new Date(startedAt).toISOString(),
        command: commandLine,
      })
    }
    logger.info(`▶ ${job.id} (${trigger}) — ${commandLine}`)

    const timeoutTimer = setTimeout(() => {
      outcome = 'timeout'
      logger.warn(`⏱ ${job.id} exceeded ${job.execution.timeoutSeconds} s, stop requested`)
      controller.abort()
      stopStep?.()
    }, job.execution.timeoutSeconds * 1000)

    return (async () => {
      const publish = (stream, text) => {
        if (nested) nested.onOutput(stream, text)
        else this.#emitOutput(executionId, job, stream, live[stream].push(text))
      }

      const transcript = createWorkflowTranscript({ onLine: (line) => publish('stdout', line) })
      const stderr = []

      let result
      try {
        result = await runSteps({
          job,
          transcript,
          signal: controller.signal,
          resolveJob: (id) => this.store.getJob(id),
          onStderr: (text) => {
            stderr.push(text)
            publish('stderr', text)
          },
          execute: (stepJob, { skipConcurrency, onOutput }) =>
            this.run(stepJob, {
              trigger: 'workflow',
              // Every step is handed the same item as the workflow itself. A
              // chain that came off a queue is working on one thing, and a step
              // that could not see which would be the only part of it that
              // could not.
              work,
              nested: {
                skipConcurrency,
                onOutput,
                onCancelable: (stop) => {
                  stopStep = stop
                },
              },
            }),
        })
      } catch (err) {
        // A Rota defect, not the job's: it must stay readable in the history
        // rather than disappearing into a rejected promise.
        logger.error(`workflow ${job.id} failed`, err)
        transcript.final(`internal failure: ${err.message}`)
        result = { ok: false, ran: 0, failedAt: null, error: `internal failure: ${err.message}` }
      } finally {
        clearTimeout(timeoutTimer)
        this.running.delete(executionId)
        stopStep = null
      }

      let status
      if (outcome === 'timeout') status = STATUS.TIMED_OUT
      else if (outcome === 'cancel') status = STATUS.CANCELLED
      else if (result.ok) status = STATUS.SUCCESS
      else status = STATUS.FAILED

      const maxBytes = job.execution.maxOutputBytes
      const out = truncateToBytes(transcript.text(), maxBytes)
      const err = truncateToBytes(stderr.join(''), maxBytes)
      const finishedAt = Date.now()

      return this.#finalize(
        {
          executionId,
          jobId: job.id,
          jobName: job.name,
          trigger,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
          status,
          // Like an agent loop: a chain of steps has no exit code of its own, 0 if
          // it went to the end and 1 otherwise.
          exitCode: status === STATUS.SUCCESS ? 0 : status === STATUS.FAILED ? 1 : null,
          signal: null,
          command: commandLine,
          workingDirectory: job.runner.workingDirectory ?? null,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          // What a step reported holds for the workflow: its output is copied as
          // it is into the trail, marker included.
          change: parseChangeMarker(out.text),
          error: describeWorkflowFailure({ status, job, result }),
        },
        nested,
        // Same reasoning for the reports a step asked for: the workflow speaks
        // for the whole chain, so it is the one that delivers them — the step,
        // being nested, delivered nothing.
        parseReports(out.text),
      )
    })()
  }

  /** Forced stop of an execution's container, past the grace period. */
  #killContainer(dockerPath, executionId) {
    const { command, args } = buildKillCommand(dockerPath, executionId)
    try {
      // Detached and outputs ignored: this is cleanup, its failure must neither
      // block nor pollute the job's history.
      const killer = spawn(command, args, { stdio: 'ignore', detached: true, env: buildDockerEnv() })
      killer.on('error', (err) => logger.warn(`stopping the container failed: ${err.message}`))
      killer.unref()
    } catch (err) {
      logger.warn(`stopping the container failed: ${err.message}`)
    }
  }

  /** Requests the stop of a running execution. */
  cancel(executionId) {
    const execution = this.running.get(executionId)
    if (!execution?.cancel) return false
    logger.info(`■ stop requested for ${execution.job.id}`)
    execution.cancel()
    return true
  }

  /** Stops every execution — called when the application closes. */
  cancelAll() {
    for (const executionId of [...this.running.keys()]) this.cancel(executionId)
  }

  #syntheticEntry(job, trigger, overrides) {
    const at = new Date().toISOString()
    return {
      executionId: randomUUID(),
      jobId: job.id,
      jobName: job.name,
      trigger,
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      exitCode: null,
      signal: null,
      command: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      change: null,
      ...overrides,
    }
  }

  /**
   * End of an execution: history and announcement, except for a step.
   *
   * A step writes nothing and announces nothing — its entry serves the workflow,
   * which draws its trail and its status from it. Otherwise a referenced job
   * would appear to have run on its own, with its notification and its history
   * line.
   */
  #finalize(entry, nested, reports = null) {
    // A step delivers nothing: it is the workflow that speaks, and it will find
    // the markers again in the trail, where the step's output was copied.
    if (nested) return entry
    if (reports?.length) this.#deliverReports(entry, reports)
    return this.#record(entry)
  }

  /**
   * Delivers the reports a script asked for, by its markers.
   *
   * Not awaited: `report` hands back immediately for an agent too, and a Discord
   * server being slow must not hold back the history entry. A failed sending is
   * logged rather than raised — the run went well, only its telling did not.
   */
  #deliverReports(entry, reports) {
    const from = entry.jobName
    const sender = this.discord ?? createDiscordSender({ integrations: this.#integrations() })
    const mirror = this.#integrations().mirrorReportsToDiscord !== false

    for (const { destination, title, markdown } of reports) {
      const publish = () =>
        sender.send({ text: `${title ? `**${title}**\n` : ''}${markdown}`, from }).then((result) => {
          if (!result.ok) logger.warn(`${entry.jobId}: Discord report failed — ${result.error}`)
        })

      if (destination === 'discord') {
        publish().catch((err) => logger.error(`${entry.jobId}: Discord report failed`, err))
        continue
      }

      this.ui.report({ title: title ?? from, markdown }).catch((err) => {
        logger.error(`${entry.jobId}: report window failed`, err)
      })
      // Same mirror as the agent's `report`: a window assumes someone in front
      // of the screen, which a scheduled job almost never has.
      if (mirror && sender.available) {
        publish().catch((err) => logger.error(`${entry.jobId}: Discord mirror failed`, err))
      }
    }
  }

  #integrations() {
    return this.store.getConfig().integrations ?? {}
  }

  async #record(entry) {
    const job = this.store.getJob(entry.jobId)
    const stored = job?.history.enabled === false ? entry : await this.history.append(entry, job)
    logger.info(`◀ ${entry.jobId} — ${entry.status} in ${entry.durationMs} ms`)
    this.emit('finished', stored)
    return stored
  }
}

/**
 * Cause of failure of an agent job.
 *
 * `describeFailure` reasons in exit codes and signals, which make no sense
 * here: what was missing is a server, a conclusion or time.
 */
function describeAgentFailure({ status, job, result }) {
  if (status === STATUS.TIMED_OUT) {
    return `The agent exceeded ${job.execution.timeoutSeconds} seconds and was stopped.`
  }
  if (status === STATUS.CANCELLED) return 'Stop requested from Rota.'
  if (status === STATUS.FAILED) return result.error ?? 'The agent did not reach a conclusion.'
  return null
}

/**
 * Cause of failure of a workflow.
 *
 * What was missing is a step, and saying so is enough: its detail is just above
 * in the trail, in its chronological place.
 */
function describeWorkflowFailure({ status, job, result }) {
  if (status === STATUS.TIMED_OUT) {
    return `The workflow exceeded ${job.execution.timeoutSeconds} seconds and was stopped.`
  }
  if (status === STATUS.CANCELLED) return 'Stop requested from Rota.'
  if (status === STATUS.FAILED) return result.error ?? 'A step failed.'
  return null
}

function describeFailure({ status, code, signal, spawnError, job }) {
  if (spawnError) {
    if (spawnError.code === 'ENOENT') {
      const tool = job.runner.type === 'shell' ? job.runner.interpreter : 'Bun'
      return `Command not found. Check the script path and the ${tool} installation.`
    }
    if (spawnError.code === 'EACCES') return 'Not enough permissions to run the command.'
    return spawnError.message
  }
  if (status === STATUS.TIMED_OUT) {
    return `The script exceeded ${job.execution.timeoutSeconds} seconds and was stopped.`
  }
  if (status === STATUS.CANCELLED) return 'Stop requested from Rota.'
  if (status === STATUS.FAILED) {
    if (signal) return `The script was stopped by signal ${signal}.`
    return `The script exited with code ${code}.`
  }
  return null
}

module.exports = { Runner, STATUS, ENV_ALLOWLIST, describeFailure }
