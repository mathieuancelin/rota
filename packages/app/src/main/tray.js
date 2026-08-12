'use strict'

// Menu bar icon and menu.
//
// Display priority is paused > error > active > idle — the most "blocking"
// state wins.
//
// Two icon sets, because the two systems disagree about who owns the colour. On
// macOS the icons are monochrome template images and the menu bar recolours them
// with the theme. Nothing does that on Linux, where a template image arrives as
// a flat black shape and disappears into the dark panel most desktops ship: so
// the Linux set carries its own colour. Both sets draw the same four shapes, and
// the shape is what actually distinguishes the states — the colour is a second
// signal, never the only one.

const path = require('node:path')
const { Tray, Menu, nativeImage } = require('electron')

const TEMPLATE_ASSETS = path.join(__dirname, '..', '..', 'assets', 'tray')
const COLOUR_ASSETS = path.join(__dirname, '..', '..', 'assets', 'tray-linux')
const USES_TEMPLATE_IMAGES = process.platform === 'darwin'
const MAX_NEXT_RUNS = 3

const icons = new Map()

function icon(name) {
  if (!icons.has(name)) {
    const file = USES_TEMPLATE_IMAGES
      ? path.join(TEMPLATE_ASSETS, `${name}Template.png`)
      : path.join(COLOUR_ASSETS, `${name}.png`)
    const image = nativeImage.createFromPath(file)
    if (USES_TEMPLATE_IMAGES) image.setTemplateImage(true)
    icons.set(name, image)
  }
  return icons.get(name)
}

function iconNameFor(state) {
  if (state.scheduler.paused) return 'paused'
  if (state.hasUnacknowledgedError) return 'error'
  if (state.scheduler.running > 0) return 'active'
  return 'idle'
}

function formatTime(iso) {
  if (!iso) return '--:--'
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`
}

function buildMenu(state, actions) {
  const items = []

  const enabledJobs = state.jobs.filter((j) => j.enabled)
  items.push({ label: 'Rota', enabled: false })
  items.push({ type: 'separator' })

  if (state.scheduler.running > 0) {
    items.push({ label: `${plural(state.scheduler.running, 'job')} running`, enabled: false })
  }
  items.push({ label: `${plural(enabledJobs.length, 'active job', 'active jobs')}`, enabled: false })

  if (state.issues.length > 0) {
    items.push({
      label: `${plural(state.issues.length, 'invalid file')}`,
      click: actions.openWindow,
    })
  }

  const nextRuns = state.nextRuns.slice(0, MAX_NEXT_RUNS)
  if (nextRuns.length > 0) {
    items.push({ type: 'separator' })
    items.push({ label: 'Next runs', enabled: false })
    for (const run of nextRuns) {
      items.push({ label: `  ${formatTime(run.at)}   ${run.name}`, enabled: false })
    }
  }

  if (state.recentErrors.length > 0) {
    items.push({ type: 'separator' })
    items.push({ label: 'Recent errors', enabled: false })
    for (const error of state.recentErrors.slice(0, MAX_NEXT_RUNS)) {
      items.push({
        label: `  ${formatTime(error.at)}   ${error.name}`,
        click: () => actions.openWindow(error.jobId),
      })
    }
  }

  items.push({ type: 'separator' })
  if (state.jobs.length > 0) {
    items.push({
      label: 'Run now',
      // Stays available with the scheduler paused, and disabled jobs appear
      // there: it is an explicit action, and that is how a job is put right
      // before being left to schedule itself.
      submenu: state.jobs.map((job) => ({
        label: job.enabled ? job.name : `${job.name} (disabled)`,
        click: () => actions.runJob(job.id),
      })),
    })
  }
  items.push({ label: 'Open Rota', click: () => actions.openWindow() })
  items.push({ label: 'Open the configuration directory', click: actions.openConfigDir })
  items.push({
    label: state.scheduler.paused ? 'Resume jobs' : 'Pause jobs',
    click: () => actions.setPaused(!state.scheduler.paused),
  })
  items.push({ type: 'separator' })
  // CommandOrControl, not Command: the second is a macOS-only modifier, and GTK
  // refuses it with an assertion on the way past — which is how a Linux run
  // announces itself in the log without anything actually breaking.
  items.push({ label: 'Quit Rota', click: actions.quit, accelerator: 'CommandOrControl+Q' })

  return Menu.buildFromTemplate(items)
}

function createTray(actions) {
  const tray = new Tray(icon('idle'))
  tray.setToolTip('Rota')

  let currentIcon = 'idle'

  return {
    update(state) {
      const name = iconNameFor(state)
      if (name !== currentIcon) {
        tray.setImage(icon(name))
        currentIcon = name
      }
      tray.setContextMenu(buildMenu(state, actions))
    },
    destroy() {
      tray.destroy()
    },
  }
}

module.exports = { createTray }
