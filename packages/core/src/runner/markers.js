'use strict'

// The marker by which a script reports that it has actually had an effect.
//
// Many recurring jobs do nothing most of the time: a sync running every five
// minutes only has something to push once in a while. Notifying every success
// amounts to notifying "nothing happened" 288 times a day, which mostly teaches
// people to ignore notifications.
//
// The script writes to its standard output:
//
//   ::rota:changed::
//   ::rota:changed:: 3 files pushed
//
// The optional part following the marker becomes the body of the notification.
// The marker stays visible in the history: hiding it would make the displayed
// output different from what the script actually wrote.

// Two more markers give a script what `report` and `report_discord` give an
// agent: a window, a Discord message. Same names as the tools, so that whoever
// knows one knows the other.
//
//   ::rota:report:: Nightly sync
//   ## 3 files pushed
//   - notes.md
//   ::rota:end::
//
// What follows the opening marker is the title, optional. What follows the line
// is the body, up to `::rota:end::`. A block left open by a script that died
// in the middle is still delivered: having written the report is enough, and
// swallowing it would lose precisely what was meant to be said.
//
// The destination comes from the settings, never from the script — which is what
// lets these work inside the sandbox, where `fetch` is out of reach. A script
// says what it has to say and Rota decides where that goes.

const MARKER = '::rota:changed::'
const REPORT = '::rota:report::'
const REPORT_DISCORD = '::rota:report_discord::'
const END = '::rota:end::'

const OPENINGS = [
  { marker: REPORT, destination: 'window' },
  { marker: REPORT_DISCORD, destination: 'discord' },
]

/**
 * @param {string} stdout
 * @returns {{changed: true, message: string|null} | null}
 */
function parseChangeMarker(stdout) {
  if (typeof stdout !== 'string' || !stdout.includes(MARKER)) return null

  // The last occurrence: the last state announced is the one that counts.
  let found = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(MARKER)) continue
    const message = trimmed.slice(MARKER.length).trim()
    found = { changed: true, message: message.length > 0 ? message : null }
  }
  return found
}

/**
 * Reports a script asked for, in the order it wrote them.
 *
 * @param {string} stdout
 * @returns {Array<{destination: 'window'|'discord', title: string|null, markdown: string}>}
 */
function parseReports(stdout) {
  if (typeof stdout !== 'string') return []
  if (!stdout.includes(REPORT) && !stdout.includes(REPORT_DISCORD)) return []

  const reports = []
  let open = null

  // A report is closed by its end marker, by the next opening — a forgotten
  // `::rota:end::` must not swallow the report that follows — or by the end
  // of the output.
  const close = () => {
    if (!open) return
    const markdown = open.lines.join('\n').trim()
    if (markdown !== '') reports.push({ ...open, lines: undefined, markdown })
    open = null
  }

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()

    const opening = OPENINGS.find(({ marker }) => trimmed.startsWith(marker))
    if (opening) {
      close()
      const title = trimmed.slice(opening.marker.length).trim()
      open = { destination: opening.destination, title: title === '' ? null : title, lines: [] }
      continue
    }

    if (trimmed === END) {
      close()
      continue
    }

    // Everything outside a block is ordinary output, and stays so: what the
    // script wrote is what the history shows.
    if (open) open.lines.push(line)
  }
  close()

  return reports.map(({ destination, title, markdown }) => ({ destination, title, markdown }))
}

module.exports = { parseChangeMarker, parseReports, MARKER, REPORT, REPORT_DISCORD, END }
