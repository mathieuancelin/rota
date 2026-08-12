'use strict'

// Reading the lock state at startup. The case that matters is the last one: an
// impossible read must not hold jobs back forever.

const test = require('node:test')
const assert = require('node:assert/strict')

const { isSessionLocked } = require('../src/lib/session-lock')

const IOREG_LOCKED = `
    "CGSSession" = {"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes}
  <key>CGSSessionScreenIsLocked</key>
  <true/>
`
const IOREG_UNLOCKED = `
  <key>kCGSSessionOnConsoleKey</key>
  <true/>
`

test('detects a locked session', () => {
  assert.equal(isSessionLocked({ platform: 'darwin', run: () => IOREG_LOCKED }), true)
})

test('the key being absent means unlocked', () => {
  assert.equal(isSessionLocked({ platform: 'darwin', run: () => IOREG_UNLOCKED }), false)
})

test('the key at false means unlocked', () => {
  const output = '<key>CGSSessionScreenIsLocked</key>\n<false/>'
  assert.equal(isSessionLocked({ platform: 'darwin', run: () => output }), false)
})

test('on Linux the answer comes from logind', () => {
  assert.equal(isSessionLocked({ platform: 'linux', run: () => 'yes\n' }), true)
  assert.equal(isSessionLocked({ platform: 'linux', run: () => 'no\n' }), false)
})

test('logind answering something unexpected is not a lock', () => {
  // A property that is unset prints an empty line rather than failing.
  assert.equal(isSessionLocked({ platform: 'linux', run: () => '' }), false)
  assert.equal(isSessionLocked({ platform: 'linux', run: () => 'unknown' }), false)
})

test('no logind, no session, no loginctl: nothing is held back', () => {
  const locked = isSessionLocked({
    platform: 'linux',
    run: () => {
      throw new Error('loginctl: command not found')
    },
  })
  assert.equal(locked, false, 'a machine with no screen has no screen to lock')
})

test('a platform we have no answer for is not asked', () => {
  let called = false
  const locked = isSessionLocked({
    platform: 'win32',
    run: () => {
      called = true
      return IOREG_LOCKED
    },
  })
  assert.equal(locked, false)
  assert.equal(called, false)
})

test('a read that fails does not hold the jobs back', () => {
  const locked = isSessionLocked({
    platform: 'darwin',
    run: () => {
      throw new Error('ioreg not found')
    },
  })
  assert.equal(locked, false, 'one job too many beats a job never started')
})

test('on this machine, the real read returns a boolean without throwing', () => {
  assert.equal(typeof isSessionLocked(), 'boolean')
})
