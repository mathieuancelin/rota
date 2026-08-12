'use strict'

// The "should we notify?" decision is tested without Electron: we inject a fake
// Notification constructor to observe what would have been displayed.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const shown = []

// Intercepting require('electron') before the module under test is loaded.
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      Notification: class {
        constructor(options) {
          shown.push(options)
        }
        static isSupported() {
          return true
        }
        on() {}
        show() {}
      },
      // The module varies the logo by outcome: we keep the requested path so we
      // can check which one was chosen.
      nativeImage: {
        createFromPath: (file) => ({ isEmpty: () => false, file }),
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { createNotifier } = require('../src/main/notifications')
Module._load = originalLoad

function job(notifications) {
  return {
    id: 'j',
    name: 'Ma tâche',
    notifications: { onStart: false, onSuccess: false, onChange: false, onError: true, ...notifications },
  }
}

const execution = (overrides = {}) => ({
  status: 'success',
  durationMs: 1200,
  executionId: 'e1',
  error: null,
  change: null,
  ...overrides,
})

function notifier() {
  shown.length = 0
  return createNotifier({ onErrorClick: () => {} })
}

test('a success with no effect does not notify when only onChange is on', () => {
  const n = notifier()
  n.finished(job({ onChange: true }), execution())
  assert.deepEqual(shown, [], 'les cycles sans effet doivent rester silencieux')
})

test("a success with an effect notifies and takes up the script's message", () => {
  const n = notifier()
  n.finished(job({ onChange: true }), execution({ change: { changed: true, message: '2 commits pushed' } }))

  assert.equal(shown.length, 1)
  assert.match(shown[0].title, /2 commits pushed/)
})

test('an effect with no message is still notified, with a default label', () => {
  const n = notifier()
  n.finished(job({ onChange: true }), execution({ change: { changed: true, message: null } }))

  assert.equal(shown.length, 1)
  assert.match(shown[0].title, /changes applied/)
})

test('onSuccess alone notifies every success, effect or not', () => {
  const n = notifier()
  n.finished(job({ onSuccess: true }), execution())
  n.finished(job({ onSuccess: true }), execution({ change: { changed: true, message: 'x' } }))
  assert.equal(shown.length, 2)
})

test('both options on produce one notification', () => {
  const n = notifier()
  n.finished(job({ onSuccess: true, onChange: true }), execution({ change: { changed: true, message: 'x' } }))

  assert.equal(shown.length, 1, 'onChange l’emporte, sans doublon')
  assert.match(shown[0].title, /x/)
})

test('with both options, a success with no effect falls back to onSuccess', () => {
  const n = notifier()
  n.finished(job({ onSuccess: true, onChange: true }), execution())

  assert.equal(shown.length, 1)
  assert.match(shown[0].title, /finished/)
})

test('a failure always notifies if onError is on', () => {
  const n = notifier()
  n.finished(job({}), execution({ status: 'failed', error: 'code 13' }))

  assert.equal(shown.length, 1)
  assert.match(shown[0].title, /failed/)
  assert.equal(shown[0].body, 'code 13')
})

// --- logo variation ----------------------------------------------------------

const iconName = (options) => options.icon?.file.replace(/^.*\//, '')

test('the icon is green on success, red on failure, plain while running', () => {
  const n = notifier()
  n.started(job({ onStart: true }), execution())
  n.finished(job({ onSuccess: true }), execution())
  n.finished(job({}), execution({ status: 'failed', error: 'code 13' }))

  assert.deepEqual(shown.map(iconName), ['neutral.png', 'success.png', 'error.png'])
})

test('a success with an effect carries the green icon too', () => {
  const n = notifier()
  n.finished(job({ onChange: true }), execution({ change: { changed: true, message: 'x' } }))

  assert.equal(iconName(shown[0]), 'success.png')
})

test('a timeout carries the red icon, like any failure', () => {
  const n = notifier()
  n.finished(job({}), execution({ status: 'timed-out', error: null }))

  assert.equal(iconName(shown[0]), 'error.png')
})

test('a skipped execution does not notify: it is not a failure', () => {
  const n = notifier()
  n.finished(job({}), execution({ status: 'skipped-already-running' }))
  n.finished(job({}), execution({ status: 'cancelled' }))
  assert.deepEqual(shown, [])
})
