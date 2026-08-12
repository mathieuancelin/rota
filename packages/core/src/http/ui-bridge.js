'use strict'

// How an agent reaches a person who is not in this process.
//
// In the application, `ask_user` opens a window and waits for it. With no
// window — a daemon, or an application driven from somewhere else — the same
// question goes out over the event stream as a `ui-request`, and the answer
// comes back as an ordinary POST to /api/ui/answer.
//
// Three properties are worth stating, because each is a decision:
//
//   - **An interface is attached for exactly as long as its connection lives.**
//     Not a registration, not a session: the TCP connection is the lease. A
//     laptop that closes its lid stops being somewhere questions can be sent,
//     and nothing has to notice and clean up.
//   - **With nobody attached, the blocking tools are not offered at all.** The
//     agent is told in its transcript which were withdrawn and why, so a model
//     that would have asked chooses something else instead of discovering the
//     refusal three seconds later.
//   - **A question outlives its asker only until the timeout.** Same rule as
//     the window: a job that asks at three in the morning must not sit there
//     for ever, and an unanswered `confirm` counts as a refusal.

const { randomUUID } = require('node:crypto')

const logger = require('../lib/logger')

/**
 * @returns {{ui: object, answer: Function, bind: Function, pending: Function, closeAll: Function}}
 */
function createUiBridge() {
  /** @type {Map<string, {settle: Function, timer: object, kind: string}>} */
  const waiting = new Map()

  // Set by bind(), once the server that carries the questions exists. Until
  // then — and there is a moment during composition where that is true — the
  // bridge behaves exactly as if nobody were attached.
  let transport = { publish: () => {}, attachedCount: () => 0 }

  const attached = () => transport.attachedCount() > 0

  function settle(requestId, result) {
    const entry = waiting.get(requestId)
    if (!entry) return false
    waiting.delete(requestId)
    clearTimeout(entry.timer)
    entry.settle(result)
    return true
  }

  /**
   * Sends a question and waits. `onTimeout` is what the answer becomes when
   * nobody replies in time.
   */
  function askOverTheStream({ kind, payload, timeoutSeconds, onTimeout }) {
    if (!attached()) return Promise.resolve(onTimeout.unavailable)

    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          logger.info(`${kind} unanswered after ${timeoutSeconds} s`)
          settle(requestId, onTimeout.expired)
        },
        Math.max(1, timeoutSeconds) * 1000,
      )
      timer.unref?.()

      waiting.set(requestId, { settle: resolve, timer, kind })
      transport.publish('ui-request', { requestId, kind, ...payload, timeoutSeconds })
    })
  }

  return {
    /** Wires the bridge to the server that carries its questions. */
    bind({ publish, attachedCount }) {
      transport = { publish, attachedCount }
    },

    /**
     * The interface handed to the agent's tools — the same shape the windows
     * implement, so nothing downstream knows which one it got.
     */
    ui: {
      attached,

      async report({ title, markdown }) {
        // A report is not a question: it goes out and nobody waits. With nobody
        // attached it is dropped, which is what a report to an empty room is.
        transport.publish('ui-report', { title, markdown })
      },

      ask({ question, defaultValue, timeoutSeconds }) {
        return askOverTheStream({
          kind: 'ask',
          payload: { question, defaultValue },
          timeoutSeconds,
          onTimeout: {
            unavailable: { answered: false, reason: 'unavailable' },
            expired: { answered: false, reason: 'timeout' },
          },
        })
      },

      confirm({ question, detail, timeoutSeconds }) {
        return askOverTheStream({
          kind: 'confirm',
          payload: { question, detail },
          timeoutSeconds,
          onTimeout: {
            unavailable: { confirmed: false, reason: 'unavailable' },
            expired: { confirmed: false, reason: 'timeout' },
          },
        })
      },
    },

    /**
     * An interface answering a question it was sent.
     *
     * @param {string} requestId
     * @param {{action?: string, value?: string}} answer
     */
    answer(requestId, { action, value } = {}) {
      const entry = waiting.get(requestId)
      if (!entry) {
        // Late, or answered twice, or invented. None of them is an error worth
        // a stack trace, and all of them mean the same thing to the caller.
        return { ok: false, error: 'unknown request, or already answered' }
      }

      const submitted = action === 'submit'
      const result =
        entry.kind === 'confirm'
          ? submitted
            ? { confirmed: true }
            : { confirmed: false, reason: 'cancelled' }
          : submitted
            ? { answered: true, value: typeof value === 'string' ? value : '' }
            : { answered: false, reason: 'cancelled' }

      settle(requestId, result)
      return { ok: true }
    },

    /** What is still waiting — for the tests, and for a status that tells the truth. */
    pending: () => [...waiting.entries()].map(([requestId, { kind }]) => ({ requestId, kind })),

    /**
     * Everyone hung up. Every pending question is settled as unanswered rather
     * than left to its timeout: the execution waiting on it should learn now
     * that there is nobody left to ask.
     */
    closeAll() {
      for (const [requestId, entry] of [...waiting.entries()]) {
        settle(
          requestId,
          entry.kind === 'confirm'
            ? { confirmed: false, reason: 'unavailable' }
            : { answered: false, reason: 'unavailable' },
        )
      }
    },
  }
}

module.exports = { createUiBridge }
