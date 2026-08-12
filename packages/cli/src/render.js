'use strict'

// Turning answers into something a terminal reads well.
//
// Two rules throughout. Columns are padded to the widest cell rather than to a
// guess, because a table whose columns move between runs is one you have to
// read rather than scan. And colour is decoration only: every line says the
// same thing with the escape sequences stripped, which is what happens the
// moment anybody pipes this into grep.

const STATUS_COLOURS = {
  success: 'green',
  failed: 'red',
  'timed-out': 'red',
  'skipped-already-running': 'yellow',
  'skipped-locked-session': 'yellow',
  cancelled: 'yellow',
}

const CODES = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
}

// Escape sequences occupy no columns; a width that counted them would push the
// coloured rows of a table out of line with the plain ones.
const ANSI = /\u001b\[\d+m/g

function createStyle(enabled) {
  const style = {}
  for (const name of Object.keys(CODES)) {
    style[name] = (text) => (enabled ? `${CODES[name]}${text}${CODES.reset}` : String(text))
  }
  style.status = (status) => {
    const colour = STATUS_COLOURS[status]
    return colour ? style[colour](status) : String(status)
  }
  return style
}

/** Escape sequences must not count towards a column's width. */
function visibleLength(text) {
  return String(text).replace(/\[\d+m/g, '').length
}

function pad(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - visibleLength(text)))
}

/**
 * A table with a header, or a single line when there is nothing in it — an
 * empty table with headers reads as a bug rather than as an answer.
 *
 * @param {string[]} headers
 * @param {Array<Array<string>>} rows
 * @param {{style: object, empty?: string}} options
 */
function table(headers, rows, { style, empty = 'nothing to show' }) {
  if (rows.length === 0) return style.dim(empty)

  const widths = headers.map((header, column) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[column] ?? ''))),
  )

  const line = (cells) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? String(cell) : pad(cell, widths[column])))
      .join('  ')
      .trimEnd()

  return [style.dim(line(headers)), ...rows.map((row) => line(row))].join('\n')
}

/**
 * "in 4 min", "3 h ago", "never".
 *
 * Relative rather than absolute because the question being asked is almost
 * always "soon?" or "recently?", and an ISO timestamp answers neither without
 * arithmetic.
 */
function relativeTime(value, now = Date.now()) {
  if (!value) return 'never'
  const at = typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(at)) return 'never'

  const seconds = Math.round((at - now) / 1000)
  const ahead = seconds >= 0
  const magnitude = Math.abs(seconds)

  const units = [
    ['s', 60],
    ['min', 60],
    ['h', 24],
    ['d', 7],
  ]

  let amount = magnitude
  let unit = 's'
  for (const [name, step] of units) {
    unit = name
    if (amount < step) break
    amount = Math.round(amount / step)
  }
  if (unit === 'd' && amount >= 7) {
    amount = Math.round(amount / 7)
    unit = 'w'
  }

  if (magnitude < 5) return 'now'
  return ahead ? `in ${amount} ${unit}` : `${amount} ${unit} ago`
}

/** "1.2 s", "340 ms" — a duration nobody has to divide in their head. */
function duration(ms) {
  if (ms == null) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} min ${seconds} s`
}

module.exports = { createStyle, table, relativeTime, duration, visibleLength }
