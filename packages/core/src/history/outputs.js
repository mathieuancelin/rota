'use strict'

// Large outputs stored separately.
//
// A history entry keeps only an excerpt inline; beyond that, the full output
// goes to history/outputs/. Without this, a chatty job with 500 retained
// executions would produce a JSONL of several hundred megabytes, read in full
// on every pagination.

const fs = require('node:fs/promises')
const path = require('node:path')

const OUTPUTS_DIRNAME = 'outputs'
const SUFFIX = { stdout: 'out', stderr: 'err' }
const EXECUTION_ID = /^[0-9a-f-]{36}$/i

function relativePath(executionId, stream) {
  return path.join(OUTPUTS_DIRNAME, `${executionId}.${SUFFIX[stream]}.log`)
}

async function write(outputsDir, executionId, stream, text) {
  await fs.mkdir(outputsDir, { recursive: true })
  await fs.writeFile(path.join(outputsDir, `${executionId}.${SUFFIX[stream]}.log`), text, 'utf8')
  return relativePath(executionId, stream)
}

/**
 * Reads a full output.
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
async function read(historyDir, relative) {
  // The path comes from a history entry, but that entry goes through the
  // renderer: we check again that it does not leave the outputs directory.
  const resolved = path.resolve(historyDir, relative)
  const root = path.resolve(historyDir, OUTPUTS_DIRNAME)
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    return { ok: false, error: 'Output path outside the allowed directory' }
  }
  try {
    return { ok: true, text: await fs.readFile(resolved, 'utf8') }
  } catch (err) {
    return { ok: false, error: `Output unreadable: ${err.message}` }
  }
}

/** Deletes the output files of executions removed from the history. */
async function removeFor(outputsDir, executionIds) {
  for (const executionId of executionIds) {
    if (!EXECUTION_ID.test(executionId)) continue
    for (const suffix of Object.values(SUFFIX)) {
      await fs.rm(path.join(outputsDir, `${executionId}.${suffix}.log`), { force: true })
    }
  }
}

module.exports = { write, read, removeFor, relativePath, OUTPUTS_DIRNAME }
