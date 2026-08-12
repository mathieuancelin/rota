'use strict'

// Collecting and truncating a process's output.
//
// Two constraints: never let a chatty output inflate memory or the history, and
// never cut in the middle of a UTF-8 character — a naive truncation would
// produce a "\uFFFD" at the end of the excerpt.

/**
 * Useful length of a buffer whose end may hold an incomplete UTF-8 sequence.
 * A truncated sequence is dropped entirely.
 */
function trimIncompleteTail(buffer) {
  let index = buffer.length - 1
  // A UTF-8 sequence has at most three continuation bytes (10xxxxxx).
  for (let steps = 0; index >= 0 && (buffer[index] & 0xc0) === 0x80 && steps < 3; steps++) {
    index--
  }
  if (index < 0) return 0

  const lead = buffer[index]
  const expected = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return index + expected <= buffer.length ? buffer.length : index
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`
  const value = bytes < 1024 * 1024 ? bytes / 1024 : bytes / (1024 * 1024)
  const unit = bytes < 1024 * 1024 ? 'Kio' : 'Mio'
  return `${value.toFixed(1).replace('.', ',')} ${unit}`
}

/**
 * Accumulates chunks up to maxBytes, then merely counts.
 * @param {{maxBytes: number}} options
 */
function createOutputCollector({ maxBytes }) {
  const chunks = []
  let kept = 0
  let total = 0

  return {
    push(chunk) {
      total += chunk.length
      if (kept >= maxBytes) return
      const room = maxBytes - kept
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room)
      chunks.push(slice)
      kept += slice.length
    },

    /** @returns {{text: string, truncated: boolean, totalBytes: number}} */
    result() {
      const buffer = Buffer.concat(chunks, kept)
      if (total <= kept) {
        return { text: buffer.toString('utf8'), truncated: false, totalBytes: total }
      }
      const usable = buffer.subarray(0, trimIncompleteTail(buffer))
      const notice = `\n[… output truncated: ${formatBytes(kept)} kept out of ${formatBytes(total)} produced]`
      return { text: usable.toString('utf8') + notice, truncated: true, totalBytes: total }
    },
  }
}

/**
 * Cuts a text at a size in bytes, without breaking a character.
 * Produces the excerpt kept in the JSONL when the output goes to a file.
 */
function truncateToBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }
  const cut = buffer.subarray(0, maxBytes)
  return { text: cut.subarray(0, trimIncompleteTail(cut)).toString('utf8'), truncated: true }
}

module.exports = { createOutputCollector, truncateToBytes, trimIncompleteTail, formatBytes }
