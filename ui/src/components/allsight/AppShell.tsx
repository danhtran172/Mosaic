import { useMemo, useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { Lock, SearchX } from "lucide-react";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import type { FilterKind, MediaItem, OrderEntry, PersonalFolder } from "@/lib/allsight/types";
import { Sidebar, type View } from "./Sidebar";
import { LicensePaywall, useLicense } from "./License";
import { BulkBar, DEFAULT_COLOR_TOLERANCE, Header, WindowControls, type ColorFilter } from "./Chrome";
import { EMPTY_DESIGN_FILTER, designFilterCount, mediaMatchesDesignFilter, type DesignFilter } from "@/lib/allsight/designer-tools";
import { analyzeColors, mediaMatchesColor, subscribeThumbnailStore, thumbnailStoreVersion } from "@/lib/allsight/thumbnail-resource-manager";
import { Gallery } from "./Gallery";
import { Inspector, type InspectorTarget } from "./Inspector";
import { Lightbox } from "./Lightbox";
import { FolderGallery } from "./FolderGallery";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { TagManager } from "./TagManager";
import { TrashPage } from "./TrashPage";
import { ExtensionManage } from "./ExtensionManage";
import { LibraryLocationSetup } from "./ProfileManager";
import { getInDeckBridge, type InDeckProfile, type UpdateStatus } from "@/lib/indeck/bridge";
import { mediaGroupById, type MediaGroupBy } from "@/lib/allsight/grouping";

const OTHER_MEDIA_SOURCE_ID = "__indeck-other-media__";
const DEFAULT_MEDIA_SOURCE_ID = "allsight-web-imports";
const DISCARDS_MEDIA_SOURCE_ID = "indeck-discards";

type LibraryState = ReturnType<typeof useAllsight>["state"];

/**
 * Lookups the visibility rules need for every media, built once per Library
 * change. The rules used to scan every Gallery's member list, every source and
 * every trashed Gallery for each media in turn — quadratic in the size of the
 * Library, and re-run on every edit — which is what made large Libraries slow
 * to open and sluggish to work in.
 */
function libraryIndex(state: LibraryState) {
  const sourceById = new Map(state.sources.map((source) => [source.id, source]));
  const providersByMedia = new Map<string, typeof state.folders>();
  for (const folder of state.folders) {
    for (const id of folder.mediaIds) {
      const list = providersByMedia.get(id);
      if (list) list.push(folder);
      else providersByMedia.set(id, [folder]);
    }
  }
  const trashedMediaIds = new Set(state.trashFolders.flatMap((folder) => folder.mediaIds));
  const managedSourceIds = new Set([
    ...state.folders.flatMap((folder) => folder.sourceIds ?? []),
    ...state.mainSourceIds,
  ]);
  const mainSourceIds = new Set(state.mainSourceIds);
  return { sourceById, providersByMedia, trashedMediaIds, managedSourceIds, mainSourceIds };
}
type LibraryIndex = ReturnType<typeof libraryIndex>;
const NO_PROVIDERS: LibraryState["folders"] = [];
const NO_MEDIA_IDS = new Set<string>();

/**
 * The order entries a view renders and the media they expand to, in display
 * order. This is the Gallery's own rule, so it is also the only honest count.
 */
function shownMedia(visible: MediaItem[], order: OrderEntry[], groupById: Map<string, LibraryState["groups"][number]>) {
  const visibleById = new Map(visible.map((media) => [media.id, media]));
  const entries = order.filter((e) => {
    if (e.kind === "media") return visibleById.has(e.id);
    const g = groupById.get(e.id);
    return !!g && g.memberIds.some((id) => visibleById.has(id));
  });
  const flatMedia: MediaItem[] = [];
  // The same media can be listed by more than one order entry after an
  // interrupted edit. Count and show it once.
  const seen = new Set<string>();
  const push = (id: string) => {
    const m = visibleById.get(id);
    if (!m || seen.has(id)) return;
    seen.add(id);
    flatMedia.push(m);
  };
  for (const e of entries) {
    if (e.kind === "media") push(e.id);
    else groupById.get(e.id)?.memberIds.forEach(push);
  }
  return { entries, flatMedia };
}

function isDefaultMedia(media: MediaItem, index: LibraryIndex) {
  const source = index.sourceById.get(media.sourceId);
  return media.sourceId === DEFAULT_MEDIA_SOURCE_ID || /^default\s*save$/i.test(source?.name ?? "");
}

function isDiscardedMedia(media: MediaItem) {
  return media.sourceId === DISCARDS_MEDIA_SOURCE_ID;
}

function isOtherMedia(media: MediaItem, index: LibraryIndex) {
  const source = index.sourceById.get(media.sourceId);
  if (isDefaultMedia(media, index) || isDiscardedMedia(media)) return false;
  // A deleted Gallery remains recoverable in Trash. Its media/source records
  // must not fall back into Main Gallery while that Gallery is in Trash.
  if (index.trashedMediaIds.has(media.id)) return false;
  // A source only becomes a normal provider after a Gallery explicitly adopts
  // it as a Media Source. Files imported manually from another folder/source
  // therefore remain in the virtual “Khác” provider.
  const sourceIsManaged = (!!source && index.managedSourceIds.has(media.sourceId)) || index.mainSourceIds.has(media.sourceId);
  if (!sourceIsManaged) return true;
  // A media manually added to a Gallery from a different source belongs to
  // that Gallery and “Khác” at the same time.
  return false;
}

export function AppShell() {
  const t = useT();
  const { state, hideMedia, discardFromFolder, createGroup, setFavorite } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [propFilters, setPropFilters] = useState<Record<string, string[]>>({});
  const [galleryFilterIds, setGalleryFilterIds] = useState<string[]>([]);
  const [sourceFilterIds, setSourceFilterIds] = useState<string[]>([]);
  const [invertAdvancedFilters, setInvertAdvancedFilters] = useState(false);
  const [colorFilter, setColorFilter] = useState<ColorFilter | null>(null);
  const [designFilter, setDesignFilter] = useState<DesignFilter>(EMPTY_DESIGN_FILTER);
  const designFilterOn = designFilterCount(designFilter) > 0;
  const [colorAnalysis, setColorAnalysis] = useState<{ done: number; total: number } | null>(null);
  // Palettes arrive while the filter is on (background analysis, cards as
  // they load). Re-filter on them only then, not on every thumbnail event.
  const thumbnailVersion = useSyncExternalStore(subscribeThumbnailStore, thumbnailStoreVersion);
  const paletteVersion = colorFilter ? thumbnailVersion : 0;
  const colorFilterOn = colorFilter !== null;
  const mediaRef = useRef(state.media);
  mediaRef.current = state.media;
  useEffect(() => {
    if (!colorFilterOn) { setColorAnalysis(null); return; }
    return analyzeColors(mediaRef.current, (done, total) => setColorAnalysis({ done, total }));
  }, [colorFilterOn, state.media.length]);
  const [groupBy, setGroupBy] = useState<MediaGroupBy[]>([]);

  const [selected, setSelected] = useState<string[]>([]);
  // Start with the library unobstructed. Inspector remains available from the
  // header and can still auto-open after the user makes a new selection.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [locked, setLocked] = useState(false);
  // Trial and purchase state from main.js. Once the trial is over, the
  // paywall stands in for the whole app until a key is activated.
  const [license, setLicense] = useLicense();
  const [pwdTry, setPwdTry] = useState("");
  const [pwdError, setPwdError] = useState(false);
  const [unlockedFolders, setUnlockedFolders] = useState<string[]>([]);
  const [folderPwd, setFolderPwd] = useState("");
  const [folderPwdError, setFolderPwdError] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [extensionManageOpen, setExtensionManageOpen] = useState(false);
  const [currentProfile, setCurrentProfile] = useState<InDeckProfile | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  const previousFolderLocks = useRef(new Map<string, boolean>());
  const startupLockApplied = useRef(false);

  useEffect(() => {
    const bridge = getInDeckBridge();
    if (!bridge) return;
    const unsubscribe = bridge.onUpdateStatus(setUpdateStatus);
    void bridge.checkForUpdates().catch(() => setUpdateStatus({ state: "error" }));
    return unsubscribe;
  }, []);

  const refreshCurrentProfile = useCallback(async () => {
    const bridge = getInDeckBridge();
    if (!bridge) return;
    try { setCurrentProfile(await bridge.currentProfile()); } catch { /* The browser preview has no desktop profile. */ }
  }, []);

  useEffect(() => { void refreshCurrentProfile(); }, [refreshCurrentProfile]);

  const folder = view.kind === "folder" ? state.folders.find((f) => f.id === view.id) ?? null : null;
  const folderLocked = !!folder?.locked && !unlockedFolders.includes(folder.id);
  const requiresFolderPassword = Boolean(state.password && state.requirePasswordToUnlockGallery);

  // App locking is persistent, unlike Gallery unlock grants. Once the
  // profile state arrives from disk, every new app session starts locked.
  useEffect(() => {
    if (startupLockApplied.current || !state.password) return;
    startupLockApplied.current = true;
    if (state.appLockEnabled) setLocked(true);
  }, [state.appLockEnabled, state.password]);

  // Gallery source only exists for Main Gallery. Do not keep a hidden grouping
  // active after navigating into an individual Gallery.
  useEffect(() => {
    if (view.kind === "all") return;
    setGroupBy((current) => current.filter((item) => item.kind !== "gallery-source"));
  }, [view.kind]);

  // Unlocking is a session-only state.  A Gallery that is locked again must
  // immediately lose its old session grant; otherwise it can be opened
  // straight away after locking it a second time.
  useEffect(() => {
    const currentLocks = new Map(state.folders.map((item) => [item.id, Boolean(item.locked)]));
    setUnlockedFolders((previous) => previous.filter((id) => {
      const wasLocked = previousFolderLocks.current.get(id);
      return currentLocks.has(id) && !(currentLocks.get(id) && wasLocked === false);
    }));
    previousFolderLocks.current = currentLocks;
  }, [state.folders]);

  // Turning this requirement on takes effect immediately, including for a
  // Gallery that was unlocked earlier in this app session.
  useEffect(() => {
    if (state.requirePasswordToUnlockGallery) setUnlockedFolders([]);
  }, [state.requirePasswordToUnlockGallery]);

  const matchesPassword = useCallback(async (value: string) => {
    if (!state.password) return true;
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return hash === state.password;
  }, [state.password]);

  const unlockCurrentFolder = useCallback(() => {
    if (!folder) return;
    void (requiresFolderPassword ? matchesPassword(folderPwd) : Promise.resolve(true)).then((matched) => {
      if (!matched) { setFolderPwdError(true); return; }
      setUnlockedFolders((previous) => [...new Set([...previous, folder.id])]);
      setFolderPwd("");
      setFolderPwdError(false);
    });
  }, [folder, folderPwd, matchesPassword, requiresFolderPassword]);

  // Space is a convenient direct unlock only when this Gallery deliberately
  // has no password requirement. It must never bypass the password flow.
  useEffect(() => {
    if (!folderLocked || requiresFolderPassword) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      unlockCurrentFolder();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [folderLocked, requiresFolderPassword, unlockCurrentFolder]);

  // Tab toggles the Inspector. Text fields and dialogs keep Tab for their own
  // focus traversal, so the shortcut only applies while the Library has focus.
  useEffect(() => {
    if (locked || lightboxId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true], [role=dialog], [role=menu]")) return;
      event.preventDefault();
      setInspectorOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locked, lightboxId]);

  const index = useMemo(() => libraryIndex(state), [state.folders, state.mainSourceIds, state.sources, state.trashFolders]);
  const folderMediaIds = useMemo(() => new Set(folder?.mediaIds ?? []), [folder]);
  const unlockedFolderSet = useMemo(() => new Set(unlockedFolders), [unlockedFolders]);
  const excludedFolderSet = useMemo(() => new Set(state.excludedFolderIds), [state.excludedFolderIds]);

  // The rules are built for a scope rather than for the current view alone,
  // so the Sidebar can count what Main Gallery shows while a Gallery is open.
  const passesFor = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Typing a Group's name surfaces the media inside it, so that name counts
    // as searchable text on every member.
    const groupNameByMedia = new Map<string, string>();
    if (q) {
      for (const group of state.groups) {
        const name = group.name.trim();
        if (!name) continue;
        for (const memberId of group.memberIds) groupNameByMedia.set(memberId, name);
      }
    }
    return (folder: PersonalFolder | null, folderMediaIds: Set<string>) => (m: MediaItem) => {
      if (m.hidden) return false;
      const providers = index.providersByMedia.get(m.id) ?? NO_PROVIDERS;
      // Deleting a Gallery moves files from its managed Default Source to
      // Discards. They remain recoverable in Trash, never as “Khác” in Main.
      if (!folder && isDiscardedMedia(m)) return false;
      if (!folder && index.trashedMediaIds.has(m.id)
        && providers.length === 0
        && !index.mainSourceIds.has(m.sourceId)) return false;
      if (folder && !folderMediaIds.has(m.id)) return false;
      const other = isOtherMedia(m, index);
      const defaultMedia = isDefaultMedia(m, index);
      const mainMediaSource = index.mainSourceIds.has(m.sourceId);
      if (!folder && (providers.length || other || defaultMedia)) {
        const visibleFolderProvider = providers.some((f) =>
          (!f.locked || unlockedFolderSet.has(f.id)) && !excludedFolderSet.has(f.id),
        );
        // A direct Main Gallery Media Source normally remains a valid owner
        // even when its Gallery is hidden. The Inspector toggle deliberately
        // makes Gallery Sources take precedence over that direct ownership.
        const hasUnlockedFolderProvider = providers.length === 0 || providers.some((f) => !f.locked || unlockedFolderSet.has(f.id));
        const mediaSourceKeepsVisible = mainMediaSource
          && !state.ignoreMediaSourcesWhenExcluded
          && hasUnlockedFolderProvider;
        // Moving media into a Gallery makes that Gallery its owner, so hiding
        // the Gallery has to hide the media — even when the file also sits in
        // a Main Media Source or a Gallery Default Source. Those source rules
        // describe media no Gallery has claimed; letting them override an
        // explicit exclusion is what kept moved media on show in Main.
        const everyProviderExcluded = providers.length > 0 && !visibleFolderProvider;
        if (everyProviderExcluded) return false;
        if (!visibleFolderProvider
          && !mediaSourceKeepsVisible
          && !(other && !state.excludeOtherMedia)
          && !(defaultMedia && !state.excludeDefaultMedia)) return false;
      }
      if (filter === "favorites" && !m.favorite) return false;
      if (filter === "images" && m.type !== "image") return false;
      if (filter === "videos" && m.type !== "video") return false;
       const hasAdvancedFilters = Object.values(propFilters).some((values) => values.length) || galleryFilterIds.length > 0 || sourceFilterIds.length > 0 || colorFilter !== null || designFilterOn;
       let matchesAdvanced = true;
       for (const [gid, vals] of Object.entries(propFilters)) {
         if (!vals.length) continue;
         if (folder?.managedGroupIds?.length && !folder.managedGroupIds.includes(gid)) continue;
         if (folder?.disabledGeneralGroupIds?.includes(gid) || folder?.disabledGalleryGroupIds?.includes(gid)) continue;
         // In Main Gallery, a Property must not affect media whose only
         // Gallery owners have explicitly disabled that Property.
         if (!folder && providers.length > 0 && providers.every((provider) =>
           (provider.disabledGeneralGroupIds ?? []).includes(gid) || (provider.disabledGalleryGroupIds ?? []).includes(gid),
         )) continue;
         if (!vals.some((v) => (m.props[gid] ?? []).includes(v))) matchesAdvanced = false;
       }
       if (galleryFilterIds.length && !providers.some((f) => galleryFilterIds.includes(f.id))) matchesAdvanced = false;
       if (sourceFilterIds.length) {
         const matchesSource = sourceFilterIds.includes(m.sourceId);
         const matchesOther = !!folder
           && sourceFilterIds.includes(OTHER_MEDIA_SOURCE_ID)
           && !(folder.sourceIds ?? []).includes(m.sourceId);
         if (!matchesSource && !matchesOther) matchesAdvanced = false;
       }
       if (colorFilter && !mediaMatchesColor(m, colorFilter.hex, colorFilter.tolerance)) matchesAdvanced = false;
       if (designFilterOn && !mediaMatchesDesignFilter(m, designFilter)) matchesAdvanced = false;
       if (hasAdvancedFilters && (invertAdvancedFilters ? matchesAdvanced : !matchesAdvanced)) return false;
      if (q) {
        const hay = [m.name, m.notes, groupNameByMedia.get(m.id) ?? "", ...Object.values(m.props).flat()].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
    // paletteVersion: a colour filter must see palettes measured since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorFilter, paletteVersion, designFilter, designFilterOn, excludedFolderSet, filter, galleryFilterIds, index, invertAdvancedFilters, propFilters, query, sourceFilterIds, state.excludeDefaultMedia, state.excludeOtherMedia, state.groups, state.ignoreMediaSourcesWhenExcluded, unlockedFolderSet]);
  const passes = useMemo(() => passesFor(folder, folderMediaIds), [folder, folderMediaIds, passesFor]);

  // Keep member Media Groups aligned with the current view. The group itself
  // stays in order when at least one member passes, but Gallery must receive
  // the individual ids too so it never renders hidden/filtered members.
  const visibleMediaIds = useMemo(() => state.media.filter(passes).map((media) => media.id), [passes, state.media]);
  const groupById = useMemo(() => new Map(state.groups.map((group) => [group.id, group])), [state.groups]);
  const { entries, flatMedia } = useMemo(
    () => shownMedia(state.media.filter(passes), state.order, groupById),
    [groupById, passes, state.media, state.order],
  );
  // What Main Gallery shows right now, by the very same rules, so its count
  // in the Sidebar never includes media hidden by an exclusion, a lock, a
  // filter or anything else. Inside Main Gallery that is simply the view.
  const mainGalleryCount = useMemo(() => {
    if (!folder) return flatMedia.length;
    return shownMedia(state.media.filter(passesFor(null, NO_MEDIA_IDS)), state.order, groupById).flatMedia.length;
  }, [flatMedia.length, folder, groupById, passesFor, state.media, state.order]);

  const filtersActive = Boolean(query.trim()) || filter !== "all" || invertAdvancedFilters
    || galleryFilterIds.length > 0 || sourceFilterIds.length > 0 || colorFilter !== null || designFilterOn || Object.values(propFilters).some((values) => values.length > 0);
  const clearAllFilters = () => {
    setQuery("");
    setFilter("all");
    setPropFilters({});
    setGalleryFilterIds([]);
    setSourceFilterIds([]);
    setColorFilter(null);
    setDesignFilter(EMPTY_DESIGN_FILTER);
    setInvertAdvancedFilters(false);
  };

  const lightboxIndex = lightboxId ? flatMedia.findIndex((m) => m.id === lightboxId) : -1;

  // Hiding is recoverable from the Trash, but it is still asked about, the
  // same way the Gallery's own menu asks.
  const hideSelection = useCallback((ids: string[]) => {
    if (!ids.length) return;
    if (folder) {
      const galleryId = folder.id;
      setConfirmReq({
        title: c(`Ẩn ${ids.length} ảnh khỏi Gallery?`, `Hide ${ids.length} images from this Gallery?`),
        description: c("Ảnh sẽ vào thùng rác của Gallery này. File gốc trong Folder nguồn vẫn được giữ.", "The images will enter this Gallery's trash. Original files in source folders are kept."),
        onConfirm: () => { ids.forEach((id) => discardFromFolder(galleryId, id)); setSelected([]); },
      });
      return;
    }
    setConfirmReq({
      title: c(`Ẩn ${ids.length} media khỏi Main Gallery?`, `Hide ${ids.length} media from Main Gallery?`),
      description: c("Media sẽ vào thùng rác Mosaic và có thể khôi phục. File gốc không bị thay đổi.", "Media will enter Mosaic trash and can be restored. Original files are unchanged."),
      onConfirm: () => { hideMedia(ids); setSelected([]); },
    });
  }, [discardFromFolder, folder, hideMedia, state.language]);

  // Library shortcuts: Ctrl/Cmd+F search, Ctrl/Cmd+A select all, Esc clear
  // the selection, Delete hide it. Typing in a field, an open dialog or menu,
  // and every full-page tool keep their keys to themselves.
  useEffect(() => {
    if (locked || lightboxId || tagManagerOpen || extensionManageOpen || trashOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "f" && !event.shiftKey && !event.altKey) {
        const search = document.querySelector<HTMLInputElement>("[data-library-search]");
        if (search) { event.preventDefault(); search.focus(); search.select(); }
        return;
      }
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu]")) return;
      if (view.kind === "folders" || folderLocked) return;
      if (mod && key === "a" && !event.shiftKey) {
        event.preventDefault();
        setSelected(flatMedia.map((media) => media.id));
        return;
      }
      if (event.key === "Escape" && selected.length) {
        setSelected([]);
        return;
      }
      if (event.key === "Delete" && selected.length) {
        event.preventDefault();
        hideSelection(selected);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [extensionManageOpen, flatMedia, folderLocked, hideSelection, lightboxId, locked, selected, tagManagerOpen, trashOpen, view.kind]);

  const title =
    view.kind === "all" ? t("allMedia") : view.kind === "folders" ? t("folders") : (folder?.name ?? "");
  // `flatMedia` is what the Gallery actually renders, so it is the only honest
  // count: membership alone counted media that a filter, an exclusion, a lock
  // or a hide had already removed from view.
  const subtitle =
    view.kind === "folder" ? folder?.notes || t("count", { count: flatMedia.length })
      : view.kind === "all" ? t("count", { count: flatMedia.length })
        : undefined;

  const allSelected =
    flatMedia.length > 0 && flatMedia.every((m) => selected.includes(m.id));

  const handleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const visibleIds = flatMedia.map((m) => m.id);
      const everySelected = visibleIds.length > 0 && visibleIds.every((id) => prev.includes(id));
      return everySelected ? [] : visibleIds;
    });
  }, [flatMedia]);

  // What the inspector describes: last selected media, otherwise the open collection.
  const inspectorTarget: InspectorTarget | null = useMemo(() => {
    const last = selected[selected.length - 1];
    if (last) return { kind: "media", id: last };
    if (folder) return { kind: "folder", id: folder.id };
    if (view.kind === "all") return { kind: "all" };
    return null;
  }, [folder, selected, view.kind]);

  // Auto-open the inspector whenever a new target is picked (opt-out in settings).
  const targetKey = inspectorTarget
    ? inspectorTarget.kind === "all" ? "all" : `${inspectorTarget.kind}:${inspectorTarget.id}`
    : null;
  const previousInspectorTarget = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // The initial “Main Gallery” target is not a user selection. Do not open
    // Inspector on launch just because it exists.
    if (previousInspectorTarget.current === undefined) {
      previousInspectorTarget.current = targetKey;
      return;
    }
    if (targetKey && targetKey !== previousInspectorTarget.current && state.inspectorAutoOpen) {
      setInspectorOpen(true);
    }
    previousInspectorTarget.current = targetKey;
  }, [targetKey, state.inspectorAutoOpen]);

  // Every screen — the Library, the lock screen and each full-page tool — sits
  // under the same draggable title bar with its window controls. The tool pages
  // used to replace the whole window and drop it, which left them with no way
  // to move, minimise or close the window short of going back first.
  const titlebar = (
    <div className="window-titlebar flex h-6 shrink-0 items-center border-b border-border/55">
      <span className="pl-3 text-[11px] font-medium tracking-wide text-muted-foreground">{currentProfile?.name || "Mosaic"}</span>
      <span className="flex-1" />
      <WindowControls />
    </div>
  );
  const framed = (content: React.ReactNode) => (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {titlebar}
      <div className="flex min-h-0 flex-1 flex-col">{content}</div>
    </div>
  );

  if (license?.state === "expired") return framed(<LicensePaywall status={license} onStatus={setLicense} />);

  if (locked) {
    return framed(
      <div className="flex flex-1 items-center justify-center bg-background px-4">
        <div className="glass-panel w-full max-w-sm space-y-4 rounded-2xl p-8 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-xl bg-primary/85 text-primary-foreground">
            <Lock className="size-5" />
          </span>
          <h1 className="font-display text-xl font-semibold">{t("brand")}</h1>
          <p className="text-sm text-muted-foreground">{t("enterPassword")}</p>
          <input
            autoFocus
            type="password"
            value={pwdTry}
            onChange={(e) => setPwdTry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              void matchesPassword(pwdTry).then((matched) => {
                if (matched) {
                  setLocked(false); setPwdTry(""); setPwdError(false);
                } else setPwdError(true);
              });
            }}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {pwdError && <p className="text-xs text-destructive">{t("wrongPassword")}</p>}
          <button
            onClick={() => void matchesPassword(pwdTry).then((matched) => {
              if (matched) { setLocked(false); setPwdTry(""); setPwdError(false); }
              else setPwdError(true);
            })}
            className="w-full rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary"
          >
            {t("unlockApp")}
          </button>
        </div>
      </div>,
    );
  }

  if (tagManagerOpen) return framed(<TagManager onBack={() => setTagManagerOpen(false)} />);
  if (extensionManageOpen) return framed(<ExtensionManage onBack={() => setExtensionManageOpen(false)} unlockedFolderIds={unlockedFolders} />);
  if (trashOpen) return framed(<TrashPage onBack={() => setTrashOpen(false)} onConfirm={setConfirmReq} confirmDialog={<ConfirmDialog request={confirmReq} onClose={() => setConfirmReq(null)} />} />);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {titlebar}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <Sidebar view={view} unlockedFolderIds={unlockedFolders} onView={(v) => { setView(v); setSelected([]); }} onConfirm={setConfirmReq} onLock={() => setLocked(true)} onRelockGallery={(id) => { setUnlockedFolders((previous) => previous.filter((item) => item !== id)); if (view.kind === "folder" && view.id === id) setSelected([]); }} onManageTags={() => setTagManagerOpen(true)} onOpenExtensionManage={() => setExtensionManageOpen(true)} onOpenTrash={() => setTrashOpen(true)} onMediaMovedFromSelection={() => setSelected([])} mainGalleryCount={mainGalleryCount} />

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          title={title}
          subtitle={subtitle}
          query={query}
          onQuery={setQuery}
          filter={filter}
          onFilter={setFilter}
          showFilters={view.kind !== "folders"}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
          allSelected={allSelected}
          onSelectAll={handleSelectAll}
          propFilters={propFilters}
          onTogglePropFilter={(gid, v) =>
            setPropFilters((prev) => {
              const cur = prev[gid] ?? [];
              const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
              return { ...prev, [gid]: next };
            })
          }
          onClearPropFilters={() => setPropFilters({})}
          viewKind={view.kind}
          folder={folder}
          galleryFilterIds={galleryFilterIds}
          onToggleGalleryFilter={(id) => setGalleryFilterIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])}
           sourceFilterIds={sourceFilterIds}
           onToggleSourceFilter={(id) => setSourceFilterIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])}
           invertAdvancedFilters={invertAdvancedFilters}
           onToggleInvertAdvancedFilters={() => setInvertAdvancedFilters((value) => !value)}
           onClearAdvancedFilters={() => { setPropFilters({}); setGalleryFilterIds([]); setSourceFilterIds([]); setColorFilter(null); setDesignFilter(EMPTY_DESIGN_FILTER); setInvertAdvancedFilters(false); }}
           colorFilter={colorFilter}
           designFilter={designFilter}
           onDesignFilter={setDesignFilter}
           onColorFilter={setColorFilter}
           colorAnalysis={colorAnalysis}
          groupBy={groupBy}
          onToggleGroupBy={(value) => setGroupBy((current) => {
            const id = mediaGroupById(value);
            return current.some((item) => mediaGroupById(item) === id)
              ? current.filter((item) => mediaGroupById(item) !== id)
              : [...current, value];
          })}
        />

        {view.kind === "folders" ? (
          <FolderGallery onOpen={setView} unlockedFolderIds={unlockedFolders} />
        ) : folderLocked && folder ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-16 text-center">
            <span className="grid size-11 place-items-center rounded-xl bg-primary/85 text-primary-foreground">
              <Lock className="size-5" />
            </span>
            <p className="font-display text-lg font-medium">{t("lockedFolder")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{t("lockedFolderHint")}</p>
            {requiresFolderPassword && (
              <input
                autoFocus
                type="password"
                value={folderPwd}
                onChange={(e) => setFolderPwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  unlockCurrentFolder();
                }}
                placeholder={t("password")}
                className="w-56 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            )}
            {folderPwdError && <p className="text-xs text-destructive">{t("wrongPassword")}</p>}
            <button
              onClick={unlockCurrentFolder}
              className="rounded-xl border border-primary/45 bg-primary/28 px-4 py-2 text-sm font-medium text-foreground shadow-[inset_0_1px_rgba(255,255,255,.22),0_8px_24px_rgba(53,108,70,.18)] backdrop-blur-xl transition-all hover:border-primary/70 hover:bg-primary/42 hover:shadow-[inset_0_1px_rgba(255,255,255,.3),0_10px_28px_rgba(53,108,70,.28)] active:scale-[.98]"
            >
              {t("unlockFolder2")}
            </button>
          </div>
        ) : entries.length === 0 && filtersActive ? (
          // Nothing matched. The Library is not empty, so say so and offer
          // the way back instead of the "add some media" message.
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-16 text-center">
            <SearchX className="size-8 text-muted-foreground" />
            <p className="font-display text-lg font-medium">{c("Không có kết quả", "No results")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{c("Không có media nào khớp với tìm kiếm hoặc bộ lọc hiện tại.", "No media match the current search or filters.")}</p>
            <button onClick={clearAllFilters} className="glass-btn rounded-lg px-4 py-2 text-sm font-medium">{c("Xóa tìm kiếm và bộ lọc", "Clear search and filters")}</button>
          </div>
        ) : (
          <Gallery
            // No `key` here on purpose. Keying it to the Inspector remounted
            // the whole Gallery on every toggle, which threw away the scroll
            // position and sent the user back to the top. `layoutKey` below
            // already re-measures the viewport, which is all the toggle needs.
            entries={entries}
            visibleMediaIds={visibleMediaIds}
            selected={selected}
            setSelected={setSelected}
            onOpen={setLightboxId}
            onConfirm={setConfirmReq}
            currentFolderId={folder?.id ?? null}
            galleryLayout={folder?.layout ?? state.mainGalleryLayout}
            layoutKey={inspectorOpen ? "inspector-open" : "inspector-closed"}
            groupBy={groupBy}
          />
        )}

        <BulkBar
          selected={selected}
          folder={folder}
          onClear={() => setSelected([])}
          onHide={() => hideSelection(selected)}
          onFavorite={(favorite) => setFavorite(selected, favorite)}
          onGroup={() => { createGroup(selected); setSelected([]); }}
        />
        {updateStatus.state !== "idle" && updateStatus.state !== "checking" && updateStatus.state !== "development" && (
          <div className="glass-float absolute right-5 bottom-5 z-50 flex max-w-sm items-center gap-3 rounded-xl px-3 py-2.5 text-sm shadow-xl">
            <span className="min-w-0 flex-1">
              {updateStatus.state === "available" && t("updateAvailable", { version: updateStatus.version ?? "" })}
              {updateStatus.state === "downloading" && t("downloadingUpdate", { percent: updateStatus.percent ?? 0 })}
              {updateStatus.state === "ready" && t("updateAvailable", { version: updateStatus.version ?? "" })}
              {updateStatus.state === "error" && t("updateFailed")}
            </span>
            {updateStatus.state === "available" && <button onClick={() => void getInDeckBridge()?.downloadUpdate().catch(() => setUpdateStatus({ state: "error" }))} className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">{t("downloadUpdate")}</button>}
            {updateStatus.state === "ready" && <button onClick={() => void getInDeckBridge()?.installUpdate().catch(() => setUpdateStatus({ state: "error" }))} className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">{t("restartToUpdate")}</button>}
          </div>
        )}
      </main>

      {inspectorOpen && inspectorTarget && (
        <Inspector target={inspectorTarget} unlockedFolderIds={unlockedFolders} currentFolderId={folder?.id ?? null} onClose={() => setInspectorOpen(false)} onConfirm={setConfirmReq} onFilterColor={(hex) => setColorFilter((current) => ({ hex, tolerance: current?.tolerance ?? DEFAULT_COLOR_TOLERANCE }))} />
      )}
      </div>

      {lightboxIndex >= 0 && (
        <Lightbox
          items={flatMedia}
          index={lightboxIndex}
          onIndex={(i) => setLightboxId(flatMedia[i]?.id ?? null)}
          onClose={() => setLightboxId(null)}
          currentFolderId={folder?.id ?? null}
        />
      )}

      <ConfirmDialog request={confirmReq} onClose={() => setConfirmReq(null)} />
      {currentProfile && !currentProfile.initialized && <LibraryLocationSetup profile={currentProfile} onConfigured={() => window.location.reload()} />}
    </div>
  );
}
