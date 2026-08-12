'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseChangeMarker, MARKER } = require('../src/runner/markers')

test('an output with no marker reports no effect', () => {
  assert.equal(parseChangeMarker('No local change\nNothing to push\n'), null)
  assert.equal(parseChangeMarker(''), null)
})

test('the marker on its own reports an effect with no message', () => {
  assert.deepEqual(parseChangeMarker(`travail\n${MARKER}\n`), { changed: true, message: null })
})

test('the text after the marker becomes the message', () => {
  assert.deepEqual(parseChangeMarker(`${MARKER} 3 files pushed`), {
    changed: true,
    message: '3 files pushed',
  })
})

test('the marker is recognised in the middle of a chatty output', () => {
  const stdout = ['ligne 1', 'ligne 2', `${MARKER} 1 commit pushed`, 'ligne 4'].join('\n')
  assert.deepEqual(parseChangeMarker(stdout), { changed: true, message: '1 commit pushed' })
})

test('the last occurrence is the one that counts', () => {
  const stdout = `${MARKER} first state\n${MARKER} final state\n`
  assert.equal(parseChangeMarker(stdout).message, 'final state')
})

test('indentation around the marker is tolerated', () => {
  assert.deepEqual(parseChangeMarker(`   ${MARKER} indented   `), {
    changed: true,
    message: 'indented',
  })
})

test('a marker mentioned mid-line does not count', () => {
  // Otherwise a script documenting the convention would report itself.
  assert.equal(parseChangeMarker(`write ${MARKER} to report an effect`), null)
})

test('an entry that is not a string does not throw', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.equal(parseChangeMarker(input), null)
  }
})

// --- reports ----------------------------------------------------------------
//
// What `report` and `report_discord` give an agent, given to a script that has
// no tools: a window, a Discord message.

const { parseReports, REPORT, REPORT_DISCORD, END } = require('../src/runner/markers')

test('an ordinary output asks for no report', () => {
  assert.deepEqual(parseReports('nothing to report\n'), [])
  assert.deepEqual(parseReports(''), [])
  assert.deepEqual(parseReports(null), [])
})

test('a block becomes a report, title included', () => {
  const stdout = [
    'travail…',
    `${REPORT} Sync nocturne`,
    '## 3 fichiers',
    '- notes.md',
    END,
    'finished',
  ].join('\n')

  assert.deepEqual(parseReports(stdout), [
    { destination: 'window', title: 'Sync nocturne', markdown: '## 3 fichiers\n- notes.md' },
  ])
})

test('the title is optional', () => {
  assert.deepEqual(parseReports(`${REPORT}\ncorps\n${END}`), [
    { destination: 'window', title: null, markdown: 'corps' },
  ])
})

test('report_discord aims at the channel, not the window', () => {
  assert.deepEqual(parseReports(`${REPORT_DISCORD} Veille\ntrois articles\n${END}`), [
    { destination: 'discord', title: 'Veille', markdown: 'trois articles' },
  ])
})

test('several reports go out in the order they were written', () => {
  const stdout = [
    `${REPORT} un`, 'a', END,
    `${REPORT_DISCORD} deux`, 'b', END,
  ].join('\n')

  assert.deepEqual(
    parseReports(stdout).map((r) => [r.destination, r.title]),
    [['window', 'un'], ['discord', 'deux']],
  )
})

// Having written the report is enough: a script that died in the middle still
// said what it had to say, and swallowing it would lose precisely that.
test('a block left open is delivered all the same', () => {
  assert.deepEqual(parseReports(`${REPORT} Interrompu\nwhat is already known`), [
    { destination: 'window', title: 'Interrompu', markdown: "what is already known" },
  ])
})

test('a forgotten end does not swallow the next report', () => {
  const stdout = [`${REPORT} un`, 'a', `${REPORT} deux`, 'b', END].join('\n')

  assert.deepEqual(
    parseReports(stdout).map((r) => [r.title, r.markdown]),
    [['un', 'a'], ['deux', 'b']],
  )
})

test('an empty block asks for nothing', () => {
  assert.deepEqual(parseReports(`${REPORT} Titre\n\n  \n${END}`), [])
})

test("the markdown's own indentation is kept", () => {
  const [report] = parseReports(`${REPORT}\n- a\n  - b\n${END}`)

  assert.equal(report.markdown, '- a\n  - b')
})

// The two markers look alike; one must not be read for the other.
test('report and report_discord are not confused', () => {
  assert.equal(parseReports(`${REPORT_DISCORD}\nx\n${END}`)[0].destination, 'discord')
  assert.equal(parseReports(`${REPORT}\nx\n${END}`)[0].destination, 'window')
})

test('the markers stay in the output: the change can still be read', () => {
  const stdout = [`${REPORT} Fait`, 'corps', END, `${MARKER} 3 fichiers`].join('\n')

  assert.deepEqual(parseChangeMarker(stdout), { changed: true, message: '3 fichiers' })
  assert.equal(parseReports(stdout).length, 1)
})
