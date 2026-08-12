'use strict'

// Chaining the steps of a workflow job.
//
// A step is either a reference to an existing job, or a runner written on the
// spot. In both cases it goes through the same execution path as any job — same
// environment, same timeout, same sandbox — with one difference: it writes no
// history entry and notifies nothing. The workflow tells the whole story in a
// single entry, and a referenced job must not appear to have run on its own.
//
// Steps chain in the order written, and the first that fails stops everything —
// unless it says otherwise. A chain whose second link broke rarely has anything
// useful to do with the third.
//
// This module knows neither processes nor docker: it receives the means to run
// a step, and returns the trail. That is what makes it testable without
// starting anything.

const STEP_STATUS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
}

// What a step receives from the ones before it.
//
// A script gets `ROTA_STEPS`, a JSON array it can parse. An agent gets the
// same thing appended to its prompt, in prose: a model reads a paragraph better
// than it reads an escaped array, and it has no environment to read anyway.
//
// Both are bounded, and not out of tidiness: the environment of a child process
// goes through ARG_MAX — a megabyte here — and one chatty step would be enough
// to make every step after it fail to start. What gets dropped is the output of
// the oldest steps, which the transcript still carries in full.
const STEP_OUTPUT_LIMIT = 4000
const STEPS_PAYLOAD_LIMIT = 64_000

const clipOutput = (text) => {
  const flat = String(text ?? '').trim()
  return flat.length > STEP_OUTPUT_LIMIT ? `${flat.slice(0, STEP_OUTPUT_LIMIT)}\n[…truncated]` : flat
}

/** The record of one finished step, as the next ones see it. */
const stepRecord = (name, entry) => ({
  name,
  status: entry.status,
  durationMs: entry.durationMs ?? 0,
  output: clipOutput(entry.stdout),
})

/**
 * The steps so far, as JSON, under the payload ceiling.
 *
 * Trimming starts with the oldest outputs: the last step's is the one the next
 * step is most likely to be working from.
 */
function stepsAsJson(previous) {
  const entries = previous.map((step) => ({ ...step, output: clipOutput(step.output) }))
  for (let i = 0; i < entries.length; i += 1) {
    if (JSON.stringify(entries).length <= STEPS_PAYLOAD_LIMIT) break
    entries[i].output = '[…dropped, see the execution output]'
  }
  return JSON.stringify(entries)
}

/** The same thing, written for a model rather than parsed by a script. */
function stepsAsText(previous) {
  const blocks = previous.map((step, index) => {
    const seconds = (step.durationMs / 1000).toFixed(1)
    const head = `## Step ${index + 1} — ${step.name} (${step.status}, ${seconds} s)`
    const output = clipOutput(step.output)
    return output ? `${head}\n\n${output}` : `${head}\n\n(no output)`
  })
  return blocks.join('\n\n')
}

/**
 * Hands the previous steps to the one about to run.
 *
 * A copy, never the definition itself: a referenced job is the store's, and
 * writing into it would leak one execution's context into the next.
 *
 * A step that declines them — `receivesPreviousSteps: false` — is handed nothing
 * at all, not an empty list: absence is the honest signal for something one
 * asked not to receive.
 */
function withPreviousSteps(jobLike, previous, { receives = true } = {}) {
  if (!receives) return jobLike

  if (previous.length === 0) {
    // An empty variable rather than an absent one: a script can parse it without
    // testing for it first, and `[]` says "you are the first" clearly enough.
    return jobLike.runner.type === 'agent'
      ? jobLike
      : {
          ...jobLike,
          runner: {
            ...jobLike.runner,
            environment: { ...jobLike.runner.environment, ROTA_STEPS: '[]', TICKTRAY_STEPS: '[]' },
          },
        }
  }

  if (jobLike.runner.type === 'agent') {
    return {
      ...jobLike,
      runner: {
        ...jobLike.runner,
        agent: {
          ...jobLike.runner.agent,
          prompt: `${jobLike.runner.agent.prompt}\n\n# What the previous steps produced\n\n${stepsAsText(previous)}`,
        },
      },
    }
  }

  return {
    ...jobLike,
    runner: {
      ...jobLike.runner,
      environment: {
        ...jobLike.runner.environment,
        ROTA_STEPS: stepsAsJson(previous),
        // Deprecated alias, for scripts written before the rename.
        TICKTRAY_STEPS: stepsAsJson(previous),
      },
    },
  }
}

/** Label of a step: its own, that of the job aimed at, or its type. */
function stepLabel(step, resolved) {
  if (step.name) return step.name
  if (step.job) return resolved?.name ?? step.job
  return step.runner.type
}

/**
 * Executable definition of a step written on the spot.
 *
 * It borrows everything from the workflow except its runner: identifier,
 * execution settings, sandbox, environment. That is what makes an agent step
 * find the workflow's memory and working directory rather than creating one per
 * step, which nothing would clean up afterwards.
 */
function inlineJob(job, step, index) {
  const runner = { ...step.runner }
  if (runner.workingDirectory === undefined && job.runner.workingDirectory !== undefined) {
    runner.workingDirectory = job.runner.workingDirectory
  }
  return {
    ...job,
    name: `${job.name} — ${stepLabel(step, null)}`,
    runner,
    // A step's inline code has its own file: two bun-inline steps in the same
    // workflow would otherwise write to the same place.
    inlineVariant: `step-${index + 1}`,
  }
}

/**
 * Trail of a workflow, as an output that reads back like a script's.
 *
 * What a step puts on its standard output is copied there as it is, with no
 * indentation and no prefix: that is what lets the change marker be seen, and
 * whoever reads it back three weeks later recognise what the script wrote.
 */
function createWorkflowTranscript({ onLine = null } = {}) {
  const lines = []
  // A step's output arrives in chunks, which do not stop on newlines. Without
  // this buffer, a line cut across two chunks would become two lines in the
  // trail.
  let pending = ''

  const write = (line) => {
    lines.push(line)
    onLine?.(`${line}\n`)
  }

  const flush = () => {
    if (pending === '') return
    write(pending)
    pending = ''
  }

  return {
    flush,

    header(job, steps) {
      write(`Workflow "${job.name}" — ${steps.length} step${steps.length > 1 ? 's' : ''}`)
      write('')
    },

    step({ index, total, label, origin, command }) {
      write(`── step ${index + 1}/${total} · ${label}${origin} ──`)
      if (command) write(`$ ${command}`)
    },

    output(text) {
      if (!text) return
      pending += text
      const parts = pending.split('\n')
      // The last chunk is not a line until a newline has closed it: it waits for
      // the rest, or for the end of the step.
      pending = parts.pop()
      for (const line of parts) write(line)
    },

    outcome({ status, durationMs, error }) {
      flush()
      const seconds = (durationMs / 1000).toFixed(1)
      if (status === STEP_STATUS.SUCCESS) write(`✓ succeeded in ${seconds} s`)
      else if (status === STEP_STATUS.SKIPPED) write(`· skipped — ${error}`)
      else write(`✗ ${status} in ${seconds} s — ${error ?? 'no reason given'}`)
      write('')
    },

    final(text) {
      flush()
      write('── result ──')
      write(text)
    },

    text() {
      return `${lines.join('\n')}\n`
    },
  }
}

/**
 * Runs the steps, in order.
 *
 * @param {object} options
 * @param {object} options.job the workflow's definition
 * @param {(job: object, opts: object) => Promise<object>} options.execute starts a
 *        step and returns its entry, without recording it
 * @param {(id: string) => object|null} options.resolveJob
 * @param {AbortSignal} options.signal
 * @param {object} options.transcript
 * @param {(text: string) => void} options.onStderr
 * @returns {Promise<{ok: boolean, ran: number, failedAt: number|null, error: string|null}>}
 */
async function runSteps({ job, execute, resolveJob, signal, transcript, onStderr }) {
  const steps = job.runner.workflow.steps
  transcript.header(job, steps)

  let ran = 0
  let failedAt = null
  let error = null
  const previous = []

  for (const [index, step] of steps.entries()) {
    if (signal.aborted) break

    const resolved = step.job ? resolveJob(step.job) : null
    const label = stepLabel(step, resolved)

    // A named job that does not exist is a fault in the definition, not an
    // execution failure: it is reported as such and stops the chain, instead of
    // being passed over in silence.
    if (step.job && !resolved) {
      transcript.step({ index, total: steps.length, label, origin: '', command: null })
      transcript.outcome({
        status: STEP_STATUS.FAILED,
        durationMs: 0,
        error: `unknown job: ${step.job}`,
      })
      if (!step.continueOnError) {
        failedAt = index
        error = `Step ${index + 1} (${label}) names an unknown job: ${step.job}.`
        break
      }
      continue
    }

    const stepJob = withPreviousSteps(resolved ?? inlineJob(job, step, index), previous, {
      receives: step.receivesPreviousSteps !== false,
    })
    const origin = resolved ? ` (job "${resolved.id}")` : ''

    transcript.step({ index, total: steps.length, label, origin, command: null })

    const entry = await execute(stepJob, {
      // A step written on the spot carries the workflow's identifier: the
      // concurrency guard would see the workflow itself, running, and would skip
      // every step. A referenced job keeps its own, and therefore its guard.
      skipConcurrency: !resolved,
      onOutput: (stream, text) => {
        if (stream === 'stdout') transcript.output(text)
        else onStderr(text)
      },
    })
    ran += 1
    previous.push(stepRecord(label, entry))

    const status =
      entry.status === 'success'
        ? STEP_STATUS.SUCCESS
        : entry.status === 'skipped-already-running'
          ? STEP_STATUS.SKIPPED
          : entry.status

    transcript.outcome({
      status,
      durationMs: entry.durationMs ?? 0,
      error: entry.error,
    })

    if (status === STEP_STATUS.SUCCESS || status === STEP_STATUS.SKIPPED) continue
    if (step.continueOnError) continue

    failedAt = index
    error = `Step ${index + 1} (${label}) ${entry.status}: ${entry.error ?? 'no reason given'}`
    break
  }

  const aborted = signal.aborted
  const ok = failedAt === null && !aborted

  transcript.final(
    aborted
      ? `Stopped after ${ran} of ${steps.length} steps.`
      : ok
        ? `${steps.length} step${steps.length > 1 ? 's' : ''} completed.`
        : `${ran} of ${steps.length} steps ran, stopped at step ${failedAt + 1}.`,
  )

  return { ok, ran, failedAt, error }
}

/** Preview shown by the interface, in place of a command line. */
function describeWorkflow(job) {
  const steps = job.runner.workflow?.steps ?? []
  const names = steps.map((step) => step.name ?? step.job ?? step.runner?.type ?? '?')
  return `workflow: ${names.join(' → ')}`
}

module.exports = {
  runSteps,
  withPreviousSteps,
  stepsAsJson,
  stepsAsText,
  STEP_OUTPUT_LIMIT,
  STEPS_PAYLOAD_LIMIT,
  createWorkflowTranscript,
  describeWorkflow,
  inlineJob,
  stepLabel,
  STEP_STATUS,
}
