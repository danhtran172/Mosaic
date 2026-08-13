import type { AllsightState } from "./types";

/**
 * InDeck must never fall back to Lovable's demo library.  The actual library
 * always comes from the Electron backend; this is only the safe state while
 * it is loading or when the desktop bridge is unavailable.
 */
export function buildEmptyState(): AllsightState {
  return {
    sources: [],
    mainSourceIds: [],
    media: [],
    folders: [],
    trashFolders: [],
    excludedFolderIds: [],
    excludeOtherMedia: false,
    excludeDefaultMedia: false,
    ignoreMediaSourcesWhenExcluded: false,
    propertyGroups: [],
    groups: [],
    galleryGroups: [],
    extensionGallerySlotIds: [null, null, null, null],
    galleryOrder: [],
    order: [],
    language: "vi",
    appearance: "dark",
    themeColor: "green",
    password: null,
    appLockEnabled: false,
    requirePasswordToUnlockGallery: false,
    thumbHeight: 200,
    mainGalleryLayout: "square",
    inspectorAutoOpen: true,
    lightboxFitMedia: false,
  };
}
