'use strict'

// Fallback interface, when no window is available — tests, execution with no
// graphical process.
//
// It refuses rather than throwing: an agent must learn that its question could
// not be asked, and carry on. A crash would teach it the same thing, but would
// take the execution down with it.

function createUnavailableUi() {
  return {
    // Nobody, and no prospect of anybody: the tools that would wait for an
    // answer are withdrawn before the turn rather than failing during it.
    attached: () => false,
    async report() {},
    async ask() {
      return { answered: false, reason: 'unavailable' }
    },
    async confirm() {
      return { confirmed: false, reason: 'unavailable' }
    },
  }
}

module.exports = { createUnavailableUi }
