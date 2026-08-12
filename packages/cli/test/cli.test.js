'use strict'

// The command line, minus the network.
//
// What is worth testing here is what the network cannot tell you: that the help
// only offers options a command reads, that a table's columns line up once the
// colour is stripped, that a stream frame split across two packets is still one
// event, and that an address you can listen on is turned into one you can dial.

const test = require('node:test')
const assert = require('node:assert/strict')

const { COMMANDS, SOURCE, commandHelp, usage } = require('../src/help')
const { createStyle, duration, relativeTime, table, visibleLength } = require('../src/render')
const { normaliseHost, parseFrame, resolveEndpoint, ApiError } = require('../src/api')
const { parseArguments } = require('../src/index')
const { describeEvent } = require('../src/commands')

const plain = createStyle(false)

// --- help ---------------------------------------------------------------------

test('every command appears in the usage list', () => {
  const text = usage()
  for (const command of COMMANDS) {
    assert.ok(text.includes(command.name), `${command.name} is missing from the usage`)
    assert.ok(text.includes(command.summary), `${command.name}'s summary is missing`)
  }
})

test('every command has its own help', () => {
  for (const command of COMMANDS) {
    const text = commandHelp(command.name)
    assert.ok(text, `${command.name} has no help`)
    assert.ok(text.includes(command.summary))
  }
})

test('a command is only offered the options it reads', () => {
  // The whole reason the options are declared rather than written out: a help
  // that offered --remote everywhere would be worse than none, because it
  // would be believed.
  assert.ok(commandHelp('jobs').includes('--remote'))
  assert.ok(!commandHelp('show').includes('--remote'))
  assert.ok(!commandHelp('validate').includes('--remote'))

  assert.ok(commandHelp('history').includes('--limit'))
  assert.ok(!commandHelp('status').includes('--limit'))

  // A disk command has no use for a token.
  assert.ok(!commandHelp('show').includes('--token'))
  assert.ok(commandHelp('run').includes('--token'))
})

test('the help says where each command gets its answer', () => {
  assert.match(commandHelp('show'), /Works with nothing running/)
  assert.match(commandHelp('run'), /over HTTP/)
  assert.match(commandHelp('enable'), /Writes the job file/)
})

test('every command in the table is implemented', () => {
  const commands = require('../src/commands')
  for (const command of COMMANDS) {
    assert.equal(typeof commands[command.name], 'function', `${command.name} is documented but absent`)
  }
})

test('the three sources are all represented', () => {
  const sources = new Set(COMMANDS.map((c) => c.source))
  assert.deepEqual([...sources].sort(), [SOURCE.API, SOURCE.DISK, SOURCE.FILE].sort())
})

// --- arguments ----------------------------------------------------------------

test('a bare command parses to itself', () => {
  const { name, argument, options } = parseArguments(['jobs'])
  assert.equal(name, 'jobs')
  assert.equal(argument, null)
  assert.equal(options.json, false)
})

test('an identifier is the one positional a command takes', () => {
  const { name, argument } = parseArguments(['show', 'sync-notes'])
  assert.equal(name, 'show')
  assert.equal(argument, 'sync-notes')
})

test('a second identifier is refused rather than ignored', () => {
  assert.match(parseArguments(['show', 'a', 'b']).error, /unexpected argument: b/)
})

test('options are read wherever they appear', () => {
  const { name, argument, options } = parseArguments([
    '--json',
    'history',
    '--limit',
    '5',
    'sync',
    '--config-dir',
    '/tmp/c',
  ])
  assert.equal(name, 'history')
  assert.equal(argument, 'sync')
  assert.equal(options.json, true)
  assert.equal(options.limit, 5)
  assert.equal(options.configDir, '/tmp/c')
})

test('--limit wants a number that means something', () => {
  assert.match(parseArguments(['history', 'x', '--limit', 'lots']).error, /positive number/)
  assert.match(parseArguments(['history', 'x', '--limit', '0']).error, /positive number/)
  assert.match(parseArguments(['history', 'x', '--limit', '-3']).error, /positive number/)
})

test('an option missing its value is refused rather than swallowing the command', () => {
  assert.match(parseArguments(['--token']).error, /--token needs a value/)
})

test('both spellings of colour are accepted', () => {
  assert.equal(parseArguments(['jobs', '--no-colour']).options.colour, false)
  assert.equal(parseArguments(['jobs', '--no-color']).options.colour, false)
})

test('an unknown option is named', () => {
  assert.match(parseArguments(['jobs', '--verbose']).error, /unknown option: --verbose/)
})

// --- rendering ----------------------------------------------------------------

test('a table lines its columns up', () => {
  const rows = [
    ['a', 'short', 'x'],
    ['bbbbbb', 'much longer cell', 'y'],
  ]
  const lines = table(['ID', 'NAME', 'Z'], rows, { style: plain }).split('\n')
  const column = (line) => line.indexOf('short') !== -1 || line.indexOf('much longer') !== -1

  const [, first, second] = lines
  assert.equal(first.indexOf('short'), second.indexOf('much longer cell'))
  assert.ok(column(first) && column(second))
})

test('colour does not shift a column', () => {
  const styled = createStyle(true)
  const rows = [
    [styled.bold('a'), 'one'],
    ['bbbbbb', 'two'],
  ]
  const lines = table(['ID', 'N'], rows, { style: plain }).split('\n')
  // The escape sequences are invisible, so the second column starts at the same
  // place on both rows.
  assert.equal(
    lines[1].replace(/\u001b\[\d+m/g, '').indexOf('one'),
    lines[2].indexOf('two'),
  )
})

test('an empty table says so instead of printing headers over nothing', () => {
  assert.equal(table(['A'], [], { style: plain, empty: 'no job' }), 'no job')
})

test('escape sequences do not count towards a width', () => {
  const styled = createStyle(true)
  assert.equal(visibleLength(styled.red('abc')), 3)
})

test('relative time reads the way the question is asked', () => {
  const now = Date.parse('2026-08-11T12:00:00Z')
  assert.equal(relativeTime(null, now), 'never')
  assert.equal(relativeTime('2026-08-11T12:00:02Z', now), 'now')
  assert.equal(relativeTime('2026-08-11T12:04:00Z', now), 'in 4 min')
  assert.equal(relativeTime('2026-08-11T09:00:00Z', now), '3 h ago')
  assert.equal(relativeTime('2026-08-14T12:00:00Z', now), 'in 3 d')
})

test('a duration is not something to divide in your head', () => {
  assert.equal(duration(340), '340 ms')
  assert.equal(duration(1200), '1.2 s')
  assert.equal(duration(125_000), '2 min 5 s')
  assert.equal(duration(null), '')
})

// --- the stream ---------------------------------------------------------------

test('a frame is an event and its payload', () => {
  assert.deepEqual(parseFrame('event: started\ndata: {"jobId":"x"}'), {
    event: 'started',
    data: { jobId: 'x' },
  })
})

test('a keep-alive comment is not an event', () => {
  assert.equal(parseFrame(': keep-alive'), null)
  assert.equal(parseFrame(': attached'), null)
})

test('a frame with no event name is a message', () => {
  assert.deepEqual(parseFrame('data: 1'), { event: 'message', data: 1 })
})

test('an unparseable payload is handed over as text rather than dropped', () => {
  assert.deepEqual(parseFrame('event: x\ndata: not json'), { event: 'x', data: 'not json' })
})

test('events are described in one line each', () => {
  assert.match(describeEvent({ event: 'started', data: { jobId: 'sync', trigger: 'schedule' } }, plain), /sync/)
  assert.match(
    describeEvent({ event: 'finished', data: { jobId: 'sync', status: 'success', durationMs: 1200 } }, plain),
    /sync.*success.*1\.2 s/,
  )
  // Output that is only whitespace is not worth a line.
  assert.equal(describeEvent({ event: 'output', data: { chunk: '\n' } }, plain), null)
  // The state carries the whole world; printing it would drown everything else.
  assert.match(
    describeEvent({ event: 'state', data: { jobs: [1, 2], scheduler: { running: 1 } } }, plain),
    /2 job\(s\), 1 running/,
  )
})

test('an output chunk of several lines is several lines', () => {
  const line = describeEvent({ event: 'output', data: { chunk: 'a\nb\n', stream: 'stdout' } }, plain)
  assert.equal(line.split('\n').length, 2)
})

// --- the endpoint -------------------------------------------------------------

function fakeStore(http, { envFile = '/nonexistent/.env' } = {}) {
  return { getConfig: () => ({ http }), paths: { envFile } }
}

test('an address you listen on is turned into one you can dial', () => {
  assert.equal(normaliseHost('0.0.0.0'), '127.0.0.1')
  assert.equal(normaliseHost('::'), '127.0.0.1')
  assert.equal(normaliseHost('127.0.0.1'), '127.0.0.1')
  assert.equal(normaliseHost('::1'), '[::1]')
})

test('the address and the token come from the configuration', () => {
  const store = fakeStore({ enabled: true, apiEnabled: true, listen: '127.0.0.1', port: 47823, token: 'tt_abc' })
  assert.deepEqual(resolveEndpoint(store, {}), { base: 'http://127.0.0.1:47823', token: 'tt_abc' })
})

test('an argument beats the environment, which beats the file', () => {
  const store = fakeStore({ enabled: true, apiEnabled: true, listen: '127.0.0.1', port: 1, token: 'from-file' })
  assert.equal(resolveEndpoint(store, { env: {} }).token, 'from-file')
  assert.equal(resolveEndpoint(store, { env: { ROTA_TOKEN: 'from-env' } }).token, 'from-env')
  assert.equal(
    resolveEndpoint(store, { token: 'from-argument', env: { ROTA_TOKEN: 'from-env' } }).token,
    'from-argument',
  )
})

test('a server that is off is said to be off, not simply unreachable', () => {
  assert.throws(
    () => resolveEndpoint(fakeStore({ enabled: false, apiEnabled: true, token: 't' }), {}),
    (err) => {
      assert.ok(err instanceof ApiError)
      assert.match(err.message, /disabled/)
      return true
    },
  )
})

test('the API being off is a different sentence from the port being shut', () => {
  assert.throws(
    () => resolveEndpoint(fakeStore({ enabled: true, apiEnabled: false, token: 't' }), {}),
    /the API is not/,
  )
})

test('--url reaches an engine the local configuration knows nothing about', () => {
  const store = fakeStore({ enabled: false, apiEnabled: false, token: null })
  const endpoint = resolveEndpoint(store, { url: 'http://elsewhere:9000/', token: 'x' })
  assert.equal(endpoint.base, 'http://elsewhere:9000')
})

test('having no token at all is refused before anything is sent', () => {
  const store = fakeStore({ enabled: true, apiEnabled: true, listen: '127.0.0.1', port: 1, token: null })
  assert.throws(() => resolveEndpoint(store, { env: {} }), /no token to present/)
})
