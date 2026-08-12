'use strict'

// Output of a running execution, as it is watched scrolling past.
//
// Distinct from the collection meant for the history, for two reasons. It keeps
// only the tail — a chatty job must not inflate the main process's memory for
// hours — and it renders text as it comes rather than at the end, which is the
// whole point.
//
// Chunk boundaries follow nothing: an accented character can arrive in two
// pieces. `StringDecoder` holds the orphan byte until the next chunk, where a
// naive `toString()` would produce a "\uFFFD" every time an accent falls on a
// buffer boundary.

const { StringDecoder } = require('node:string_decoder')

const DEFAULT_MAX_CHARS = 64 * 1024

/**
 * @param {{maxChars?: number}} [options]
 */
function createLiveTail({ maxChars = DEFAULT_MAX_CHARS } = {}) {
  const decoder = new StringDecoder('utf8')
  let text = ''
  let dropped = false

  return {
    /**
     * @param {Buffer|string} chunk
     * @returns {string} the newly readable text, possibly empty
     */
    push(chunk) {
      const piece = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (piece === '') return ''

      text += piece
      if (text.length > maxChars) {
        // Cut on an end of line rather than to the character: a truncated start
        // of line reads worse than a missing line.
        const excess = text.length - maxChars
        const boundary = text.indexOf('\n', excess)
        text = boundary === -1 ? text.slice(excess) : text.slice(boundary + 1)
        dropped = true
      }
      return piece
    },

    /** @returns {{text: string, dropped: boolean}} */
    read() {
      return { text, dropped }
    },
  }
}

module.exports = { createLiveTail, DEFAULT_MAX_CHARS }
