'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildCommand, formatCommand } = require('../src/runner/command')

const bunJob = {
  runner: { type: 'bun', script: '/Users/moi/scripts/sync.js', args: ['--verbose'], interpreter: 'sh' },
}
const shellJob = {
  runner: { type: 'shell', script: '/Users/moi/scripts/backup.sh', args: [], interpreter: 'bash' },
}

test('a bun job is started by the resolved binary', () => {
  assert.deepEqual(buildCommand(bunJob, { bunPath: '/Users/moi/.bun/bin/bun' }), {
    command: '/Users/moi/.bun/bin/bun',
    args: ['run', '/Users/moi/scripts/sync.js', '--verbose'],
  })
})

test('a bun-inline job starts the file produced from its code', () => {
  const job = { runner: { type: 'bun-inline', code: 'console.log(1)', args: ['--flag'] } }

  assert.deepEqual(buildCommand(job, { bunPath: 'bun', inlineScript: '/tmp/inline/demo.js' }), {
    command: 'bun',
    args: ['run', '/tmp/inline/demo.js', '--flag'],
    // The code itself appears nowhere in the command: it is on disk.
  })
})

test('the inline code is never passed as an argument', () => {
  const job = { runner: { type: 'bun-inline', code: '; rm -rf / #', args: [] } }
  const { args } = buildCommand(job, { bunPath: 'bun', inlineScript: '/tmp/inline/demo.js' })

  assert.deepEqual(args, ['run', '/tmp/inline/demo.js'])
  assert.ok(!args.some((arg) => arg.includes('rm -rf')), 'le code reste hors de la ligne de commande')
})

test('a shell job uses its interpreter', () => {
  assert.deepEqual(buildCommand(shellJob), {
    command: 'bash',
    args: ['/Users/moi/scripts/backup.sh'],
  })
})

test('the arguments stay an array, never a concatenated string', () => {
  const hostile = { runner: { type: 'shell', script: '/tmp/x.sh', args: ['; rm -rf /'], interpreter: 'sh' } }
  const { args } = buildCommand(hostile)
  assert.deepEqual(args, ['/tmp/x.sh', '; rm -rf /'])
})

test('formatCommand escapes what could mislead the reader', () => {
  const hostile = { runner: { type: 'shell', script: '/tmp/x.sh', args: ['; rm -rf /'], interpreter: 'sh' } }
  assert.equal(formatCommand(buildCommand(hostile)), "sh /tmp/x.sh '; rm -rf /'")
})

test('formatCommand leaves simple paths readable', () => {
  assert.equal(
    formatCommand(buildCommand(bunJob, { bunPath: 'bun' })),
    'bun run /Users/moi/scripts/sync.js --verbose',
  )
})

test('an apostrophe in an argument stays correctly quoted', () => {
  const job = { runner: { type: 'shell', script: "/tmp/l'ecole.sh", args: [], interpreter: 'sh' } }
  assert.equal(formatCommand(buildCommand(job)), `sh '/tmp/l'\\''ecole.sh'`)
})
