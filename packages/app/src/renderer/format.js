// Formatting shared by the views. Nothing business-related here: the renderer
// merely dresses up what the main process sends it.

export const STATUS_LABELS = {
  scheduled: 'Scheduled',
  running: 'Running',
  success: 'Succeeded',
  failed: 'Failed',
  'timed-out': 'Timed out',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  'skipped-already-running': 'Already running',
}

export const TRIGGER_LABELS = {
  schedule: 'scheduled',
  manual: 'manual',
  startup: 'at startup',
  wake: 'on wake',
  agent: 'by an agent',
  discord: 'from Discord',
  webhook: 'by webhook',
  workflow: 'by a workflow',
}

/** CSS class grouping the statuses by severity. */
export function statusTone(status) {
  if (status === 'success') return 'ok'
  if (status === 'failed' || status === 'timed-out') return 'error'
  if (status === 'running') return 'running'
  return 'muted'
}

// en-GB rather than en-US: 24-hour clock and day before month, which the former
// French format already gave — only the language changes.
const LOCALE = 'en-GB'

export function formatTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(LOCALE, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${Math.round(seconds % 60)} s`
}

/** "in 3 min", "2 hours ago". Returns null if the date is absent. */
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return null
  const deltaMs = new Date(iso).getTime() - now
  const absSeconds = Math.abs(deltaMs) / 1000

  const [value, unit] =
    absSeconds < 60
      ? [Math.round(deltaMs / 1000), 'second']
      : absSeconds < 3600
        ? [Math.round(deltaMs / 60_000), 'minute']
        : absSeconds < 86_400
          ? [Math.round(deltaMs / 3_600_000), 'hour']
          : [Math.round(deltaMs / 86_400_000), 'day']

  return new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' }).format(value, unit)
}

export function fileName(filePath) {
  return filePath ? filePath.split('/').pop() : ''
}
