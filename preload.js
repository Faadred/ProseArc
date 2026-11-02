// Preload script — the secure bridge between the main process and the UI.
//
// The renderer runs with no Node access (contextIsolation on). Here we expose a
// small, explicit, allow-listed API as window.api. Each method just forwards to
// an IPC handler in main.js. Nothing else from Node/Electron leaks to the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (id) => ipcRenderer.invoke('projects:get', id),
  createProject: (input) => ipcRenderer.invoke('projects:create', input),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  updateSegment: (projectId, segmentId, fields) =>
    ipcRenderer.invoke('projects:updateSegment', { projectId, segmentId, fields }),
  saveGlossary: (projectId, glossary) =>
    ipcRenderer.invoke('projects:saveGlossary', { projectId, glossary }),
  getGlobalGlossary: () => ipcRenderer.invoke('glossary:getGlobal'),
  saveGlobalGlossary: (glossary) => ipcRenderer.invoke('glossary:saveGlobal', glossary),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getSecrets: () => ipcRenderer.invoke('secrets:get'),
  saveSecrets: (secrets) => ipcRenderer.invoke('secrets:save', secrets),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),

  // Covers (native image picker; remove clears the stored cover file).
  pickCover: (projectId) => ipcRenderer.invoke('cover:pick', projectId),
  removeCover: (projectId) => ipcRenderer.invoke('cover:remove', projectId),

  // Manuscript import (opens a native file picker, returns { fileName, text }).
  pickManuscript: () => ipcRenderer.invoke('manuscript:pick'),

  // Export in the chosen format (opens a native save dialog for the location).
  exportProject: (projectId, format) => ipcRenderer.invoke('export:project', { projectId, format }),

  // Translation engine
  startTranslation: (projectId) => ipcRenderer.invoke('engine:start', projectId),
  stopTranslation: () => ipcRenderer.invoke('engine:stop'),
  testConnection: (apiUrl) => ipcRenderer.invoke('engine:testConnection', apiUrl),
  sampleTranslate: (cfg) => ipcRenderer.invoke('engine:sample', cfg),
  listModels: (cfg) => ipcRenderer.invoke('engine:listModels', cfg),

  // First-run Setup
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  detectLocalServers: () => ipcRenderer.invoke('local:detect'),
  applyAiToAllProjects: (ai) => ipcRenderer.invoke('projects:applyAi', ai),
  retranslateSegment: (projectId, segmentId) =>
    ipcRenderer.invoke('engine:retranslateSegment', { projectId, segmentId }),
  resetForRetranslate: (projectId, includeReviewed) =>
    ipcRenderer.invoke('projects:resetForRetranslate', { projectId, includeReviewed }),
  markAllReviewed: (projectId) => ipcRenderer.invoke('projects:markAllReviewed', projectId),

  // Subscribe to engine events (started / progress / log / done / error).
  // Returns an unsubscribe function.
  onEngineEvent: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },
});
