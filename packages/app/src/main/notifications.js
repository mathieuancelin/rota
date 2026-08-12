'use strict'

// System notifications, configurable per job.
//
// The goal the spec states for the first job: stay silent as long as all is
// well. The default is therefore "errors only".

const path = require('node:path')
const { Notification, nativeImage } = require('electron')
const { logger } = require('@rota/core')

// The logo varied by outcome: green on success, red on failure, plain for the
// rest. Unlike the tray icons, these are not template images — macOS recolours
// nothing, they are three distinct files.
const ICONS_DIR = path.join(__dirname, '..', '..', 'assets', 'notification')
const icons = new Map()

/**
 * @param {'neutral'|'success'|'error'} name
 * @returns {import('electron').NativeImage|undefined} undefined if the file is
 *          missing — the notification then goes out with the application's icon,
 *          which beats not going out at all.
 */
function icon(name) {
  if (!icons.has(name)) {
    const image = nativeImage.createFromPath(path.join(ICONS_DIR, `${name}.png`))
    if (image.isEmpty()) logger.warn(`notification icon not found: ${name}`)
    icons.set(name, image.isEmpty() ? undefined : image)
  }
  return icons.get(name)
}

const STATUS_LABELS = {
  'timed-out': 'Timed out',
  cancelled: 'Stop requested',
  'skipped-already-running': 'Execution skipped',
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} seconds`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes} min ${rest} s`
}

/**
 * @param {object} deps
 * @param {(jobId: string, executionId: string) => void} deps.onErrorClick
 */
// A notification nobody holds a reference to any more can be collected by the GC
// before the system has presented it: it then disappears with no error and no
// trace. So we keep them until they close.
const RETENTION_MS = 60_000

function createNotifier({ onErrorClick }) {
  const supported = Notification.isSupported()
  if (!supported) logger.warn('system notifications unavailable')

  const pending = new Set()
  // The system's last refusal, reported to the settings: a notification that
  // does not arrive is otherwise impossible to tell from a silent job.
  let lastFailure = null

  const show = (options, onClick) => {
    if (!supported) return

    const notification = new Notification(options)
    pending.add(notification)

    const forget = () => {
      clearTimeout(timer)
      pending.delete(notification)
    }
    // Net: "close" does not fire in every case.
    const timer = setTimeout(forget, RETENTION_MS)
    timer.unref?.()

    // These two traces make it possible to tell "the application emitted
    // nothing" from "the system refused to display" — without them, a missing
    // notification is undebuggable.
    notification.on('show', () => {
      lastFailure = null
      logger.info(`notification displayed: ${options.title}`)
    })
    notification.on('failed', (_event, error) => {
      lastFailure = { at: new Date().toISOString(), reason: String(error) }
      logger.warn(`notification refused by the system: ${error}`)
      forget()
    })
    notification.on('close', forget)
    if (onClick) {
      notification.on('click', () => {
        onClick()
        forget()
      })
    }

    logger.info(`notification emitted: ${options.title}`)
    notification.show()
  }

  return {
    /** State reported to the settings. */
    getStatus() {
      return { supported, lastFailure }
    },

    started(job, execution) {
      if (!job.notifications.onStart) return
      show({
        title: `${job.name} started`,
        body: job.description || undefined,
        icon: icon('neutral'),
        silent: true,
      })
    },

    finished(job, execution) {
      const { status } = execution

      if (status === 'success') {
        const changed = Boolean(execution.change?.changed)

        // onChange wins when both are active: a single notification, and the one
        // carrying the script's message is the more informative.
        if (job.notifications.onChange && changed) {
          show({
            title: `${job.name}: ${execution.change.message ?? 'changes applied'}`,
            body: `Finished in ${formatDuration(execution.durationMs)}.`,
            icon: icon('success'),
            silent: true,
          })
          return
        }

        if (!job.notifications.onSuccess) return
        show({
          title: `${job.name} finished`,
          body: `Ran successfully in ${formatDuration(execution.durationMs)}.`,
          icon: icon('success'),
          silent: true,
        })
        return
      }

      // An execution skipped because the previous one is still running is not a
      // failure: reporting it on every cycle would be noise.
      if (status === 'skipped-already-running' || status === 'cancelled') return

      if (!job.notifications.onError) return
      show(
        {
          title: `${job.name} failed`,
          body: execution.error ?? STATUS_LABELS[status] ?? 'The script failed.',
          icon: icon('error'),
          urgency: 'critical',
        },
        () => onErrorClick(job.id, execution.executionId),
      )
    },
  }
}

module.exports = { createNotifier, formatDuration }
