'use strict'

// Bridge of the agent windows: report and question.
//
// Deliberately separate from the main window's. These windows have no reason to
// reach the configuration, the history or the scheduler; giving them the full
// surface would widen it for no motive.
//
// Like the other, this script runs sandboxed: the channel names are copied here
// rather than imported, and a test checks the lists agree.

const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = {
  AGENT_PANEL_GET: 'rota:agent:panel:get',
  AGENT_PANEL_ANSWER: 'rota:agent:panel:answer',
}

contextBridge.exposeInMainWorld('rotaAgent', {
  /** The window comes and fetches its content when its rendering is ready. */
  getPanel: (panelId) => ipcRenderer.invoke(CHANNELS.AGENT_PANEL_GET, panelId),
  answerPanel: (panelId, answer) => ipcRenderer.invoke(CHANNELS.AGENT_PANEL_ANSWER, panelId, answer),
})
