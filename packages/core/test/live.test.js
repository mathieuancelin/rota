'use strict'

// The output of a running execution.
//
// Two traps, and they are what is exercised here: an accented character arriving
// in two chunks, and a chatty job that must not inflate the main process's
// memory for hours.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createLiveTail } = require('../src/runner/live')

test('the pieces add up, and are handed back as they come', () => {
  const tail = createLiveTail()

  assert.equal(tail.push(Buffer.from('bon')), 'bon')
  assert.equal(tail.push(Buffer.from('jour\n')), 'jour\n')
  assert.deepEqual(tail.read(), { text: 'bonjour\n', dropped: false })
})

// An "é" takes two bytes: cut between two chunks, a naive toString() would
// produce a "\uFFFD" every time an accent falls on a boundary.
test('a character cut between two chunks is put back together, not mangled', () => {
  const tail = createLiveTail()
  const accent = Buffer.from('déjà vu')

  assert.equal(tail.push(accent.subarray(0, 2)), 'd', 'the orphan byte is held back')
  assert.equal(tail.push(accent.subarray(2)), 'éjà vu')
  assert.equal(tail.read().text, 'déjà vu')
  assert.equal(tail.read().text.includes('�'), false)
})

test('a chunk completing no character returns nothing', () => {
  const tail = createLiveTail()
  assert.equal(tail.push(Buffer.from('é').subarray(0, 1)), '')
  assert.equal(tail.read().text, '')
})

// An execution running for hours while writing constantly must not grow the main
// process's memory: only the tail is kept.
test('past the window, the beginning is dropped', () => {
  const tail = createLiveTail({ maxChars: 40 })

  for (let index = 0; index < 20; index += 1) tail.push(`ligne ${index}\n`)

  const { text, dropped } = tail.read()
  assert.equal(dropped, true)
  assert.ok(text.length <= 40)
  assert.ok(text.endsWith('ligne 19\n'))
  assert.equal(text.includes('ligne 0\n'), false)
})

// A truncated start of line reads worse than a missing line.
test('the cut falls on an end of line when there is one', () => {
  const tail = createLiveTail({ maxChars: 20 })

  tail.push('first line\nsecond line\n')

  const { text } = tail.read()
  assert.equal(text, 'second line\n')
})

test('with no end of line within reach, the cut falls on the character', () => {
  const tail = createLiveTail({ maxChars: 10 })

  tail.push('abcdefghijklmno')

  assert.deepEqual(tail.read(), { text: 'fghijklmno', dropped: true })
})

test('while it fits in the window, nothing is dropped', () => {
  const tail = createLiveTail({ maxChars: 100 })
  tail.push('court\n')
  assert.deepEqual(tail.read(), { text: 'court\n', dropped: false })
})
