'use strict'

// IPC surface exposed to the renderer.
//
// Every channel is registered explicitly here and repeated by name in the
// preload: no channel name is built dynamically. Arguments coming from the
// renderer are revalidated — in particular the identifiers, which are used to
// compose file paths.

const fs = require('node:fs/promises')
const path = require('node:path')
const { ipcMain, shell } = require('electron')

const { agentMemory: memory, generateToken, logger } = require('@rota/core')

const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

// Ceiling of the global memory. The same as a job's by default: it is the same
// context it occupies.
const GLOBAL_MEMORY_MAX_ENTRIES = 100

const CHANNELS = {
  STATE_GET: 'rota:state:get',
  STATE_CHANGED: 'rota:state:changed',
  NAVIGATE: 'rota:navigate',
  JOBS_READ: 'rota:jobs:read',
  JOBS_CREATE: 'rota:jobs:create',
  JOBS_SAVE: 'rota:jobs:save',
  JOBS_SET_ENABLED: 'rota:jobs:setEnabled',
  JOBS_DELETE: 'rota:jobs:delete',
  JOBS_RUN: 'rota:jobs:run',
  RUNS_CANCEL: 'rota:runs:cancel',
  // Output of a running execution: what has already scrolled past, then the rest.
  RUNS_OUTPUT_GET: 'rota:runs:output:get',
  RUNS_OUTPUT: 'rota:runs:output',
  HISTORY_READ: 'rota:history:read',
  OUTPUT_READ: 'rota:output:read',
  ERRORS_ACKNOWLEDGE: 'rota:errors:acknowledge',
  SCHEDULER_SET_PAUSED: 'rota:scheduler:setPaused',
  CONFIG_PATCH: 'rota:config:patch',
  // The HTTP server's token is drawn here rather than in the renderer: it is
  // cryptographic randomness, and it has no business passing through a text field.
  CONFIG_GENERATE_HTTP_TOKEN: 'rota:config:generateHttpToken',
  // Global memory: shared by every agent job, edited from the settings or
  // straight in its file.
  MEMORY_GLOBAL_READ: 'rota:memory:global:read',
  MEMORY_GLOBAL_WRITE: 'rota:memory:global:write',
  MEMORY_GLOBAL_DELETE: 'rota:memory:global:delete',
  SHELL_OPEN_CONFIG_DIR: 'rota:shell:openConfigDir',
  SHELL_OPEN_JOB_FILE: 'rota:shell:openJobFile',
  // Agent windows. Their bridge is src/preload/agent.js, not the main window's:
  // they have no business reaching the rest of the surface.
  AGENT_PANEL_GET: 'rota:agent:panel:get',
  AGENT_PANEL_ANSWER: 'rota:agent:panel:answer',
  // Chat. It lives in a tab of the editor, hence on the main window's bridge
  // like the rest of the interface.
  AGENT_CHAT_LIST: 'rota:agent:chat:list',
  AGENT_CHAT_CREATE: 'rota:agent:chat:create',
  AGENT_CHAT_OPEN: 'rota:agent:chat:open',
  AGENT_CHAT_RENAME: 'rota:agent:chat:rename',
  AGENT_CHAT_DELETE: 'rota:agent:chat:delete',
  AGENT_CHAT_SEND: 'rota:agent:chat:send',
  AGENT_CHAT_STOP: 'rota:agent:chat:stop',
  AGENT_CHAT_CLOSE: 'rota:agent:chat:close',
  AGENT_CHAT_EVENT: 'rota:agent:chat:event',
}

function assertJobId(id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) {
    throw new Error(`Invalid job identifier: ${JSON.stringify(id)}`)
  }
  return id
}

function jobFilePath(store, id) {
  return path.join(store.paths.jobsDir, `${assertJobId(id)}.json`)
}

function clampInteger(value, { min, max, fallback }) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * @param {object} deps
 * @param {import('./config/store').ConfigStore} deps.store
 * @param {import('./history/store').HistoryStore} deps.history
 * @param {import('./scheduler').Scheduler} deps.scheduler
 * @param {import('./runner').Runner} deps.runner
 * @param {import('./state-store').StateStore} deps.state
 * @param {() => object} deps.getSnapshot
 * @param {(paused: boolean) => Promise<void>} deps.setPaused
 * @param {() => void} deps.publish
 * @param {import('./agent-panels').createAgentPanels} deps.panels
 */
function registerIpc({
  store,
  history,
  scheduler,
  runner,
  state,
  getSnapshot,
  setPaused,
  publish,
  panels,
  chat,
  confirmDestructive,
}) {
  ipcMain.handle(CHANNELS.STATE_GET, () => getSnapshot())

  // The panel comes and fetches its content; the identifier comes from the URL
  // fragment of its own window, but stays checked like everything that crosses.
  ipcMain.handle(CHANNELS.AGENT_PANEL_GET, (_event, panelId) => {
    if (typeof panelId !== 'string') return { ok: false, error: 'invalid panel' }
    return panels.get(panelId)
  })

  ipcMain.handle(CHANNELS.AGENT_CHAT_LIST, (_event, jobId) => {
    assertJobId(jobId)
    return chat.list(jobId)
  })

  ipcMain.handle(CHANNELS.AGENT_CHAT_CREATE, (_event, jobId) => {
    assertJobId(jobId)
    return chat.create(jobId)
  })

  // With no conversation identifier, the job's last one; with one, the
  // conversation picked from the list.
  ipcMain.handle(CHANNELS.AGENT_CHAT_OPEN, (_event, jobId, chatId = null) => {
    assertJobId(jobId)
    if (chatId === null || chatId === undefined) return chat.open(jobId)
    if (typeof chatId !== 'string') return { ok: false, errors: ['Invalid conversation'] }
    return chat.openConversation(jobId, chatId)
  })

  ipcMain.handle(CHANNELS.AGENT_CHAT_RENAME, (_event, jobId, chatId, title) => {
    assertJobId(jobId)
    if (typeof chatId !== 'string') return { ok: false, errors: ['Invalid conversation'] }
    if (title !== null && typeof title !== 'string') {
      return { ok: false, errors: ['A title is expected'] }
    }
    return chat.rename(jobId, chatId, title)
  })

  ipcMain.handle(CHANNELS.AGENT_CHAT_DELETE, (_event, jobId, chatId) => {
    assertJobId(jobId)
    if (typeof chatId !== 'string') return { ok: false, errors: ['Invalid conversation'] }
    return chat.remove(jobId, chatId)
  })

  ipcMain.handle(CHANNELS.AGENT_CHAT_SEND, (_event, chatId, content) => {
    if (typeof chatId !== 'string') return { ok: false, error: 'invalid conversation' }
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'empty message' }
    }
    return chat.post(chatId, content)
  })

  ipcMain.handle(CHANNELS.AGENT_CHAT_STOP, (_event, chatId) => {
    if (typeof chatId !== 'string') return { ok: false, error: 'invalid conversation' }
    return chat.stop(chatId)
  })

  // Leaving the tab does not close the conversation; this channel is the explicit
  // gesture, which interrupts the running turn and releases the container.
  ipcMain.handle(CHANNELS.AGENT_CHAT_CLOSE, (_event, chatId) => {
    if (typeof chatId !== 'string') return { ok: false, error: 'invalid conversation' }
    return chat.close(chatId)
  })

  ipcMain.handle(CHANNELS.AGENT_PANEL_ANSWER, (_event, panelId, answer) => {
    if (typeof panelId !== 'string') return { ok: false, error: 'invalid panel' }
    return panels.answer(panelId, {
      action: answer?.action === 'submit' ? 'submit' : 'cancel',
      value: typeof answer?.value === 'string' ? answer.value : '',
    })
  })

  ipcMain.handle(CHANNELS.JOBS_READ, async (_event, id) => {
    try {
      return { ok: true, content: await fs.readFile(jobFilePath(store, id), 'utf8') }
    } catch (err) {
      return { ok: false, errors: [`Read failed: ${err.message}`] }
    }
  })

  // Creation: unlike saving, the identifier comes from a text field. Its shape is
  // therefore a user error to display, not an exception to let bubble up.
  ipcMain.handle(CHANNELS.JOBS_CREATE, async (_event, id, templateId) => {
    if (typeof id !== 'string' || !JOB_ID.test(id)) {
      return {
        ok: false,
        errors: [
          'Invalid identifier: lowercase letters, digits, hyphen and underscore, ' +
            'starting with a letter or a digit.',
        ],
      }
    }
    if (typeof templateId !== 'string') return { ok: false, errors: ['Invalid template'] }

    const result = await store.createJob(id, templateId)
    if (result.ok) logger.info(`job ${id} created from the interface (template ${templateId})`)
    return result
  })

  ipcMain.handle(CHANNELS.JOBS_SAVE, async (_event, id, content) => {
    assertJobId(id)
    if (typeof content !== 'string') return { ok: false, errors: ['Invalid content'] }

    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      return { ok: false, errors: [`Invalid JSON: ${err.message}`] }
    }

    const result = await store.saveJob(id, parsed)
    if (result.ok) logger.info(`job ${id} saved from the interface`)
    return result
  })

  ipcMain.handle(CHANNELS.JOBS_SET_ENABLED, async (_event, id, enabled) => {
    assertJobId(id)
    return store.setJobEnabled(id, enabled)
  })

  // The confirmation is on the main side, as a native dialog: deletion is
  // irreversible and takes the history with it. One more button in the page gets
  // clicked by accident; a modal sheet does not — and its default button is
  // "Cancel".
  ipcMain.handle(CHANNELS.JOBS_DELETE, async (_event, id) => {
    assertJobId(id)
    const job = store.getJob(id)
    if (!job) return { ok: false, errors: [`Unknown job: ${id}`] }

    const confirmed = await confirmDestructive({
      message: `Delete "${job.name}"?`,
      detail:
        `The file ${id}.json will be deleted, along with the job's entire history ` +
        `and whatever its executions left behind. This action cannot be undone.`,
      confirmLabel: 'Delete',
    })
    if (!confirmed) return { ok: false, cancelled: true }

    const result = await store.deleteJob(id)
    if (result.ok) await store.reload()
    return result
  })

  ipcMain.handle(CHANNELS.JOBS_RUN, async (_event, id) => {
    assertJobId(id)
    return scheduler.runNow(id)
  })

  ipcMain.handle(CHANNELS.RUNS_CANCEL, async (_event, executionId) => {
    if (typeof executionId !== 'string') return { ok: false, errors: ['Invalid identifier'] }
    const cancelled = runner.cancel(executionId)
    return cancelled ? { ok: true } : { ok: false, errors: ['That execution is no longer running'] }
  })

  // What has already scrolled past. The rest arrives through RUNS_OUTPUT, pushed
  // by the main process.
  ipcMain.handle(CHANNELS.RUNS_OUTPUT_GET, (_event, executionId) => {
    if (typeof executionId !== 'string') return { ok: false, error: 'Invalid identifier' }
    return runner.liveOutput(executionId)
  })

  ipcMain.handle(CHANNELS.HISTORY_READ, async (_event, id, options = {}) => {
    assertJobId(id)
    try {
      return {
        ok: true,
        ...(await history.read(id, {
          limit: clampInteger(options.limit, { min: 1, max: 500, fallback: 50 }),
          offset: clampInteger(options.offset, { min: 0, max: 100_000, fallback: 0 }),
        })),
      }
    } catch (err) {
      return { ok: false, errors: [`History unreadable: ${err.message}`] }
    }
  })

  ipcMain.handle(CHANNELS.OUTPUT_READ, async (_event, relative) => history.readOutput(relative))

  ipcMain.handle(CHANNELS.ERRORS_ACKNOWLEDGE, async () => {
    state.acknowledgeErrors()
    publish()
    return { ok: true }
  })

  ipcMain.handle(CHANNELS.SCHEDULER_SET_PAUSED, async (_event, paused) => {
    if (typeof paused !== 'boolean') return { ok: false, errors: ['Expected value: boolean'] }
    await setPaused(paused)
    return { ok: true }
  })

  ipcMain.handle(CHANNELS.CONFIG_PATCH, async (_event, patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, errors: ['An object is expected'] }
    }
    const result = await store.patchConfig(patch)
    if (result.ok) publish()
    return result
  })

  ipcMain.handle(CHANNELS.CONFIG_GENERATE_HTTP_TOKEN, async () => {
    const config = store.getConfig()
    const result = await store.patchConfig({
      http: { ...config.http, token: generateToken() },
    })
    if (result.ok) publish()
    return result.ok ? { ok: true, token: store.getConfig().http.token } : result
  })

  ipcMain.handle(CHANNELS.MEMORY_GLOBAL_READ, async () => {
    const state = await memory.loadGlobal(store.paths.memoryDir)
    return {
      ok: true,
      file: memory.globalMemoryFile(store.paths.memoryDir),
      entries: Object.entries(state.entries)
        .map(([key, entry]) => ({ key, value: entry.value, updatedAt: entry.updatedAt }))
        .sort((a, b) => a.key.localeCompare(b.key, 'en')),
    }
  })

  ipcMain.handle(CHANNELS.MEMORY_GLOBAL_WRITE, async (_event, key, value) => {
    if (typeof key !== 'string' || key.trim() === '') {
      return { ok: false, errors: ['A key is required'] }
    }
    if (typeof value !== 'string') return { ok: false, errors: ['A value is expected'] }

    const state = await memory.loadGlobal(store.paths.memoryDir)
    // The same ceiling as a job's memory: it is the same context it occupies, and
    // the bound has no reason to be wider there.
    memory.write(state, key.trim(), value, { maxEntries: GLOBAL_MEMORY_MAX_ENTRIES })
    await memory.saveGlobal(store.paths.memoryDir, state)
    return { ok: true }
  })

  ipcMain.handle(CHANNELS.MEMORY_GLOBAL_DELETE, async (_event, key) => {
    if (typeof key !== 'string') return { ok: false, errors: ['A key is required'] }

    const state = await memory.loadGlobal(store.paths.memoryDir)
    if (!memory.remove(state, key)) return { ok: false, errors: [`Unknown key: ${key}`] }
    await memory.saveGlobal(store.paths.memoryDir, state)
    return { ok: true }
  })

  ipcMain.handle(CHANNELS.SHELL_OPEN_CONFIG_DIR, async () => {
    await shell.openPath(store.paths.root)
    return { ok: true }
  })

  ipcMain.handle(CHANNELS.SHELL_OPEN_JOB_FILE, async (_event, id) => {
    const error = await shell.openPath(jobFilePath(store, id))
    return error ? { ok: false, errors: [error] } : { ok: true }
  })
}

module.exports = { registerIpc, CHANNELS }
