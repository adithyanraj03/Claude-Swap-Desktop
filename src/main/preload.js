'use strict';
/** The renderer's whole view of the outside world. Context-isolated. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** Subscribe to pushed state. Returns an unsubscribe function. */
  onState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },

  /** Fired when the popover is shown, so the UI can reset to its default view. */
  onShown(callback) {
    const handler = () => callback();
    ipcRenderer.on('shown', handler);
    return () => ipcRenderer.removeListener('shown', handler);
  },

  getState: () => ipcRenderer.invoke('get-state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  switchTo: (target) => ipcRenderer.invoke('switch', target),
  switchBest: () => ipcRenderer.invoke('switch-best'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  runningSessions: () => ipcRenderer.invoke('running-sessions'),
  openTui: () => ipcRenderer.invoke('open-tui'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
  /** Ask the frameless window to match the rendered content height. */
  resize: (height) => ipcRenderer.send('resize', Math.round(height)),
  /** Corner-grip drag: resize live, keeping the bottom-right corner fixed. */
  resizeAnchored: (width, height) =>
    ipcRenderer.send('resize-anchored', Math.round(width), Math.round(height)),
  /** End of a grip drag — persist whatever size we landed on. */
  resizeCommit: () => ipcRenderer.send('resize-commit'),
  resetSize: () => ipcRenderer.send('reset-size'),
});
