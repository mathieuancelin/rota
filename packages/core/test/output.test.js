'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createOutputCollector,
  truncateToBytes,
  trimIncompleteTail,
} = require('../src/runner/output')

test('an output under the limit is returned intact', () => {
  const collector = createOutputCollector({ maxBytes: 1024 })
  collector.push(Buffer.from('bonjour '))
  collector.push(Buffer.from('le monde'))

  assert.deepEqual(collector.result(), {
    text: 'bonjour le monde',
    truncated: false,
    totalBytes: 16,
  })
})

test('past the limit, the output is cut and says so', () => {
  const collector = createOutputCollector({ maxBytes: 10 })
  collector.push(Buffer.from('0123456789ABCDEF'))

  const result = collector.result()
  assert.equal(result.truncated, true)
  assert.equal(result.totalBytes, 16)
  assert.ok(result.text.startsWith('0123456789'))
  assert.ok(result.text.includes('truncated'), 'the truncation must be explicit')
})

test('the total counter carries on past the limit', () => {
  const collector = createOutputCollector({ maxBytes: 4 })
  for (let i = 0; i < 100; i++) collector.push(Buffer.from('xxxx'))

  assert.equal(collector.result().totalBytes, 400)
})

test('a cut in the middle of an accented character produces no �', () => {
  // "é" takes two bytes: cutting at 3 lands right in the middle.
  const collector = createOutputCollector({ maxBytes: 3 })
  collector.push(Buffer.from('abéc', 'utf8'))

  const result = collector.result()
  assert.ok(!result.text.includes('�'), `replacement character in ${JSON.stringify(result.text)}`)
  assert.ok(result.text.startsWith('ab'))
})

test('a cut in the middle of an emoji produces no �', () => {
  // An emoji takes four bytes.
  const collector = createOutputCollector({ maxBytes: 6 })
  collector.push(Buffer.from('ab🎉cd', 'utf8'))

  const result = collector.result()
  assert.ok(!result.text.includes('�'))
  assert.ok(result.text.startsWith('ab'))
})

test('trimIncompleteTail keeps the complete sequences', () => {
  const complete = Buffer.from('abé', 'utf8')
  assert.equal(trimIncompleteTail(complete), complete.length)

  const cut = complete.subarray(0, complete.length - 1)
  assert.equal(trimIncompleteTail(cut), 2, 'the incomplete « é » is dropped')
})

test('truncateToBytes leaves a short text intact', () => {
  assert.deepEqual(truncateToBytes('court', 100), { text: 'court', truncated: false })
})

test('truncateToBytes cuts on a character boundary', () => {
  const result = truncateToBytes('ééééé', 5)
  assert.equal(result.truncated, true)
  assert.equal(result.text, 'éé', '5 bytes hold only two whole « é »')
})

test('the limit is counted in bytes, not in characters', () => {
  // Five "é"s make ten bytes: they just fit.
  assert.equal(truncateToBytes('ééééé', 10).truncated, false)
  assert.equal(truncateToBytes('ééééé', 9).truncated, true)
})
