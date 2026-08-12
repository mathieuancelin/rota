'use strict'

// Resolving external binaries: Bun, and Docker for sandboxed jobs.
//
// Started at login, the application inherits launchd's minimal PATH — not the
// user's shell one. Looking only in PATH would be enough in development and
// would fail in production, with an incomprehensible error message. So the
// usual locations are tried as well.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const WELL_KNOWN_DIRS = [
  path.join(os.homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
]

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function searchPathDirs() {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
}

// Docker Desktop and its competitors do not put their binary in the same place,
// and none of them is in launchd's PATH.
const DOCKER_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  path.join(os.homedir(), '.docker', 'bin'),
  path.join(os.homedir(), '.rd', 'bin'),
  '/Applications/Docker.app/Contents/Resources/bin',
]

/**
 * @param {{name: string, configured: string|null, dirs: string[], label: string, hint: string}} spec
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
function resolveExecutable({ name, configured = null, dirs, label, hint }) {
  if (configured) {
    if (isExecutable(configured)) return { ok: true, path: configured }
    return {
      ok: false,
      error: `The configured path for ${label} is not executable: ${configured}`,
    }
  }

  for (const dir of [...searchPathDirs(), ...dirs]) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return { ok: true, path: candidate }
  }

  return { ok: false, error: `${label} not found. ${hint}` }
}

/** @param {string|null} configured path forced by config.runners.bunPath */
function resolveBun(configured = null) {
  return resolveExecutable({
    name: 'bun',
    configured,
    dirs: WELL_KNOWN_DIRS,
    label: 'Bun',
    hint: 'Installe-le (https://bun.sh) ou renseigne son chemin dans config.json, champ runners.bunPath.',
  })
}

/** @param {string|null} configured path forced by config.runners.dockerPath */
function resolveDocker(configured = null) {
  return resolveExecutable({
    name: 'docker',
    configured,
    dirs: DOCKER_DIRS,
    label: 'Docker',
    hint: 'A sandboxed job needs the docker command. Install Docker, or set its path in config.json, field runners.dockerPath.',
  })
}

/**
 * PATH handed to child processes: the inherited one, completed with the usual
 * locations. A shell script calling `bun` or `git` must find them even when
 * started from launchd.
 */
function childPath() {
  const seen = new Set()
  const dirs = []
  for (const dir of [...searchPathDirs(), ...WELL_KNOWN_DIRS, '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!seen.has(dir)) {
      seen.add(dir)
      dirs.push(dir)
    }
  }
  return dirs.join(path.delimiter)
}

module.exports = { resolveBun, resolveDocker, childPath, WELL_KNOWN_DIRS, DOCKER_DIRS }
