import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Folder, FolderPlus, HardDrive, Heart, PanelRightClose, Pencil, Play, Search, Trash2 } from "lucide-react";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { Chip, PropertyPicker } from "./PropertyPicker";
import { AutoTagEditor } from "./AutoTagEditor";
import { LockOverlay } from "./LockOverlay";

import { cn } from "@/lib/utils";
import type { ConfirmRequest } from "./ConfirmDialog";

export type InspectorTarget = { kind: "all" } | { kind: "media"; id: string } | { kind: "folder"; id: string };

export function Inspector({
  target,
  unlockedFolderIds,
  currentFolderId,
  onClose,
  onConfirm,
}: {
  target: InspectorTarget | null;
  unlockedFolderIds: string[];
  currentFolderId?: string | null;
  onClose: () => void;
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const t = useT();
  const { state, setInspectorAutoOpen } = useAllsight();

  return (
    <aside className="glass-panel app-scroll static flex h-full w-80 min-h-0 shrink-0 basis-80 flex-col overflow-y-auto rounded-none border-y-0 border-r-0">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="font-display text-sm font-semibold tracking-tight">{t("inspector")}</h2>
        <button
          onClick={onClose}
          aria-label={t("close")}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>

      <div className="flex-1">
        {target?.kind === "folder" ? (
          <FolderPanel folderId={target.id} unlockedFolderIds={unlockedFolderIds} onConfirm={onConfirm} />
        ) : target?.kind === "media" ? (
          <MediaPanel mediaId={target.id} currentFolderId={currentFolderId} />
        ) : target?.kind === "all" ? (
          <MainGalleryPanel onConfirm={onConfirm} />
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t("preview")}</div>
        )}
      </div>

      <div className="sticky bottom-0 border-t border-border/60 bg-background/40 px-4 py-3 backdrop-blur-md">
        <button
          onClick={() => setInspectorAutoOpen(!state.inspectorAutoOpen)}
          className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors",
              state.inspectorAutoOpen ? "border-primary bg-primary/85 text-primary-foreground" : "border-border",
            )}
          >
            {state.inspectorAutoOpen && <Check className="size-3" />}
          </span>
          {t("autoOpenInspector")}
        </button>
      </div>
    </aside>
  );
}

function MainGalleryPanel({ onConfirm }: { onConfirm: (request: ConfirmRequest) => void }) {
  const { state, toggleExcludedFolder, toggleExcludeOtherMedia, toggleIgnoreMediaSourcesWhenExcluded, attachMainSource, detachMainSource } = useAllsight();
  const t = useT();
  const [addingSource, setAddingSource] = useState(false);
  const [sourceMessage, setSourceMessage] = useState("");
  const [defaultSavePath, setDefaultSavePath] = useState("");
  const [galleryQuery, setGalleryQuery] = useState("");
  useEffect(() => {
    const bridge = getInDeckBridge();
    if (!bridge) return;
    let active = true;
    void bridge.currentProfile().then((profile) => {
      if (!active || !profile.mediaPath) return;
      setDefaultSavePath(`${String(profile.mediaPath).replace(/[\\/]+$/, "")}\\DefaultSave`);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const excluded = new Set(state.excludedFolderIds);
  const visibleFolders = state.folders.filter((folder) => folder.name.toLowerCase().includes(galleryQuery.trim().toLowerCase()));
  const excludedFolders = state.folders.filter((folder) => excluded.has(folder.id));
  const includesLockedGallery = excludedFolders.some((folder) => folder.locked);
  const isDefaultMedia = (mediaId: string) => {
    const media = state.media.find((item) => item.id === mediaId);
    if (!media) return false;
    const source = state.sources.find((item) => item.id === media.sourceId);
    return media.sourceId === "allsight-web-imports" || /^default\s*save$/i.test(source?.name ?? "");
  };
  const isDiscardedMedia = (mediaId: string) => state.media.find((item) => item.id === mediaId)?.sourceId === "indeck-discards";
  const isOtherMedia = (mediaId: string) => {
    const media = state.media.find((item) => item.id === mediaId);
    if (!media || isDefaultMedia(mediaId) || isDiscardedMedia(mediaId)) return false;
    if (state.trashFolders.some((folder) => folder.mediaIds.includes(media.id))) return false;
    const source = state.sources.find((item) => item.id === media.sourceId);
    const sourceIsManaged = !!source && (state.mainSourceIds.includes(media.sourceId) || state.folders.some((folder) =>
      (folder.sourceIds ?? []).includes(media.sourceId),
    ));
    if (!sourceIsManaged) return true;
    return false;
  };
  // A locked Gallery deliberately conceals its count.  Do not leak that count
  // through the total at the top of the inspector.
  const knownHiddenCount = state.media.filter((media) => {
    const providers = state.folders.filter((folder) => folder.mediaIds.includes(media.id));
    const other = isOtherMedia(media.id);
    const defaultMedia = isDefaultMedia(media.id);
    const mainMediaSource = state.mainSourceIds.includes(media.sourceId);
    return (providers.length > 0 || other || defaultMedia)
      && providers.every((folder) => excluded.has(folder.id))
      && (!mainMediaSource || state.ignoreMediaSourcesWhenExcluded)
      && (!other || state.excludeOtherMedia)
      && (!defaultMedia || state.excludeDefaultMedia)
      && !providers.some((folder) => excluded.has(folder.id) && folder.locked);
  }).length;
  const hiddenCountLabel = includesLockedGallery
    ? [knownHiddenCount > 0 ? String(knownHiddenCount) : "", "?"].filter(Boolean).join(" + ")
    : String(knownHiddenCount);
  return (
    <div className="space-y-4 px-4 pb-8">
      <div className="space-y-1">
        <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">{t("gallerySources")}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("gallerySourcesHint")}</p>
        <p className="text-xs text-muted-foreground">{t("hiddenMediaCount", { count: hiddenCountLabel })}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={state.ignoreMediaSourcesWhenExcluded}
        title={t("gallerySourcesHint")}
        onClick={toggleIgnoreMediaSourcesWhenExcluded}
        className="glass-btn flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
      >
        <span className="min-w-0 flex-1 text-sm font-medium">{t("ignoreMediaSources")}</span>
        <span className={cn("relative h-5 w-9 shrink-0 rounded-full border transition-colors", state.ignoreMediaSourcesWhenExcluded ? "border-primary/70 bg-primary/80" : "border-border bg-secondary/65")}>
          <span className={cn("absolute top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform", state.ignoreMediaSourcesWhenExcluded ? "translate-x-[18px]" : "translate-x-0.5")} />
        </span>
      </button>
      <label className="glass-btn flex items-center gap-2 rounded-lg px-2.5 py-2">
        <Search className="size-3.5 text-muted-foreground" />
        <input value={galleryQuery} onChange={(event) => setGalleryQuery(event.target.value)} placeholder={t("searchGalleries")} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
      </label>
      <div className="app-scroll max-h-60 space-y-1.5 overflow-y-auto pr-1">
        {visibleFolders.map((folder) => {
          const off = excluded.has(folder.id);
          return <button key={folder.id} onClick={() => toggleExcludedFolder(folder.id)} className="glass-btn flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm">
            {off ? <EyeOff className="size-4 text-muted-foreground" /> : <Eye className="size-4 text-primary" />}
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="text-[11px] text-muted-foreground">{folder.locked ? "?" : folder.mediaIds.length}</span>
          </button>;
        })}
        {(() => {
          const otherCount = state.media.filter((media) => isOtherMedia(media.id)).length;
          const off = state.excludeOtherMedia;
          return <button onClick={toggleExcludeOtherMedia} className="glass-btn flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm">
            {off ? <EyeOff className="size-4 text-muted-foreground" /> : <Eye className="size-4 text-primary" />}
            <span className="min-w-0 flex-1 truncate">{t("other")}</span>
            <span className="text-[11px] text-muted-foreground">{otherCount}</span>
          </button>;
        })()}
        {state.folders.length === 0 && <p className="text-sm text-muted-foreground">{t("none")}</p>}
        {state.folders.length > 0 && visibleFolders.length === 0 && <p className="py-3 text-center text-xs text-muted-foreground">{t("noGalleriesFound")}</p>}
      </div>
      <section className="space-y-2.5 border-t border-border/50 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">{t("mediaSources")}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("mediaSourcesHint")}</p>
          </div>
          <button
            type="button"
            disabled={addingSource}
            onClick={() => void (async () => {
              const bridge = getInDeckBridge();
              if (!bridge) { setSourceMessage(t("onlyDesktopApp")); return; }
              const path = await bridge.pickFolder();
              if (!path) return;
              setAddingSource(true);
              setSourceMessage("");
              const result = await attachMainSource(path);
              setAddingSource(false);
              if (result === "exists") setSourceMessage(t("sourceAlreadyAdded"));
              if (result === "unavailable") setSourceMessage(t("sourceUnavailable"));
            })()}
            className="glass-btn inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:cursor-wait disabled:opacity-60"
          >
            <FolderPlus className="size-3.5" />
            {addingSource ? t("adding") : t("addFolder")}
          </button>
        </div>
        <div className="overflow-hidden rounded-xl border border-border/65 bg-background/25">
          {(() => {
            const source = state.sources.find((item) => item.id === "allsight-web-imports" || /^default\s*save$/i.test(item.name))
              ?? (defaultSavePath ? { path: defaultSavePath } : undefined);
            const count = state.media.filter((media) => isDefaultMedia(media.id)).length;
            return <div className="flex min-w-0 items-center gap-2.5 border-b border-border/55 px-2.5 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/70 text-muted-foreground"><HardDrive className="size-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{t("defaultSource")}</span><span className="block truncate text-[11px] text-muted-foreground" title={source?.path}>{source?.path ?? "—"}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{t("mediaCount", { count })}</span></span>
            </div>;
          })()}
          {state.mainSourceIds.map((sourceId) => {
            const source = state.sources.find((item) => item.id === sourceId);
            if (!source) return null;
            const count = state.media.filter((media) => media.sourceId === source.id).length;
            return <div key={source.id} className="flex min-w-0 items-center gap-2.5 border-b border-border/55 px-2.5 py-2.5 last:border-b-0">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/70 text-muted-foreground"><HardDrive className="size-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{source.name}</span><span className="block truncate text-[11px] text-muted-foreground" title={source.path}>{source.path}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{t("mediaCount", { count })}</span></span>
          <button type="button" title={t("removeSourceFromMainGallery")} onClick={() => onConfirm({ title: t("removeMediaSource"), description: t("removeSourceFromGalleryHint", { source: source.name, gallery: t("mainGallery") }), confirmLabel: t("removeSource"), onConfirm: () => detachMainSource(source.id) })} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"><Trash2 className="size-3.5" /></button>
            </div>;
          })}
          {state.mainSourceIds.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted-foreground">{t("noDirectMediaSources")}</div>}
        </div>
        {sourceMessage && <p className="text-xs text-muted-foreground">{sourceMessage}</p>}
      </section>
    </div>
  );
}

function FolderPanel({ folderId, unlockedFolderIds, onConfirm }: { folderId: string; unlockedFolderIds: string[]; onConfirm: (request: ConfirmRequest) => void }) {
  const t = useT();
  const { state, updateFolder, renameFolder, attachSourceFolder, detachSourceFromFolder } = useAllsight();
  const folder = state.folders.find((f) => f.id === folderId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [addingSource, setAddingSource] = useState(false);
  const [sourceMessage, setSourceMessage] = useState("");
  if (!folder) return null;

  const cover = state.media.find((m) => m.id === (folder.coverId ?? folder.mediaIds[0]));
  const isLocked = folder.locked && !unlockedFolderIds.includes(folder.id);
  const managedSourceIds = new Set(folder.sourceIds ?? []);
  const folderMedia = state.media.filter((media) => folder.mediaIds.includes(media.id));
  // "Khác" keeps the original physical source intact. It only groups media
  // that this Gallery owns without adopting their source as a Media Source.
  const otherMedia = folderMedia.filter((media) => !managedSourceIds.has(media.sourceId));

  return (
    <div className="space-y-5 px-4 pb-8">
      {cover && (
        <div className="relative overflow-hidden rounded-xl border border-border/70">
          <img
            src={cover.url || cover.originalUrl || cover.contentUrl || ""}
            alt={folder.name}
            className={cn("h-36 w-full object-cover", isLocked && "scale-105 opacity-70 blur-[7px]")}
          />
          {isLocked && <LockOverlay />}
        </div>
      )}


      <div className="space-y-1.5">
        <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {t("folderInfo")}
        </h3>
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  void renameFolder(folder.id, draft.trim());
                  setEditing(false);
                }
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-full rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={() => {
                if (draft.trim()) void renameFolder(folder.id, draft.trim());
                setEditing(false);
              }}
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/85 text-primary-foreground"
            >
              <Check className="size-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</p>
            <button
              aria-label={t("editName")}
              title={t("editName")}
              onClick={() => {
                setDraft(folder.name);
                setEditing(true);
              }}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Pencil className="size-3" />
            </button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("count", { count: folder.mediaIds.length })}</p>
      </div>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {t("description")}
        </h3>
        <textarea
          value={folder.notes}
          onChange={(e) => updateFolder(folder.id, { notes: e.target.value })}
          placeholder={t("descriptionPlaceholder")}
          rows={3}
          className="w-full resize-none rounded-lg border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {t("autoTags")}
        </h3>
        <AutoTagEditor folderId={folder.id} />
      </section>

      <section className="space-y-2.5 border-t border-border/50 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">{t("mediaSources")}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("galleryMediaSourcesHint")}</p>
          </div>
          <button
            type="button"
            disabled={addingSource}
            onClick={() => void (async () => {
              const bridge = getInDeckBridge();
              if (!bridge) { setSourceMessage(t("onlyDesktopApp")); return; }
              const path = await bridge.pickFolder();
              if (!path) return;
              setAddingSource(true);
              setSourceMessage("");
              const result = await attachSourceFolder(folder.id, path);
              setAddingSource(false);
              if (result === "exists") setSourceMessage(t("sourceAlreadyInGallery"));
              if (result === "unavailable") setSourceMessage(t("sourceUnavailable"));
            })()}
            className="glass-btn inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:cursor-wait disabled:opacity-60"
          >
            <FolderPlus className="size-3.5" />
            {addingSource ? t("adding") : t("addFolder")}
          </button>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/65 bg-background/25">
          {(folder.sourceIds ?? []).map((sourceId) => {
            const source = state.sources.find((item) => item.id === sourceId);
            if (!source) return null;
            const count = folderMedia.filter((media) => media.sourceId === source.id).length;
            const isDefaultSource = source.id === folder.defaultSourceId || source.id === `indeck-gallery-default:${folder.id}`;
            return (
              <div key={source.id} className="flex min-w-0 items-center gap-2.5 border-b border-border/55 px-2.5 py-2.5 last:border-b-0">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/70 text-muted-foreground"><HardDrive className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{source.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground" title={source.path}>{source.path}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{count} media</span>
                </span>
                {!isDefaultSource && <button
                  type="button"
                  aria-label={`${t("removeSourceFromGallery")}: ${source.name}`}
                  title={t("removeSourceFromGallery")}
                  onClick={() => onConfirm({
                    title: t("removeSourceFromGallery"),
                    description: t("removeSourceFromGalleryHint", { source: source.name, gallery: folder.name }),
                    confirmLabel: t("removeSourceFromGallery"),
                    onConfirm: () => detachSourceFromFolder(folder.id, source.id),
                  })}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>}
              </div>
            );
          })}
          {otherMedia.length > 0 && (
            <div className="flex min-w-0 items-center gap-2.5 px-2.5 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/70 text-muted-foreground"><Folder className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t("other")}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{t("manualGalleryMediaHint")}</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{otherMedia.length} media</span>
              </span>
            </div>
          )}
          {(folder.sourceIds ?? []).length === 0 && otherMedia.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">{t("noMediaSources")}</div>
          )}
        </div>
        {sourceMessage && <p className="text-xs text-muted-foreground">{sourceMessage}</p>}
      </section>
    </div>
  );
}

function MediaPanel({ mediaId, currentFolderId }: { mediaId: string; currentFolderId?: string | null }) {
  const t = useT();
  const {
    state,
    updateMedia,
    toggleFavorite,
    addPropValue,
    removePropValue,
    addToFolder,
  } = useAllsight();

  const media = state.media.find((m) => m.id === mediaId);
  if (!media) return null;
  const sourceEntry = state.sources.find((s) => s.id === media.sourceId);
  // In a media Inspector, the useful source information is the real folder,
  // not the friendly label such as "Default Source".
  const source = sourceEntry ? { ...sourceEntry, name: sourceEntry.path || sourceEntry.name } : undefined;
  const memberFolders = state.folders.filter((f) => f.mediaIds.includes(media.id));
  const contextFolder = currentFolderId ? state.folders.find((folder) => folder.id === currentFolderId) : null;
  const editablePropertyGroups = state.propertyGroups.filter((group) => {
    if (!contextFolder) {
      return !memberFolders.length || !memberFolders.every((folder) =>
        (folder.disabledGeneralGroupIds ?? []).includes(group.id) || (folder.disabledGalleryGroupIds ?? []).includes(group.id),
      );
    }
    if (group.id.startsWith(`exclusive:${contextFolder.id}:`)) return true;
    if (group.id.startsWith("exclusive:")) return false;
    if (group.id.startsWith("gallery-group:")) {
      const inherited = state.galleryGroups.some((galleryGroup) =>
        galleryGroup.folderIds.includes(contextFolder.id) && (galleryGroup.propertyGroupIds ?? []).includes(group.id),
      );
      return inherited && !(contextFolder.disabledGalleryGroupIds ?? []).includes(group.id);
    }
    return !(contextFolder.disabledGeneralGroupIds ?? []).includes(group.id);
  });

  return (
    <div className="space-y-5 px-4 pb-8">
      <div className="relative overflow-hidden rounded-xl border border-border/70">
        <img src={media.url} alt={media.name} className="w-full object-contain" />
        {media.type === "video" && (
          <span className="glass-panel absolute bottom-2 left-2 grid size-6 place-items-center rounded-full">
            <Play className="size-3" />
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="truncate text-sm font-medium" title={media.name}>
          {media.name}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={media.path}>
          {media.path}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("source")}: <span className="text-foreground">{source?.name ?? "—"}</span>
        </p>
      </div>

      <button
        onClick={() => toggleFavorite(media.id)}
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-1.5 text-sm font-medium transition-colors",
          media.favorite ? "bg-primary/15 text-foreground" : "bg-secondary/50 hover:bg-accent",
        )}
      >
        <Heart className={cn("size-4", media.favorite && "fill-favorite text-favorite")} />
        {t("favorite")}
      </button>

      {editablePropertyGroups.map((g) => (
        <section key={g.id} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {g.name}
            </h3>
            <PropertyPicker
              label={`${t("addValue")} ${g.name}`}
              align="end"
              options={g.values.map((v) => ({ id: v, label: v }))}
              onSelect={(v) => addPropValue([media.id], g.id, v)}
              onCreate={(v) => addPropValue([media.id], g.id, v)}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(media.props[g.id] ?? []).map((v) => (
              <Chip key={v} label={v} onRemove={() => removePropValue(media.id, g.id, v)} />
            ))}
            {(media.props[g.id] ?? []).length === 0 && (
              <span className="text-xs text-muted-foreground">{t("none")}</span>
            )}
          </div>
        </section>
      ))}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Gallery
          </h3>
          <PropertyPicker
            label={t("addToFolder")}
            align="end"
            allowCreate={false}
            options={state.folders
              .filter((f) => !f.mediaIds.includes(media.id))
              .map((f) => ({ id: f.id, label: f.name }))}
            onSelect={(id) => addToFolder(id, [media.id])}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {memberFolders.map((f) => <Chip key={f.id} label={f.name} />)}
          {memberFolders.length === 0 && <span className="text-xs text-muted-foreground">{t("none")}</span>}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {t("notes")}
        </h3>
        <textarea
          value={media.notes}
          onChange={(e) => updateMedia(media.id, { notes: e.target.value })}
          placeholder={t("notesPlaceholder")}
          rows={4}
          className="w-full resize-none rounded-lg border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </section>
    </div>
  );
}
