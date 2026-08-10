/**
 * Electron boundary for the InDeck renderer.
 *
 * Components may use this module, but must never read/write localStorage for
 * library data. Filesystem access and persistence remain behind preload IPC.
 */
export type InDeckSnapshot = {
  version: 1;
  library: unknown;
};

export type InDeckProfile = {
  id: string;
  name: string;
  isDefault?: boolean;
  initialized: boolean;
  mediaPath?: string | null;
  lastMediaPath?: string | null;
  discardedAt?: number | null;
};

export type InDeckLibraryLocationStatus = {
  mediaPath: string;
  exists: boolean;
  sharedWith: Array<{ id: string; name: string }>;
};

export type DetectedBrowser = {
  id: "chrome" | "edge" | "brave";
  name: string;
  installed: boolean;
  path: string | null;
};

export type InDeckBridge = {
  readLibrarySnapshot: () => Promise<InDeckSnapshot>;
  writeStore: (value: unknown) => Promise<void>;
  listProfiles: () => Promise<InDeckProfile[]>;
  currentProfile: () => Promise<InDeckProfile>;
  createProfile: (name: string) => Promise<InDeckProfile>;
  renameProfile: (profileId: string, name: string) => Promise<InDeckProfile>;
  setDefaultProfile: (profileId: string) => Promise<InDeckProfile>;
  deleteProfile: (profileId: string, typedName: string, replacementDefaultId?: string | null) => Promise<{ id: string }>;
  listDiscardedProfiles: () => Promise<InDeckProfile[]>;
  recoverProfile: (profileId: string) => Promise<InDeckProfile>;
  libraryLocationStatus: (profileId: string, folder: string) => Promise<InDeckLibraryLocationStatus>;
  configureProfileLibrary: (profileId: string, folder: string, useExisting: boolean) => Promise<InDeckProfile>;
  recoverProfileLibrary: (profileId: string) => Promise<{ mediaPath: string; repairedDefaults: boolean }>;
  openProfile: (profileId: string) => Promise<{ id: string; focused: boolean }>;
  createProfileShortcut: (profileId: string) => Promise<string>;
  detectBrowsers: () => Promise<DetectedBrowser[]>;
  openExtensionInstall: (browserId: DetectedBrowser["id"]) => Promise<{ opened: boolean; storeUrl: string }>;
  minimizeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  pickFolder: () => Promise<string | null>;
  ensureGalleryDefaultSource: (gallery: { galleryId: string; galleryName: string; previousPath?: string }) => Promise<{ id: string; name: string; path: string }>;
  discardGalleryDefaultSource: (source: { sourceId: string; sourcePath: string }) => Promise<{ source: { id: string; name: string; path: string }; moved: Array<{ from: string; to: string }> }>;
  scanFolder: (source: unknown) => Promise<unknown>;
  cachedSource: (source: unknown) => Promise<unknown>;
  resolveSource: (source: unknown) => Promise<unknown>;
  ensureThumbnails: (assets: unknown[]) => Promise<Record<string, string>>;
  watchSources: (folders: string[]) => Promise<unknown>;
  onFolderChanged: (callback: (folder: string) => void) => () => void;
  onMediaImported: (callback: (payload: unknown) => void) => () => void;
  copyImage: (asset: unknown) => Promise<boolean>;
  showInFolder: (asset: unknown) => Promise<boolean>;
  openWithDefaultApp: (asset: unknown) => Promise<boolean>;
  permanentDelete: (asset: unknown) => Promise<boolean>;
};

declare global {
  interface Window {
    vision?: InDeckBridge;
  }
}

export function getInDeckBridge(): InDeckBridge | null {
  return window.vision ?? null;
}

export function isInDeckDesktop(): boolean {
  return !!getInDeckBridge();
}
