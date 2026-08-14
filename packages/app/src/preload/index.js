'use strict'

// Bridge between the renderer and the main process.
//
// This script runs in a sandboxed context: `require` there accepts only a few
// Electron modules, no relative file. The channel names are therefore copied
// here rather than imported from src/main/ipc.js — a test checks the two lists
// stay identical.

const { contextBridge, ipcRenderer } = require('electron')

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
  RUNS_OUTPUT_GET: 'rota:runs:output:get',
  RUNS_OUTPUT: 'rota:runs:output',
  HISTORY_READ: 'rota:history:read',
  OUTPUT_READ: 'rota:output:read',
  ERRORS_ACKNOWLEDGE: 'rota:errors:acknowledge',
  ERRORS_CLEAR: 'rota:errors:clear',
  WORK_LIST: 'rota:work:list',
  WORK_CREATE: 'rota:work:create',
  WORK_RETRY: 'rota:work:retry',
  WORK_CANCEL: 'rota:work:cancel',
  WORK_DELETE: 'rota:work:delete',
  SCHEDULER_SET_PAUSED: 'rota:scheduler:setPaused',
  CONFIG_PATCH: 'rota:config:patch',
  CONFIG_GENERATE_HTTP_TOKEN: 'rota:config:generateHttpToken',
  MEMORY_GLOBAL_READ: 'rota:memory:global:read',
  MEMORY_GLOBAL_WRITE: 'rota:memory:global:write',
  MEMORY_GLOBAL_DELETE: 'rota:memory:global:delete',
  SHELL_OPEN_CONFIG_DIR: 'rota:shell:openConfigDir',
  SHELL_OPEN_JOB_FILE: 'rota:shell:openJobFile',
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

/** Generic subscription: always returns an unsubscribe function. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld('rota', {
  getState: () => ipcRenderer.invoke(CHANNELS.STATE_GET),
  onStateChanged: (callback) => subscribe(CHANNELS.STATE_CHANGED, callback),

  /** The main process asks for a view to open (click on a notification). */
  onNavigate: (callback) => subscribe(CHANNELS.NAVIGATE, callback),

  readJob: (id) => ipcRenderer.invoke(CHANNELS.JOBS_READ, id),
  createJob: (id, templateId) => ipcRenderer.invoke(CHANNELS.JOBS_CREATE, id, templateId),
  saveJob: (id, content) => ipcRenderer.invoke(CHANNELS.JOBS_SAVE, id, content),
  setJobEnabled: (id, enabled) => ipcRenderer.invoke(CHANNELS.JOBS_SET_ENABLED, id, enabled),

  /** Irreversible: the main process asks for confirmation before acting. */
  deleteJob: (id) => ipcRenderer.invoke(CHANNELS.JOBS_DELETE, id),
  runJob: (id) => ipcRenderer.invoke(CHANNELS.JOBS_RUN, id),
  cancelRun: (executionId) => ipcRenderer.invoke(CHANNELS.RUNS_CANCEL, executionId),

  /** Output already produced by a running execution, then the rest as it comes. */
  readLiveOutput: (executionId) => ipcRenderer.invoke(CHANNELS.RUNS_OUTPUT_GET, executionId),
  onLiveOutput: (callback) => subscribe(CHANNELS.RUNS_OUTPUT, callback),

  /** Conversation with a job's agent, in a tab of the editor. */
  listChats: (id) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_LIST, id),
  createChat: (id) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_CREATE, id),
  openChat: (id, chatId = null) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_OPEN, id, chatId),
  renameChat: (id, chatId, title) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_RENAME, id, chatId, title),
  deleteChat: (id, chatId) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_DELETE, id, chatId),
  sendChat: (chatId, content) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_SEND, chatId, content),
  stopChat: (chatId) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_STOP, chatId),
  closeChat: (chatId) => ipcRenderer.invoke(CHANNELS.AGENT_CHAT_CLOSE, chatId),
  onChatEvent: (callback) => subscribe(CHANNELS.AGENT_CHAT_EVENT, callback),

  readHistory: (id, options) => ipcRenderer.invoke(CHANNELS.HISTORY_READ, id, options),
  readOutput: (relative) => ipcRenderer.invoke(CHANNELS.OUTPUT_READ, relative),
  acknowledgeErrors: () => ipcRenderer.invoke(CHANNELS.ERRORS_ACKNOWLEDGE),
  clearErrors: () => ipcRenderer.invoke(CHANNELS.ERRORS_CLEAR),

  /** The work queues. The list is fetched, never pushed with the state. */
  listWork: (filter) => ipcRenderer.invoke(CHANNELS.WORK_LIST, filter ?? {}),
  createWork: (item) => ipcRenderer.invoke(CHANNELS.WORK_CREATE, item),
  retryWork: (id) => ipcRenderer.invoke(CHANNELS.WORK_RETRY, id),
  cancelWork: (id) => ipcRenderer.invoke(CHANNELS.WORK_CANCEL, id),
  deleteWork: (id) => ipcRenderer.invoke(CHANNELS.WORK_DELETE, id),

  setSchedulerPaused: (paused) => ipcRenderer.invoke(CHANNELS.SCHEDULER_SET_PAUSED, paused),
  patchConfig: (patch) => ipcRenderer.invoke(CHANNELS.CONFIG_PATCH, patch),
  generateHttpToken: () => ipcRenderer.invoke(CHANNELS.CONFIG_GENERATE_HTTP_TOKEN),

  /** Global memory: what every agent job finds again. */
  readGlobalMemory: () => ipcRenderer.invoke(CHANNELS.MEMORY_GLOBAL_READ),
  writeGlobalMemory: (key, value) => ipcRenderer.invoke(CHANNELS.MEMORY_GLOBAL_WRITE, key, value),
  deleteGlobalMemory: (key) => ipcRenderer.invoke(CHANNELS.MEMORY_GLOBAL_DELETE, key),
  openConfigDir: () => ipcRenderer.invoke(CHANNELS.SHELL_OPEN_CONFIG_DIR),
  openJobFile: (id) => ipcRenderer.invoke(CHANNELS.SHELL_OPEN_JOB_FILE, id),
})
