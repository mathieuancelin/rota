'use strict'

// Cron expressions. A hand-written module: the one in the repository that most
// deserves tests, on a par with next-run.
//
// The dates are built in local time, as the module computes them.

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseCron, compileCron, nextOccurrence, countOccurrences } = require('../src/lib/cron')

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()
const show = (ms) => (ms === null ? 'jamais' : new Date(ms).toLocaleString('sv-SE').slice(0, 16))

function next(expression, from) {
  const fields = compileCron(expression)
  assert.ok(fields, `"${expression}" should have parsed`)
  return nextOccurrence(fields, from)
}

// --- parsing ------------------------------------------------------------------

test('the simple fields are accepted', () => {
  const result = parseCron('0 9 * * *')
  assert.equal(result.ok, true)
  assert.deepEqual([...result.fields.minute.values], [0])
  assert.deepEqual([...result.fields.hour.values], [9])
})

test('lists, ranges and steps are expanded', () => {
  const { fields } = parseCron('0,30 9-11 */10 * *')
  assert.deepEqual([...fields.minute.values].sort((a, b) => a - b), [0, 30])
  assert.deepEqual([...fields.hour.values].sort((a, b) => a - b), [9, 10, 11])
  assert.deepEqual([...fields.dayOfMonth.values].sort((a, b) => a - b), [1, 11, 21, 31])
})

test('a step over a range does not go past the range', () => {
  const { fields } = parseCron('0-30/15 * * * *')
  assert.deepEqual([...fields.minute.values].sort((a, b) => a - b), [0, 15, 30])
})

test('"5/2" means "from 5, every 2"', () => {
  const { fields } = parseCron('5/20 * * * *')
  assert.deepEqual([...fields.minute.values].sort((a, b) => a - b), [5, 25, 45])
})

test('month and day names are accepted, whatever the case', () => {
  const { fields } = parseCron('0 0 * JAN-mar mon,Fri')
  assert.deepEqual([...fields.month.values].sort((a, b) => a - b), [1, 2, 3])
  assert.deepEqual([...fields.dayOfWeek.values].sort((a, b) => a - b), [1, 5])
})

test('Sunday is written 0 or 7', () => {
  assert.deepEqual([...parseCron('0 0 * * 7').fields.dayOfWeek.values], [0])
  assert.deepEqual([...parseCron('0 0 * * 0').fields.dayOfWeek.values], [0])
})

test('the usual shorthands are recognised', () => {
  assert.deepEqual([...parseCron('@daily').fields.hour.values], [0])
  assert.deepEqual([...parseCron('@hourly').fields.minute.values], [0])
  assert.deepEqual([...parseCron('@weekly').fields.dayOfWeek.values], [0])
  assert.equal(parseCron('@yearly').ok, true)
})

test('repeated spaces and the edges do not get in the way', () => {
  assert.equal(parseCron('  0   9  *  *  *  ').ok, true)
})

// --- refusals -----------------------------------------------------------------

test('six fields are refused, naming the seconds', () => {
  const result = parseCron('0 0 9 * * *')
  assert.equal(result.ok, false)
  assert.match(result.error, /Seconds are not supported/)
})

test('a value out of bounds is refused, naming the field', () => {
  const result = parseCron('0 25 * * *')
  assert.equal(result.ok, false)
  assert.match(result.error, /hour/)
  assert.match(result.error, /0-23/)
})

test('a day of month at 32 is refused', () => {
  assert.match(parseCron('0 0 32 * *').error, /day of month/)
})

test('a reversed range is refused', () => {
  assert.match(parseCron('0 17-9 * * *').error, /reversed range/)
})

test('a zero step is refused', () => {
  assert.match(parseCron('*/0 * * * *').error, /invalid step/)
})

test('an unknown word is refused', () => {
  assert.match(parseCron('0 0 * * lundi').error, /is not a recognised value/)
})

test('the extensions that are not handled are refused', () => {
  for (const expression of ['0 0 L * *', '0 0 * * 5#3', '0 0 ? * *']) {
    assert.equal(parseCron(expression).ok, false, `"${expression}" should have been refused`)
  }
})

test('an empty or missing expression is refused without throwing', () => {
  for (const input of ['', '   ', null, undefined, 42]) {
    assert.equal(parseCron(input).ok, false)
  }
})

// --- occurrences --------------------------------------------------------------

test('the next occurrence is strictly later', () => {
  // Right on the hour: the next one is the following day, not that very instant.
  assert.equal(show(next('0 9 * * *', at(2026, 3, 10, 9, 0))), '2026-03-11 09:00')
})

test('an occurrence within the day is found', () => {
  assert.equal(show(next('30 14 * * *', at(2026, 3, 10, 9, 0))), '2026-03-10 14:30')
})

test('every five minutes', () => {
  assert.equal(show(next('*/5 * * * *', at(2026, 3, 10, 9, 2))), '2026-03-10 09:05')
})

test('weekdays skip the weekend', () => {
  // 2026-03-13 is a Friday: the next occurrence is Monday the 16th.
  assert.equal(show(next('0 9 * * 1-5', at(2026, 3, 13, 9, 0))), '2026-03-16 09:00')
})

test('a restricted month jumps to the following year', () => {
  assert.equal(show(next('0 0 1 1 *', at(2026, 3, 10, 9, 0))), '2027-01-01 00:00')
})

test('29 February only happens in leap years', () => {
  assert.equal(show(next('0 0 29 2 *', at(2026, 3, 1))), '2028-02-29 00:00')
})

test('an impossible date returns no occurrence', () => {
  assert.equal(next('0 0 30 2 *', at(2026, 3, 1)), null)
})

// The rule people forget: two restricted day fields read as an OR.
test('a restricted day of month and day of week combine as OR', () => {
  // The 1st of the month, and also every Monday. From Thursday 2026-01-01, the
  // next is Monday the 5th, not 1 February.
  assert.equal(show(next('0 0 1 * 1', at(2026, 1, 1, 0, 0))), '2026-01-05 00:00')
})

test('a single restricted day field applies on its own', () => {
  // Day of month unrestricted: only the day of week counts.
  assert.equal(show(next('0 0 * * 1', at(2026, 1, 1))), '2026-01-05 00:00')
  // Day of week unrestricted: only the day of month counts.
  assert.equal(show(next('0 0 15 * *', at(2026, 1, 1))), '2026-01-15 00:00')
})

test('a field starting with * is not restricted', () => {
  // "*/2" in day of month does not enable the OR rule: Friday alone counts, even
  // days excluded.
  const fields = compileCron('0 0 */2 * 5')
  assert.equal(fields.dayOfMonth.restricted, false)
  assert.equal(fields.dayOfWeek.restricted, true)
})

test('the seconds of the starting instant are ignored', () => {
  const from = new Date(2026, 2, 10, 8, 59, 42, 500).getTime()
  assert.equal(show(next('0 9 * * *', from)), '2026-03-10 09:00')
})

// --- counting -----------------------------------------------------------------

test('the count gives the missed occurrences', () => {
  const fields = compileCron('0 * * * *')
  assert.equal(countOccurrences(fields, at(2026, 3, 10, 0, 0), at(2026, 3, 10, 5, 0)), 5)
})

test('no missed occurrence gives zero', () => {
  const fields = compileCron('0 9 * * *')
  assert.equal(countOccurrences(fields, at(2026, 3, 10, 9, 0), at(2026, 3, 10, 10, 0)), 0)
})

test('the count is bounded, a long sleep costs nothing', () => {
  const fields = compileCron('* * * * *')
  const count = countOccurrences(fields, at(2026, 1, 1), at(2026, 12, 31), { max: 50 })
  assert.equal(count, 50)
})

// --- daylight saving ------------------------------------------------------------
//
// Europe/Paris jumps from 2am to 3am on the last Sunday of March. The tests do
// not necessarily run in that zone: we therefore only check what holds
// everywhere — the occurrence exists, falls after the start, and the computation
// terminates.

test('the spring transition does not block the search', () => {
  const from = at(2026, 3, 28, 12, 0)
  const found = next('30 2 * * *', from)
  assert.ok(found !== null, 'an occurrence must be found')
  assert.ok(found > from)
  assert.ok(found < from + 4 * 24 * 3600_000, 'et dans les jours qui suivent')
})

test('an expression already parsed is not parsed again', () => {
  assert.equal(compileCron('0 9 * * *'), compileCron('0 9 * * *'))
  assert.equal(compileCron('expression fautive'), null)
})
