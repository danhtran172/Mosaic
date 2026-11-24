export type MediaType = "image" | "video";

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  sourceId: string;
  type: MediaType;
  /** Original file URL. Previews come from the shared thumbnail cache instead. */
  originalUrl?: string;
  modified?: number;
  /** Source file size in bytes; part of the thumbnail cache identity. */
  size?: number;
  /** Video length in seconds, read during the scan; 0 when it could not be read. */
  duration?: number;
  vault?: boolean;
  contentUrl?: string;
  width: number;
  height: number;
  favorite: boolean;
  hidden: boolean;
  notes: string;
  /** propertyGroupId -> values */
  props: Record<string, string[]>;
  createdAt: number;
}

export interface MediaSource {
  id: string;
  name: string;
  path: string;
  /** Present only when this Profile explicitly links the source to a Vault bridge. */
  vaultBridgeId?: string;
  /** Stable Windows folder identity used if the linked Vault folder is moved. */
  tracking?: { volume: string; fileId: string };
}

export interface PersonalFolder {
  id: string;
  name: string;
  notes: string;
  /** propertyGroupId -> values applied automatically to added media */
  autoTags: Record<string, string[]>;
  /** Real media sources selected for this Gallery. */
  sourceIds?: string[];
  /** Source managed by InDeck for files saved directly into this Gallery. */
  defaultSourceId?: string;
  defaultSourcePath?: string;
  mediaIds: string[];
  /** Media removed from this Gallery but still recoverable from its trash. */
  discardedMediaIds?: string[];
  coverId: string | null;
  locked: boolean;
  /** Saved display layout for this Gallery. */
  layout?: GalleryLayout;
  /** General + gallery-exclusive tag groups available in this gallery. */
  managedGroupIds?: string[];
  /** General Property Groups are enabled by default; these are explicit opt-outs. */
  disabledGeneralGroupIds?: string[];
  /** Property Groups inherited from a Gallery Group, explicitly hidden for this Gallery. */
  disabledGalleryGroupIds?: string[];
}

export interface PropertyGroup {
  id: string;
  name: string;
  values: string[];
}

export interface MediaGroup {
  id: string;
  /** Optional user-facing name. Unnamed groups intentionally have no label. */
  name: string;
  memberIds: string[];
  collapsed: boolean;
  coverId: string | null;
  /**
   * Lay the Group out as a card that is exactly as wide as its members, so it
   * sits inside an ordinary row beside other cards instead of claiming rows of
   * its own. Only honoured while the members still fit one row at the current
   * zoom; otherwise the Group falls back to its full-width frame.
   */
  fit?: boolean;
}

/** A visual collection of Galleries. It never owns media. */
export interface GalleryGroup {
  id: string;
  name: string;
  folderIds: string[];
  collapsed: boolean;
  /** Property Groups owned by this Gallery Group and inherited by its Galleries. */
  propertyGroupIds?: string[];
}

export type OrderEntry = { kind: "media" | "group"; id: string };
/** Order of cards on the Galleries screen. Gallery groups and single Galleries share one rail. */
export type GalleryOrderEntry = { kind: "folder" | "group"; id: string };

export type Appearance = "light" | "dark" | "system";
export type ThemeColor = "green" | "blue" | "teal" | "pink" | "orange";
export type Language = "en" | "vi";
export type FilterKind = "all" | "favorites" | "images" | "videos";
export type GalleryLayout = "justified" | "square";

export interface AllsightState {
  sources: MediaSource[];
  /** Real Media Sources explicitly managed by Main Gallery. */
  mainSourceIds: string[];
  media: MediaItem[];
  folders: PersonalFolder[];
  /** Collections removed from the library, recoverable from the discard pile. */
  trashFolders: PersonalFolder[];
  /** Collections hidden from the sidebar / library view. */
  excludedFolderIds: string[];
  /** Virtual “Khác” source: media added from a source that no Gallery manages. */
  excludeOtherMedia: boolean;
  /** Virtual Default Source: files saved by the extension without a Gallery slot. */
  excludeDefaultMedia: boolean;
  /** When enabled, an excluded Gallery can also hide media owned by Main Gallery Media Sources. */
  ignoreMediaSourcesWhenExcluded: boolean;
  propertyGroups: PropertyGroup[];
  groups: MediaGroup[];
  galleryGroups: GalleryGroup[];
  /** Four Gallery targets used by the browser extension. */
  extensionGallerySlotIds: Array<string | null>;
  galleryOrder: GalleryOrderEntry[];
  order: OrderEntry[];
  language: Language;
  appearance: Appearance;
  themeColor: ThemeColor;
  password: string | null;
  /** Require the app password before a Library is shown after startup. */
  appLockEnabled: boolean;
  requirePasswordToUnlockGallery: boolean;
  thumbHeight: number;
  /** Display layout saved independently for Main Gallery. */
  mainGalleryLayout: GalleryLayout;
  inspectorAutoOpen: boolean;
  /** Lightbox: preserve natural pixels, or enlarge inside a fixed contain box. */
  lightboxFitMedia: boolean;
  /**
   * Media deleted from Mosaic for good while its file still sits in a watched
   * folder. Remembered so the next rescan does not bring it back as new.
   */
  removedMediaIds: string[];
}
