'use strict'

// The preload runs sandboxed: it cannot import src/main/ipc.js and therefore
// copies the channel names. This test guarantees the two lists do not diverge —
// a divergence would otherwise only show at run time.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { CHANNELS } = require('../src/main/ipc')

// Two bridges: the main window's, and the agent windows', deliberately narrower.
// The comparison is on their union.
const PRELOADS = ['index.js', 'agent.js'].map((name) =>
  fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', name), 'utf8'),
)

test('the preloads declare exactly the same channels as the main process', () => {
  const declared = PRELOADS.flatMap((source) =>
    [...source.matchAll(/'(rota:[^']+)'/g)].map((m) => m[1]),
  )
  assert.deepEqual(new Set(declared), new Set(Object.values(CHANNELS)))
})

// A channel in both bridges would widen the main window's surface without anyone
// noticing.
test('no channel is declared in both bridges at once', () => {
  const [main, agent] = PRELOADS.map(
    (source) => new Set([...source.matchAll(/'(rota:[^']+)'/g)].map((m) => m[1])),
  )
  const shared = [...main].filter((channel) => agent.has(channel))
  assert.deepEqual(shared, [])
})

test("every channel is prefixed, so as not to collide with Electron's", () => {
  for (const channel of Object.values(CHANNELS)) {
    assert.ok(channel.startsWith('rota:'), `${channel} should be prefixed`)
  }
})

test('the channel names are unique', () => {
  const values = Object.values(CHANNELS)
  assert.equal(new Set(values).size, values.length)
})
