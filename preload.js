const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vision', {
  getAppDisplayName: () => ipcRenderer.invoke('app:display-name'),
  readStore: () => ipcRenderer.invoke('store:read'),
  writeStore: value => ipcRenderer.invoke('store:write', value),
  readLibrarySnapshot: () => ipcRenderer.invoke('library:snapshot'),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  currentProfile: () => ipcRenderer.invoke('profiles:current'),
  createProfile: name => ipcRenderer.invoke('profiles:create', name),
  renameProfile: (profileId, name) => ipcRenderer.invoke('profiles:rename', profileId, name),
  setDefaultProfile: profileId => ipcRenderer.invoke('profiles:set-default', profileId),
  deleteProfile: (profileId, typedName, replacementDefaultId) => ipcRenderer.invoke('profiles:delete', profileId, typedName, replacementDefaultId),
  listDiscardedProfiles: () => ipcRenderer.invoke('profiles:discarded-list'),
  recoverProfile: profileId => ipcRenderer.invoke('profiles:recover', profileId),
  libraryLocationStatus: (profileId, folder) => ipcRenderer.invoke('profiles:library-location-status', profileId, folder),
  configureProfileLibrary: (profileId, folder, useExisting) => ipcRenderer.invoke('profiles:configure-library', profileId, folder, useExisting),
  recoverProfileLibrary: profileId => ipcRenderer.invoke('profiles:recover-library', profileId),
  openProfile: profileId => ipcRenderer.invoke('profiles:open', profileId),
  createProfileShortcut: profileId => ipcRenderer.invoke('profiles:create-shortcut', profileId),
  detectBrowsers: () => ipcRenderer.invoke('extension:browsers'),
  openExtensionInstall: browserId => ipcRenderer.invoke('extension:install', browserId),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: callback => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  pickFolder: () => ipcRenderer.invoke('folders:pick'),
  ensureGalleryDefaultSource: gallery => ipcRenderer.invoke('gallery:default-source:ensure', gallery),
  discardGalleryDefaultSource: source => ipcRenderer.invoke('gallery:default-source:discard', source),
  scanFolder: source => ipcRenderer.invoke('folder:scan', source),
  cachedSource: source => ipcRenderer.invoke('source:catalog', source),
  removeCachedSource: sourceId => ipcRenderer.invoke('source:catalog-remove', sourceId),
  resolveSource: source => ipcRenderer.invoke('source:resolve', source),
  ensureThumbnails: (assets, requestId) => ipcRenderer.invoke('thumbnails:ensure', assets, requestId),
  cancelThumbnails: requestId => ipcRenderer.invoke('thumbnails:cancel', requestId),
  thumbnailMetrics: () => ipcRenderer.invoke('thumbnails:metrics'),
  listVaultBridges: () => ipcRenderer.invoke('vault:bridges'),
  syncMediaLocations: () => ipcRenderer.invoke('media:sync-locations'),
  refreshSources: folders => ipcRenderer.invoke('sources:refresh', folders),
  watchSources: folders => ipcRenderer.invoke('sources:watch', folders),
  onFolderChanged: callback => {
    const listener = (_, folder) => callback(folder);
    ipcRenderer.on('folder:changed', listener);
    return () => ipcRenderer.removeListener('folder:changed', listener);
  },
  onMediaImported: callback => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('media:imported', listener);
    return () => ipcRenderer.removeListener('media:imported', listener);
  },
  copyImage: asset => ipcRenderer.invoke('image:copy', asset),
  showInFolder: asset => ipcRenderer.invoke('image:show-in-folder', asset),
  openWithDefaultApp: asset => ipcRenderer.invoke('media:open-default', asset),
  trashMedia: asset => ipcRenderer.invoke('media:trash', asset)
});
