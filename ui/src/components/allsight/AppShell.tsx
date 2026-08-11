import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Lock } from "lucide-react";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import type { FilterKind, MediaItem, OrderEntry } from "@/lib/allsight/types";
import { Sidebar, type View } from "./Sidebar";
import { BulkBar, Header, WindowControls } from "./Chrome";
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

function isDefaultMedia(media: MediaItem, state: ReturnType<typeof useAllsight>["state"]) {
  const source = state.sources.find((item) => item.id === media.sourceId);
  return media.sourceId === DEFAULT_MEDIA_SOURCE_ID || /^default\s*save$/i.test(source?.name ?? "");
}

function isDiscardedMedia(media: MediaItem) {
  return media.sourceId === DISCARDS_MEDIA_SOURCE_ID;
}

function isOtherMedia(media: MediaItem, state: ReturnType<typeof useAllsight>["state"]) {
  const source = state.sources.find((item) => item.id === media.sourceId);
  if (isDefaultMedia(media, state) || isDiscardedMedia(media)) return false;
  // A deleted Gallery remains recoverable in Trash. Its media/source records
  // must not fall back into Main Gallery while that Gallery is in Trash.
  if (state.trashFolders.some((folder) => folder.mediaIds.includes(media.id))) return false;
  // A source only becomes a normal provider after a Gallery explicitly adopts
  // it as a Media Source. Files imported manually from another folder/source
  // therefore remain in the virtual “Khác” provider.
  const sourceIsManaged = !!source && state.folders.some((folder) =>
    (folder.sourceIds ?? []).includes(media.sourceId),
  ) || state.mainSourceIds.includes(media.sourceId);
  if (!sourceIsManaged) return true;
  // A media manually added to a Gallery from a different source belongs to
  // that Gallery and “Khác” at the same time.
  return false;
}

export function AppShell() {
  const t = useT();
  const { state } = useAllsight();
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [propFilters, setPropFilters] = useState<Record<string, string[]>>({});
  const [galleryFilterIds, setGalleryFilterIds] = useState<string[]>([]);
  const [sourceFilterIds, setSourceFilterIds] = useState<string[]>([]);
  const [invertAdvancedFilters, setInvertAdvancedFilters] = useState(false);
  const [groupBy, setGroupBy] = useState<MediaGroupBy[]>([]);

  const [selected, setSelected] = useState<string[]>([]);
  // Start with the library unobstructed. Inspector remains available from the
  // header and can still auto-open after the user makes a new selection.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [locked, setLocked] = useState(false);
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

  const passes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (m: MediaItem) => {
      if (m.hidden) return false;
      // Deleting a Gallery moves files from its managed Default Source to
      // Discards. They remain recoverable in Trash, never as “Khác” in Main.
      if (!folder && isDiscardedMedia(m)) return false;
      if (!folder && state.trashFolders.some((trashFolder) => trashFolder.mediaIds.includes(m.id))
        && !state.folders.some((activeFolder) => activeFolder.mediaIds.includes(m.id))
        && !state.mainSourceIds.includes(m.sourceId)) return false;
      if (folder && !folder.mediaIds.includes(m.id)) return false;
      const providers = state.folders.filter((f) => f.mediaIds.includes(m.id));
      const other = isOtherMedia(m, state);
      const defaultMedia = isDefaultMedia(m, state);
      const mainMediaSource = state.mainSourceIds.includes(m.sourceId);
      if (!folder && (providers.length || other || defaultMedia)) {
        const visibleFolderProvider = providers.some((f) =>
          (!f.locked || unlockedFolders.includes(f.id)) && !state.excludedFolderIds.includes(f.id),
        );
        // A direct Main Gallery Media Source normally remains a valid owner
        // even when its Gallery is hidden. The Inspector toggle deliberately
        // makes Gallery Sources take precedence over that direct ownership.
        const hasUnlockedFolderProvider = providers.length === 0 || providers.some((f) => !f.locked || unlockedFolders.includes(f.id));
        const mediaSourceKeepsVisible = mainMediaSource
          && !state.ignoreMediaSourcesWhenExcluded
          && hasUnlockedFolderProvider;
        if (!visibleFolderProvider
          && !mediaSourceKeepsVisible
          && !(other && !state.excludeOtherMedia)
          && !(defaultMedia && !state.excludeDefaultMedia)) return false;
      }
      if (filter === "favorites" && !m.favorite) return false;
      if (filter === "images" && m.type !== "image") return false;
      if (filter === "videos" && m.type !== "video") return false;
       const hasAdvancedFilters = Object.values(propFilters).some((values) => values.length) || galleryFilterIds.length > 0 || sourceFilterIds.length > 0;
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
       if (hasAdvancedFilters && (invertAdvancedFilters ? matchesAdvanced : !matchesAdvanced)) return false;
      if (q) {
        const hay = [m.name, ...Object.values(m.props).flat()].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
  }, [filter, folder, galleryFilterIds, invertAdvancedFilters, propFilters, query, sourceFilterIds, state, unlockedFolders]);

  // Keep member Media Groups aligned with the current view. The group itself
  // stays in order when at least one member passes, but Gallery must receive
  // the individual ids too so it never renders hidden/filtered members.
  const visibleMediaIds = useMemo(() => state.media.filter(passes).map((media) => media.id), [passes, state.media]);

  const entries: OrderEntry[] = useMemo(() => {
    const byId = new Map(state.media.map((m) => [m.id, m]));
    return state.order.filter((e) => {
      if (e.kind === "media") {
        const m = byId.get(e.id);
        return !!m && passes(m);
      }
      const g = state.groups.find((x) => x.id === e.id);
      return !!g && g.memberIds.some((id) => { const m = byId.get(id); return !!m && passes(m); });
    });
  }, [passes, state.groups, state.media, state.order]);

  const flatMedia = useMemo(() => {
    const out: MediaItem[] = [];
    for (const e of entries) {
      if (e.kind === "media") {
        const m = state.media.find((x) => x.id === e.id);
        if (m) out.push(m);
      } else {
        const g = state.groups.find((x) => x.id === e.id);
        g?.memberIds.forEach((id) => {
          const m = state.media.find((x) => x.id === id);
          if (m && passes(m)) out.push(m);
        });
      }
    }
    return out;
  }, [entries, passes, state.groups, state.media]);

  const lightboxIndex = lightboxId ? flatMedia.findIndex((m) => m.id === lightboxId) : -1;

  const title =
    view.kind === "all" ? t("allMedia") : view.kind === "folders" ? t("folders") : (folder?.name ?? "");
  const subtitle =
    view.kind === "folder" ? folder?.notes || t("count", { count: folder?.mediaIds.length ?? 0 }) : undefined;

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

  if (locked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
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
      </div>
    );
  }

  if (tagManagerOpen) return <TagManager onBack={() => setTagManagerOpen(false)} />;
  if (extensionManageOpen) return <ExtensionManage onBack={() => setExtensionManageOpen(false)} unlockedFolderIds={unlockedFolders} />;
  if (trashOpen) return <TrashPage onBack={() => setTrashOpen(false)} />;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <div className="window-titlebar flex h-[18px] shrink-0 items-center border-b border-border/55">
        <span className="pl-3 text-[11px] font-medium tracking-wide text-muted-foreground">{currentProfile?.name || "Mosaic"}</span>
        <span className="flex-1" />
        <WindowControls />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <Sidebar view={view} unlockedFolderIds={unlockedFolders} onView={(v) => { setView(v); setSelected([]); }} onConfirm={setConfirmReq} onLock={() => setLocked(true)} onRelockGallery={(id) => { setUnlockedFolders((previous) => previous.filter((item) => item !== id)); if (view.kind === "folder" && view.id === id) setSelected([]); }} onManageTags={() => setTagManagerOpen(true)} onOpenExtensionManage={() => setExtensionManageOpen(true)} onOpenTrash={() => setTrashOpen(true)} />

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
           onClearAdvancedFilters={() => { setPropFilters({}); setGalleryFilterIds([]); setSourceFilterIds([]); setInvertAdvancedFilters(false); }}
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
        ) : (
          <Gallery
            key={inspectorOpen ? "gallery-with-inspector" : "gallery-without-inspector"}
            entries={entries}
            visibleMediaIds={visibleMediaIds}
            selected={selected}
            setSelected={setSelected}
            onOpen={setLightboxId}
            onConfirm={setConfirmReq}
            currentFolderId={folder?.id ?? null}
            layoutKey={inspectorOpen ? "inspector-open" : "inspector-closed"}
            groupBy={groupBy}
          />
        )}

        <BulkBar selected={selected} folder={folder} onClear={() => setSelected([])} />
        {updateStatus.state !== "idle" && updateStatus.state !== "checking" && updateStatus.state !== "development" && (
          <div className="glass-float absolute right-5 bottom-5 z-50 flex max-w-sm items-center gap-3 rounded-xl px-3 py-2.5 text-sm shadow-xl">
            <span className="min-w-0 flex-1">
              {updateStatus.state === "available" && t("updateAvailable", { version: updateStatus.version ?? "" })}
              {updateStatus.state === "downloading" && t("downloadingUpdate", { percent: updateStatus.percent ?? 0 })}
              {updateStatus.state === "ready" && t("updateAvailable", { version: updateStatus.version ?? "" })}
              {updateStatus.state === "error" && t("updateFailed")}
            </span>
            {updateStatus.state === "available" && <button onClick={() => void getInDeckBridge()?.downloadUpdate()} className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">{t("downloadUpdate")}</button>}
            {updateStatus.state === "ready" && <button onClick={() => void getInDeckBridge()?.installUpdate()} className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground">{t("restartToUpdate")}</button>}
          </div>
        )}
      </main>

      {inspectorOpen && inspectorTarget && (
        <Inspector target={inspectorTarget} unlockedFolderIds={unlockedFolders} currentFolderId={folder?.id ?? null} onClose={() => setInspectorOpen(false)} onConfirm={setConfirmReq} />
      )}
      </div>

      {lightboxIndex >= 0 && (
        <Lightbox
          items={flatMedia}
          index={lightboxIndex}
          onIndex={(i) => setLightboxId(flatMedia[i]?.id ?? null)}
          onClose={() => setLightboxId(null)}
        />
      )}

      <ConfirmDialog request={confirmReq} onClose={() => setConfirmReq(null)} />
      {currentProfile && !currentProfile.initialized && <LibraryLocationSetup profile={currentProfile} onConfigured={() => window.location.reload()} />}
    </div>
  );
}
