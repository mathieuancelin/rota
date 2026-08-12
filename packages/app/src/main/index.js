'use strict'

// Entry point of the main process.
//
// This file composes; it does not implement. The engine — configuration,
// scheduler, runner, history, agents, Discord, HTTP — is built in one call and
// lives in @rota/core. What is left here is everything that exists only
// because there is a screen: a tray icon, a window, notifications, the IPC
// bridge, and the throttling that keeps a chatty job from redrawing the
// interface a hundred times a second.

const path = require('node:path')
const { app, dialog, shell } = require('electron')

const {
  acquireInstanceLock,
  createEngine,
  DEFAULT_CONFIG,
  logger,
  resolveConfigDir,
  resolvePaths,
} = require('@rota/core')

const { createAgentPanels } = require('./agent-panels')
const autostart = require('./autostart')
const { registerIpc, CHANNELS } = require('./ipc')
const { createNotifier } = require('./notifications')
const { watchPower } = require('./power-electron')
const { createRemoteEngine } = require('./remote-engine')
const { createTray } = require('./tray')
const { applySecurityPolicy, applyTheme, createMainWindow } = require('./window')

// State updates are frequent during an execution; we bound the rate of sends to
// the renderer rather than emitting one per event.
const PUBLISH_THROTTLE_MS = 250

// Shorter than the state's: output scrolling in quarter-second jerks reads
// badly, where the running-execution counter puts up with it.
const OUTPUT_THROTTLE_MS = 120

// How long a refusal at startup waits to be read before giving up and leaving.
// Long enough for somebody sitting there, short enough that nothing hangs.
const DIALOG_GRACE_MS = 30_000

const context = {
  engine: null,
  lock: null,
  notifier: null,
  panels: null,
  tray: null,
  window: null,
  power: null,
  autostart: null,
  quitting: false,
  publishTimer: null,
  /** @type {Map<string, {jobId: string, stdout: string, stderr: string}>} */
  pendingOutput: new Map(),
  outputTimer: null,
}

// Chromium writes its cache, its cookies and its session state into userData,
// whose default path is exactly the one the spec reserves for user
// configuration. We move it into a subdirectory before anything else
// initialises: "Open the configuration directory" must show config.json and
// jobs/, not thirty session files.
//
// To be done before requestSingleInstanceLock(), which already places its lock in userData.
app.setPath('userData', path.join(resolveConfigDir(), '.chromium'))

// Two instances would run two schedulers on the same jobs.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(start).catch(fatal)
}

async function start() {
  // Menu bar application: no icon in the Dock nor in Cmd-Tab.
  app.dock?.hide()
  applySecurityPolicy()

  // Agent jobs open windows — report, question — and sometimes wait for the
  // answer. That is the reason their loop runs in this process rather than in a
  // child, and the reason the engine is handed this interface rather than
  // inventing one.
  context.panels = createAgentPanels()
  context.engine = await buildEngine()
  // buildEngine() has already asked the application to quit — a directory
  // somebody else holds, or a remote mode with nowhere to point.
  if (!context.engine) return

  applyTheme(context.engine.store.getConfig().theme ?? DEFAULT_CONFIG.theme)

  context.notifier = createNotifier({
    onErrorClick: (jobId, executionId) => {
      showWindow()
      sendToWindow(CHANNELS.NAVIGATE, { view: 'history', jobId, executionId })
    },
  })

  wireEngine()
  applyAutostart()

  context.tray = createTray({
    openWindow: (jobId) => {
      showWindow()
      if (jobId) sendToWindow(CHANNELS.NAVIGATE, { view: 'history', jobId })
    },
    openConfigDir: () => shell.openPath(context.engine.paths.root),
    runJob: (jobId) => {
      context.engine.scheduler.runNow(jobId).catch((err) => logger.error('manual run', err))
    },
    setPaused: (paused) => context.engine.setPaused(paused),
    quit,
  })

  registerIpc({
    store: context.engine.store,
    history: context.engine.history,
    scheduler: context.engine.scheduler,
    runner: context.engine.runner,
    state: context.engine.state,
    getSnapshot: snapshot,
    setPaused: (paused) => context.engine.setPaused(paused),
    publish,
    panels: context.panels,
    chat: context.engine.chat,
    confirmDestructive,
  })

  // Wired before the scheduler starts: an initial locked state has to be known
  // before the first occurrence is computed. In remote mode this still applies —
  // the calls go out over HTTP, and a daemon told that the screen locked beats
  // a daemon polling ioreg to find out.
  context.power = watchPower(context.engine.scheduler)

  await context.engine.start()

  publish()
  showWindow()
  announceHowToComeBack()
}

/**
 * On Linux, how to get the window back.
 *
 * A menu bar application assumes there is a menu bar. GNOME has had no tray
 * since version 3 — an AppIndicator extension puts one back, and many people
 * have one, but many do not. Closing the window there would otherwise be a trap:
 * the scheduler carries on, correctly, with nothing left on screen to reach it
 * by and no obvious way back.
 *
 * There is a way back, and it is the ordinary one: starting Rota again.
 * The single-instance lock turns the second launch into a request to show the
 * window. Saying so once, in the log, costs a line and saves somebody the
 * conclusion that the application is broken.
 */
function announceHowToComeBack() {
  if (process.platform !== 'linux') return
  logger.info(
    'closing the window leaves the scheduler running — start Rota again to bring it back',
  )
}

/**
 * Embedded or remote — the one decision that changes what this process is.
 *
 * Embedded is the default and the whole desktop install: the scheduler runs
 * here. Remote points the same window at a rotad, and the renderer is not
 * told which it got.
 *
 * The instance lock is taken **only** when the engine is embedded, and it is
 * taken by the application exactly as the daemon takes it. That is the point:
 * one configuration directory opened by an application and by a daemon at once
 * is two schedulers on the same jobs, and neither of them would notice.
 */
async function buildEngine() {
  // Read before anything is built, and read from the file rather than from an
  // engine we have not decided how to build yet.
  const paths = resolvePaths()
  const settings = await readEngineSettings(paths)

  if (settings.mode === 'remote') {
    if (!settings.url) {
      fatal(new Error('remote mode is selected but no engine URL is configured'))
      return null
    }
    const engine = createRemoteEngine({ paths, remote: settings })
    engine.on('connection', ({ attached, url, error }) => {
      if (!attached) logger.warn(`the engine at ${url} is not answering: ${error}`)
      publish()
    })
    // A question the daemon's agent asked, which only this shell has a screen
    // for. Answering it is what "an interface is attached" means.
    engine.on('ui-request', (request) => forwardUiRequest(engine, request))
    engine.on('ui-report', ({ title, markdown }) => context.panels.ui.report({ title, markdown }))
    return engine
  }

  try {
    context.lock = acquireInstanceLock(paths, { role: 'Rota.app' })
  } catch (err) {
    // A graphical application writing only to stderr is an application that
    // failed silently, so this refusal is worth a dialog. But `showErrorBox` is
    // modal and blocking: launched at login, behind a locked screen, it would
    // wait for a click that comes hours later — with the window invisible and
    // the process apparently hung. So the log gets it unconditionally, the
    // dialog is the asynchronous one, and we leave anyway after a short wait.
    logger.error(`refusing to start: ${err.message}`)
    process.stderr.write(`${err.message}\n`)

    await Promise.race([
      dialog.showMessageBox({
        type: 'error',
        message: 'Rota is already running that directory',
        detail: err.message,
        buttons: ['Quit'],
      }),
      new Promise((resolve) => setTimeout(resolve, DIALOG_GRACE_MS)),
    ])

    app.exit(1)
    return null
  }

  return createEngine({ paths, ui: context.panels.ui })
}

/**
 * The engine settings, straight from config.json.
 *
 * Deliberately not through ConfigStore: the store belongs to an engine, and
 * which engine to build is the question being answered. An unreadable or
 * missing file means the default, which is embedded — the mode that needs no
 * configuration at all.
 */
async function readEngineSettings(paths) {
  try {
    const raw = await require('node:fs/promises').readFile(paths.configFile, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONFIG.engine, ...(parsed.engine ?? {}) }
  } catch {
    return { ...DEFAULT_CONFIG.engine }
  }
}

/** A remote agent's question, asked in a window here, answered back over HTTP. */
async function forwardUiRequest(engine, request) {
  const { requestId, kind, timeoutSeconds } = request

  const answer =
    kind === 'confirm'
      ? await context.panels.ui.confirm({
          question: request.question,
          detail: request.detail,
          timeoutSeconds,
        })
      : await context.panels.ui.ask({
          question: request.question,
          defaultValue: request.defaultValue,
          timeoutSeconds,
        })

  const submitted = kind === 'confirm' ? answer.confirmed : answer.answered
  await engine.answerUiRequest(requestId, {
    action: submitted ? 'submit' : 'cancel',
    value: answer.value ?? '',
  })
}

/** Everything the shell does in reaction to the engine, and nothing more. */
function wireEngine() {
  const engine = context.engine

  engine.on('started', (execution) => {
    const job = engine.store.getJob(execution.jobId)
    if (job) context.notifier.started(job, execution)
  })

  // A chatty job produces dozens of chunks a second. They are batched before
  // being sent, as the state snapshot already is: what matters is seeing it
  // scroll, not receiving every byte separately.
  engine.on('output', ({ executionId, jobId, stream, chunk }) => {
    const pending = context.pendingOutput.get(executionId) ?? { jobId, stdout: '', stderr: '' }
    pending[stream] += chunk
    context.pendingOutput.set(executionId, pending)
    flushOutput()
  })

  engine.on('finished', (execution) => {
    const job = engine.store.getJob(execution.jobId)
    if (job) context.notifier.finished(job, execution)
    // What was still pending goes out before the end is announced: otherwise the
    // last lines would arrive after the view had moved to the history.
    flushOutput({ immediate: true })
    sendToWindow(CHANNELS.RUNS_OUTPUT, {
      executionId: execution.executionId,
      jobId: execution.jobId,
      done: true,
      status: execution.status,
    })
  })

  // The conversation lives in a tab of the main window: its events follow the
  // same path as the rest of the interface.
  engine.on('chat', (event) => sendToWindow(CHANNELS.AGENT_CHAT_EVENT, event))

  engine.on('config-changed', (config) => {
    applyTheme(config.theme)
    applyAutostart()
  })

  engine.on('changed', publish)
}

/**
 * Confirmation of an irreversible action, as a modal sheet attached to the
 * window. "Cancel" is the default button: an unlucky press on Enter or Escape
 * destroys nothing.
 */
async function confirmDestructive({ message, detail, confirmLabel }) {
  const parent = context.window && !context.window.isDestroyed() ? context.window : null
  const options = {
    type: 'warning',
    buttons: ['Cancel', confirmLabel],
    defaultId: 0,
    cancelId: 0,
    message,
    detail,
  }
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return response === 1
}

function sendToWindow(channel, payload) {
  if (context.window && !context.window.isDestroyed()) {
    context.window.webContents.send(channel, payload)
  }
}

/** Sends the accumulated chunks, at most once per throttle window. */
function flushOutput({ immediate = false } = {}) {
  if (context.outputTimer && !immediate) return
  if (context.outputTimer) {
    clearTimeout(context.outputTimer)
    context.outputTimer = null
  }

  const send = () => {
    context.outputTimer = null
    for (const [executionId, pending] of context.pendingOutput) {
      sendToWindow(CHANNELS.RUNS_OUTPUT, { executionId, ...pending })
    }
    context.pendingOutput.clear()
  }

  if (immediate) {
    send()
    return
  }
  context.outputTimer = setTimeout(send, OUTPUT_THROTTLE_MS)
  context.outputTimer.unref?.()
}

/**
 * Applies the launch-at-login setting, only if it changed, and remembers the
 * result: macOS may refuse, and the interface must be able to say so.
 */
function applyAutostart() {
  const wanted = context.engine.store.getConfig().launchAtLogin
  if (context.autostart?.wanted === wanted) return

  const result = autostart.apply(wanted)
  context.autostart = {
    wanted,
    supported: autostart.isSupported(),
    active: result.ok ? wanted : autostart.isEnabled(),
    reason: result.ok ? null : result.reason,
  }
}

function snapshot() {
  const state = context.engine.snapshot({
    autostart: context.autostart,
    notifier: context.notifier,
  })
  // Which engine this window is drawing. The interface has to be able to say
  // so: "no job is running" and "the daemon you named is not answering" look
  // identical on screen and are not the same problem at all.
  return {
    ...state,
    connection: state.connection ?? { mode: 'embedded', url: null, attached: true },
  }
}

/** Broadcasts the state to the tray and the renderer, at most once per throttle window. */
function publish() {
  if (context.publishTimer) return
  context.publishTimer = setTimeout(() => {
    context.publishTimer = null
    const state = snapshot()
    context.tray?.update(state)
    sendToWindow(CHANNELS.STATE_CHANGED, state)
  }, PUBLISH_THROTTLE_MS)
  context.publishTimer.unref?.()
}

function showWindow() {
  if (context.window && !context.window.isDestroyed()) {
    context.window.show()
    context.window.focus()
    return
  }
  context.window = createMainWindow({
    onCloseRequested: () => (context.quitting ? 'close' : 'hide'),
  })
  context.window.webContents.on('did-finish-load', () => publish())
}

function quit() {
  context.quitting = true
  app.quit()
}

app.on('window-all-closed', () => {
  // Tray application: closing the window does not stop the engine.
})

app.on('activate', () => {
  // The main window, not just any: an agent report left open would otherwise be
  // enough to stop it reopening from the Dock.
  if (!context.window || context.window.isDestroyed()) showWindow()
})

app.on('before-quit', async () => {
  context.quitting = true
  context.power?.close()
  await context.engine?.stop()
  context.lock?.release()
  // After the engine: closing a conversation may ask one last question, and the
  // panel that would carry it has to still be there to be told no.
  context.panels?.closeAll()
  context.tray?.destroy()
})

function fatal(err) {
  logger.error('startup failed', err)
  app.quit()
}
