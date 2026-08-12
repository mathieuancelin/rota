'use strict'

// Launching at login on Linux.
//
// macOS and Windows have a system setting and Electron owns it; there is
// nothing of ours to test there. Linux has no such setting — the mechanism is a
// file we write — so the file is the thing to pin down: where it goes, what is
// in it, and what happens when the home directory will not take it.
//
// `require('electron')` is intercepted the way notifications.test.js does it:
// this suite runs under node --test, with no Electron anywhere.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { isPackaged: true } }
  return load.call(this, request, ...rest)
}

const {
  applyLinux,
  autostartDir,
  desktopEntry,
  execPath,
  DESKTOP_ENTRY,
} = require('../src/main/autostart')

Module._load = load

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-autostart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the entry lands where the specification says it does', () => {
  assert.equal(
    autostartDir({ env: {}, homedir: '/home/someone' }),
    '/home/someone/.config/autostart',
  )
  // XDG_CONFIG_HOME is honoured here exactly as it is for the configuration
  // directory: somebody who moved one moved both.
  assert.equal(
    autostartDir({ env: { XDG_CONFIG_HOME: '/elsewhere/config' }, homedir: '/home/someone' }),
    '/elsewhere/config/autostart',
  )
})

test('enabling writes a desktop entry that starts this executable', (t) => {
  const dir = path.join(workspace(t), 'autostart')
  const result = applyLinux(true, { dir, exec: '/opt/Rota/rota' })

  assert.equal(result.ok, true)
  const written = fs.readFileSync(path.join(dir, DESKTOP_ENTRY), 'utf8')
  assert.match(written, /^\[Desktop Entry\]$/m)
  assert.match(written, /^Type=Application$/m)
  assert.match(written, /^Exec=\/opt\/Rota\/rota$/m)
  assert.match(written, /^Terminal=false$/m)
})

test('the directory is created rather than assumed', (t) => {
  const dir = path.join(workspace(t), 'never', 'existed')
  assert.equal(applyLinux(true, { dir, exec: '/bin/tt' }).ok, true)
  assert.equal(fs.existsSync(path.join(dir, DESKTOP_ENTRY)), true)
})

test('the entry waits for the panel before asking it for a place', () => {
  // An icon registered before the panel is up is occasionally dropped, and the
  // application then looks as though it never started.
  assert.match(desktopEntry('/bin/tt'), /^X-GNOME-Autostart-Delay=\d+$/m)
})

test('disabling removes it, and disabling twice is not an error', (t) => {
  const dir = path.join(workspace(t), 'autostart')
  applyLinux(true, { dir, exec: '/bin/tt' })
  assert.equal(fs.existsSync(path.join(dir, DESKTOP_ENTRY)), true)

  assert.equal(applyLinux(false, { dir }).ok, true)
  assert.equal(fs.existsSync(path.join(dir, DESKTOP_ENTRY)), false)
  // Turning off something that is already off is a thing an interface does.
  assert.equal(applyLinux(false, { dir }).ok, true)
})

test('enabling twice leaves one entry, not two', (t) => {
  const dir = path.join(workspace(t), 'autostart')
  applyLinux(true, { dir, exec: '/bin/one' })
  applyLinux(true, { dir, exec: '/bin/two' })

  assert.deepEqual(fs.readdirSync(dir), [DESKTOP_ENTRY])
  assert.match(fs.readFileSync(path.join(dir, DESKTOP_ENTRY), 'utf8'), /^Exec=\/bin\/two$/m)
})

test('a home that will not take the file says why, rather than lying', (t) => {
  const dir = path.join(workspace(t), 'autostart')
  const result = applyLinux(true, {
    dir,
    exec: '/bin/tt',
    fileSystem: {
      mkdirSync: () => {},
      writeFileSync: () => {
        throw new Error('EROFS: read-only file system')
      },
      rmSync: () => {},
    },
  })

  assert.equal(result.ok, false)
  // The interface has a checkbox that has to be able to explain itself.
  assert.match(result.reason, /read-only file system/)
})

test('inside an AppImage, the entry names the AppImage and not its mount point', () => {
  // process.execPath inside an AppImage points at a temporary mount that is gone
  // by the next login; APPIMAGE holds where the file actually is.
  assert.equal(
    execPath({ env: { APPIMAGE: '/home/someone/Apps/Rota.AppImage' }, argv0: '/tmp/.mount_x/rota' }),
    '/home/someone/Apps/Rota.AppImage',
  )
  assert.equal(execPath({ env: {}, argv0: '/usr/bin/rota' }), '/usr/bin/rota')
})
