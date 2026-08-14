'use strict'

// The Agents view's selection.
//
// One bug is worth a whole test file here, because of what it cost: the view
// handed its editor the result of `profiles.find(...)` without checking it, and
// the two moments where that returns nothing — just after creating an agent,
// just after deleting one — are exactly the two the user goes through. Rendering
// threw, React unmounted the entire application, and the only way back was to
// restart it. The list looked frozen; it was gone.
//
// So the rule these tests hold: the identifier may designate nothing at any
// moment, and that must resolve to nothing rather than to an exception.

const test = require('node:test')
const assert = require('node:assert/strict')

const { selectedProfile, correctedSelection } = require('../src/renderer/views/profiles-model.mjs')

const list = (...ids) => ids.map((id) => ({ id, name: id }))

// --- resolving --------------------------------------------------------------------

test('a selection that designates a profile resolves to it', () => {
  assert.equal(selectedProfile(list('a', 'b'), 'b').id, 'b')
})

// The moment just after creating an agent: the identifier is set, the state has
// not come back yet.
test('a selection that designates nothing resolves to nothing, not to undefined', () => {
  assert.equal(selectedProfile(list('a'), 'tout-neuf'), null)
})

test('no selection, an empty list, a list that is not one: all resolve to nothing', () => {
  assert.equal(selectedProfile(list('a'), null), null)
  assert.equal(selectedProfile([], 'a'), null)
  assert.equal(selectedProfile(undefined, 'a'), null)
  assert.equal(selectedProfile(list('a'), undefined), null)
})

// --- tidying up ---------------------------------------------------------------------

test('a selection that still designates something is left alone', () => {
  assert.equal(correctedSelection(list('a', 'b'), 'b'), undefined)
})

// Deleting the shown agent: the selection falls back on what is left rather
// than leaving the pane empty for good.
test('a selection pointing at a gone profile falls back on the first', () => {
  assert.equal(correctedSelection(list('a', 'b'), 'disparu'), 'a')
})

test('the last profile deleted leaves nothing selected', () => {
  assert.equal(correctedSelection([], 'le-dernier'), undefined, 'not while the state may still be catching up')
  assert.equal(correctedSelection(list(), null), undefined)
})

test('arriving on a list with nothing selected selects the first', () => {
  assert.equal(correctedSelection(list('a', 'b'), null), 'a')
})

// A correction written on every republication would fight the user for the
// selection, one state push at a time.
test('nothing to correct is reported as nothing, not as null', () => {
  assert.equal(correctedSelection(list('a'), 'a'), undefined)
  assert.equal(correctedSelection([], null), undefined)
})
