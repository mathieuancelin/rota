'use strict'

// Resolving the ${VARIABLE} references carried by job definitions.
//
// An API key has no business sitting in the clear in a file tracked in a
// repository. But started from the Finder, a macOS application inherits no shell
// environment: `process.env` there holds a handful of variables set by the
// system, and never those of the `.zshrc`. Sending the user back to their shell
// would therefore only work in development.
//
// Hence a `.env` next to `config.json`, read on every resolution. The real
// environment wins over the file: that is the established convention, and it
// allows overriding a value for the duration of one `npm start`.

const fs = require('node:fs')

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Parses a file in `KEY=value` format.
 *
 * Deliberately modest: no substitution of variables into one another, no
 * multiline values. This file holds a handful of secrets, not a language.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseEnvFile(text) {
  const values = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const separator = line.indexOf('=')
    if (separator <= 0) continue

    const key = line.slice(0, separator).replace(/^export\s+/, '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    values[key] = unquote(line.slice(separator + 1).trim())
  }
  return values
}

/**
 * Strips surrounding quotes. Inside double quotes only, the usual escapes are
 * interpreted — without which a multiline key in PEM format could not be
 * written.
 */
function unquote(value) {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\(["\\])/g, '$1')
  }
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  // An end-of-line comment is only recognised outside quotes: otherwise a
  // password containing "#" would be silently truncated.
  return value.replace(/\s+#.*$/, '')
}

/**
 * Environment available for resolution: the file, completed — and overridden —
 * by the process's real environment.
 *
 * @param {string} envFile path of the .env
 * @param {Record<string, string|undefined>} [processEnv]
 * @returns {Record<string, string>}
 */
function loadEnv(envFile, processEnv = process.env) {
  let fromFile = {}
  try {
    fromFile = parseEnvFile(fs.readFileSync(envFile, 'utf8'))
  } catch {
    // Absent or unreadable: that is not an error, it is the common case.
  }

  const merged = { ...fromFile }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value != null) merged[key] = value
  }
  return merged
}

/**
 * Replaces the ${VARIABLE}s of a string.
 * @returns {{ok: true, value: string} | {ok: false, missing: string[]}}
 */
function resolveReferences(text, env) {
  const missing = []
  const value = text.replace(REFERENCE, (match, name) => {
    if (env[name] == null || env[name] === '') {
      missing.push(name)
      return match
    }
    return env[name]
  })
  return missing.length > 0 ? { ok: false, missing } : { ok: true, value }
}

/**
 * Resolves the headers of an agent job.
 *
 * Fails as a whole rather than sending a literal `Bearer ${OPENAI_API_KEY}`: the
 * server would answer 401, and the history would blame the model for a
 * configuration problem.
 *
 * @param {Record<string, string>} headers
 * @param {Record<string, string>} env
 * @returns {{ok: true, headers: Record<string, string>} | {ok: false, errors: string[]}}
 */
function resolveHeaders(headers, env) {
  const resolved = {}
  const errors = []

  for (const [name, value] of Object.entries(headers)) {
    const result = resolveReferences(value, env)
    if (result.ok) {
      resolved[name] = result.value
    } else {
      const plural = result.missing.length > 1 ? 's' : ''
      errors.push(
        `runner.agent.api.headers.${name}: missing variable${plural}: ` +
          result.missing.join(', '),
      )
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, headers: resolved }
}

module.exports = { parseEnvFile, loadEnv, resolveReferences, resolveHeaders }
