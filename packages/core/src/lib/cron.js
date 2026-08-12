'use strict'

// Five-field cron expressions: minute, hour, day of month, month, day of week.
//
// Written here rather than pulled from a dependency: the format is small, frozen
// for forty years, and entirely verifiable by tests. The difficulty is not the
// parsing, it is two rules people forget:
//
//   * when the day of month AND the day of week are both restricted, the
//     occurrence happens if one OR the other matches — never both at once.
//     "0 0 1 * 1" means "on the 1st of the month, and also every Monday". A
//     field starting with "*" does not count as restricted, as in Vixie's cron,
//     where this rule comes from.
//   * everything is computed in local time. A job at 02:30 therefore does not
//     happen on the night the clock springs forward, when that minute does not
//     exist, and happens once — not twice — when it falls back.
//
// No extensions: no seconds, no "L", no "#", no "?". A six-field expression is
// refused with a message saying so, rather than reinterpreted.

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const FIELDS = [
  { key: 'minute', label: 'minute', min: 0, max: 59 },
  { key: 'hour', label: 'hour', min: 0, max: 23 },
  { key: 'dayOfMonth', label: 'day of month', min: 1, max: 31 },
  { key: 'month', label: 'month', min: 1, max: 12, names: MONTH_NAMES, namesFrom: 1 },
  { key: 'dayOfWeek', label: 'day of week', min: 0, max: 7, names: DAY_NAMES, namesFrom: 0 },
]

// Usual shorthands, taken as they are from crontab(5).
const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

// Four years necessarily cover a 29 February. Beyond that, the expression
// describes a date that does not exist ("31 February") and the search stops.
const SEARCH_YEARS = 4

function parseValue(token, field) {
  const lowered = token.toLowerCase()
  if (field.names) {
    const index = field.names.indexOf(lowered)
    if (index !== -1) return index + field.namesFrom
  }
  if (!/^\d+$/.test(token)) return null
  return Number(token)
}

/**
 * Parses one field.
 * @returns {{ok: true, values: Set<number>, restricted: boolean} | {ok: false, error: string}}
 */
function parseField(raw, field) {
  const values = new Set()
  // Vixie: only a field starting with "*" escapes the OR rule between day of
  // month and day of week.
  const restricted = !raw.startsWith('*')

  for (const part of raw.split(',')) {
    if (part === '') return { ok: false, error: `${field.label}: empty element in "${raw}"` }

    const [range, stepText, ...extra] = part.split('/')
    if (extra.length > 0) return { ok: false, error: `${field.label}: "${part}" has more than one step` }

    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        return { ok: false, error: `${field.label}: invalid step in "${part}"` }
      }
      step = Number(stepText)
    }

    let from
    let to
    if (range === '*') {
      from = field.min
      to = field.max
    } else if (range.includes('-')) {
      const [startText, endText, ...rest] = range.split('-')
      if (rest.length > 0) return { ok: false, error: `${field.label}: invalid range "${range}"` }
      from = parseValue(startText, field)
      to = parseValue(endText, field)
    } else {
      from = parseValue(range, field)
      // "5/2" means "from 5 on, every 2": that is an implicit range up to the
      // field's maximum.
      to = stepText === undefined ? from : field.max
    }

    if (from === null || to === null) {
      return { ok: false, error: `${field.label}: "${range}" is not a recognised value` }
    }
    for (const value of [from, to]) {
      if (value < field.min || value > field.max) {
        return {
          ok: false,
          error: `${field.label}: ${value} is out of ${field.min}-${field.max}`,
        }
      }
    }
    if (from > to) {
      return { ok: false, error: `${field.label}: reversed range "${range}"` }
    }

    for (let value = from; value <= to; value += step) values.add(value)
  }

  // Sunday is written 0 or 7; getDay() only knows 0.
  if (field.key === 'dayOfWeek' && values.delete(7)) values.add(0)

  return { ok: true, values, restricted }
}

/**
 * Parses a whole expression.
 * @param {string} expression
 * @returns {{ok: true, fields: object} | {ok: false, error: string}}
 */
function parseCron(expression) {
  if (typeof expression !== 'string') {
    return { ok: false, error: 'a string is expected' }
  }
  const trimmed = expression.trim()
  if (trimmed === '') return { ok: false, error: 'empty expression' }

  const resolved = ALIASES[trimmed.toLowerCase()] ?? trimmed
  const parts = resolved.split(/\s+/)

  if (parts.length !== 5) {
    const extra =
      parts.length === 6
        ? ' Seconds are not supported: the minute is the smallest step.'
        : ''
    return {
      ok: false,
      error: `five fields expected (minute hour day month weekday), got ${parts.length}.${extra}`,
    }
  }

  const fields = {}
  for (const [index, field] of FIELDS.entries()) {
    const result = parseField(parts[index], field)
    if (!result.ok) return result
    fields[field.key] = result
  }
  return { ok: true, fields }
}

// The scheduler recomputes occurrences on every sync: we do not reparse the
// same expression dozens of times.
const compiled = new Map()

/** @returns {object|null} parsed fields, or null if the expression is invalid */
function compileCron(expression) {
  if (!compiled.has(expression)) {
    const result = parseCron(expression)
    compiled.set(expression, result.ok ? result.fields : null)
  }
  return compiled.get(expression)
}

function matchesDay(fields, date) {
  const { dayOfMonth, dayOfWeek } = fields
  const dayMatch = dayOfMonth.values.has(date.getDate())
  const weekMatch = dayOfWeek.values.has(date.getDay())

  if (dayOfMonth.restricted && dayOfWeek.restricted) return dayMatch || weekMatch
  if (dayOfMonth.restricted) return dayMatch
  if (dayOfWeek.restricted) return weekMatch
  return true
}

/**
 * First occurrence strictly after `from`.
 *
 * Advances field by field rather than minute by minute: a yearly expression
 * would otherwise take half a million iterations.
 *
 * @param {object} fields parsed fields
 * @param {number} from epoch ms
 * @returns {number|null} epoch ms, or null if the expression describes no date
 */
function nextOccurrence(fields, from) {
  const date = new Date(from)
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)

  const limit = new Date(date)
  limit.setFullYear(limit.getFullYear() + SEARCH_YEARS)

  while (date <= limit) {
    if (!fields.month.values.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1)
      date.setHours(0, 0, 0, 0)
      continue
    }
    if (!matchesDay(fields, date)) {
      date.setDate(date.getDate() + 1)
      date.setHours(0, 0, 0, 0)
      continue
    }
    if (!fields.hour.values.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!fields.minute.values.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0)
      continue
    }
    return date.getTime()
  }
  return null
}

/**
 * Number of occurrences in the interval ]from, until].
 *
 * Only used to decide on a catch-up and to log it: the count is bounded so
 * that a per-minute expression and a month-long sleep do not cost forty
 * thousand iterations.
 *
 * @returns {number}
 */
function countOccurrences(fields, from, until, { max = 1000 } = {}) {
  let count = 0
  let cursor = from
  while (count < max) {
    const next = nextOccurrence(fields, cursor)
    if (next === null || next > until) break
    count += 1
    cursor = next
  }
  return count
}

module.exports = { parseCron, compileCron, nextOccurrence, countOccurrences, ALIASES }
