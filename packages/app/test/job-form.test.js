'use strict'

// What the form does to a definition.
//
// The view is not exercised here — that is rendering — but what it writes is,
// and above all switching from one type to another: changing `runner.type`
// otherwise leaves the old type's fields, which the schema refuses, and without
// the new one's, which it requires. A half-converted definition no longer saves.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  RUNNER_SEEDS,
  TRIGGER_SEEDS,
  addTrigger,
  removeTrigger,
  applyKindChange,
  deletePath,
  effective,
  readPath,
  schemaDefault,
  writePath,
} = require('../src/renderer/views/job-form-model.mjs')
const { validateJob } = require('@rota/core')

const jobSchema = require('@rota/core/schemas/job.schema.json')

const baseJob = () => ({
  $schema: 'https://rota.local/schemas/job.schema.json',
  id: 'demo',
  name: 'Demo',
  triggers: [{ type: 'interval', every: 15, unit: 'minutes' }],
  runner: { type: 'bun', script: '/Users/moi/scripts/demo.js' },
})

const valid = (job) => {
  const result = validateJob(job)
  assert.equal(result.ok, true, result.errors?.join(' | '))
  return result.job
}

// --- paths ------------------------------------------------------------------------

test('reading, writing and removing a value deep down', () => {
  const job = baseJob()

  writePath(job, ['execution', 'sandbox', 'enabled'], true)
  assert.equal(readPath(job, ['execution', 'sandbox', 'enabled']), true)
  assert.deepEqual(job.execution, { sandbox: { enabled: true } }, 'the missing levels are created')

  deletePath(job, ['execution', 'sandbox', 'enabled'])
  assert.deepEqual(job.execution.sandbox, {})
})

test('removing a value that is not there does not throw', () => {
  const job = baseJob()
  deletePath(job, ['execution', 'sandbox', 'enabled'])
  assert.equal(job.execution, undefined)
})

// A field absent from the file is not empty: it is the schema that will fill it
// in. Showing it empty would suggest a setting at zero.
test('a missing field is shown with the value the schema will apply', () => {
  const job = baseJob()

  assert.equal(effective(jobSchema, job, ['execution', 'timeoutSeconds']), 300)
  assert.equal(effective(jobSchema, job, ['notifications', 'onError']), true)
  assert.equal(effective(jobSchema, job, ['execution', 'sandbox', 'image']), 'oven/bun:1')

  writePath(job, ['execution', 'timeoutSeconds'], 30)
  assert.equal(effective(jobSchema, job, ['execution', 'timeoutSeconds']), 30)
})

test('the default values really come from the schema, not from a copy', () => {
  assert.equal(schemaDefault(jobSchema, ['history', 'retainExecutions']), 500)
  assert.equal(schemaDefault(jobSchema, ['runner', 'agent', 'maxIterations']), 25)
  assert.equal(schemaDefault(jobSchema, ['champ', 'inconnu']), undefined)
})

// --- switching trigger --------------------------------------------------------------

test('going from an interval to a cron expression produces a valid definition', () => {
  const job = baseJob()
  applyKindChange(job, ['triggers', 0], 'cron', TRIGGER_SEEDS)

  assert.deepEqual(job.triggers[0], { type: 'cron', expression: '0 9 * * 1-5' })
  valid(job)
})

test('and back: the expression goes, the interval returns', () => {
  const job = baseJob()
  applyKindChange(job, ['triggers', 0], 'cron', TRIGGER_SEEDS)
  applyKindChange(job, ['triggers', 0], 'interval', TRIGGER_SEEDS)

  assert.deepEqual(job.triggers[0], { type: 'interval', every: 15, unit: 'minutes' })
  valid(job)
})

// A webhook has neither an interval nor an expression: what is left from a
// previous type is refused by validation, and that is exactly what one does not see.
test("switching to webhook takes the timed types' fields away", () => {
  const job = baseJob()
  applyKindChange(job, ['triggers', 0], 'webhook', TRIGGER_SEEDS)

  assert.deepEqual(job.triggers[0], { type: 'webhook' })
  valid(job)
})

test('a Discord keyword survives a round trip through the webhook', () => {
  const job = baseJob()
  applyKindChange(job, ['triggers', 0], 'discord', TRIGGER_SEEDS)
  job.triggers[0].keyword = 'deploy'
  applyKindChange(job, ['triggers', 0], 'webhook', TRIGGER_SEEDS)

  assert.equal(job.triggers[0].keyword, undefined)
})

test('adding then removing a trigger leaves the definition valid', () => {
  const job = baseJob()
  addTrigger(job)
  assert.equal(job.triggers.length, 2)
  valid(job)

  removeTrigger(job, 1)
  assert.equal(job.triggers.length, 1)
  valid(job)
})

// A job with no trigger only starts on demand. That is a legitimate definition,
// and the form must be able to lead there without producing a file the schema
// refuses.
test('removing the last trigger stays valid', () => {
  const job = baseJob()
  removeTrigger(job, 0)

  assert.deepEqual(job.triggers, [])
  valid(job)
})

// --- switching runner ---------------------------------------------------------------

test('every type produces a definition the schema accepts', () => {
  for (const kind of Object.keys(RUNNER_SEEDS)) {
    const job = baseJob()
    applyKindChange(job, ['runner'], kind, RUNNER_SEEDS)

    // The types pointing at a file start from an empty path: it is up to the user
    // to fill it, and the schema requires an absolute path.
    if (job.runner.script === '') job.runner.script = '/Users/moi/scripts/demo.js'

    const result = validateJob(job)
    assert.equal(result.ok, true, `${kind} : ${result.errors?.join(' | ')}`)
    assert.equal(result.job.runner.type, kind)
  }
})

test('switching to agent drops the script and seeds the configuration', () => {
  const job = baseJob()
  applyKindChange(job, ['runner'], 'agent', RUNNER_SEEDS)

  assert.equal(job.runner.script, undefined)
  assert.equal(job.runner.code, undefined)
  assert.ok(job.runner.agent.prompt.length > 0)
  assert.ok(job.runner.agent.model.length > 0)
  valid(job)
})

test('leaving agent drops its configuration, which would be refused elsewhere', () => {
  const job = baseJob()
  applyKindChange(job, ['runner'], 'agent', RUNNER_SEEDS)
  applyKindChange(job, ['runner'], 'shell', RUNNER_SEEDS)

  assert.equal(job.runner.agent, undefined)
  assert.equal(job.runner.interpreter, 'sh')
  job.runner.script = '/tmp/x.sh'
  valid(job)
})

test('switching to bun-inline drops the script and seeds some code', () => {
  const job = baseJob()
  applyKindChange(job, ['runner'], 'bun-inline', RUNNER_SEEDS)

  assert.equal(job.runner.script, undefined)
  assert.ok(job.runner.code.trim().length > 0)
  valid(job)
})

// Retracing one's steps after a round trip must not erase what had been entered:
// seeding only fills what is missing.
test('what was typed survives a round trip', () => {
  const job = baseJob()
  applyKindChange(job, ['runner'], 'agent', RUNNER_SEEDS)
  job.runner.agent.model = 'gpt-oss:latest'
  job.runner.agent.prompt = 'A prompt of my own.'

  applyKindChange(job, ['runner'], 'agent', RUNNER_SEEDS)

  assert.equal(job.runner.agent.model, 'gpt-oss:latest')
  assert.equal(job.runner.agent.prompt, 'A prompt of my own.')
})

test('the common fields cross the switches', () => {
  const job = baseJob()
  job.runner.workingDirectory = '/Users/moi/travail'
  job.runner.environment = { TOKEN: 'x' }

  applyKindChange(job, ['runner'], 'agent', RUNNER_SEEDS)

  assert.equal(job.runner.workingDirectory, '/Users/moi/travail')
  assert.deepEqual(job.runner.environment, { TOKEN: 'x' })
})

test('an unknown type touches nothing', () => {
  const job = baseJob()
  applyKindChange(job, ['runner'], 'python', RUNNER_SEEDS)

  assert.deepEqual(job.runner, { type: 'bun', script: '/Users/moi/scripts/demo.js' })
})

// --- settings coverage -----------------------------------------------------------
//
// "Edit every job type in full": a field added to the schema without being added
// to the form would go unnoticed until one went looking for it.

const CHAMPS_HORS_FORMULAIRE = new Set([
  '$schema', // technical, written by the job template
  'id', // c'est le nom du file, il ne se renomme pas ici
  'runner.code', // onglet Code
  'runner.agent.prompt', // onglet Prompt
  'runner.agent.systemPrompt', // the System tab
  'runner.agent.api.extraBody', // objet libre, sans forme connue
])

function leafPaths(node, prefix = []) {
  if (!node?.properties) return [prefix.join('.')]
  return Object.entries(node.properties).flatMap(([key, child]) =>
    leafPaths(child, [...prefix, key]),
  )
}

// A tool added to the schema without being added to the form is invisible: it
// exists, it can be declared by hand in the JSON, but the checkbox appears
// nowhere. That is exactly what happened to run_job.
test("the form's tool list covers exactly the schema's", () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'renderer', 'views', 'JobForm.jsx'),
    'utf8',
  )

  // The runner lives under `definitions` since the workflow steps reuse it:
  // `properties.runner` now carries only the reference. The tool names live
  // there too, because `tools.subagents.deny` enumerates the same words and two
  // copies of that list would drift.
  const duSchema = jobSchema.definitions.toolName.enum
  assert.deepEqual(
    jobSchema.definitions.runner.properties.agent.properties.tools.properties.enabled.items,
    { $ref: '#/definitions/toolName' },
    'the tool list must stay a single reference',
  )

  // The only TOOL_LABELS block: other lists of pairs exist in the file — the MCP
  // transports, the units — and are not tools.
  const bloc = source.slice(source.indexOf('const TOOL_LABELS = ['))
  const duFormulaire = [...bloc.slice(0, bloc.indexOf('\n]')).matchAll(/\['([a-z_]+)',/g)].map(
    (m) => m[1],
  )

  assert.deepEqual(
    [...duFormulaire].sort(),
    [...duSchema].sort(),
    'the form and the schema do not offer the same tools',
  )
})

test('every field of the schema is in the form, or explicitly set aside', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'renderer', 'views', 'JobForm.jsx'),
    'utf8',
  )

  const manquants = leafPaths(jobSchema)
    .filter((champ) => champ !== '' && !CHAMPS_HORS_FORMULAIRE.has(champ))
    .filter((champ) => {
      // The form designates its fields by a path: ['execution', 'sandbox', 'image'].
      const motif = champ
        .split('.')
        .map((key) => `'${key}'`)
        .join(', ')
      return !source.includes(motif)
    })

  assert.deepEqual(manquants, [], 'champs absents du formulaire')
})

// --- workflow steps ---------------------------------------------------------------
//
// Steps used to be JSON-only, on the grounds that a step carries a whole runner.
// That held until you wanted to reorder three of them.

const {
  addStep,
  moveStep,
  removeStep,
  setStepKind,
  stepKind,
  stepsOf,
} = require('../src/renderer/views/job-form-model.mjs')

const workflowJob = () => ({
  id: 'chaine',
  name: 'Chain',
  triggers: [],
  runner: { type: 'workflow', workflow: { steps: [] } },
})

test('an added step produces a definition the schema accepts', () => {
  const job = workflowJob()
  addStep(job)

  assert.equal(stepsOf(job).length, 1)
  valid(job)
})

test('the order of the steps changes with no rewriting', () => {
  const job = workflowJob()
  addStep(job)
  addStep(job)
  addStep(job)
  stepsOf(job).forEach((step, i) => {
    step.name = `etape-${i}`
  })

  moveStep(job, 0, 1)
  assert.deepEqual(stepsOf(job).map((s) => s.name), ['etape-1', 'etape-0', 'etape-2'])

  moveStep(job, 2, -1)
  assert.deepEqual(stepsOf(job).map((s) => s.name), ['etape-1', 'etape-2', 'etape-0'])
  valid(job)
})

// Nothing to move past: the buttons are disabled, and the model does not care.
test('moving out of bounds does nothing', () => {
  const job = workflowJob()
  addStep(job)
  addStep(job)

  moveStep(job, 0, -1)
  moveStep(job, 1, 1)

  assert.equal(stepsOf(job).length, 2)
})

// A step names a job or carries a runner; both at once cannot be told apart, and
// the validation refuses them together.
test('turning a step into a reference takes its runner away', () => {
  const job = workflowJob()
  addStep(job)

  setStepKind(job, 0, 'job')

  assert.equal(stepsOf(job)[0].runner, undefined)
  assert.equal(stepsOf(job)[0].job, '')
  assert.equal(stepKind(stepsOf(job)[0]), 'job')
})

test('and going back to a runner takes the reference away', () => {
  const job = workflowJob()
  addStep(job)
  setStepKind(job, 0, 'job')

  setStepKind(job, 0, 'shell')

  assert.equal(stepsOf(job)[0].job, undefined)
  assert.equal(stepsOf(job)[0].runner.type, 'shell')
  stepsOf(job)[0].runner.script = '/tmp/x.sh'
  valid(job)
})

test('every kind of step produces a valid definition', () => {
  for (const kind of ['bun-inline', 'bun', 'shell', 'agent']) {
    const job = workflowJob()
    addStep(job)
    setStepKind(job, 0, kind)
    const step = stepsOf(job)[0]
    if (step.runner.script === '') step.runner.script = '/Users/moi/scripts/x.js'

    const result = validateJob(job)
    assert.equal(result.ok, true, `${kind} : ${result.errors?.join(' | ')}`)
    assert.equal(result.job.runner.workflow.steps[0].runner.type, kind)
  }
})

// The form must not be able to write a nested workflow: the schema refuses it,
// and the selector does not offer it.
test('the form does not offer to nest a workflow', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'renderer', 'views', 'JobForm.jsx'),
    'utf8',
  )
  const bloc = source.slice(source.indexOf('const STEP_KIND_LABELS = ['))
  const proposes = [...bloc.slice(0, bloc.indexOf('\n]')).matchAll(/\['([a-z-]+)',/g)].map((m) => m[1])

  assert.deepEqual(proposes, ['job', 'bun-inline', 'bun', 'shell', 'agent'])
  assert.ok(!proposes.includes('workflow'))
})

test('removing a step leaves the others in place', () => {
  const job = workflowJob()
  addStep(job)
  addStep(job)
  stepsOf(job)[1].name = 'la seconde'

  removeStep(job, 0)

  assert.equal(stepsOf(job).length, 1)
  assert.equal(stepsOf(job)[0].name, 'la seconde')
})

// The schema describes a step once; the form reads its explanations from there,
// including through the $ref that the steps' runner goes through.
test("the form reads the schema's explanations right into a step", () => {
  assert.equal(schemaDefault(jobSchema, ['runner', 'workflow', 'steps', 0, 'continueOnError']), false)
  assert.equal(schemaDefault(jobSchema, ['runner', 'workflow', 'steps', 0, 'receivesPreviousSteps']), true)
  assert.equal(
    schemaDefault(jobSchema, ['runner', 'workflow', 'steps', 0, 'runner', 'agent', 'maxIterations']),
    25,
  )
})

// The trigger dropdown is written by hand: those <option> elements are not
// generated from the schema. Adding `power` to the schema, to the validator and
// to TRIGGER_SEEDS was not enough — the type validated, the engine fired it, and
// the editor offered it nowhere. The test above catches a missing *field*
// because it walks the schema's leaves; it does not walk into array items, so
// nothing covered the list of types itself. This does.
test('the form offers every trigger type the schema accepts', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'renderer', 'views', 'JobForm.jsx'),
    'utf8',
  )
  const types = jobSchema.properties.triggers.items.properties.type.enum

  for (const type of types) {
    assert.ok(
      source.includes(`<option value="${type}">`),
      `"${type}" is accepted by the schema but has no entry in the trigger dropdown`,
    )
    assert.ok(TRIGGER_SEEDS[type], `"${type}" has no TRIGGER_SEEDS entry, so switching to it keeps the old type's fields`)
  }

  // And the other way: nothing offered that the schema would refuse.
  const offered = [...source.matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1])
  for (const type of Object.keys(TRIGGER_SEEDS)) {
    assert.ok(types.includes(type), `"${type}" is seeded by the form but unknown to the schema`)
    assert.ok(offered.includes(type), `"${type}" is seeded but not offered`)
  }
})

test('switching to power or after leaves a trigger the schema accepts', () => {
  for (const [type, expected] of [
    ['power', ['event']],
    ['after', ['job', 'on']],
  ]) {
    const job = baseJob()
    job.triggers = [{ type: 'interval', every: 15, unit: 'minutes' }]
    applyKindChange(job, ['triggers', 0], type, TRIGGER_SEEDS)
    const trigger = job.triggers[0]

    assert.equal(trigger.type, type)
    for (const field of expected) {
      assert.ok(field in trigger, `${type} should be seeded with ${field}`)
    }
    // The interval's own fields must be gone, not left dormant: the schema
    // refuses them, and a job that will not save is worse than one that will
    // not run.
    assert.equal(trigger.every, undefined)
    assert.equal(trigger.unit, undefined)

    // `after` needs a real job name before it validates, which the form asks
    // for; the point here is that nothing of the old type is left behind.
    if (type === 'after') trigger.job = 'backup'
    valid(job)
  }
})
