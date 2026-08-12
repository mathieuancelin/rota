// Filtering and ordering the job list, knowing nothing of React.
//
// Separate from the view so that it can be exercised: two details regress
// silently there — accents, which one does not type into a filter field, and
// jobs with neither occurrence nor execution, which would rise to the top of a
// sort on a missing value.

/** Case- and accent-insensitive: "veille" must find "Veillée". */
export const fold = (text) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * The identifier is searched on top of the name and the description: it is the
 * one under your eyes in the history and in the Discord commands.
 */
export const matches = (job, needle) =>
  [job.name, job.description, job.id].some((field) => fold(field).includes(needle))

/** Absent last, whatever the direction: a missing value is not zero. */
export function byDate(a, b, direction) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const diff = Date.parse(a) - Date.parse(b)
  return direction === 'asc' ? diff : -diff
}

export const SORTS = {
  // The default, and it is a choice: a list that does not move can be learnt.
  // The other two reorder under the cursor as executions come and go.
  name: {
    label: 'Name',
    compare: (a, b) => a.name.localeCompare(b.name, 'en'),
  },
  next: {
    label: 'Next run',
    compare: (a, b) => byDate(a.nextRunAt, b.nextRunAt, 'asc'),
  },
  last: {
    label: 'Last run',
    compare: (a, b) => byDate(a.lastRun?.at, b.lastRun?.at, 'desc'),
  },
}

/**
 * @param {object[]} jobs jobs from the state snapshot
 * @param {{search: string, sort: string}} options
 * @returns {object[]} a new list — the snapshot is never sorted in place
 */
export function arrange(jobs, { search = '', sort = 'name' } = {}) {
  const needle = fold(search.trim())
  return jobs
    .filter((job) => needle === '' || matches(job, needle))
    .sort((SORTS[sort] ?? SORTS.name).compare)
}
