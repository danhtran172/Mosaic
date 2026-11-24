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

export type UpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "development";
  version?: string;
  percent?: number;
};

export type InDeckBridge = {
  getAppDisplayName: () => Promise<string>;
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
  permanentlyDeleteProfile: (profileId: string, typedName: string) => Promise<{ id: string }>;
  libraryLocationStatus: (profileId: string, folder: string) => Promise<InDeckLibraryLocationStatus>;
  configureProfileLibrary: (profileId: string, folder: string, useExisting: boolean) => Promise<InDeckProfile>;
  recoverProfileLibrary: (profileId: string) => Promise<{ mediaPath: string; repairedDefaults: boolean }>;
  openProfile: (profileId: string) => Promise<{ id: string; focused: boolean }>;
  createProfileShortcut: (profileId: string) => Promise<string>;
  detectBrowsers: () => Promise<DetectedBrowser[]>;
  openExtensionInstall: (browserId: DetectedBrowser["id"]) => Promise<{ opened: boolean; storeUrl: string }>;
  checkForUpdates: () => Promise<UpdateStatus>;
  downloadUpdate: () => Promise<UpdateStatus>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
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
  ensureThumbnails: (assets: unknown[], requestId?: string) => Promise<Record<string, { url: string; color: string | null; palette?: Array<[string, number]> | null }>>;
  /** Placeholder colours measured from cached thumbnails, by media id. */
  thumbnailColors?: () => Promise<Record<string, { revision: string; color: string | null; palette?: Array<[string, number]> }>>;
  /** Measure palettes for media that have none yet, through the low-priority thumbnail lane. */
  analyzeThumbnailColors?: (assets: unknown[], requestId?: string) => Promise<Record<string, { revision: string; color: string | null; palette?: Array<[string, number]> }>>;
  /** Discard every cached thumbnail variant of these media so they are rebuilt. */
  regenerateThumbnails?: (assets: unknown[]) => Promise<number>;
  cancelThumbnails: (requestId: string) => Promise<void>;
  thumbnailMetrics: () => Promise<Array<{ id: string; size: number; priority: "high" | "buffer"; queuedMs: number; decodeMs: number; totalMs: number; outcome: string; at: number }>>;
  syncMediaLocations: () => Promise<{ moved: unknown[]; renamed: unknown[]; skipped: unknown[]; conflicts: unknown[] }>;
  watchSources: (folders: string[]) => Promise<unknown>;
  refreshSources: (folders: string[]) => Promise<unknown>;
  onFolderChanged: (callback: (folder: string) => void) => () => void;
  onMediaImported: (callback: (payload: unknown) => void) => () => void;
  /** Aspect ratios measured in the background for media that had none. */
  onMediaDimensions?: (callback: (dimensions: Record<string, { width: number; height: number }>) => void) => () => void;
  /** Trial and purchase state. Absent in an older main process. */
  licenseStatus?: () => Promise<LicenseStatus>;
  /** Like Eagle, a key activates only with the email it was bought with. */
  activateLicense?: (key: string, email: string) => Promise<LicenseResult>;
  /** Open the page where a card buyer finds their key again. */
  recoverLicense?: () => Promise<boolean>;
  deactivateLicense?: () => Promise<LicenseResult>;
  /** Open the card checkout in the browser; false when none is configured. */
  buyLicense?: () => Promise<boolean>;
  /** A fresh VietQR transfer request, or null when none is offered here. */
  /** A fresh VietQR transfer request. With a license server it needs the buyer's email. */
  bankTransfer?: (email?: string) => Promise<BankTransferDetails | { error: string } | null>;
  /** Has the server matched a payment to this order? Once paid, main activates the key. */
  licenseOrderStatus?: (code: string, email: string) => Promise<{ ok: true; status: "pending" | "paid"; activation?: LicenseResult } | { ok: false; error: string }>;
  /** Computers a license runs on (the stored license, or the given key and email). */
  licenseDevices?: (credentials?: { key: string; email: string }) => Promise<LicenseDevicesResult>;
  /** Remove a computer from a license, from any computer. */
  removeLicenseDevice?: (machine: string, credentials?: { key: string; email: string }) => Promise<LicenseDevicesResult & { status?: LicenseStatus }>;
  onLicenseChanged?: (callback: (status: LicenseStatus) => void) => () => void;
  copyImage: (asset: unknown) => Promise<boolean>;
  /** Plain text onto the system clipboard (hex codes, paths). */
  copyText?: (text: string) => Promise<boolean>;
  /** An SVG's markup onto the clipboard, to paste as a vector. */
  copySvg?: (asset: unknown) => Promise<boolean>;
  /** The system "Open with" chooser for the file. */
  openWith?: (asset: unknown) => Promise<boolean>;
  /** Begin an OS drag of these local files, for dropping into another app. */
  startDrag?: (assets: unknown[], icon?: string) => void;
  showInFolder: (asset: unknown) => Promise<boolean>;
  openWithDefaultApp: (asset: unknown) => Promise<boolean>;
  /**
   * `true` once the file is in a recoverable trash. A failure may name why,
   * so the UI can tell an outdated Vault apart from an unreachable one.
   */
  trashMedia: (asset: unknown) => Promise<boolean | { ok: false; reason?: "vault-no-trash" | "vault-unavailable" | "failed" }>;
};

export type LicenseStatus = {
  state: "development" | "licensed" | "trial" | "expired";
  trialDays: number;
  trialDaysLeft: number;
  trialEndsAt: number;
  /** The price for the region Windows is set to. */
  price: { region: string; currency: string; amount: number };
  deviceLimit: number | null;
  checkoutAvailable: boolean;
  /** A VietQR bank transfer is offered for this region. */
  bankTransferAvailable: boolean;
  /** This computer's code, which a bank-transfer key is issued for. */
  machineCode: string | null;
  /** Activations go through the Mosaic license server. */
  serverEnabled: boolean;
  /** A "Forgot your key?" page is configured. */
  recoverAvailable: boolean;
  /** Where bank-transfer buyers reach the seller. */
  supportContact: string | null;
  cardKeysAccepted: boolean;
  license: { source: "lemonsqueezy" | "offline" | "server"; email: string | null; keyHint: string; activatedAt: number | null } | null;
};
export type BankTransferDetails = {
  qr: string;
  order: string;
  content: string;
  amount: number;
  currency: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  contact: string;
  /** The license server matches the payment and unlocks the app by itself. */
  automatic: boolean;
};
export type LicenseDevice = { machine: string; name: string; activatedAt: number; lastSeenAt: number };
export type LicenseDevicesResult =
  | { ok: true; devices: LicenseDevice[]; deviceLimit: number | null; current: string }
  | { ok: false; error: string };
export type LicenseResult =
  | { ok: true; status: LicenseStatus }
  | { ok: false; error: "empty" | "email" | "invalid" | "other-machine" | "offline" | "device-limit" | "wrong-product" | "card-keys-unavailable"; detail?: string | null; devices?: LicenseDevice[]; deviceLimit?: number | null };

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
