// Preload script — the secure bridge between the main process and the UI.
//
// The renderer runs with no Node access (contextIsolation on). Here we expose a
// small, explicit, allow-listed API as window.api. Each method just forwards to
// an IPC handler in main.js. Nothing else from Node/Electron leaks to the page.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  getSeriesGlossary: (series) => ipcRenderer.invoke('glossary:getSeries', series),
  saveSeriesGlossary: (series, glossary) => ipcRenderer.invoke('glossary:saveSeries', { series, glossary }),
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
  listProviders: () => ipcRenderer.invoke('providers:list'),

  // First-run Setup
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  detectLocalServers: () => ipcRenderer.invoke('local:detect'),
  applyAiToAllProjects: (ai) => ipcRenderer.invoke('projects:applyAi', ai),

  // Built-in translator: model folders and the models found in them.
  getModelFolders: () => ipcRenderer.invoke('models:folders'),
  addModelFolder: (folder) => ipcRenderer.invoke('models:addFolder', folder || null),
  removeModelFolder: (folder) => ipcRenderer.invoke('models:removeFolder', folder),
  listModelFiles: () => ipcRenderer.invoke('models:list'),
  builtinStatus: () => ipcRenderer.invoke('builtin:status'),
  builtinEngines: () => ipcRenderer.invoke('builtin:engines'),
  builtinStop: () => ipcRenderer.invoke('builtin:stop'),
  engineInfo: () => ipcRenderer.invoke('engine:info'),
  engineCheckUpdate: () => ipcRenderer.invoke('engine:checkUpdate'),
  engineDownload: (flavour) => ipcRenderer.invoke('engine:download', flavour),
  engineCancel: () => ipcRenderer.invoke('engine:cancel'),
  engineUse: (choice) => ipcRenderer.invoke('engine:use', choice),

  // Hugging Face: find and download models
  hubSearch: (query) => ipcRenderer.invoke('hub:search', query),
  hubFiles: (repo) => ipcRenderer.invoke('hub:files', repo),
  hubFolder: () => ipcRenderer.invoke('hub:folder'),
  hubChooseFolder: () => ipcRenderer.invoke('hub:chooseFolder'),
  hubState: () => ipcRenderer.invoke('hub:state'),
  hubDownload: (repo, file) => ipcRenderer.invoke('hub:download', { repo, file }),
  hubCancel: () => ipcRenderer.invoke('hub:cancel'),
  onHubProgress: (callback) => {
    const listener = (_e, p) => callback(p);
    ipcRenderer.on('hub:progress', listener);
    return () => ipcRenderer.removeListener('hub:progress', listener);
  },
  // Folder import (a folder of books and the folders inside it) and the translation queue
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  scanFolder: (root) => ipcRenderer.invoke('folder:scan', root),
  importFolder: (input) => ipcRenderer.invoke('folder:import', input),
  onFolderProgress: (callback) => {
    const listener = (_e, p) => callback(p);
    ipcRenderer.on('folder:progress', listener);
    return () => ipcRenderer.removeListener('folder:progress', listener);
  },
  queueGet: () => ipcRenderer.invoke('queue:get'),
  queueAdd: (ids) => ipcRenderer.invoke('queue:add', ids),
  queueRemove: (id) => ipcRenderer.invoke('queue:remove', id),
  queueMove: (id, delta) => ipcRenderer.invoke('queue:move', { id, delta }),
  queueClearFinished: () => ipcRenderer.invoke('queue:clearFinished'),
  queueRetry: (id) => ipcRenderer.invoke('queue:retry', id),
  queueStart: () => ipcRenderer.invoke('queue:start'),
  queuePause: () => ipcRenderer.invoke('queue:pause'),
  onQueueState: (callback) => {
    const listener = (_e, s) => callback(s);
    ipcRenderer.on('queue:state', listener);
    return () => ipcRenderer.removeListener('queue:state', listener);
  },

  // App updates from GitHub releases
  appUpdateInfo: () => ipcRenderer.invoke('app:updateInfo'),
  appCheckUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  appInstallUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  appOpenReleases: () => ipcRenderer.invoke('app:openReleases'),
  onAppUpdate: (callback) => {
    const listener = (_e, s) => callback(s);
    ipcRenderer.on('app:update', listener);
    return () => ipcRenderer.removeListener('app:update', listener);
  },
  onEngineProgress: (callback) => {
    const listener = (_e, p) => callback(p);
    ipcRenderer.on('engine:progress', listener);
    return () => ipcRenderer.removeListener('engine:progress', listener);
  },
  onBuiltinStatus: (callback) => {
    const listener = (_e, st) => callback(st);
    ipcRenderer.on('builtin:status', listener);
    return () => ipcRenderer.removeListener('builtin:status', listener);
  },
  // Path of a dropped file/folder (File.path is gone in modern Electron).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
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
