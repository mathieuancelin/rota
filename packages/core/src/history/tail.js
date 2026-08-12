'use strict'

// Reading the last lines of a file without loading it whole.
//
// History is append-only and is read from the most recent backwards: reading
// from the end shows a page of 50 entries without touching the tens of
// thousands before them.

const fs = require('node:fs/promises')

const CHUNK_SIZE = 64 * 1024
const NEWLINE = 0x0a

/**
 * @param {string} filePath
 * @param {number} count number of lines wanted
 * @returns {Promise<{lines: string[], reachedStart: boolean}>} lines from the
 *          most recent to the oldest
 */
async function readLastLines(filePath, count) {
  let handle
  try {
    handle = await fs.open(filePath, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], reachedStart: true }
    throw err
  }

  try {
    const { size } = await handle.stat()
    const lines = []
    let position = size
    // Leftover: an incomplete start of line, to be joined with the previous chunk.
    let remainder = Buffer.alloc(0)

    while (position > 0 && lines.length < count) {
      const length = Math.min(CHUNK_SIZE, position)
      position -= length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)

      const combined = Buffer.concat([buffer, remainder])
      const firstNewline = combined.indexOf(NEWLINE)
      if (firstNewline === -1) {
        // No end of line in this chunk: keep going backwards.
        remainder = combined
        continue
      }

      // What follows the first newline starts on a character boundary: UTF-8
      // decoding is safe there.
      remainder = combined.subarray(0, firstNewline)
      const complete = combined.subarray(firstNewline + 1).toString('utf8').split('\n')

      for (let i = complete.length - 1; i >= 0 && lines.length < count; i--) {
        if (complete[i].length > 0) lines.push(complete[i])
      }
    }

    if (position === 0 && lines.length < count && remainder.length > 0) {
      const first = remainder.toString('utf8')
      if (first.length > 0) lines.push(first)
    }

    return { lines, reachedStart: position === 0 }
  } finally {
    await handle.close()
  }
}

/** Number of non-empty lines. Used to decide on a compaction. */
async function countLines(filePath) {
  let handle
  try {
    handle = await fs.open(filePath, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }

  try {
    const buffer = Buffer.alloc(CHUNK_SIZE)
    let count = 0
    let position = 0
    let lastByte = NEWLINE

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position)
      if (bytesRead === 0) break
      position += bytesRead
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === NEWLINE) count++
        lastByte = buffer[i]
      }
    }
    // Last line with no trailing newline.
    if (position > 0 && lastByte !== NEWLINE) count++
    return count
  } finally {
    await handle.close()
  }
}

module.exports = { readLastLines, countLines }
