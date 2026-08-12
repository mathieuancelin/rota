'use strict'

// Windows opened by agents: report, question, confirmation.
//
// A word on the confirmation, which could have been a native
// `dialog.showMessageBox`: Electron offers no way of closing a dialog box from
// code. Yet these questions have a timeout — a scheduled job may ask its own at
// three in the morning, and it must not sit there waiting for it. A native box
// would have stayed on screen after expiry, with nobody left to listen to it.
// Hence the same window as for `ask_user`, which we know how to close.
//
// The content is never pushed to the window: it comes and fetches it when its
// rendering is ready. Pushing would mean waiting for `did-finish-load`, and a
// message emitted too early would be silently lost.

const { randomUUID } = require('node:crypto')

const { logger } = require('@rota/core')
const { createAgentWindow } = require('./window')

const FRAMES = {
  report: { width: 720, height: 640, resizable: true },
  ask: { width: 520, height: 300, resizable: false, alwaysOnTop: true },
  confirm: { width: 520, height: 300, resizable: false, alwaysOnTop: true },
}

function createAgentPanels() {
  /** @type {Map<string, {kind: string, payload: object, settle: Function|null, window: object}>} */
  const panels = new Map()

  function open({ kind, title, payload, settle = null, timeoutMs = null, onTimeout = null }) {
    const panelId = randomUUID()

    const finish = (result) => {
      const panel = panels.get(panelId)
      if (!panel) return
      panels.delete(panelId)
      if (panel.timer) clearTimeout(panel.timer)
      if (!panel.window.isDestroyed()) panel.window.destroy()
      panel.settle?.(result)
    }

    const window = createAgentWindow({
      panelId,
      title,
      frame: FRAMES[kind],
      // Closing the window counts as an answer: without that, the execution would
      // wait out the whole timeout for an answer nothing can give it any more.
      onClosed: () => {
        const panel = panels.get(panelId)
        if (!panel) return
        panels.delete(panelId)
        if (panel.timer) clearTimeout(panel.timer)
        panel.settle?.({ cancelled: true })
      },
    })

    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            logger.info(`question unanswered after ${Math.round(timeoutMs / 1000)} s`)
            finish(onTimeout)
          }, timeoutMs)
    timer?.unref?.()

    panels.set(panelId, { kind, payload, settle, window, timer })
    return { panelId, finish }
  }

  return {
    /** Content claimed by the window at the moment it appears. */
    get(panelId) {
      const panel = panels.get(panelId)
      if (!panel) return { ok: false, error: 'unknown panel, or already closed' }
      return { ok: true, kind: panel.kind, ...panel.payload }
    },

    /** The user's answer. `action` is "submit" or "cancel". */
    answer(panelId, { action, value } = {}) {
      const panel = panels.get(panelId)
      if (!panel) return { ok: false, error: 'unknown panel, or already closed' }

      const settle = panel.settle
      panels.delete(panelId)
      if (panel.timer) clearTimeout(panel.timer)
      if (!panel.window.isDestroyed()) panel.window.destroy()

      if (action === 'submit') {
        settle?.(panel.kind === 'confirm' ? { confirmed: true } : { answered: true, value })
      } else {
        settle?.({ cancelled: true })
      }
      return { ok: true }
    },

    /** Interface handed to the agent's tools. */
    ui: {
      // There is a screen, by construction: this shell only exists because of it.
      attached: () => true,

      async report({ title, markdown }) {
        open({ kind: 'report', title, payload: { title, markdown } })
      },

      ask({ question, defaultValue, timeoutSeconds }) {
        return new Promise((resolve) => {
          open({
            kind: 'ask',
            title: 'Rota — question',
            payload: { question, defaultValue },
            timeoutMs: timeoutSeconds * 1000,
            onTimeout: { answered: false, reason: 'timeout' },
            settle: (result) =>
              resolve(
                result.answered
                  ? { answered: true, value: result.value }
                  : { answered: false, reason: result.reason ?? 'cancelled' },
              ),
          })
        })
      },

      confirm({ question, detail, timeoutSeconds }) {
        return new Promise((resolve) => {
          open({
            kind: 'confirm',
            title: 'Rota — confirmation',
            payload: { question, detail },
            timeoutMs: timeoutSeconds * 1000,
            onTimeout: { confirmed: false, reason: 'timeout' },
            settle: (result) =>
              resolve(
                result.confirmed
                  ? { confirmed: true }
                  : { confirmed: false, reason: result.reason ?? 'cancelled' },
              ),
          })
        })
      },
    },

    /** Closes everything — when the application shuts down. */
    closeAll() {
      for (const panelId of [...panels.keys()]) {
        const panel = panels.get(panelId)
        panels.delete(panelId)
        if (panel.timer) clearTimeout(panel.timer)
        if (!panel.window.isDestroyed()) panel.window.destroy()
        panel.settle?.({ cancelled: true })
      }
    },
  }
}

module.exports = { createAgentPanels, FRAMES }
