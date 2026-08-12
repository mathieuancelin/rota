'use strict'

// Perimeter of an agent's file access.
//
// An agent receives paths from a language model: neither proofread nor
// necessarily well-intentioned, and sometimes simply invented. Everything
// therefore goes through a resolution that refuses what leaves the working
// directory.
//
// The delicate point is the symbolic link. Comparing strings after
// `path.resolve` is not enough: `notes/shortcut/passwd` stays under the working
// directory when read, and designates `/etc/passwd` when opened. So we resolve
// the nearest ancestor that really exists — the only one the system can say
// where it leads — before joining the rest back on.

const fs = require('node:fs')
const path = require('node:path')

/**
 * Effective working directory of an agent job, created as needed.
 *
 * With no declaration, each agent gets its own folder: without that, half the
 * definitions would have no perimeter, and the file tools would be unusable
 * until one thought about it.
 *
 * @param {object} job validated definition
 * @param {{agentsDir: string}} paths
 * @returns {string}
 */
function resolveWorkspace(job, paths) {
  return job.runner.workingDirectory ?? path.join(paths.agentsDir, job.id)
}

function ensureWorkspace(workspace) {
  fs.mkdirSync(workspace, { recursive: true })
  return fs.realpathSync(workspace)
}

/**
 * Resolves a path within the agent's perimeter.
 *
 * @param {string} root working directory, already passed through realpath
 * @param {string} target path proposed by the model, relative or absolute
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
function resolveInWorkspace(root, target) {
  if (typeof target !== 'string' || target.trim() === '') {
    return { ok: false, error: 'missing path' }
  }

  const absolute = path.resolve(root, target)

  // Walk up to the first existing ancestor, then ask it where it leads.
  const missing = []
  let existing = absolute
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    missing.unshift(path.basename(existing))
    existing = parent
  }

  let resolved
  try {
    resolved = path.resolve(fs.realpathSync(existing), ...missing)
  } catch {
    resolved = absolute
  }

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return {
      ok: false,
      error:
        `"${target}" leaves the working directory. ` +
        'File access is bounded to that directory; use a relative path.',
    }
  }

  return { ok: true, path: resolved }
}

/** Path shown to the model: relative to the perimeter, never absolute. */
function displayPath(root, absolute) {
  const relative = path.relative(root, absolute)
  return relative === '' ? '.' : relative
}

module.exports = { resolveWorkspace, ensureWorkspace, resolveInWorkspace, displayPath }
