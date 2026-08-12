'use strict'

// Main window, hardened as per the Security section of the spec:
// no Node integration, context isolation, sandbox, and no uncontrolled
// navigation or window opening.

const path = require('node:path')
const { BrowserWindow, shell, session, nativeTheme } = require('electron')

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIR = path.join(__dirname, '..', '..', 'dist', 'renderer')
const RENDERER_DIST = path.join(RENDERER_DIR, 'index.html')
const AGENT_DIST = path.join(RENDERER_DIR, 'agent.html')

function contentSecurityPolicy() {
  const policy = {
    'default-src': ["'self'"],
    // 'unsafe-inline' for styles only: Vite and React inject inline styles.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    'script-src': ["'self'"],
    // Monaco runs its language services (JSON validation, completion) in Web
    // Workers. Vite emits them as same-origin files, but Monaco may also
    // instantiate them through a blob URL.
    'worker-src': ["'self'", 'blob:'],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  }
  if (DEV_SERVER_URL) {
    // Vite's hot reload needs eval and a websocket.
    policy['script-src'].push("'unsafe-inline'", "'unsafe-eval'")
    policy['connect-src'].push('ws://localhost:5273', 'http://localhost:5273')
  }
  return Object.entries(policy)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ')
}

/**
 * Appearance of the application.
 *
 * A single point of control for everything: `themeSource` drives the
 * `prefers-color-scheme` the windows see, hence the stylesheets, the Monaco
 * editor which listens to the same media query, and the window backgrounds.
 * Nothing else needs to know a setting exists.
 *
 * @param {'system'|'light'|'dark'} theme
 */
function applyTheme(theme) {
  nativeTheme.themeSource = theme
}

function applySecurityPolicy() {
  const csp = contentSecurityPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    })
  })
}

/**
 * No navigation from the renderer: external links go out to the browser. Placed
 * on every window, these guards being per-window where the CSP holds for the
 * whole session.
 */
function lockNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
}

function createMainWindow({ onCloseRequested }) {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Rota',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Avoids a white flash before the first render, in both themes.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f4f4f6',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  lockNavigation(win)

  win.once('ready-to-show', () => win.show())

  // Closing the window hides the application: the engine keeps running in the tray.
  win.on('close', (event) => {
    if (onCloseRequested?.() === 'hide') {
      event.preventDefault()
      win.hide()
    }
  })

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL)
  } else {
    win.loadFile(RENDERER_DIST)
  }

  return win
}

/**
 * An agent's window: report, question, or chat console.
 *
 * A second bundle entry rather than the main window diverted: the CSP forbids
 * `data:` and the renderer has no router. The `panelId` travels in the URL
 * fragment, and the window comes and fetches its content over IPC — nothing is
 * pushed, so nothing is lost before the rendering is ready.
 *
 * @param {object} options
 * @param {string} options.panelId
 * @param {string} options.title
 * @param {{width: number, height: number, resizable?: boolean, alwaysOnTop?: boolean}} options.frame
 * @param {() => void} [options.onClosed]
 */
function createAgentWindow({ panelId, title, frame, onClosed }) {
  const win = new BrowserWindow({
    width: frame.width,
    height: frame.height,
    minWidth: 380,
    minHeight: 240,
    show: false,
    title,
    resizable: frame.resizable ?? true,
    alwaysOnTop: frame.alwaysOnTop ?? false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f4f4f6',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'agent.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  lockNavigation(win)
  win.once('ready-to-show', () => {
    win.show()
    // The application is a tray agent, with no icon in the Dock: without this
    // reminder, a question asked while you are working elsewhere opens behind
    // the window of the moment.
    win.focus()
  })
  if (onClosed) win.on('closed', onClosed)

  if (DEV_SERVER_URL) {
    win.loadURL(`${DEV_SERVER_URL}/agent.html#${panelId}`)
  } else {
    win.loadFile(AGENT_DIST, { hash: panelId })
  }

  return win
}

module.exports = { createMainWindow, createAgentWindow, applySecurityPolicy, applyTheme }
