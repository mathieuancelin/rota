'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { resolveConfigDir, resolvePaths, ensureStructure } = require('../src/config/paths')

// The directory is the same everywhere, macOS included: these are files the user
// edits, not application data to hide away in Library.
test('the configuration directory is ~/.config/rota, whatever the system', () => {
  assert.equal(
    resolveConfigDir({ env: {}, homedir: '/Users/moi' }),
    '/Users/moi/.config/rota',
  )
  assert.equal(
    resolveConfigDir({ env: {}, homedir: '/home/moi' }),
    '/home/moi/.config/rota',
  )
})

test('XDG_CONFIG_HOME is honoured when it is set', () => {
  assert.equal(
    resolveConfigDir({ env: { XDG_CONFIG_HOME: '/xdg' }, homedir: '/home/moi' }),
    '/xdg/rota',
  )
})

test('ROTA_CONFIG_DIR wins over everything else', () => {
  assert.equal(
    resolveConfigDir({ env: { ROTA_CONFIG_DIR: '/tmp/instance', XDG_CONFIG_HOME: '/xdg' } }),
    '/tmp/instance',
  )
})

test('ensureStructure creates the tree and the default files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const paths = resolvePaths(dir)

  const created = await ensureStructure(paths)

  assert.deepEqual(created, { config: true, state: true })
  for (const dirPath of [
    paths.jobsDir,
    paths.scriptsDir,
    paths.historyDir,
    paths.outputsDir,
    paths.logsDir,
  ]) {
    assert.ok((await fs.stat(dirPath)).isDirectory(), `${dirPath} devrait exister`)
  }
  const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8'))
  assert.equal(config.launchAtLogin, true)
})

test('ensureStructure is idempotent and never overwrites an existing file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const paths = resolvePaths(dir)

  await ensureStructure(paths)
  await fs.writeFile(paths.configFile, JSON.stringify({ launchAtLogin: false }))

  const created = await ensureStructure(paths)

  assert.deepEqual(created, { config: false, state: false })
  const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8'))
  assert.equal(config.launchAtLogin, false, "the user's content is preserved")
})

test('a corrupt config.json is not replaced by the defaults', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rota-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const paths = resolvePaths(dir)
  await ensureStructure(paths)
  await fs.writeFile(paths.configFile, '{ broken')

  await ensureStructure(paths)

  assert.equal(await fs.readFile(paths.configFile, 'utf8'), '{ broken')
})
