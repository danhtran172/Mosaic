import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { buildEmptyState } from "./initial-state";
import type {
  AllsightState,
  Appearance,
  ThemeColor,
  GalleryGroup,
  GalleryOrderEntry,
  Language,
  MediaItem,
  OrderEntry,
  PersonalFolder,
} from "./types";
import { I18nContext, makeTranslate } from "./i18n";
import { getInDeckBridge } from "../indeck/bridge";

// Kept only for the browser-only preview. Desktop state is persisted by the
// Electron backend, never by Lovable's old localStorage key.
const KEY = "indeck.browser-state.v1";

let desktopLibrary: Record<string, any> | null = null;
let desktopWriteQueue = Promise.resolve();

const fileUrl = (value: string) => `file:///${encodeURI(value.replace(/\\/g, "/"))}`;

function libraryToState(library: Record<string, any>): AllsightState {
  const groups = Array.isArray(library.tagGroups) ? library.tagGroups : [];
  const definitions = (group: Record<string, any>) =>
    group.legacyField === "tags"
      ? library.tagDefinitions ?? []
      : group.legacyField === "persons"
        ? library.personDefinitions ?? []
        : group.values ?? [];
  const propertyGroups = groups.map((group: Record<string, any>) => ({
    id: String(group.id),
    name: String(group.name ?? group.id),
    values: definitions(group).map((value: any) => String(value?.name ?? value)).filter(Boolean),
  }));
  // Exclusive groups belong to one Gallery, but their media values still live
  // in assetMeta.tagGroups. Give them a stable namespaced id in this adapter.
  for (const gallery of library.collections ?? []) {
    for (const group of gallery.exclusiveTagGroups ?? []) {
      if (group.enabled === false) continue;
      propertyGroups.push({
        id: `exclusive:${gallery.id}:${group.id}`,
        name: String(group.name ?? "Exclusive tags"),
        values: (group.values ?? []).map((value: any) => String(value?.name ?? value)).filter(Boolean),
      });
    }
  }
  for (const group of library.mainExclusiveTagGroups ?? []) {
    if (group.enabled === false) continue;
    propertyGroups.push({
      id: `exclusive:main:${group.id}`,
      name: String(group.name ?? "Exclusive property"),
      values: (group.values ?? []).map((value: any) => String(value?.name ?? value)).filter(Boolean),
    });
  }
  for (const galleryGroup of library.galleryGroups ?? []) {
    for (const group of galleryGroup.propertyGroups ?? []) {
      propertyGroups.push({
        id: `gallery-group:${galleryGroup.id}:${group.id}`,
        name: String(group.name ?? "Gallery Group Property"),
        values: (group.values ?? []).map((value: any) => String(value?.name ?? value)).filter(Boolean),
      });
    }
  }
  const sources = (library.sources ?? []).map((source: Record<string, any>) => ({
    id: String(source.id),
    name: String(source.name ?? source.path ?? "Untitled source"),
    path: String(source.path ?? ""),
  }));
  const media = (library.sources ?? []).flatMap((source: Record<string, any>) =>
    (source.assets ?? []).map((asset: Record<string, any>) => {
      const meta = library.assetMeta?.[asset.id] ?? {};
      const originalUrl = asset.contentUrl || fileUrl(String(asset.path ?? ""));
      const props: Record<string, string[]> = {};
      for (const group of groups) {
        const values = group.legacyField === "tags"
          ? meta.tags
          : group.legacyField === "persons"
            ? meta.persons
            : meta.tagGroups?.[group.id];
        props[group.id] = Array.isArray(values) ? values.map(String) : [];
      }
      for (const gallery of library.collections ?? []) {
        for (const group of gallery.exclusiveTagGroups ?? []) {
          if (group.enabled === false) continue;
          const id = `exclusive:${gallery.id}:${group.id}`;
          props[id] = Array.isArray(meta.tagGroups?.[group.id]) ? meta.tagGroups[group.id].map(String) : [];
        }
      }
      for (const group of library.mainExclusiveTagGroups ?? []) {
        if (group.enabled === false) continue;
        const id = `exclusive:main:${group.id}`;
        props[id] = Array.isArray(meta.tagGroups?.[group.id]) ? meta.tagGroups[group.id].map(String) : [];
      }
      return {
        id: String(asset.id),
        name: String(asset.name ?? "Untitled media"),
        path: String(asset.path ?? ""),
        sourceId: String(source.id),
        type: asset.type === "video" ? "video" : "image",
        url: "",
        originalUrl,
        modified: Number(asset.modified ?? 0),
        vault: Boolean(asset.vault),
        contentUrl: asset.contentUrl ? String(asset.contentUrl) : undefined,
        width: Number(asset.width ?? 4),
        height: Number(asset.height ?? 3),
        favorite: Boolean(meta.favorite),
        hidden: false,
        notes: String(meta.note ?? ""),
        props,
        createdAt: Number(meta.order ?? asset.modified ?? Date.now()),
      };
    }),
  );
  const toFolder = (gallery: Record<string, any>) => {
    const storedMediaIds = (gallery.items ?? [])
      .filter((id: string) => !(gallery.discardedIds ?? []).includes(id))
      .map(String);
    // Legacy libraries stored items oldest-first. New records persist the
    // explicit newest-first marker so this migration happens only once.
    const mediaIds = gallery.itemOrder === "newest-first"
      ? storedMediaIds
      : [...storedMediaIds].reverse();
    return {
      id: String(gallery.id),
      name: String(gallery.name ?? "Untitled Gallery"),
      notes: String(gallery.note ?? ""),
      autoTags: {
        theme: Array.isArray(gallery.defaultTags) ? gallery.defaultTags.map(String) : [],
        character: Array.isArray(gallery.defaultPersons) ? gallery.defaultPersons.map(String) : [],
        ...(gallery.autoTagGroups ?? {}),
      },
      sourceIds: Array.isArray(gallery.sourceIds) ? gallery.sourceIds.map(String) : [],
      defaultSourceId: gallery.defaultSourceId ? String(gallery.defaultSourceId) : undefined,
      defaultSourcePath: gallery.defaultSourcePath ? String(gallery.defaultSourcePath) : undefined,
      mediaIds,
      discardedMediaIds: Array.isArray(gallery.discardedIds) ? gallery.discardedIds.map(String) : [],
      // A Gallery without a manually selected cover uses the first media that
      // was added to it. Persist the resolved value on the next state write.
      coverId: gallery.coverId
        ? String(gallery.coverId)
        : (gallery.itemOrder === "newest-first" ? storedMediaIds.at(-1) : storedMediaIds[0]) ?? null,
      locked: Boolean(gallery.locked),
      managedGroupIds: [...new Set([
        ...(gallery.generalTagGroupIds ?? groups.map((group: Record<string, any>) => group.id)),
        ...(gallery.exclusiveTagGroups ?? []).filter((group: Record<string, any>) => group.enabled !== false).map((group: Record<string, any>) => `exclusive:${gallery.id}:${group.id}`),
      ].map(String))],
      disabledGeneralGroupIds: Array.isArray(gallery.disabledGeneralPropertyIds)
        ? gallery.disabledGeneralPropertyIds.map(String)
        : [],
      disabledGalleryGroupIds: Array.isArray(gallery.disabledGalleryPropertyIds)
        ? gallery.disabledGalleryPropertyIds.map(String)
        : [],
    };
  };
  const folders = (library.collections ?? []).map(toFolder);
  // Main Gallery only owns sources explicitly added from its Inspector. A
  // source detached from a Gallery must not silently become a Main source.
  const mainSourceIds = (Array.isArray(library.mainSourceIds) ? library.mainSourceIds.map(String) : [])
    .filter((id) => sources.some((source) => source.id === id));
  const folderIds = new Set(folders.map((folder) => folder.id));
  const galleryGroups: GalleryGroup[] = (library.galleryGroups ?? [])
    .map((group: Record<string, any>) => ({
      id: String(group.id),
      name: String(group.title ?? group.name ?? "Gallery group"),
      folderIds: [...new Set((group.galleries ?? group.folderIds ?? []).map(String).filter((id: string) => folderIds.has(id)))],
      collapsed: Boolean(group.collapsed),
      propertyGroupIds: Array.isArray(group.propertyGroupIds)
        ? group.propertyGroupIds.map(String)
        : (group.propertyGroups ?? []).map((property: Record<string, any>) => `gallery-group:${group.id}:${property.id}`),
    }))
    .filter((group: GalleryGroup) => group.folderIds.length > 1);
  const groupedGalleryIds = new Set(galleryGroups.flatMap((group) => group.folderIds));
  const knownGalleryEntries = Array.isArray(library.galleryOrder) ? library.galleryOrder : [];
  const knownGalleryOrder = new Map<string, GalleryOrderEntry>();
  for (const entry of knownGalleryEntries) {
    if (!entry || (entry.kind !== "folder" && entry.kind !== "group")) continue;
    const id = String(entry.id ?? "");
    if ((entry.kind === "group" && galleryGroups.some((group) => group.id === id)) || (entry.kind === "folder" && folderIds.has(id) && !groupedGalleryIds.has(id))) {
      knownGalleryOrder.set(`${entry.kind}:${id}`, { kind: entry.kind, id });
    }
  }
  const galleryOrder: GalleryOrderEntry[] = [
    ...knownGalleryOrder.values(),
    ...galleryGroups.filter((group) => !knownGalleryOrder.has(`group:${group.id}`)).map((group) => ({ kind: "group" as const, id: group.id })),
    ...folders.filter((folder) => !groupedGalleryIds.has(folder.id) && !knownGalleryOrder.has(`folder:${folder.id}`)).map((folder) => ({ kind: "folder" as const, id: folder.id })),
  ];
  const grouped = (library.libraryGroups ?? []).filter((group: Record<string, any>) => (group.assets ?? []).length > 1);
  const groupedIds = new Set(grouped.flatMap((group: Record<string, any>) => group.assets ?? []));
  const order: OrderEntry[] = [
    ...grouped.map((group: Record<string, any>) => ({ kind: "group" as const, id: String(group.id), order: Number(group.order ?? 0) })),
    ...media.filter((item) => !groupedIds.has(item.id)).map((item) => ({ kind: "media" as const, id: item.id, order: item.createdAt })),
  ].sort((a, b) => b.order - a.order).map(({ kind, id }) => ({ kind, id }));

  return {
    sources,
    mainSourceIds,
    media,
    folders,
    trashFolders: (library.discardedGalleries ?? []).map(toFolder),
    excludedFolderIds: Array.isArray(library.allMediaExcludedGalleryIds)
      ? library.allMediaExcludedGalleryIds.map(String)
      : [],
    excludeOtherMedia: Boolean(library.allMediaExcludeOther),
    excludeDefaultMedia: Boolean(library.allMediaExcludeDefault),
    ignoreMediaSourcesWhenExcluded: Boolean(library.allMediaIgnoreMediaSources),
    propertyGroups,
    groups: grouped.map((group: Record<string, any>) => ({
      id: String(group.id),
      memberIds: (group.assets ?? []).map(String),
      collapsed: Boolean(group.collapsed),
      coverId: group.coverId ? String(group.coverId) : null,
    })),
    galleryGroups,
    extensionGallerySlotIds: Array.from({ length: 4 }, (_, index) => library.extensionGallerySlots?.[index] == null ? null : String(library.extensionGallerySlots[index])),
    galleryOrder,
    order,
    language: library.language === "en" ? "en" : "vi",
    appearance: library.appearance === "light" ? "light" : "dark",
    themeColor: ["blue", "teal", "pink", "orange"].includes(library.themeColor) ? library.themeColor : "green",
    // This is a SHA-256 digest produced by the old InDeck flow, never plaintext.
    password: library.passwordHash ? String(library.passwordHash) : null,
    appLockEnabled: Boolean(library.passwordHash && library.appLockEnabled),
    requirePasswordToUnlockGallery: Boolean(library.requirePasswordToUnlockGallery),
    thumbHeight: Math.max(100, Math.min(400, Math.round(Number(library.zoom ?? 200) / 50) * 50)),
    inspectorAutoOpen: library.inspectorAutoOpen !== false,
    lightboxFitMedia: Boolean(library.lightboxFitMedia),
  };
}

function stateToLibrary(state: AllsightState, library: Record<string, any>) {
  const next = JSON.parse(JSON.stringify(library)) as Record<string, any>;
  next.assetMeta ??= {};
  // A permanently removed file must not reappear from the persisted source
  // catalog on the next launch. Source rescans can still add existing files.
  const activeMediaIds = new Set(state.media.map((media) => media.id));
  const storedSources = new Map((next.sources ?? []).map((source: Record<string, any>) => [String(source.id), source]));
  // The UI can introduce a source through the Gallery inspector.  Serialize
  // from state rather than only filtering the old catalog, otherwise a source
  // that was just picked would disappear after the next restart.
  next.sources = state.sources.map((source) => {
    const old = storedSources.get(source.id) ?? {};
    const oldAssets = new Map((old.assets ?? []).map((asset: Record<string, any>) => [String(asset.id), asset]));
    return {
      ...old,
      id: source.id,
      name: source.name,
      path: source.path,
      assets: state.media
        .filter((media) => media.sourceId === source.id && activeMediaIds.has(media.id))
        .map((media) => ({
          ...(oldAssets.get(media.id) ?? {}),
          id: media.id,
          name: media.name,
          path: media.path,
          type: media.type,
          modified: media.modified ?? media.createdAt,
          vault: media.vault,
          contentUrl: media.contentUrl,
          width: media.width,
          height: media.height,
        })),
    };
  });
  next.tagGroups = state.propertyGroups.filter((group) => !group.id.startsWith("exclusive:") && !group.id.startsWith("gallery-group:")).map((group) => {
    const old = (library.tagGroups ?? []).find((item: Record<string, any>) => item.id === group.id) ?? {};
    return { ...old, id: group.id, name: group.name, values: old.legacyField ? old.values : group.values.map((name) => ({ name })) };
  });
  next.tagDefinitions = state.propertyGroups.find((group) => group.id === "theme")?.values.map((name) => ({ name })) ?? next.tagDefinitions ?? [];
  next.personDefinitions = state.propertyGroups.find((group) => group.id === "character")?.values.map((name) => ({ name })) ?? next.personDefinitions ?? [];
  for (const media of state.media) {
    const meta = (next.assetMeta[media.id] ??= {});
    meta.favorite = media.favorite;
    meta.note = media.notes;
    meta.tags = media.props.theme ?? [];
    meta.persons = media.props.character ?? [];
    meta.tagGroups = Object.fromEntries(Object.entries(media.props)
      .filter(([id]) => id !== "theme" && id !== "character")
      .map(([id, values]) => [id.startsWith("exclusive:") ? id.split(":").at(-1)! : id, values]));
  }
  const collectionsById = new Map((library.collections ?? []).map((item: Record<string, any>) => [item.id, item]));
  next.collections = state.folders.map((folder) => {
    const old = collectionsById.get(folder.id) ?? { id: folder.id, sourceIds: [], groups: [], discardedIds: [], manualItemIds: [] };
    return {
      ...old,
      name: folder.name,
      note: folder.notes,
      sourceIds: [...new Set(folder.sourceIds ?? [])],
      defaultSourceId: folder.defaultSourceId,
      defaultSourcePath: folder.defaultSourcePath,
      items: [...new Set([...folder.mediaIds, ...(folder.discardedMediaIds ?? [])])],
      itemOrder: "newest-first",
      discardedIds: [...new Set(folder.discardedMediaIds ?? [])],
      coverId: folder.coverId ?? undefined,
      locked: folder.locked,
      // A disabled Property must no longer auto-tag files on the backend. The
      // filter also cleans up old profile data created before this rule.
      defaultTags: (folder.disabledGeneralGroupIds ?? []).includes("theme") ? [] : (folder.autoTags.theme ?? []),
      defaultPersons: (folder.disabledGeneralGroupIds ?? []).includes("character") ? [] : (folder.autoTags.character ?? []),
      autoTagGroups: Object.fromEntries(Object.entries(folder.autoTags)
        .filter(([id]) => id !== "theme" && id !== "character" && !(folder.disabledGeneralGroupIds ?? []).includes(id) && !(folder.disabledGalleryGroupIds ?? []).includes(id))
        .map(([id, values]) => [id.startsWith("exclusive:") ? id.split(":").at(-1)! : id, values])),
      generalTagGroupIds: state.propertyGroups
        .filter((group) => !group.id.startsWith("exclusive:") && !group.id.startsWith("gallery-group:") && !(folder.disabledGeneralGroupIds ?? []).includes(group.id))
        .map((group) => group.id),
      disabledGeneralPropertyIds: [...new Set(folder.disabledGeneralGroupIds ?? [])],
      disabledGalleryPropertyIds: [...new Set(folder.disabledGalleryGroupIds ?? [])],
      exclusiveTagGroups: state.propertyGroups
        .filter((group) => group.id.startsWith(`exclusive:${folder.id}:`))
        .map((group) => ({ id: group.id.slice(`exclusive:${folder.id}:`.length), name: group.name, values: group.values.map((name) => ({ name })), enabled: true })),
    };
  });
  next.mainSourceIds = [...new Set(state.mainSourceIds)];
  next.mainExclusiveTagGroups = state.propertyGroups
    .filter((group) => group.id.startsWith("exclusive:main:"))
    .map((group) => ({
      id: group.id.slice("exclusive:main:".length),
      name: group.name,
      values: group.values.map((name) => ({ name })),
      enabled: true,
    }));
  next.discardedGalleries = state.trashFolders.map((folder) => ({
    ...(collectionsById.get(folder.id) ?? { id: folder.id, sourceIds: [], groups: [], discardedIds: [], manualItemIds: [] }),
    name: folder.name,
    note: folder.notes,
    sourceIds: [...new Set(folder.sourceIds ?? [])],
    defaultSourceId: folder.defaultSourceId,
    defaultSourcePath: folder.defaultSourcePath,
    items: [...new Set([...folder.mediaIds, ...(folder.discardedMediaIds ?? [])])],
    itemOrder: "newest-first",
    discardedIds: [...new Set(folder.discardedMediaIds ?? [])],
    coverId: folder.coverId ?? undefined,
    locked: folder.locked,
  }));
  next.libraryGroups = state.groups.filter((group) => group.memberIds.length > 1).map((group) => ({
    id: group.id,
    assets: group.memberIds,
    collapsed: group.collapsed,
    coverId: group.coverId ?? undefined,
    order: Math.max(...group.memberIds.map((id) => next.assetMeta[id]?.order ?? 0), 0),
  }));
  next.galleryGroups = state.galleryGroups.filter((group) => group.folderIds.length > 1).map((group, index) => ({
    id: group.id,
    title: group.name,
    galleries: [...new Set(group.folderIds)],
    collapsed: group.collapsed,
    propertyGroupIds: [...new Set(group.propertyGroupIds ?? [])],
    propertyGroups: (group.propertyGroupIds ?? []).map((id) => state.propertyGroups.find((property) => property.id === id)).filter(Boolean).map((property) => ({
      id: property!.id.slice(`gallery-group:${group.id}:`.length),
      name: property!.name,
      values: property!.values.map((name) => ({ name })),
    })),
    order: Date.now() - index,
  }));
  next.galleryOrder = state.galleryOrder;
  next.extensionGallerySlots = Array.from({ length: 4 }, (_, index) => state.extensionGallerySlotIds[index] ?? null);
  const now = Date.now();
  state.order.forEach((entry, index) => {
    if (entry.kind === "media") (next.assetMeta[entry.id] ??= {}).order = now - index;
  });
  next.language = state.language;
  next.appearance = state.appearance;
  next.themeColor = state.themeColor;
  next.passwordHash = state.password;
  next.appLockEnabled = Boolean(state.password && state.appLockEnabled);
  next.requirePasswordToUnlockGallery = state.requirePasswordToUnlockGallery;
  next.inspectorAutoOpen = state.inspectorAutoOpen;
  next.lightboxFitMedia = state.lightboxFitMedia;
  next.allMediaExcludedGalleryIds = [...new Set(state.excludedFolderIds)];
    next.allMediaExcludeOther = state.excludeOtherMedia;
    next.allMediaExcludeDefault = state.excludeDefaultMedia;
  next.allMediaIgnoreMediaSources = state.ignoreMediaSourcesWhenExcluded;
  next.zoom = state.thumbHeight;
  return next;
}

function load(): AllsightState {
  // Do not revive Lovable/localStorage mock data when the backend is absent.
  return buildEmptyState();
}

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

interface Ctx {
  state: AllsightState;
  set: (fn: (s: AllsightState) => AllsightState) => void;
  setMediaPreview: (id: string, url: string) => void;
  setMediaDimensions: (id: string, width: number, height: number) => void;
  reset: () => void;
  // media
  updateMedia: (id: string, patch: Partial<MediaItem>) => void;
  toggleFavorite: (id: string) => void;
  addPropValue: (mediaIds: string[], groupId: string, value: string) => void;
  removePropValue: (mediaId: string, groupId: string, value: string) => void;
  hideMedia: (ids: string[]) => void;
  restoreMedia: (id: string) => void;
  purgeMedia: (id: string) => void;
  restoreFolder: (id: string) => void;
  purgeFolder: (id: string) => void;
  toggleExcludedFolder: (id: string) => void;
  toggleExcludeOtherMedia: () => void;
  toggleExcludeDefaultMedia: () => void;
  toggleIgnoreMediaSourcesWhenExcluded: () => void;
  syncMediaLocation: () => Promise<{ moved: number; skipped: number; conflicts: number }>;
  duplicateMedia: (id: string) => void;

  // property groups
  addPropertyGroup: (name: string) => void;
  renamePropertyGroup: (id: string, name: string) => void;
  deletePropertyGroup: (id: string) => void;
  createPropertyValue: (groupId: string, value: string) => void;
  renamePropertyValue: (groupId: string, from: string, to: string) => void;
  deletePropertyValue: (groupId: string, value: string) => void;
  addExclusivePropertyGroup: (folderId: string, name: string) => void;
  addGalleryGroupProperty: (galleryGroupId: string, name: string) => void;
  toggleFolderProperty: (folderId: string, propertyId: string) => void;
  // folders
  createFolder: (name: string, options?: { sourceIds?: string[]; notes?: string; autoTags?: Record<string, string[]> }) => string;
  updateFolder: (id: string, patch: Partial<PersonalFolder>) => void;
  /** Rename Gallery and keep its InDeck-managed Default Source in sync. */
  renameFolder: (id: string, name: string) => Promise<void>;
  /** Create/repair the Gallery's InDeck-managed Default Source. */
  ensureFolderDefaultSource: (id: string, name?: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  addToFolder: (folderId: string, mediaIds: string[]) => void;
  /** Reorder media inside one Gallery without changing any other Gallery. */
  moveMediaInFolder: (folderId: string, mediaId: string, targetIndex: number) => void;
  removeFromFolder: (folderId: string, mediaId: string) => void;
  discardFromFolder: (folderId: string, mediaId: string) => void;
  restoreFromFolderTrash: (folderId: string, mediaId: string) => void;
  createGalleryGroup: (folderIds: string[], name?: string) => string | null;
  addGalleryToGroup: (groupId: string, folderId: string, targetIndex?: number) => void;
  removeGalleryFromGroup: (folderId: string) => void;
  updateGalleryGroup: (groupId: string, patch: Partial<GalleryGroup>) => void;
  moveGalleryEntry: (entry: GalleryOrderEntry, targetIndex: number) => void;
  moveGalleryInGroup: (groupId: string, folderId: string, targetIndex: number) => void;
  setExtensionGallerySlots: (ids: Array<string | null>) => void;
  // sources
  addSource: (name: string, path: string) => void;
  removeSource: (id: string) => void;
  /** Attach a real folder source to one Gallery, scanning it when it is new. */
  attachSourceFolder: (folderId: string, path: string) => Promise<"added" | "exists" | "unavailable">;
  /** Detach a source from this Gallery only; original files and the source stay intact. */
  detachSourceFromFolder: (folderId: string, sourceId: string) => void;
  /** Attach a real folder source directly to Main Gallery. */
  attachMainSource: (path: string) => Promise<"added" | "exists" | "unavailable">;
  /** Remove only Main Gallery's relationship with a source. */
  detachMainSource: (sourceId: string) => void;
  // groups
  createGroup: (memberIds: string[]) => void;
  addToGroup: (groupId: string, mediaId: string) => void;
  moveGroupMember: (groupId: string, mediaId: string, targetIndex: number) => void;
  insertIntoGroup: (groupId: string, mediaId: string, targetIndex: number) => void;
  removeFromGroup: (mediaId: string) => void;
  dissolveGroup: (groupId: string) => void;
  updateGroup: (groupId: string, patch: Partial<{ collapsed: boolean; coverId: string | null }>) => void;
  // order
  setOrder: (order: OrderEntry[]) => void;
  moveEntry: (entry: OrderEntry, targetIndex: number) => void;
  resetOrder: () => void;
  // prefs
  setLanguage: (l: Language) => void;
  setAppearance: (a: Appearance) => void;
  setThemeColor: (color: ThemeColor) => void;
  setThumbHeight: (n: number) => void;
  setPassword: (p: string | null) => void;
  setAppLockEnabled: (value: boolean) => void;
  setRequirePasswordToUnlockGallery: (value: boolean) => void;
  setInspectorAutoOpen: (v: boolean) => void;
  setLightboxFitMedia: (v: boolean) => void;
}

const StoreContext = createContext<Ctx | null>(null);

export function AllsightProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AllsightState>(() => buildEmptyState());
  const [hydrated, setHydrated] = useState(false);
  const skipPersist = useRef(false);

  useEffect(() => {
    const bridge = getInDeckBridge();
    if (!bridge) {
      setState(load());
      setHydrated(true);
      return;
    }
    let active = true;
    bridge.readLibrarySnapshot()
      .then(({ library }) => {
        if (!active || !library || typeof library !== "object") return;
        desktopLibrary = library as Record<string, any>;
        const initial = libraryToState(desktopLibrary);
        skipPersist.current = true;
        setState(initial);
        setHydrated(true);
        // Render the first viewport from the disk thumbnail cache. Remaining
        // cards are requested lazily by the gallery as they approach view.
        const firstBatch = initial.media.slice(0, 50).map((media) => ({
          id: media.id,
          path: media.path,
          type: media.type,
          modified: media.modified,
          vault: media.vault,
          contentUrl: media.contentUrl,
        }));
        void bridge.ensureThumbnails(firstBatch).then((urls) => {
          if (!active) return;
          skipPersist.current = true;
          setState((current) => ({
            ...current,
            media: current.media.map((media) => urls[media.id] ? { ...media, url: urls[media.id]! } : media),
          }));
        });
      })
      .catch(() => {
        if (!active) return;
        setState(load());
        setHydrated(true);
      });
    return () => { active = false; };
  }, []);

  // The browser extension imports through Electron, outside React state. Read
  // the committed snapshot after that event so the saved file immediately
  // appears in its target Gallery and a later UI write cannot overwrite it.
  useEffect(() => {
    const bridge = getInDeckBridge();
    if (!bridge?.onMediaImported) return;
    let active = true;
    return bridge.onMediaImported(() => {
      void bridge.readLibrarySnapshot().then(({ library }) => {
        if (!active || !library || typeof library !== "object") return;
        desktopLibrary = library as Record<string, any>;
        skipPersist.current = true;
        setState(libraryToState(desktopLibrary));
      });
    });
  }, []);

  // Files can reach DefaultSave from the browser extension or another file
  // operation while InDeck is already open. Watch the real source folders and
  // reload the backend snapshot; the backend re-indexes DefaultSave before it
  // returns the snapshot.
  useEffect(() => {
    const bridge = getInDeckBridge();
    if (!hydrated || !bridge?.watchSources || !bridge.refreshSources || !bridge.onFolderChanged) return;
    const folders = [...new Set(state.sources.map((source) => source.path).filter(Boolean))];
    void bridge.watchSources(folders);
    let active = true;
    let queued = false;
    const unsubscribe = bridge.onFolderChanged((folder) => {
      if (!active || queued) return;
      queued = true;
      window.setTimeout(() => {
        queued = false;
        void bridge.refreshSources([folder]).then(() => bridge.readLibrarySnapshot()).then(({ library }) => {
          if (!active || !library || typeof library !== "object") return;
          desktopLibrary = library as Record<string, any>;
          skipPersist.current = true;
          setState(libraryToState(desktopLibrary));
        }).catch(() => {});
      }, 80);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [hydrated, state.sources]);

  useEffect(() => {
    if (!hydrated) return;
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    const bridge = getInDeckBridge();
    if (bridge && desktopLibrary) {
      const next = stateToLibrary(state, desktopLibrary);
      desktopLibrary = next;
      desktopWriteQueue = desktopWriteQueue.catch(() => {}).then(() => bridge.writeStore(next));
      return;
    }
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* quota */
    }
  }, [state, hydrated]);

  const set = useCallback((fn: (s: AllsightState) => AllsightState) => setState(fn), []);
  const setMediaPreview = useCallback((id: string, url: string) => {
    skipPersist.current = true;
    setState((current) => ({
      ...current,
      media: current.media.map((media) => media.id === id ? { ...media, url } : media),
    }));
  }, []);
  const setMediaDimensions = useCallback((id: string, width: number, height: number) => {
    if (!width || !height) return;
    skipPersist.current = true;
    setState((current) => ({
      ...current,
      media: current.media.map((media) =>
        media.id === id && (media.width !== width || media.height !== height)
          ? { ...media, width, height }
          : media,
      ),
    }));
  }, []);

  const api = useMemo<Ctx>(() => {
    const entriesWithout = (order: OrderEntry[], entry: OrderEntry) =>
      order.filter((e) => !(e.kind === entry.kind && e.id === entry.id));

    return {
      state,
      set,
      setMediaPreview,
      setMediaDimensions,
      reset: () => setState(buildEmptyState()),
      updateMedia: (id, patch) =>
        set((s) => ({ ...s, media: s.media.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
      toggleFavorite: (id) =>
        set((s) => ({
          ...s,
          media: s.media.map((m) => (m.id === id ? { ...m, favorite: !m.favorite } : m)),
        })),
      addPropValue: (mediaIds, groupId, value) =>
        set((s) => ({
          ...s,
          propertyGroups: s.propertyGroups.map((g) =>
            g.id === groupId && !g.values.includes(value)
              ? { ...g, values: [...g.values, value].sort((a, b) => a.localeCompare(b)) }
              : g,
          ),
          media: s.media.map((m) =>
            mediaIds.includes(m.id)
              ? {
                  ...m,
                  props: {
                    ...m.props,
                    [groupId]: Array.from(new Set([...(m.props[groupId] ?? []), value])),
                  },
                }
              : m,
          ),
        })),
      removePropValue: (mediaId, groupId, value) =>
        set((s) => ({
          ...s,
          media: s.media.map((m) =>
            m.id === mediaId
              ? { ...m, props: { ...m.props, [groupId]: (m.props[groupId] ?? []).filter((v) => v !== value) } }
              : m,
          ),
        })),
      hideMedia: (ids) =>
        set((s) => ({
          ...s,
          media: s.media.map((m) => (ids.includes(m.id) ? { ...m, hidden: true } : m)),
        })),
      restoreMedia: (id) =>
        set((s) => ({
          ...s,
          media: s.media.map((m) => (m.id === id ? { ...m, hidden: false } : m)),
        })),
      purgeMedia: (id) =>
        set((s) => ({
          ...s,
          media: s.media.filter((m) => m.id !== id),
          groups: s.groups
            .map((g) => ({ ...g, memberIds: g.memberIds.filter((x) => x !== id) }))
            .filter((g) => g.memberIds.length > 0),
          folders: s.folders.map((f) => {
            const mediaIds = f.mediaIds.filter((x) => x !== id);
            return {
              ...f,
              mediaIds,
              discardedMediaIds: (f.discardedMediaIds ?? []).filter((x) => x !== id),
              coverId: f.coverId === id ? (mediaIds[0] ?? null) : f.coverId,
            };
          }),
          order: s.order.filter((e) => !(e.kind === "media" && e.id === id)),
        })),
      restoreFolder: (id) =>
        set((s) => {
          const f = s.trashFolders.find((x) => x.id === id);
          if (!f) return s;
          return { ...s, folders: [...s.folders, f], trashFolders: s.trashFolders.filter((x) => x.id !== id) };
        }),
      purgeFolder: (id) =>
        set((s) => ({ ...s, trashFolders: s.trashFolders.filter((x) => x.id !== id) })),
      toggleExcludedFolder: (id) =>
        set((s) => ({
          ...s,
          excludedFolderIds: s.excludedFolderIds.includes(id)
            ? s.excludedFolderIds.filter((x) => x !== id)
            : [...s.excludedFolderIds, id],
        })),
      toggleExcludeOtherMedia: () => set((s) => ({ ...s, excludeOtherMedia: !s.excludeOtherMedia })),
      toggleExcludeDefaultMedia: () => set((s) => ({ ...s, excludeDefaultMedia: !s.excludeDefaultMedia })),
      toggleIgnoreMediaSourcesWhenExcluded: () => set((s) => ({
        ...s,
        ignoreMediaSourcesWhenExcluded: !s.ignoreMediaSourcesWhenExcluded,
      })),
      syncMediaLocation: async () => {
        const bridge = getInDeckBridge();
        if (!bridge) return { moved: 0, skipped: 0, conflicts: 0 };
        const result = await bridge.syncMediaLocations();
        const snapshot = await bridge.readLibrarySnapshot();
        if (snapshot.library && typeof snapshot.library === "object") {
          desktopLibrary = snapshot.library as Record<string, any>;
          skipPersist.current = true;
          setState(libraryToState(desktopLibrary));
        }
        return {
          moved: result.moved?.length ?? 0,
          skipped: result.skipped?.length ?? 0,
          conflicts: result.conflicts?.length ?? 0,
        };
      },


      duplicateMedia: (id) =>
        set((s) => {
          const src = s.media.find((m) => m.id === id);
          if (!src) return s;
          const copy: MediaItem = { ...src, id: uid("m"), name: src.name.replace(/(\.\w+)$/, "_copy$1") };
          const idx = s.order.findIndex((e) => e.kind === "media" && e.id === id);
          const order = [...s.order];
          order.splice(idx < 0 ? order.length : idx + 1, 0, { kind: "media", id: copy.id });
          return { ...s, media: [...s.media, copy], order };
        }),
      addPropertyGroup: (name) =>
        set((s) => {
          const id = uid("pg");
          return {
            ...s,
            propertyGroups: [...s.propertyGroups, { id, name, values: [] }],
            // General Properties are shared application-wide and immediately
            // available to every Gallery unless that Gallery disabled them.
            folders: s.folders.map((folder) => ({ ...folder, managedGroupIds: [...new Set([...(folder.managedGroupIds ?? []), id])] })),
          };
        }),
      renamePropertyGroup: (id, name) =>
        set((s) => ({
          ...s,
          propertyGroups: s.propertyGroups.map((g) => (g.id === id ? { ...g, name } : g)),
        })),
      deletePropertyGroup: (id) =>
        set((s) => ({
          ...s,
          propertyGroups: s.propertyGroups.filter((g) => g.id !== id),
          folders: s.folders.map((folder) => ({
            ...folder,
            managedGroupIds: (folder.managedGroupIds ?? []).filter((groupId) => groupId !== id),
            autoTags: Object.fromEntries(Object.entries(folder.autoTags).filter(([groupId]) => groupId !== id)),
            disabledGeneralGroupIds: (folder.disabledGeneralGroupIds ?? []).filter((groupId) => groupId !== id),
            disabledGalleryGroupIds: (folder.disabledGalleryGroupIds ?? []).filter((groupId) => groupId !== id),
          })),
          galleryGroups: s.galleryGroups.map((group) => ({ ...group, propertyGroupIds: (group.propertyGroupIds ?? []).filter((groupId) => groupId !== id) })),
          media: s.media.map((m) => {
            const props = { ...m.props };
            delete props[id];
            return { ...m, props };
          }),
        })),
      createPropertyValue: (groupId, value) =>
        set((s) => ({
          ...s,
          propertyGroups: s.propertyGroups.map((g) =>
            g.id === groupId && !g.values.includes(value)
              ? { ...g, values: [...g.values, value].sort((a, b) => a.localeCompare(b)) }
              : g,
          ),
        })),
      renamePropertyValue: (groupId, from, to) =>
        set((s) => ({
          ...s,
          propertyGroups: s.propertyGroups.map((g) =>
            g.id === groupId
              ? { ...g, values: g.values.map((v) => (v === from ? to : v)).sort((a, b) => a.localeCompare(b)) }
              : g,
          ),
          media: s.media.map((m) => ({
            ...m,
            props: { ...m.props, [groupId]: (m.props[groupId] ?? []).map((v) => (v === from ? to : v)) },
          })),
        })),
      addExclusivePropertyGroup: (folderId, name) =>
        set((s) => {
          if (folderId !== "main" && !s.folders.some((folder) => folder.id === folderId)) return s;
          const id = `exclusive:${folderId}:${uid("pg")}`;
          return { ...s, propertyGroups: [...s.propertyGroups, { id, name, values: [] }] };
        }),
      addGalleryGroupProperty: (galleryGroupId, name) =>
        set((s) => {
          if (!s.galleryGroups.some((group) => group.id === galleryGroupId)) return s;
          const id = `gallery-group:${galleryGroupId}:${uid("pg")}`;
          return {
            ...s,
            propertyGroups: [...s.propertyGroups, { id, name, values: [] }],
            galleryGroups: s.galleryGroups.map((group) => group.id === galleryGroupId ? { ...group, propertyGroupIds: [...new Set([...(group.propertyGroupIds ?? []), id])] } : group),
          };
        }),
      toggleFolderProperty: (folderId, propertyId) =>
        set((s) => ({
          ...s,
          folders: s.folders.map((folder) => {
            if (folder.id !== folderId || propertyId.startsWith(`exclusive:${folderId}:`)) return folder;
            const field = propertyId.startsWith("gallery-group:") ? "disabledGalleryGroupIds" : "disabledGeneralGroupIds";
            const disabled = folder[field] ?? [];
            const disabling = !disabled.includes(propertyId);
            return {
              ...folder,
              [field]: disabling ? [...disabled, propertyId] : disabled.filter((id) => id !== propertyId),
              // Disable is semantic, not merely visual: do not keep applying
              // this Gallery's previous automatic tags to new media.
              autoTags: disabling
                ? Object.fromEntries(Object.entries(folder.autoTags).filter(([id]) => id !== propertyId))
                : folder.autoTags,
            };
          }),
        })),
      deletePropertyValue: (groupId, value) =>
        set((s) => ({
          ...s,
          propertyGroups: s.propertyGroups.map((g) =>
            g.id === groupId ? { ...g, values: g.values.filter((v) => v !== value) } : g,
          ),
          media: s.media.map((m) => ({
            ...m,
            props: { ...m.props, [groupId]: (m.props[groupId] ?? []).filter((v) => v !== value) },
          })),
        })),
      createFolder: (name, options = {}) => {
        const id = uid("f");
        set((s) => ({
          ...s,
          media: s.media.map((media) => {
            if (!(options.sourceIds ?? []).includes(media.sourceId)) return media;
            const props = { ...media.props };
            for (const [groupId, values] of Object.entries(options.autoTags ?? {})) {
              props[groupId] = [...new Set([...(props[groupId] ?? []), ...values])];
            }
            return { ...media, props };
          }),
          folders: [
            ...s.folders,
            (() => {
              const requestedName = name.trim() || "Untitled Gallery";
              const usedNames = new Set(s.folders.map((folder) => folder.name.trim().toLocaleLowerCase()));
              let uniqueName = requestedName;
              for (let number = 2; usedNames.has(uniqueName.toLocaleLowerCase()); number += 1) {
                uniqueName = `${requestedName} (${number})`;
              }
              const addedMediaIds = s.media.filter((media) => (options.sourceIds ?? []).includes(media.sourceId)).map((media) => media.id);
              const mediaIds = [...addedMediaIds].reverse();
              return {
              id,
              name: uniqueName,
              notes: options.notes ?? "",
              autoTags: options.autoTags ?? {},
              sourceIds: [...new Set(options.sourceIds ?? [])],
              mediaIds,
              coverId: addedMediaIds[0] ?? null,
              locked: false,
              };
            })(),
          ],
          galleryOrder: [...s.galleryOrder, { kind: "folder", id }],
        }));
        return id;
      },
      updateFolder: (id, patch) =>
        set((s) => ({ ...s, folders: s.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
      ensureFolderDefaultSource: async (id, requestedName) => {
        const folder = state.folders.find((item) => item.id === id);
        const bridge = getInDeckBridge();
        const galleryName = requestedName?.trim() || folder?.name;
        if (!galleryName || !bridge) return;
        try {
          const source = await bridge.ensureGalleryDefaultSource({
            galleryId: id,
            galleryName,
            previousPath: folder?.defaultSourcePath,
          });
          set((s) => ({
            ...s,
            sources: s.sources.some((item) => item.id === source.id)
              ? s.sources.map((item) => item.id === source.id ? { ...item, name: source.name, path: source.path } : item)
              : [...s.sources, source],
            folders: s.folders.map((item) => item.id !== id ? item : {
              ...item,
              defaultSourceId: source.id,
              defaultSourcePath: source.path,
              sourceIds: [...new Set([...(item.sourceIds ?? []), source.id])],
            }),
          }));
        } catch {
          // Source creation failures leave the Gallery usable with its other
          // sources; the next extension save will repair it again.
        }
      },
      renameFolder: async (id, name) => {
        const cleanName = name.trim();
        const folder = state.folders.find((item) => item.id === id);
        if (!cleanName || !folder) return;
        const bridge = getInDeckBridge();
        let defaultSource: { id: string; name: string; path: string } | null = null;
        if (bridge) {
          try {
            defaultSource = await bridge.ensureGalleryDefaultSource({
              galleryId: id,
              galleryName: cleanName,
              previousPath: folder.defaultSourcePath,
            });
          } catch { /* Rename the Gallery even if the default directory is unavailable. */ }
        }
        set((s) => ({
          ...s,
          sources: defaultSource
            ? (s.sources.some((item) => item.id === defaultSource!.id)
                ? s.sources.map((item) => item.id === defaultSource!.id ? { ...item, name: defaultSource!.name, path: defaultSource!.path } : item)
                : [...s.sources, defaultSource])
            : s.sources,
          folders: s.folders.map((item) => item.id !== id ? item : {
            ...item,
            name: cleanName,
            ...(defaultSource ? {
              defaultSourceId: defaultSource.id,
              defaultSourcePath: defaultSource.path,
              sourceIds: [...new Set([...(item.sourceIds ?? []), defaultSource.id])],
            } : {}),
          }),
        }));
      },
      deleteFolder: async (id) => {
        const folder = state.folders.find((item) => item.id === id);
        if (!folder) return;
        const bridge = getInDeckBridge();
        let discarded: { source: { id: string; name: string; path: string }; moved: Array<{ from: string; to: string }> } | null = null;
        if (bridge && folder.defaultSourceId && folder.defaultSourcePath) {
          try {
            discarded = await bridge.discardGalleryDefaultSource({
              sourceId: folder.defaultSourceId,
              sourcePath: folder.defaultSourcePath,
            });
          } catch (error) {
            // Do not move the Gallery into app trash when its files could not
            // first be moved safely to InDeckMedia/Discards.
            console.error("Could not discard Gallery Default Source", error);
            return;
          }
        }
        set((s) => {
          const current = s.folders.find((item) => item.id === id);
          if (!current) return s;
          const defaultSourceId = current.defaultSourceId;
          const moved = new Map((discarded?.moved ?? []).map((item) => [item.from.toLocaleLowerCase(), item.to]));
          const discardSource = discarded?.source;
          const remapFolder = (item: PersonalFolder) => !defaultSourceId || !discardSource || !item.sourceIds?.includes(defaultSourceId)
            ? item
            : {
              ...item,
              sourceIds: [...new Set(item.sourceIds.map((sourceId) => sourceId === defaultSourceId ? discardSource.id : sourceId))],
              ...(item.defaultSourceId === defaultSourceId ? { defaultSourceId: undefined, defaultSourcePath: undefined } : {}),
            };
          const discardedFolder = remapFolder(current);
          return {
            ...s,
            sources: discardSource
              ? [
                ...s.sources.filter((source) => source.id !== defaultSourceId && source.id !== discardSource.id),
                { id: discardSource.id, name: discardSource.name, path: discardSource.path },
              ]
              : s.sources,
            media: discardSource
              ? s.media.map((media) => {
                const target = moved.get(media.path.toLocaleLowerCase());
                return target ? { ...media, sourceId: discardSource.id, path: target, url: fileUrl(target), originalUrl: fileUrl(target) } : media;
              })
              : s.media,
            folders: s.folders.filter((item) => item.id !== id).map(remapFolder),
            trashFolders: [...s.trashFolders.map(remapFolder), discardedFolder],
            excludedFolderIds: s.excludedFolderIds.filter((item) => item !== id),
            galleryGroups: s.galleryGroups
              .map((group) => ({ ...group, folderIds: group.folderIds.filter((folderId) => folderId !== id) }))
              .filter((group) => group.folderIds.length > 1),
            galleryOrder: s.galleryOrder.filter((entry) => entry.kind !== "folder" || entry.id !== id),
          };
        });
      },

      addToFolder: (folderId, mediaIds) =>
        set((s) => {
          const folder = s.folders.find((f) => f.id === folderId);
          if (!folder) return s;
          const auto = folder.autoTags ?? {};
          return {
            ...s,
            folders: s.folders.map((f) =>
              f.id === folderId ? {
                ...f,
                mediaIds: Array.from(new Set([...mediaIds, ...f.mediaIds])),
                coverId: f.coverId ?? f.mediaIds[0] ?? mediaIds[0] ?? null,
                discardedMediaIds: (f.discardedMediaIds ?? []).filter((id) => !mediaIds.includes(id)),
              } : f,
            ),
            media: s.media.map((m) => {
              if (!mediaIds.includes(m.id)) return m;
              const props = { ...m.props };
              for (const [gid, vals] of Object.entries(auto)) {
                props[gid] = Array.from(new Set([...(props[gid] ?? []), ...vals]));
              }
              return { ...m, props };
            }),
          };
        }),
      removeFromFolder: (folderId, mediaId) =>
        set((s) => ({
          ...s,
          folders: s.folders.map((f) =>
            f.id === folderId ? (() => {
              const mediaIds = f.mediaIds.filter((i) => i !== mediaId);
              return { ...f, mediaIds, coverId: f.coverId === mediaId ? (mediaIds[0] ?? null) : f.coverId };
            })() : f,
          ),
        })),
      moveMediaInFolder: (folderId, mediaId, targetIndex) =>
        set((s) => ({
          ...s,
          folders: s.folders.map((folder) => {
            if (folder.id !== folderId) return folder;
            const current = folder.mediaIds.indexOf(mediaId);
            if (current < 0) return folder;
            const without = folder.mediaIds.filter((id) => id !== mediaId);
            const adjusted = current < targetIndex ? targetIndex - 1 : targetIndex;
            const index = Math.max(0, Math.min(adjusted, without.length));
            return { ...folder, mediaIds: [...without.slice(0, index), mediaId, ...without.slice(index)] };
          }),
        })),
      discardFromFolder: (folderId, mediaId) =>
        set((s) => ({
          ...s,
          folders: s.folders.map((folder) => folder.id !== folderId ? folder : {
            ...folder,
            mediaIds: folder.mediaIds.filter((id) => id !== mediaId),
            coverId: folder.coverId === mediaId ? (folder.mediaIds.find((id) => id !== mediaId) ?? null) : folder.coverId,
            discardedMediaIds: [...new Set([...(folder.discardedMediaIds ?? []), mediaId])],
          }),
        })),
      restoreFromFolderTrash: (folderId, mediaId) =>
        set((s) => ({
          ...s,
          folders: s.folders.map((folder) => folder.id !== folderId ? folder : {
            ...folder,
            mediaIds: [...new Set([...folder.mediaIds, mediaId])],
            discardedMediaIds: (folder.discardedMediaIds ?? []).filter((id) => id !== mediaId),
          }),
        })),
      createGalleryGroup: (folderIds, name) => {
        const ids = [...new Set(folderIds)];
        if (ids.length < 2) return null;
        const id = uid("gallery-group");
        set((s) => {
          const existing = [...s.galleryOrder];
          const lastSelected = Math.max(0, ...ids.map((folderId) => existing.findIndex((entry) => entry.kind === "folder" && entry.id === folderId)).filter((index) => index >= 0));
          const galleryOrder = existing.filter((entry) => entry.kind !== "folder" || !ids.includes(entry.id));
          const galleryGroups = s.galleryGroups.flatMap((group) => {
            const folderIds = group.folderIds.filter((folderId) => !ids.includes(folderId));
            if (folderIds.length > 1) return [{ ...group, folderIds }];
            const groupIndex = galleryOrder.findIndex((entry) => entry.kind === "group" && entry.id === group.id);
            if (folderIds.length === 1 && groupIndex >= 0) galleryOrder.splice(groupIndex, 1, { kind: "folder", id: folderIds[0] });
            else if (folderIds.length === 0 && groupIndex >= 0) galleryOrder.splice(groupIndex, 1);
            return [];
          });
          galleryOrder.splice(Math.min(lastSelected, galleryOrder.length), 0, { kind: "group", id });
          return {
            ...s,
            galleryGroups: [...galleryGroups, { id, name: name?.trim() || "Gallery group", folderIds: ids, collapsed: false }],
            galleryOrder,
          };
        });
        return id;
      },
      addGalleryToGroup: (groupId, folderId, targetIndex) =>
        set((s) => {
          if (!s.folders.some((folder) => folder.id === folderId) || !s.galleryGroups.some((group) => group.id === groupId)) return s;
          const galleryOrder = s.galleryOrder.filter((entry) => entry.kind !== "folder" || entry.id !== folderId);
          const galleryGroups = s.galleryGroups.flatMap((group) => {
            if (group.id === groupId) {
              const previousIndex = group.folderIds.indexOf(folderId);
              const folderIds = group.folderIds.filter((id) => id !== folderId);
              const requestedIndex = targetIndex ?? folderIds.length;
              const adjustedIndex = previousIndex >= 0 && previousIndex < requestedIndex
                ? requestedIndex - 1
                : requestedIndex;
              folderIds.splice(Math.max(0, Math.min(adjustedIndex, folderIds.length)), 0, folderId);
              return [{ ...group, folderIds }];
            }
            if (!group.folderIds.includes(folderId)) return [group];
            const folderIds = group.folderIds.filter((id) => id !== folderId);
            if (folderIds.length > 1) return [{ ...group, folderIds }];
            const groupIndex = galleryOrder.findIndex((entry) => entry.kind === "group" && entry.id === group.id);
            if (groupIndex >= 0) galleryOrder.splice(groupIndex, 1, { kind: "folder", id: folderIds[0] });
            return [];
          });
          return { ...s, galleryGroups, galleryOrder };
        }),
      removeGalleryFromGroup: (folderId) =>
        set((s) => {
          const source = s.galleryGroups.find((group) => group.folderIds.includes(folderId));
          if (!source) return s;
          const galleryOrder = [...s.galleryOrder];
          const groupIndex = galleryOrder.findIndex((entry) => entry.kind === "group" && entry.id === source.id);
          const folderIds = source.folderIds.filter((id) => id !== folderId);
          if (folderIds.length < 2) {
            const replacement = source.folderIds.map((id) => ({ kind: "folder" as const, id }));
            if (groupIndex >= 0) galleryOrder.splice(groupIndex, 1, ...replacement);
            else galleryOrder.push(...replacement);
            return { ...s, galleryGroups: s.galleryGroups.filter((group) => group.id !== source.id), galleryOrder };
          }
          if (!galleryOrder.some((entry) => entry.kind === "folder" && entry.id === folderId)) {
            galleryOrder.splice(groupIndex >= 0 ? groupIndex + 1 : galleryOrder.length, 0, { kind: "folder", id: folderId });
          }
          return {
            ...s,
            galleryGroups: s.galleryGroups.map((group) => group.id === source.id ? { ...group, folderIds } : group),
            galleryOrder,
          };
        }),
      updateGalleryGroup: (groupId, patch) =>
        set((s) => ({ ...s, galleryGroups: s.galleryGroups.map((group) => group.id === groupId ? { ...group, ...patch } : group) })),
      moveGalleryEntry: (entry, targetIndex) =>
        set((s) => {
          const previousIndex = s.galleryOrder.findIndex((item) => item.kind === entry.kind && item.id === entry.id);
          const galleryOrder = s.galleryOrder.filter((item) => !(item.kind === entry.kind && item.id === entry.id));
          const adjustedIndex = previousIndex >= 0 && previousIndex < targetIndex ? targetIndex - 1 : targetIndex;
          galleryOrder.splice(Math.max(0, Math.min(adjustedIndex, galleryOrder.length)), 0, entry);
          return { ...s, galleryOrder };
        }),
      moveGalleryInGroup: (groupId, folderId, targetIndex) =>
        set((s) => ({
          ...s,
          galleryGroups: s.galleryGroups.map((group) => {
            if (group.id !== groupId || !group.folderIds.includes(folderId)) return group;
            const previousIndex = group.folderIds.indexOf(folderId);
            const folderIds = group.folderIds.filter((id) => id !== folderId);
            const adjustedIndex = previousIndex < targetIndex ? targetIndex - 1 : targetIndex;
            folderIds.splice(Math.max(0, Math.min(adjustedIndex, folderIds.length)), 0, folderId);
            return { ...group, folderIds };
          }),
        })),
      setExtensionGallerySlots: (ids) =>
        set((s) => {
          const allowed = new Set(s.folders.map((folder) => folder.id));
          const seen = new Set<string>();
          const extensionGallerySlotIds = Array.from({ length: 4 }, (_, index) => {
            const id = ids[index];
            if (!id || !allowed.has(id) || seen.has(id)) return null;
            seen.add(id);
            return id;
          });
          return { ...s, extensionGallerySlotIds };
        }),
      addSource: (name, path) =>
        set((s) => ({ ...s, sources: [...s.sources, { id: uid("src"), name, path }] })),
      // Removing a source is an ownership removal, not merely hiding it from
      // the source list. Media with no remaining source must disappear
      // immediately from every Gallery and from Main Gallery.
      removeSource: (id) => set((s) => {
        const removed = new Set(s.media.filter((media) => media.sourceId === id).map((media) => media.id));
        const folders = s.folders.map((folder) => {
          const mediaIds = folder.mediaIds.filter((mediaId) => !removed.has(mediaId));
          return {
            ...folder,
            sourceIds: (folder.sourceIds ?? []).filter((sourceId) => sourceId !== id),
            mediaIds,
            discardedMediaIds: (folder.discardedMediaIds ?? []).filter((mediaId) => !removed.has(mediaId)),
            coverId: removed.has(String(folder.coverId)) ? (mediaIds[0] ?? null) : folder.coverId,
          };
        });
        return {
          ...s,
          sources: s.sources.filter((source) => source.id !== id),
          mainSourceIds: s.mainSourceIds.filter((sourceId) => sourceId !== id),
          media: s.media.filter((media) => !removed.has(media.id)),
          folders,
          groups: s.groups.map((group) => ({ ...group, memberIds: group.memberIds.filter((mediaId) => !removed.has(mediaId)) })).filter((group) => group.memberIds.length > 0),
          order: s.order.filter((entry) => !(entry.kind === "media" && removed.has(entry.id))),
        };
      }),
      attachSourceFolder: async (folderId, path) => {
        const normalize = (value: string) => String(value ?? "").replace(/[\\\\/]+$/, "").toLocaleLowerCase();
        const sourceName = String(path ?? "").replace(/[\\\\/]+$/, "").split(/[\\\\/]/).pop() || "Untitled source";
        const existing = state.sources.find((source) => normalize(source.path) === normalize(path));
        if (existing) {
          if (state.folders.find((folder) => folder.id === folderId)?.sourceIds?.includes(existing.id)) return "exists";
          set((s) => {
            const folder = s.folders.find((item) => item.id === folderId);
            if (!folder) return s;
            const incoming = s.media.filter((media) => media.sourceId === existing.id).map((media) => media.id);
            const knownOrder = new Set(s.order.filter((entry) => entry.kind === "media").map((entry) => entry.id));
            return {
              ...s,
              // This source may have been scanned before it was attached to
              // this Gallery. Keep its already-known media visible now rather
              // than waiting for a restart to rebuild the global order.
              order: [...s.order, ...incoming.filter((id) => !knownOrder.has(id)).map((id) => ({ kind: "media" as const, id }))],
              folders: s.folders.map((item) => item.id !== folderId ? item : {
                ...item,
                sourceIds: [...new Set([...(item.sourceIds ?? []), existing.id])],
                mediaIds: [...new Set([...incoming, ...item.mediaIds])],
                coverId: item.coverId ?? item.mediaIds[0] ?? incoming[0] ?? null,
                discardedMediaIds: (item.discardedMediaIds ?? []).filter((id) => !incoming.includes(id)),
              }),
            };
          });
          return "added";
        }

        const bridge = getInDeckBridge();
        if (!bridge) return "unavailable";
        const sourceId = uid("src");
        let result: any;
        try {
          result = await bridge.scanFolder({ id: sourceId, name: sourceName, path });
        } catch {
          return "unavailable";
        }
        const scanned = Array.isArray(result?.assets) ? result.assets : [];
        const actualPath = String(result?.folder ?? path);
        const actualName = String(actualPath).replace(/[\\\\/]+$/, "").split(/[\\\\/]/).pop() || sourceName;
        set((s) => {
          const target = s.folders.find((folder) => folder.id === folderId);
          if (!target) return s;
          // A concurrent action may have attached this folder while scan was in
          // flight. Reuse that source instead of creating a duplicate.
          const concurrent = s.sources.find((source) => normalize(source.path) === normalize(actualPath));
          const id = concurrent?.id ?? sourceId;
          const source = concurrent ?? { id, name: actualName, path: actualPath };
          const propertyIds = s.propertyGroups.map((group) => group.id);
          const incoming = scanned.map((asset: Record<string, any>): MediaItem => ({
            id: String(asset.id),
            name: String(asset.name ?? "Untitled media"),
            path: String(asset.path ?? ""),
            sourceId: id,
            type: asset.type === "video" ? "video" : "image",
            url: "",
            originalUrl: asset.contentUrl ? String(asset.contentUrl) : fileUrl(String(asset.path ?? "")),
            modified: Number(asset.modified ?? 0),
            vault: Boolean(asset.vault),
            contentUrl: asset.contentUrl ? String(asset.contentUrl) : undefined,
            width: Number(asset.width ?? 4),
            height: Number(asset.height ?? 3),
            favorite: false,
            hidden: false,
            notes: "",
            props: Object.fromEntries(propertyIds.map((propertyId) => [propertyId, []])),
            createdAt: Number(asset.modified ?? Date.now()),
          }));
          const known = new Set(s.media.map((media) => media.id));
          const media = [...s.media, ...incoming.filter((media) => !known.has(media.id))];
          const incomingIds = media.filter((item) => item.sourceId === id).map((item) => item.id);
          const knownOrder = new Set(s.order.filter((entry) => entry.kind === "media").map((entry) => entry.id));
          return {
            ...s,
            sources: concurrent ? s.sources : [...s.sources, source],
            // Gallery renders from `order`, not directly from `media`.
            // Include freshly scanned files immediately so reopening the app
            // is never required to see a new Media Source.
            order: [...s.order, ...incomingIds.filter((id) => !knownOrder.has(id)).map((id) => ({ kind: "media" as const, id }))],
            media: media.map((media) => {
              if (!incomingIds.includes(media.id)) return media;
              const props = { ...media.props };
              for (const [groupId, values] of Object.entries(target.autoTags ?? {})) {
                props[groupId] = [...new Set([...(props[groupId] ?? []), ...values])];
              }
              return { ...media, props };
            }),
            folders: s.folders.map((folder) => folder.id !== folderId ? folder : {
              ...folder,
              sourceIds: [...new Set([...(folder.sourceIds ?? []), id])],
              mediaIds: [...new Set([...incomingIds, ...folder.mediaIds])],
              coverId: folder.coverId ?? folder.mediaIds[0] ?? incomingIds[0] ?? null,
              discardedMediaIds: (folder.discardedMediaIds ?? []).filter((mediaId) => !incomingIds.includes(mediaId)),
            }),
          };
        });
        return "added";
      },
      detachSourceFromFolder: (folderId, sourceId) =>
        set((s) => {
          const removed = new Set(s.media.filter((media) => media.sourceId === sourceId).map((media) => media.id));
          const folders = s.folders.map((folder) => {
            if (folder.id !== folderId) return folder;
            const mediaIds = folder.mediaIds.filter((id) => !removed.has(id));
            return {
              ...folder,
              sourceIds: (folder.sourceIds ?? []).filter((id) => id !== sourceId),
              mediaIds,
              discardedMediaIds: (folder.discardedMediaIds ?? []).filter((id) => !removed.has(id)),
              coverId: folder.coverId && removed.has(folder.coverId) ? (mediaIds[0] ?? null) : folder.coverId,
            };
          });
          const stillManaged = s.mainSourceIds.includes(sourceId) || folders.some((folder) => (folder.sourceIds ?? []).includes(sourceId));
          return {
            ...s,
            sources: stillManaged ? s.sources : s.sources.filter((source) => source.id !== sourceId),
            media: stillManaged ? s.media : s.media.filter((media) => !removed.has(media.id)),
            folders,
            groups: stillManaged ? s.groups : s.groups.map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => !removed.has(id)) })).filter((group) => group.memberIds.length > 0),
            order: stillManaged ? s.order : s.order.filter((entry) => !(entry.kind === "media" && removed.has(entry.id))),
          };
        }),
      attachMainSource: async (path) => {
        const normalize = (value: string) => String(value ?? "").replace(/[\\\\/]+$/, "").toLocaleLowerCase();
        const sourceName = String(path ?? "").replace(/[\\\\/]+$/, "").split(/[\\\\/]/).pop() || "Untitled source";
        const existing = state.sources.find((source) => normalize(source.path) === normalize(path));
        if (existing) {
          if (state.mainSourceIds.includes(existing.id)) return "exists";
          set((s) => ({ ...s, mainSourceIds: [...new Set([...s.mainSourceIds, existing.id])] }));
          return "added";
        }
        const bridge = getInDeckBridge();
        if (!bridge) return "unavailable";
        const sourceId = uid("src");
        let result: any;
        try {
          result = await bridge.scanFolder({ id: sourceId, name: sourceName, path });
        } catch {
          return "unavailable";
        }
        const scanned = Array.isArray(result?.assets) ? result.assets : [];
        const actualPath = String(result?.folder ?? path);
        const actualName = String(actualPath).replace(/[\\\\/]+$/, "").split(/[\\\\/]/).pop() || sourceName;
        set((s) => {
          const concurrent = s.sources.find((source) => normalize(source.path) === normalize(actualPath));
          const id = concurrent?.id ?? sourceId;
          const source = concurrent ?? { id, name: actualName, path: actualPath };
          const propertyIds = s.propertyGroups.map((group) => group.id);
          const incoming = scanned.map((asset: Record<string, any>): MediaItem => ({
            id: String(asset.id), name: String(asset.name ?? "Untitled media"), path: String(asset.path ?? ""), sourceId: id,
            type: asset.type === "video" ? "video" : "image", url: "",
            originalUrl: asset.contentUrl ? String(asset.contentUrl) : fileUrl(String(asset.path ?? "")),
            modified: Number(asset.modified ?? 0), vault: Boolean(asset.vault), contentUrl: asset.contentUrl ? String(asset.contentUrl) : undefined,
            width: Number(asset.width ?? 4), height: Number(asset.height ?? 3), favorite: false, hidden: false, notes: "",
            props: Object.fromEntries(propertyIds.map((propertyId) => [propertyId, []])), createdAt: Number(asset.modified ?? Date.now()),
          }));
          const known = new Set(s.media.map((media) => media.id));
          const knownPaths = new Set(s.media.map((media) => normalize(media.path)));
          const accepted = incoming.filter((media) => !known.has(media.id) && !knownPaths.has(normalize(media.path)));
          const knownOrder = new Set(s.order.filter((entry) => entry.kind === "media").map((entry) => entry.id));
          return {
            ...s,
            sources: concurrent ? s.sources : [...s.sources, source],
            media: [...s.media, ...accepted],
            // Main Gallery has the same render contract as a Gallery source:
            // scanned media must be represented in the order immediately.
            order: [...s.order, ...accepted.filter((media) => !knownOrder.has(media.id)).map((media) => ({ kind: "media" as const, id: media.id }))],
            mainSourceIds: [...new Set([...s.mainSourceIds, id])],
          };
        });
        return "added";
      },
      detachMainSource: (sourceId) => set((s) => {
        const mainSourceIds = s.mainSourceIds.filter((id) => id !== sourceId);
        const stillManaged = s.folders.some((folder) => (folder.sourceIds ?? []).includes(sourceId));
        const removed = new Set(s.media.filter((media) => media.sourceId === sourceId).map((media) => media.id));
        return {
          ...s,
          mainSourceIds,
          sources: stillManaged ? s.sources : s.sources.filter((source) => source.id !== sourceId),
          media: stillManaged ? s.media : s.media.filter((media) => !removed.has(media.id)),
          folders: stillManaged ? s.folders : s.folders.map((folder) => ({ ...folder, mediaIds: folder.mediaIds.filter((id) => !removed.has(id)), discardedMediaIds: (folder.discardedMediaIds ?? []).filter((id) => !removed.has(id)), coverId: removed.has(String(folder.coverId)) ? (folder.mediaIds.find((id) => !removed.has(id)) ?? null) : folder.coverId })),
          groups: stillManaged ? s.groups : s.groups.map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => !removed.has(id)) })).filter((group) => group.memberIds.length > 0),
          order: stillManaged ? s.order : s.order.filter((entry) => !(entry.kind === "media" && removed.has(entry.id))),
        };
      }),
      createGroup: (memberIds) =>
        set((s) => {
          if (memberIds.length === 0) return s;
          const id = uid("g");
          const lastSelectedId = memberIds.at(-1)!;
          const lastSelectedIdx = s.order.findIndex(
            (e) =>
              (e.kind === "media" && e.id === lastSelectedId) ||
              (e.kind === "group" && s.groups.find((g) => g.id === e.id)?.memberIds.includes(lastSelectedId)),
          );
          const groups = s.groups
            .map((g) => ({ ...g, memberIds: g.memberIds.filter((m) => !memberIds.includes(m)) }))
            .filter((g) => g.memberIds.length > 0);
          let order = s.order.filter(
            (e) =>
              !(e.kind === "media" && memberIds.includes(e.id)) &&
              !(e.kind === "group" && !groups.some((g) => g.id === e.id)),
          );
          // Keep a newly created group where the user finished selecting,
          // rather than letting it drift to the first selected item/end.
          const insertAt = lastSelectedIdx < 0
            ? order.length
            : s.order.slice(0, lastSelectedIdx).filter((entry) => order.some((kept) => kept.kind === entry.kind && kept.id === entry.id)).length;
          order = [...order.slice(0, insertAt), { kind: "group" as const, id }, ...order.slice(insertAt)];
          return {
            ...s,
            groups: [...groups, { id, memberIds, collapsed: false, coverId: null }],
            order,
          };
        }),
      addToGroup: (groupId, mediaId) =>
        set((s) => ({
          ...s,
          groups: s.groups
            .map((g) =>
              g.id === groupId
                ? { ...g, memberIds: Array.from(new Set([...g.memberIds, mediaId])) }
                : { ...g, memberIds: g.memberIds.filter((m) => m !== mediaId) },
            )
            .filter((g) => g.memberIds.length > 0),
          order: s.order.filter((e) => !(e.kind === "media" && e.id === mediaId)),
        })),
      moveGroupMember: (groupId, mediaId, targetIndex) =>
        set((s) => {
          const group = s.groups.find((item) => item.id === groupId);
          if (!group) return s;
          const current = group.memberIds.indexOf(mediaId);
          if (current < 0) return s;
          const without = group.memberIds.filter((id) => id !== mediaId);
          const adjusted = current < targetIndex ? targetIndex - 1 : targetIndex;
          const index = Math.max(0, Math.min(adjusted, without.length));
          const memberIds = [...without.slice(0, index), mediaId, ...without.slice(index)];
          return { ...s, groups: s.groups.map((item) => item.id === groupId ? { ...item, memberIds } : item) };
        }),
      insertIntoGroup: (groupId, mediaId, targetIndex) =>
        set((s) => {
          const target = s.groups.find((group) => group.id === groupId);
          if (!target) return s;
          const current = target.memberIds.indexOf(mediaId);
          const without = target.memberIds.filter((id) => id !== mediaId);
          const adjusted = current >= 0 && current < targetIndex ? targetIndex - 1 : targetIndex;
          const index = Math.max(0, Math.min(adjusted, without.length));
          const memberIds = [...without.slice(0, index), mediaId, ...without.slice(index)];
          return {
            ...s,
            groups: s.groups.map((group) => {
              if (group.id === groupId) return { ...group, memberIds };
              return group.memberIds.includes(mediaId) ? { ...group, memberIds: group.memberIds.filter((id) => id !== mediaId) } : group;
            }),
            order: s.order.filter((entry) => !(entry.kind === "media" && entry.id === mediaId)),
          };
        }),
      removeFromGroup: (mediaId) =>
        set((s) => {
          const group = s.groups.find((g) => g.memberIds.includes(mediaId));
          if (!group) return s;
          const groups = s.groups
            .map((g) => (g.id === group.id ? { ...g, memberIds: g.memberIds.filter((m) => m !== mediaId) } : g))
            .filter((g) => g.memberIds.length > 0);
          const gi = s.order.findIndex((e) => e.kind === "group" && e.id === group.id);
          let order = [...s.order];
          if (!groups.some((g) => g.id === group.id)) {
            order = order.filter((e) => !(e.kind === "group" && e.id === group.id));
            order.splice(gi < 0 ? order.length : gi, 0, { kind: "media", id: mediaId });
          } else {
            order.splice(gi + 1, 0, { kind: "media", id: mediaId });
          }
          return { ...s, groups, order };
        }),
      dissolveGroup: (groupId) =>
        set((s) => {
          const group = s.groups.find((g) => g.id === groupId);
          if (!group) return s;
          const gi = s.order.findIndex((e) => e.kind === "group" && e.id === groupId);
          const order = s.order.filter((e) => !(e.kind === "group" && e.id === groupId));
          order.splice(
            gi < 0 ? order.length : gi,
            0,
            ...group.memberIds.map((id) => ({ kind: "media" as const, id })),
          );
          return { ...s, groups: s.groups.filter((g) => g.id !== groupId), order };
        }),
      updateGroup: (groupId, patch) =>
        set((s) => ({ ...s, groups: s.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)) })),
      setOrder: (order) => set((s) => ({ ...s, order })),
      moveEntry: (entry, targetIndex) =>
        set((s) => {
          const current = s.order.findIndex((e) => e.kind === entry.kind && e.id === entry.id);
          if (current < 0) {
            // Media living inside a group: dragging it out extracts it first.
            const group = entry.kind === "media" && s.groups.find((g) => g.memberIds.includes(entry.id));
            if (!group) return s;
            const groups = s.groups
              .map((g) => (g.id === group.id ? { ...g, memberIds: g.memberIds.filter((m) => m !== entry.id) } : g))
              .filter((g) => g.memberIds.length > 1);
            let order = [...s.order];
            if (!groups.some((g) => g.id === group.id)) {
              const gi = order.findIndex((e) => e.kind === "group" && e.id === group.id);
              const leftovers = group.memberIds
                .filter((m) => m !== entry.id)
                .map((id) => ({ kind: "media" as const, id }));
              order = order.filter((e) => !(e.kind === "group" && e.id === group.id));
              order.splice(gi < 0 ? order.length : gi, 0, ...leftovers);
            }
            const clamped = Math.max(0, Math.min(targetIndex, order.length));
            return { ...s, groups, order: [...order.slice(0, clamped), entry, ...order.slice(clamped)] };
          }
          const without = entriesWithout(s.order, entry);
          const adjusted = current < targetIndex ? targetIndex - 1 : targetIndex;
          const clamped = Math.max(0, Math.min(adjusted, without.length));
          return { ...s, order: [...without.slice(0, clamped), entry, ...without.slice(clamped)] };
        }),

      resetOrder: () =>
        set((s) => {
          const grouped = new Set(s.groups.flatMap((g) => g.memberIds));
          const sorted = [...s.media].sort((a, b) => b.createdAt - a.createdAt);
          const order: OrderEntry[] = [];
          const seenGroups = new Set<string>();
          for (const m of sorted) {
            const g = s.groups.find((gr) => gr.memberIds.includes(m.id));
            if (g) {
              if (!seenGroups.has(g.id)) {
                seenGroups.add(g.id);
                order.push({ kind: "group", id: g.id });
              }
              continue;
            }
            if (!grouped.has(m.id)) order.push({ kind: "media", id: m.id });
          }
          return { ...s, order };
        }),
      setLanguage: (language) => set((s) => ({ ...s, language })),
      setAppearance: (appearance) => set((s) => ({ ...s, appearance })),
      setThemeColor: (themeColor) => set((s) => ({ ...s, themeColor })),
      setThumbHeight: (thumbHeight) => set((s) => ({ ...s, thumbHeight })),
      setPassword: (password) => set((s) => ({ ...s, password })),
      setAppLockEnabled: (appLockEnabled) => set((s) => ({ ...s, appLockEnabled: Boolean(s.password && appLockEnabled) })),
      setRequirePasswordToUnlockGallery: (requirePasswordToUnlockGallery) => set((s) => ({ ...s, requirePasswordToUnlockGallery })),
      setInspectorAutoOpen: (inspectorAutoOpen) => set((s) => ({ ...s, inspectorAutoOpen })),
      setLightboxFitMedia: (lightboxFitMedia) => set((s) => ({ ...s, lightboxFitMedia })),
    };
  }, [state, set, setMediaDimensions, setMediaPreview]);

  // appearance
  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => {
      const mode =
        state.appearance === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : state.appearance;
      document.documentElement.classList.toggle("dark", mode === "dark");
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [state.appearance]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (state.themeColor === "green") delete document.documentElement.dataset.themeColor;
    else document.documentElement.dataset.themeColor = state.themeColor;
  }, [state.themeColor]);

  const t = useMemo(() => makeTranslate(state.language), [state.language]);

  return (
    <StoreContext.Provider value={api}>
      <I18nContext.Provider value={t}>{children}</I18nContext.Provider>
    </StoreContext.Provider>
  );
}

export function useAllsight() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useAllsight must be used inside AllsightProvider");
  return ctx;
}
