'use strict'

// Filtering and ordering the job list.
//
// Two details regress silently, and they are what is exercised here: accents,
// which one does not type into a filter field, and jobs with neither occurrence
// nor execution, which would rise to the top of a sort on a missing value.

const test = require('node:test')
const assert = require('node:assert/strict')

const { arrange, byDate, fold, matches, SORTS } = require('../src/renderer/views/job-list-model.mjs')

const job = (id, overrides = {}) => ({
  id,
  name: id,
  description: '',
  nextRunAt: null,
  lastRun: null,
  ...overrides,
})

const ids = (jobs) => jobs.map((candidate) => candidate.id)

// --- search -------------------------------------------------------------------

test('the search ignores case and accents', () => {
  assert.equal(fold('Veillée'), 'veillee')
  assert.equal(matches(job('x', { name: 'Veillée nocturne' }), 'veille'), true)
  assert.equal(matches(job('x', { name: 'veille' }), 'VEILLE'.toLowerCase()), true)
})

test('the name, the description and the identifier are searched', () => {
  const cible = job('sync-obsidian', { name: 'Synchro', description: 'Pousse les notes' })

  assert.equal(matches(cible, 'synchro'), true, 'nom')
  assert.equal(matches(cible, 'notes'), true, 'description')
  assert.equal(matches(cible, 'obsidian'), true, 'identifiant')
  assert.equal(matches(cible, 'photos'), false)
})

test('a missing description does not take the search down', () => {
  assert.equal(matches({ id: 'x', name: 'X' }, 'x'), true)
})

test('an empty filter lets everything through, without reordering anything', () => {
  const jobs = [job('b'), job('a')]
  assert.deepEqual(ids(arrange(jobs, { search: '   ' })), ['a', 'b'])
})

test('filtering does not sort the snapshot in place', () => {
  const jobs = [job('b'), job('a')]
  arrange(jobs, {})
  assert.deepEqual(ids(jobs), ['b', 'a'], 'la liste d’origine est intacte')
})

// --- ordering -----------------------------------------------------------------

test('by name, the order follows the French alphabet', () => {
  const jobs = [job('c', { name: 'Step' }), job('a', { name: 'Analyse' }), job('b', { name: 'Screen' })]

  assert.deepEqual(ids(arrange(jobs, { sort: 'name' })), ['a', 'b', 'c'])
})

test('by next execution, the soonest first', () => {
  const jobs = [
    job('tard', { nextRunAt: '2026-08-03T18:00:00.000Z' }),
    job('tot', { nextRunAt: '2026-08-03T06:00:00.000Z' }),
  ]

  assert.deepEqual(ids(arrange(jobs, { sort: 'next' })), ['tot', 'tard'])
})

test('by last execution, the most recent first', () => {
  const jobs = [
    job('ancienne', { lastRun: { at: '2026-08-01T09:00:00.000Z' } }),
    job('recente', { lastRun: { at: '2026-08-02T09:00:00.000Z' } }),
  ]

  assert.deepEqual(ids(arrange(jobs, { sort: 'last' })), ['recente', 'ancienne'])
})

// A disabled job has no occurrence, a fresh job has never run: putting them
// first would make absence pass for the smallest value.
test('the jobs with no date go last, in both directions', () => {
  const avec = job('avec', {
    nextRunAt: '2026-08-03T06:00:00.000Z',
    lastRun: { at: '2026-08-02T09:00:00.000Z' },
  })
  const sans = job('sans')

  assert.deepEqual(ids(arrange([sans, avec], { sort: 'next' })), ['avec', 'sans'])
  assert.deepEqual(ids(arrange([sans, avec], { sort: 'last' })), ['avec', 'sans'])
})

test('byDate handles absence on both sides', () => {
  assert.equal(byDate(null, null, 'asc'), 0)
  assert.equal(byDate(null, '2026-01-01T00:00:00.000Z', 'asc') > 0, true)
  assert.equal(byDate('2026-01-01T00:00:00.000Z', null, 'desc') < 0, true)
})

test('an unknown sort falls back to the name rather than sorting nothing', () => {
  const jobs = [job('b'), job('a')]
  assert.deepEqual(ids(arrange(jobs, { sort: 'quantique' })), ['a', 'b'])
})

test('every sort announced to the interface carries a label and a comparison', () => {
  for (const [id, sort] of Object.entries(SORTS)) {
    assert.ok(sort.label.length > 0, id)
    assert.equal(typeof sort.compare, 'function', id)
  }
})

// --- together -----------------------------------------------------------------

test('filter then sort, in that order', () => {
  const jobs = [
    job('sync-photos', { name: 'Sauvegarde photos', nextRunAt: '2026-08-03T18:00:00.000Z' }),
    job('sync-notes', { name: 'Synchro notes', nextRunAt: '2026-08-03T06:00:00.000Z' }),
    job('menage', { name: 'Tidying', nextRunAt: '2026-08-03T01:00:00.000Z' }),
  ]

  assert.deepEqual(ids(arrange(jobs, { search: 'sync', sort: 'next' })), ['sync-notes', 'sync-photos'])
})
