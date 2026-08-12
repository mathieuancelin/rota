'use strict'

// Launching at login.
//
// In development, the executable is the Electron binary from node_modules:
// registering it at login would install a startup item pointing at a project
// path. So we only touch the system setting in a packaged application.
//
// Two mechanisms, because there is no one answer. macOS and Windows have a
// system setting and Electron exposes it. Linux has no such thing: the
// convention is a .desktop file in ~/.config/autostart, read by every desktop
// environment that follows the freedesktop specification — which is all of the
// ones anybody runs. Writing that file ourselves is not a workaround, it *is*
// the mechanism, and it is the same gesture the daemon makes when it prints a
// systemd unit.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { app } = require('electron')
const { logger } = require('@rota/core')

const DESKTOP_ENTRY = 'rota.desktop'

/** Where the freedesktop specification says autostart entries live. */
function autostartDir({ env = process.env, homedir = os.homedir() } = {}) {
  const base = env.XDG_CONFIG_HOME || path.join(homedir, '.config')
  return path.join(base, 'autostart')
}

function isSupported() {
  if (!app.isPackaged) return false
  return (
    process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
  )
}

/**
 * The contents of the autostart entry.
 *
 * `X-GNOME-Autostart-Delay` buys the panel time to come up before the tray icon
 * asks for a place in it — without it, an icon registered too early is
 * occasionally dropped, and the application then looks as if it did not start.
 *
 * @param {string} exec absolute path to the executable
 */
function desktopEntry(exec) {
  return `[Desktop Entry]
Type=Application
Name=Rota
Comment=Local recurring task engine
Exec=${exec}
Icon=rota
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
`
}

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function apply(enabled) {
  if (!isSupported()) {
    const reason = app.isPackaged
      ? 'No effect: unsupported platform.'
      : 'No effect until the application is packaged.'
    logger.info(`launchAtLogin=${enabled} ignored: ${reason}`)
    return { ok: false, reason }
  }

  if (process.platform === 'linux') return applyLinux(enabled)

  app.setLoginItemSettings({
    openAtLogin: enabled,
    // At login, the application makes do with its icon in the tray.
    openAsHidden: true,
  })

  // macOS refuses to register an application started outside /Applications, and
  // only reports it on the error output. Without this re-read, the user would
  // tick the box with nothing happening.
  if (app.getLoginItemSettings().openAtLogin !== enabled) {
    const reason =
      'macOS refused the setting. The application must live in /Applications ' +
      'to be launched at login.'
    logger.warn(`launchAtLogin=${enabled} : ${reason}`)
    return { ok: false, reason }
  }

  logger.info(`launchAtLogin=${enabled}`)
  return { ok: true }
}

/**
 * @param {boolean} enabled
 * @param {{dir?: string, exec?: string, fileSystem?: object}} [options] injectable for tests
 */
function applyLinux(enabled, { dir = autostartDir(), exec = execPath(), fileSystem = fs } = {}) {
  const file = path.join(dir, DESKTOP_ENTRY)

  try {
    if (!enabled) {
      fileSystem.rmSync(file, { force: true })
      logger.info('launchAtLogin=false: autostart entry removed')
      return { ok: true }
    }

    fileSystem.mkdirSync(dir, { recursive: true })
    fileSystem.writeFileSync(file, desktopEntry(exec))
    logger.info(`launchAtLogin=true: ${file}`)
    return { ok: true }
  } catch (err) {
    // A read-only or unwritable home is unusual, not impossible — and the
    // interface has a checkbox that must be able to say why it did not take.
    const reason = `The autostart entry could not be written: ${err.message}`
    logger.warn(`launchAtLogin=${enabled} : ${reason}`)
    return { ok: false, reason }
  }
}

/**
 * What to put in Exec=.
 *
 * An AppImage is a single file that the user may have moved anywhere, and
 * APPIMAGE holds where it actually is — process.execPath inside one points at
 * the temporary mount, which is gone by the next login.
 */
function execPath({ env = process.env, argv0 = process.execPath } = {}) {
  return env.APPIMAGE || argv0
}

/** True if the system currently considers the application to launch at login. */
function isEnabled({ dir = autostartDir(), fileSystem = fs } = {}) {
  if (!isSupported()) return false
  if (process.platform === 'linux') return fileSystem.existsSync(path.join(dir, DESKTOP_ENTRY))
  return app.getLoginItemSettings().openAtLogin
}

module.exports = {
  apply,
  isEnabled,
  isSupported,
  // Exported for the tests: the Linux path is the one that is ours rather than
  // the system's, so it is the one worth pinning down.
  applyLinux,
  desktopEntry,
  execPath,
  autostartDir,
  DESKTOP_ENTRY,
}
