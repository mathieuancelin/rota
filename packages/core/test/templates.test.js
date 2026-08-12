'use strict'

// A template producing an invalid definition would only show at the moment a
// user tries to create the job, and the error would be attributed to them. So
// this is where it is decided, not in the interface.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { listTemplates, buildFromTemplate, humanize } = require('../src/config/templates')
const { validateJob } = require('../src/config/validate')

const SCRIPTS_DIR = '/tmp/rota-scripts'
const AGENTS_DIR = '/tmp/rota-agents'
const build = (templateId, id = 'ma-job') =>
  buildFromTemplate(templateId, id, { scriptsDir: SCRIPTS_DIR, agentsDir: AGENTS_DIR })

test('every template produces a valid definition', () => {
  for (const { id: templateId } of listTemplates()) {
    const result = validateJob(build(templateId))
    assert.equal(result.ok, true, `template ${templateId}: ${result.errors?.join(' | ')}`)
  }
})

test('every template carries an identifier, a label and a description', () => {
  const templates = listTemplates()
  assert.ok(templates.length > 0)
  for (const template of templates) {
    assert.ok(template.id && template.label && template.description, JSON.stringify(template))
    assert.equal(typeof template.build, 'undefined', 'les fonctions ne traversent pas l’IPC')
  }
})

test('the paths produced are absolute, as the schema requires', () => {
  for (const { id: templateId } of listTemplates()) {
    const job = build(templateId)
    // An inline job has no script: its code is in the definition.
    if (job.runner.script) {
      assert.ok(path.isAbsolute(job.runner.script), `${templateId} : script relatif`)
    }
    if (job.runner.workingDirectory) {
      assert.ok(path.isAbsolute(job.runner.workingDirectory), `${templateId} : cwd relatif`)
    }
  }
})

test('the inline template carries code and no script', () => {
  const job = build('bun-inline')
  assert.equal(job.runner.type, 'bun-inline')
  assert.equal(job.runner.script, undefined)
  assert.ok(job.runner.code.trim().length > 0)
})

test('a created job is disabled: its script does not exist yet', () => {
  for (const { id: templateId } of listTemplates()) {
    assert.equal(build(templateId).enabled, false, templateId)
  }
})

// The other types fit in five fields; an agent has some thirty, and discovering
// them one by one in the schema costs more than writing them all out. This
// template is therefore exhaustive — and must stay so.
test('the agent template writes every setting, including the defaulted ones', () => {
  const job = build('agent')
  const { agent } = job.runner

  assert.deepEqual(Object.keys(job.runner).sort(), [
    'agent',
    'args',
    'environment',
    'type',
    'workingDirectory',
  ])
  assert.deepEqual(Object.keys(agent).sort(), [
    'api',
    'maxIterations',
    'mcp',
    'memory',
    'model',
    'prompt',
    'reasoningEffort',
    'systemPrompt',
    'temperature',
    'tools',
  ])
  assert.deepEqual(Object.keys(agent.api).sort(), [
    'baseUrl',
    'extraBody',
    'headers',
    'timeoutSeconds',
  ])
  assert.deepEqual(Object.keys(agent.tools).sort(), [
    'enabled',
    'fetch',
    'files',
    'interaction',
    'jobs',
    'system',
  ])
  assert.deepEqual(Object.keys(job.execution).sort(), [
    'allowConcurrentRuns',
    'catchUpOnWake',
    'maxOutputBytes',
    'requiresUnlockedSession',
    'runOnStartup',
    'sandbox',
    'timeoutSeconds',
  ])
  assert.deepEqual(Object.keys(job.execution.sandbox).sort(), [
    'enabled',
    'image',
    'network',
    'mountWorkingDirectory',
  ].sort())
})

test('the agent template starts from the default instructions, by reference', () => {
  const job = build('agent')

  assert.ok(job.runner.agent.systemPrompt.startsWith('${defaults.system_prompt}'))
  // A copy taken today would age inside every job ever created.
  assert.equal(
    job.runner.agent.systemPrompt.includes('Tu es un agent autonome de Rota'),
    false,
    'the reference, not the content',
  )
})

// JSON accepts no comment: this field is the only free text in a definition, and
// therefore carries the names one needs to know to go further.
test("the agent template's description names every tool that can be turned on", () => {
  const { description } = build('agent')

  for (const tool of ['fetch', 'exec', 'shell', 'file_write', 'file_del', 'ask_user', 'confirm']) {
    assert.ok(description.includes(tool), `${tool} absent de la description`)
  }
})

// Enabling shell or file_del by default would make the opt-in a formality.
test('the agent template turns on only tools with no side effect', () => {
  const { enabled } = build('agent').runner.agent.tools

  for (const risky of ['exec', 'shell', 'file_write', 'file_del']) {
    assert.equal(enabled.includes(risky), false, `${risky} on by default`)
  }
})

test('the identifier asked for is kept as it is', () => {
  const job = build('bun', 'sauvegarde_photos')
  assert.equal(job.id, 'sauvegarde_photos')
  assert.equal(job.runner.script, path.join(SCRIPTS_DIR, 'sauvegarde_photos.js'))
})

test('an unknown template produces nothing rather than throwing', () => {
  assert.equal(build('fantome'), null)
})

test('humanize turns an identifier into a name one can show', () => {
  assert.equal(humanize('ma-job'), 'Ma job')
  assert.equal(humanize('sauvegarde_photos_nas'), 'Sauvegarde photos nas')
  assert.equal(humanize('sync'), 'Sync')
})
