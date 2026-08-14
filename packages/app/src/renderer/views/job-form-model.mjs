// What the form does to a definition, knowing nothing of React.
//
// Separate from the view so that it can be exercised: switching from one type to
// another is the part that breaks. Changing `runner.type` does not come down to
// changing a string — the old type's fields become validation errors, the new
// one's are missing, and a half-converted definition no longer saves.
//
// The schema is passed as an argument rather than imported: that is what allows
// this module to be loaded both from the renderer bundle and from a test.

/**
 * Follows an internal reference — "#/definitions/runner".
 *
 * The runner is described once and reused by the steps of a workflow: without
 * this resolution, the form would land on the reference and lose in one go the
 * explanations and the default values of all its fields.
 */
function deref(schema, node) {
  let current = node
  // A reference may designate another; the bound stops a circular schema making
  // the form go round in circles.
  for (let hops = 0; current && hops < 10; hops += 1) {
    if (current.$ref) {
      if (!current.$ref.startsWith('#/')) return null
      current = current.$ref
        .slice(2)
        .split('/')
        .reduce((target, key) => target?.[key], schema)
      continue
    }
    // A field that accepts more than one shape: the form follows the object.
    // `runner.agent` is either written out in full or names a reusable profile,
    // and it is the written-out one that has fields to draw — the reference is
    // an identifier, which the form offers as a list instead.
    if (Array.isArray(current.oneOf)) {
      const written = current.oneOf.find(
        (branch) => branch.$ref || branch.type === 'object' || branch.properties,
      )
      if (!written) break
      current = written
      continue
    }
    break
  }
  return current
}

export function schemaNode(schema, path) {
  let node = schema
  for (const key of path) {
    // An index crosses an array: what the schema describes is `items`, the same
    // for every element. That is what lets a trigger field go and fetch its
    // explanation where it is written, once and for all.
    node = typeof key === 'number' ? node?.items : node?.properties?.[key]
    node = deref(schema, node)
    if (!node) return null
  }
  return node
}

export const schemaDefault = (schema, path) => schemaNode(schema, path)?.default
export const schemaHint = (schema, path) => schemaNode(schema, path)?.description

export function readPath(target, path) {
  return path.reduce((value, key) => (value == null ? undefined : value[key]), target)
}

/** Value displayed: the file's, otherwise the one the schema will apply. */
export function effective(schema, job, path) {
  const value = readPath(job, path)
  return value === undefined ? schemaDefault(schema, path) : value
}

export function writePath(target, path, value) {
  let node = target
  for (const key of path.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {}
    node = node[key]
  }
  node[path.at(-1)] = value
}

export function deletePath(target, path) {
  const parent = readPath(target, path.slice(0, -1))
  if (parent && typeof parent === 'object') delete parent[path.at(-1)]
}

export const TRIGGER_SEEDS = {
  interval: {
    drop: ['expression', 'token', 'keyword', 'event', 'job', 'on', 'path', 'settleSeconds', 'at', 'maxAttempts', 'backoffSeconds'],
    seed: { every: 15, unit: 'minutes' },
  },
  cron: {
    drop: ['every', 'unit', 'token', 'keyword', 'event', 'job', 'on', 'path', 'settleSeconds', 'at', 'maxAttempts', 'backoffSeconds'],
    seed: { expression: '0 9 * * 1-5' },
  },
  webhook: { drop: ['every', 'unit', 'expression', 'keyword', 'event', 'job', 'on', 'path', 'settleSeconds', 'at', 'maxAttempts', 'backoffSeconds'], seed: {} },
  discord: { drop: ['every', 'unit', 'expression', 'token', 'event', 'job', 'on', 'path', 'settleSeconds', 'at', 'maxAttempts', 'backoffSeconds'], seed: { keyword: '' } },
  power: {
    drop: ['every', 'unit', 'expression', 'token', 'keyword', 'job', 'on', 'path', 'settleSeconds', 'at', 'maxAttempts', 'backoffSeconds'],
    seed: { event: 'wake' },
  },
  path: {
    drop: ['every', 'unit', 'expression', 'token', 'keyword', 'event', 'job', 'on', 'at', 'maxAttempts', 'backoffSeconds'],
    seed: { path: '' },
  },
  once: {
    drop: ['every', 'unit', 'expression', 'token', 'keyword', 'event', 'job', 'on', 'path', 'settleSeconds', 'maxAttempts', 'backoffSeconds'],
    seed: { at: '' },
  },
  after: {
    drop: ['every', 'unit', 'expression', 'token', 'keyword', 'event', 'path', 'settleSeconds', 'at', 'maxAttempts', 'backoffSeconds'],
    seed: { job: '', on: 'success' },
  },
  work: {
    drop: ['every', 'unit', 'expression', 'token', 'keyword', 'event', 'job', 'on', 'path', 'settleSeconds', 'at', 'maxAttempts', 'backoffSeconds'],
    // Neither field is required: a queue with no policy of its own uses the
    // defaults, and an empty `{ type: "work" }` is the ordinary case.
    seed: {},
  },
}

/**
 * Trigger added by the button. An interval rather than a choice to make: it is
 * the one that gets corrected fastest if it was not the right one.
 */
export const newTrigger = () => ({ type: 'interval', every: 15, unit: 'minutes' })

/**
 * Adds, removes and changes the type of a trigger.
 *
 * Removing the last one replaces it with nothing: a job with no trigger is a
 * valid definition — it only starts on demand. The form says so rather than
 * preventing it.
 */
export function addTrigger(job) {
  if (!Array.isArray(job.triggers)) job.triggers = []
  job.triggers.push(newTrigger())
}

export function removeTrigger(job, index) {
  if (!Array.isArray(job.triggers)) return
  job.triggers.splice(index, 1)
}

export const RUNNER_SEEDS = {
  bun: { drop: ['code', 'agent', 'workflow'], seed: { script: '' } },
  shell: { drop: ['code', 'agent', 'workflow'], seed: { script: '', interpreter: 'sh' } },
  'bun-inline': { drop: ['script', 'agent', 'workflow'], seed: { code: '// Run by Bun.\n' } },
  agent: {
    drop: ['script', 'code', 'workflow'],
    seed: { agent: { prompt: 'Describe here what you expect from the agent.', model: 'gemma4:latest' } },
  },
  workflow: {
    drop: ['script', 'code', 'agent'],
    seed: { workflow: { steps: [{ name: 'First step', runner: { type: 'bun-inline', code: '// Run by Bun.\n' } }] } },
  },
}

/**
 * Changes the type of a sub-object, removing what no longer has a place and
 * seeding what is missing. What already exists is kept: retracing one's steps
 * must not erase what had been entered.
 *
 * @param {object} job definition, modified in place
 * @param {string[]} path path of the sub-object (`['runner']`, `['triggers', 0]`)
 * @param {string} kind nouveau type
 * @param {object} table SCHEDULE_SEEDS ou RUNNER_SEEDS
 */
export function applyKindChange(job, path, kind, table) {
  const target = readPath(job, path)
  const change = table[kind]
  if (!target || !change) return

  for (const key of change.drop) delete target[key]
  for (const [key, value] of Object.entries(change.seed)) {
    if (target[key] === undefined) target[key] = structuredClone(value)
  }
  target.type = kind
}

/**
 * The steps of a workflow.
 *
 * A step names a job **or** carries a runner, never both: the selector therefore
 * writes one and removes the other, rather than leaving the file a pair that
 * validation refuses.
 */
export const STEP_KINDS = ['job', 'bun', 'bun-inline', 'shell', 'agent']

export const stepsOf = (job) => job.runner?.workflow?.steps ?? []

/** A step's kind, as the selector shows it. */
export function stepKind(step) {
  if (step?.job !== undefined) return 'job'
  return step?.runner?.type ?? 'bun-inline'
}

export function newStep() {
  return { name: '', runner: { type: 'bun-inline', code: '// Run by Bun.\n' } }
}

function ensureSteps(job) {
  if (!job.runner) job.runner = { type: 'workflow' }
  if (!job.runner.workflow) job.runner.workflow = { steps: [] }
  if (!Array.isArray(job.runner.workflow.steps)) job.runner.workflow.steps = []
  return job.runner.workflow.steps
}

export function addStep(job) {
  ensureSteps(job).push(newStep())
}

export function removeStep(job, index) {
  ensureSteps(job).splice(index, 1)
}

/**
 * Moves a step. The order is the only place where a workflow says what it does:
 * moving one up or down must cost a click, not a rewrite.
 */
export function moveStep(job, index, direction) {
  const steps = ensureSteps(job)
  const cible = index + direction
  if (cible < 0 || cible >= steps.length) return
  const [step] = steps.splice(index, 1)
  steps.splice(cible, 0, step)
}

/**
 * Changes a step's kind.
 *
 * Moving between "reference" and "runner" takes the other shape away: the two at
 * once cannot be told apart, and validation refuses them together. What was
 * typed into a runner survives a round trip, as elsewhere in the form.
 */
export function setStepKind(job, index, kind) {
  const step = ensureSteps(job)[index]
  if (!step) return

  if (kind === 'job') {
    delete step.runner
    if (step.job === undefined) step.job = ''
    return
  }

  delete step.job
  if (!step.runner || typeof step.runner !== 'object') step.runner = {}
  applyKindChange(step, ['runner'], kind, RUNNER_SEEDS)
}
