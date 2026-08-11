export type MediaType = "image" | "video";

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  sourceId: string;
  type: MediaType;
  url: string;
  /** Full media URL. Grid rendering must prefer the cached thumbnail in url. */
  originalUrl?: string;
  modified?: number;
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
  memberIds: string[];
  collapsed: boolean;
  coverId: string | null;
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
  inspectorAutoOpen: boolean;
  /** Lightbox: preserve natural pixels, or enlarge inside a fixed contain box. */
  lightboxFitMedia: boolean;
}
