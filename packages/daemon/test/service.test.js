'use strict'

// The unit files, and the argument parsing that leads to them.
//
// A unit file is read by an init system, not by a person: a plist that does not
// parse fails at login with a message nobody sees. So the shape is checked
// here, escaping included — a home directory containing an ampersand is
// unusual, not impossible.

const test = require('node:test')
const assert = require('node:assert/strict')

const { escapeXml, installationNotes, launchdPlist, systemdUnit } = require('../src/service')
const { parseArguments } = require('../src/index')

test('the plist names the binary, the command and the directory', () => {
  const plist = launchdPlist({
    binary: '/usr/local/bin/rotad',
    configDir: '/Users/someone/.config/rota',
  })

  assert.match(plist, /<!DOCTYPE plist PUBLIC/)
  assert.match(plist, /<string>com\.rota\.daemon<\/string>/)
  assert.match(plist, /<string>\/usr\/local\/bin\/rotad<\/string>/)
  assert.match(plist, /<string>run<\/string>/)
  assert.match(plist, /<string>--config-dir<\/string>/)
  assert.match(plist, /<string>\/Users\/someone\/\.config\/rota<\/string>/)
})

test('the plist restarts a crash but respects a clean stop', () => {
  const plist = launchdPlist({ binary: '/bin/rotad', configDir: '/tmp/c' })
  // KeepAlive as a bare <true/> would restart it after SIGTERM too, which would
  // make "stop it" impossible without unloading the agent.
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/)
})

test('the log paths follow the configuration directory', () => {
  const plist = launchdPlist({ binary: '/bin/rotad', configDir: '/tmp/c' })
  assert.match(plist, /<string>\/tmp\/c\/logs\/rotad\.out\.log<\/string>/)
  assert.match(plist, /<string>\/tmp\/c\/logs\/rotad\.err\.log<\/string>/)
})

test('a path with XML in it does not produce a broken plist', () => {
  const plist = launchdPlist({ binary: '/bin/tt', configDir: '/Users/a & b/<c>' })
  assert.match(plist, /<string>\/Users\/a &amp; b\/&lt;c&gt;<\/string>/)
  assert.equal(plist.includes('/Users/a & b/<c>'), false)
})

test('escaping covers the five characters that matter', () => {
  assert.equal(escapeXml(`& < > " '`), `&amp; &lt; &gt; &quot; &apos;`)
})

test('the systemd unit is a user unit and starts the same command', () => {
  const unit = systemdUnit({ binary: '/usr/bin/rotad', configDir: '/home/a/.config/rota' })
  assert.match(unit, /ExecStart=\/usr\/bin\/rotad run --config-dir \/home\/a\/\.config\/rota/)
  assert.match(unit, /WantedBy=default\.target/)
  // A job may outlive the stop request by its own timeout.
  assert.match(unit, /TimeoutStopSec=60/)
})

test('the notes say nothing was installed, and how to install it', () => {
  for (const kind of ['launchd', 'systemd']) {
    const notes = installationNotes(kind, { configDir: '/tmp/c' })
    assert.match(notes, /Nothing has been installed/)
    assert.match(notes, /rotad service/)
  }
})

test('run is the command you get for saying nothing', () => {
  assert.deepEqual(parseArguments([]), {
    command: 'run',
    options: { configDir: null, binary: null },
  })
})

test('the configuration directory is carried through', () => {
  const { command, options } = parseArguments(['run', '--config-dir', '/tmp/x'])
  assert.equal(command, 'run')
  assert.equal(options.configDir, '/tmp/x')
})

test('service needs a kind it recognises', () => {
  assert.equal(parseArguments(['service']).error, 'service needs a kind: launchd or systemd')
  assert.match(parseArguments(['service', 'upstart']).error, /unknown service kind: upstart/)
  assert.equal(parseArguments(['service', 'launchd']).options.kind, 'launchd')
})

test('an option missing its value is refused rather than swallowed', () => {
  assert.equal(parseArguments(['run', '--config-dir']).error, '--config-dir needs a value')
})

test('an unknown option or command is refused by name', () => {
  assert.match(parseArguments(['--nope']).error, /unknown option: --nope/)
  assert.match(parseArguments(['dance']).error, /unknown command: dance/)
  assert.match(parseArguments(['run', 'twice']).error, /unexpected argument: twice/)
})

test('help and version win wherever they appear', () => {
  assert.equal(parseArguments(['--help']).command, 'help')
  assert.equal(parseArguments(['run', '--config-dir', '/tmp/x', '--version']).command, 'version')
})
