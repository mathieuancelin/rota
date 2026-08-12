'use strict'

// Reading and writing JSON files. Writing goes through a temporary file and a
// rename: a crash in the middle of a write never leaves config.json or
// state.json truncated.

const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

/**
 * Temporary file name, unique even within one process: two concurrent writes
 * of the same file would otherwise share the same intermediate, and the second
 * would rename a file already moved.
 */
function tempName(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
}

/**
 * Reads a JSON file.
 * @returns {Promise<{ok: true, value: any} | {ok: false, missing: boolean, error: Error}>}
 */
async function readJson(filePath) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    return { ok: false, missing: err.code === 'ENOENT', error: err }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (err) {
    return { ok: false, missing: false, error: err }
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmp = tempName(filePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    // Never leave an intermediate behind: it would sit next to the real file,
    // visible in the user's configuration directory.
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/**
 * Writes a JSON file provided it does not exist yet. The `wx` flag makes the
 * file system carry the exclusivity: unlike an existence check followed by a
 * write, nothing can slip in between the two.
 * @throws {Error} with code EEXIST if the file is already there
 */
async function writeJsonNew(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
}

module.exports = { readJson, writeJsonAtomic, writeJsonNew }
