'use strict'

// How a queue item reaches the job that was woken for it.
//
// Until now nothing travelled with a trigger: firing a job passed a label and
// nothing else, so a webhook could start a job without being able to tell it
// what it was about. An item has to arrive somewhere, and there are two
// somewheres — the environment for anything that runs as a process, the prompt
// for an agent.
//
// The absence matters as much as the presence: a job run by hand must be able
// to tell that it was not handed anything, which is why the variables are
// missing rather than empty.

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildEnv } = require('../src/runner/env')
const { sandboxEnv } = require('../src/runner/sandbox')
const { expandWork, NO_WORK } = require('../src/agent/prompt')

const job = (overrides = {}) => ({
  id: 'dev',
  name: 'Dev',
  runner: { type: 'shell', environment: {}, agent: null, ...overrides },
  execution: { sandbox: { enabled: false, image: 'x', network: false, mountWorkingDirectory: false } },
})

const item = { id: 'wi-1', input: { repository: 'acme/api', issue: 421 } }

// --- the environment ---------------------------------------------------------------

test('a work item reaches a script as two variables', () => {
  const env = buildEnv(job(), { executionId: 'exec-1', work: item })

  assert.equal(env.ROTA_WORK_ITEM_ID, 'wi-1')
  assert.deepEqual(JSON.parse(env.ROTA_WORK_INPUT), item.input)
})

test('the old prefix carries them too, like every other variable', () => {
  const env = buildEnv(job(), { executionId: 'exec-1', work: item })

  assert.equal(env.TICKTRAY_WORK_ITEM_ID, 'wi-1')
  assert.equal(env.TICKTRAY_WORK_INPUT, env.ROTA_WORK_INPUT)
})

test('a run that came from anywhere else has neither variable', () => {
  const env = buildEnv(job(), { executionId: 'exec-1' })

  assert.equal('ROTA_WORK_ITEM_ID' in env, false)
  assert.equal('ROTA_WORK_INPUT' in env, false)
})

test('the item crosses into a sandbox', () => {
  const env = sandboxEnv(job(), { executionId: 'exec-1', work: item }, {})

  assert.equal(env.ROTA_WORK_ITEM_ID, 'wi-1')
  assert.deepEqual(JSON.parse(env.ROTA_WORK_INPUT), item.input)
  assert.equal(env.TICKTRAY_WORK_ITEM_ID, 'wi-1')
})

test('a sandboxed run that came from anywhere else has neither variable either', () => {
  const env = sandboxEnv(job(), { executionId: 'exec-1' }, {})

  assert.equal('ROTA_WORK_ITEM_ID' in env, false)
  assert.equal('ROTA_WORK_INPUT' in env, false)
})

// --- the prompt ---------------------------------------------------------------------

test('${work.input} is replaced by the item, readably', () => {
  const expanded = expandWork('Handle this issue:\n${work.input}', item)

  assert.match(expanded, /"repository": "acme\/api"/)
  assert.match(expanded, /"issue": 421/)
})

test('${work.id} is replaced by the identifier', () => {
  assert.equal(expandWork('item ${work.id}', item), 'item wi-1')
})

test('a prompt with no reference passes through untouched', () => {
  const text = 'Do the usual thing.'
  assert.equal(expandWork(text, item), text)
  assert.equal(expandWork(text, null), text)
})

test('without an item the reference says so rather than leaving a hole', () => {
  const expanded = expandWork('Handle this: ${work.input}', null)

  assert.equal(expanded, `Handle this: ${NO_WORK}`)
  assert.equal(expanded.includes('${work.input}'), false)
})

// A secret is ${VARIABLE} — no dot allowed — so the two resolvers cannot see
// each other's references, and neither has to know the other exists.
test('the work references do not collide with the secrets syntax', () => {
  const text = 'token ${GITHUB_TOKEN} for ${work.id}'

  assert.equal(expandWork(text, item), 'token ${GITHUB_TOKEN} for wi-1')
})
