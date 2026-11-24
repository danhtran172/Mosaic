import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy, Eye, EyeOff, Folder, FolderOpen, FolderPlus, HardDrive, Heart, Lock, PanelRightClose, Pencil, Play, Search, Trash2 } from "lucide-react";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { Chip, PropertyPicker } from "./PropertyPicker";
import { AutoTagEditor } from "./AutoTagEditor";
import { LockOverlay } from "./LockOverlay";
import type { MediaItem } from "@/lib/allsight/types";
import { LazyThumbnail } from "./Thumbnail";
import { subscribeThumbnailStore, thumbnailPalette, thumbnailStoreVersion } from "@/lib/allsight/thumbnail-resource-manager";
import { aspectLabel, canDragOut, copyText, formatBytes, paletteText, startExternalDrag } from "@/lib/allsight/designer-tools";

import { cn } from "@/lib/utils";
import type { ConfirmRequest } from "./ConfirmDialog";

/**
 * A note field that edits a local draft and commits it after a short pause
 * (and on blur). Writing straight into the Library on every keystroke rebuilt
 * the whole Gallery layout per key, which made typing lag on large Libraries.
 */
function DraftTextarea({ value, onCommit, ...props }: { value: string; onCommit: (value: string) => void } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef(0);
  const latest = useRef({ draft: value, onCommit, value });
  latest.current = { draft, onCommit, value };
  // Follow outside changes (another media selected, an undo) while not typing.
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = () => {
    window.clearTimeout(timer.current);
    const current = latest.current;
    if (current.draft !== current.value) current.onCommit(current.draft);
  };
  // Never lose a pending edit when the panel switches target or unmounts.
  useEffect(() => () => commit(), []);
  return (
    <textarea
      {...props}
      value={draft}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; commit(); }}
      onChange={(event) => {
        setDraft(event.target.value);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(commit, 450);
      }}
    />
  );
}

function formatDate(timestamp: number, language: string) {
  if (!timestamp) return "—";
  try {
    return new Date(timestamp).toLocaleString(language === "en" ? "en-GB" : "vi-VN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

export type InspectorTarget = { kind: "all" } | { kind: "media"; id: string } | { kind: "folder"; id: string };

export function Inspector({
  target,
  unlockedFolderIds,
  currentFolderId,
  onClose,
  onConfirm,
  onFilterColor,
}: {
  target: InspectorTarget | null;
  unlockedFolderIds: string[];
  currentFolderId?: string | null;
  onClose: () => void;
  onConfirm: (request: ConfirmRequest) => void;
  /** Clicking a palette colour filters the Gallery by it. */
  onFilterColor?: (hex: string) => void;
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
          <MediaPanel mediaId={target.id} currentFolderId={currentFolderId} onFilterColor={onFilterColor} />
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
  // Every count below used to rescan all media, all Galleries and all sources
  // for each media in turn — quadratic, and re-run on every Library change.
  const counts = useMemo(() => {
    const sourceById = new Map(state.sources.map((source) => [source.id, source]));
    const providersByMedia = new Map<string, typeof state.folders>();
    for (const folder of state.folders) for (const id of folder.mediaIds) {
      const list = providersByMedia.get(id);
      if (list) list.push(folder); else providersByMedia.set(id, [folder]);
    }
    const trashed = new Set(state.trashFolders.flatMap((folder) => folder.mediaIds));
    const managed = new Set([...state.folders.flatMap((folder) => folder.sourceIds ?? []), ...state.mainSourceIds]);
    const mainSources = new Set(state.mainSourceIds);
    const excludedIds = new Set(state.excludedFolderIds);
    const isDefault = (media: typeof state.media[number]) => media.sourceId === "allsight-web-imports" || /^default\s*save$/i.test(sourceById.get(media.sourceId)?.name ?? "");
    const isOther = (media: typeof state.media[number]) => {
      if (isDefault(media) || media.sourceId === "indeck-discards" || trashed.has(media.id)) return false;
      return !(sourceById.has(media.sourceId) && managed.has(media.sourceId));
    };
    let hidden = 0;
    let other = 0;
    let defaults = 0;
    const perSource = new Map<string, number>();
    for (const media of state.media) {
      perSource.set(media.sourceId, (perSource.get(media.sourceId) ?? 0) + 1);
      const providers = providersByMedia.get(media.id) ?? [];
      const otherMedia = isOther(media);
      const defaultMedia = isDefault(media);
      if (otherMedia) other += 1;
      if (defaultMedia) defaults += 1;
      if ((providers.length > 0 || otherMedia || defaultMedia)
        && providers.every((folder) => excludedIds.has(folder.id))
        && (!mainSources.has(media.sourceId) || state.ignoreMediaSourcesWhenExcluded)
        && (!otherMedia || state.excludeOtherMedia)
        && (!defaultMedia || state.excludeDefaultMedia)
        && !providers.some((folder) => excludedIds.has(folder.id) && folder.locked)) hidden += 1;
    }
    return { hidden, other, defaults, perSource };
  }, [state.excludeDefaultMedia, state.excludeOtherMedia, state.excludedFolderIds, state.folders, state.ignoreMediaSourcesWhenExcluded, state.mainSourceIds, state.media, state.sources, state.trashFolders]);
  const knownHiddenCount = counts.hidden;
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
          const otherCount = counts.other;
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
              const path = await bridge.pickFolder().catch(() => null);
              if (!path) return;
              setAddingSource(true);
              setSourceMessage("");
              try {
                const result = await attachMainSource(path);
                if (result === "exists") setSourceMessage(t("sourceAlreadyAdded"));
                if (result === "unavailable") setSourceMessage(t("sourceUnavailable"));
              } catch {
                setSourceMessage(t("sourceUnavailable"));
              } finally {
                setAddingSource(false);
              }
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
            const count = counts.defaults;
            return <div className="flex min-w-0 items-center gap-2.5 border-b border-border/55 px-2.5 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/70 text-muted-foreground"><HardDrive className="size-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{t("defaultSource")}</span><span className="block truncate text-[11px] text-muted-foreground" title={source?.path}>{source?.path ?? "—"}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{t("mediaCount", { count })}</span></span>
            </div>;
          })()}
          {state.mainSourceIds.map((sourceId) => {
            const source = state.sources.find((item) => item.id === sourceId);
            if (!source) return null;
            const count = counts.perSource.get(source.id) ?? 0;
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
  // A locked Gallery conceals its contents everywhere else (count, cover,
  // media); the Inspector showed its count, notes and sources regardless.
  if (isLocked) {
    return (
      <div className="space-y-4 px-4 pb-8">
        <div className="relative grid h-36 place-items-center overflow-hidden rounded-xl border border-border/70 bg-muted/40">
          <Lock className="size-7 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="truncate text-sm font-medium">{folder.name}</p>
          <p className="text-xs text-muted-foreground">{t("lockedFolderHint")}</p>
        </div>
      </div>
    );
  }
  const managedSourceIds = new Set(folder.sourceIds ?? []);
  const memberIds = new Set(folder.mediaIds);
  const folderMedia = state.media.filter((media) => memberIds.has(media.id));
  // "Khác" keeps the original physical source intact. It only groups media
  // that this Gallery owns without adopting their source as a Media Source.
  const otherMedia = folderMedia.filter((media) => !managedSourceIds.has(media.sourceId));

  return (
    <div className="space-y-5 px-4 pb-8">
      {cover && (
        <div className="relative overflow-hidden rounded-xl border border-border/70">
          <LazyThumbnail
            media={cover}
            priority
            thumbnailSize={512}
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
                e.preventDefault();
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
        <p className="text-xs text-muted-foreground">{t("count", { count: folderMedia.filter((media) => !media.hidden).length })}</p>
      </div>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {t("description")}
        </h3>
        <DraftTextarea
          key={folder.id}
          value={folder.notes}
          onCommit={(notes) => updateFolder(folder.id, { notes })}
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
              const path = await bridge.pickFolder().catch(() => null);
              if (!path) return;
              setAddingSource(true);
              setSourceMessage("");
              try {
                const result = await attachSourceFolder(folder.id, path);
                if (result === "exists") setSourceMessage(t("sourceAlreadyInGallery"));
                if (result === "unavailable") setSourceMessage(t("sourceUnavailable"));
              } catch {
                setSourceMessage(t("sourceUnavailable"));
              } finally {
                setAddingSource(false);
              }
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

function MediaPanel({ mediaId, currentFolderId, onFilterColor }: { mediaId: string; currentFolderId?: string | null | undefined; onFilterColor?: ((hex: string) => void) | undefined }) {
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
      <div
        className={cn("relative overflow-hidden rounded-xl border border-border/70", canDragOut(media) && "cursor-grab")}
        // Drag the preview into Figma, Photoshop or Explorer to drop the file there.
        draggable={canDragOut(media)}
        onDragStart={(event) => { event.preventDefault(); startExternalDrag([media]); }}
        title={canDragOut(media) ? (state.language === "en" ? "Drag into another app" : "Kéo vào ứng dụng khác") : undefined}
        data-inspector-preview
      >
        <LazyThumbnail media={media} priority thumbnailSize={512} className="w-full" style={{ aspectRatio: `${media.width || 4} / ${media.height || 3}` }} />
        {media.type === "video" && (
          <span className="glass-panel absolute bottom-2 left-2 grid size-6 place-items-center rounded-full">
            <Play className="size-3" />
          </span>
        )}
      </div>
      <MediaPalette media={media} onFilterColor={onFilterColor} />

      <div className="space-y-1.5">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={media.name}>
            {media.name}
          </p>
          <button
            type="button"
            onClick={() => { void getInDeckBridge()?.showInFolder(media).catch(() => false); }}
            title={t("openInFolder")}
            aria-label={t("openInFolder")}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="size-3.5" />
          </button>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={media.path}>
          {media.path}
        </p>
        {/* The facts people look for first: kind, pixels, when it changed. */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1 text-xs">
          <dt className="text-muted-foreground">{t("source")}</dt>
          <dd className="truncate text-foreground" title={source?.name}>{source?.name ?? "—"}</dd>
          <dt className="text-muted-foreground">{state.language === "en" ? "Type" : "Loại"}</dt>
          <dd className="text-foreground">{media.type === "video" ? "Video" : (media.name.split(".").pop() ?? "").toUpperCase() || "Image"}{media.vault ? " · Vault" : ""}</dd>
          <dt className="text-muted-foreground">{state.language === "en" ? "Size" : "Kích thước"}</dt>
          <dd className="text-foreground tabular-nums">{media.width > 4 && media.height > 3 ? `${media.width} × ${media.height}` : "—"}</dd>
          {media.width > 4 && media.height > 3 && (
            <>
              <dt className="text-muted-foreground">{state.language === "en" ? "Ratio" : "Tỉ lệ"}</dt>
              <dd className="text-foreground tabular-nums">{aspectLabel(media.width, media.height)}</dd>
            </>
          )}
          {Boolean(media.size) && (
            <>
              <dt className="text-muted-foreground">{state.language === "en" ? "File size" : "Dung lượng"}</dt>
              <dd className="text-foreground tabular-nums">{formatBytes(media.size)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{state.language === "en" ? "Modified" : "Sửa lần cuối"}</dt>
          <dd className="text-foreground">{formatDate(media.modified ?? 0, state.language)}</dd>
        </dl>
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
        <DraftTextarea
          key={media.id}
          value={media.notes}
          onCommit={(notes) => updateMedia(media.id, { notes })}
          placeholder={t("notesPlaceholder")}
          rows={4}
          className="w-full resize-none rounded-lg border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </section>
    </div>
  );
}

/**
 * The media's dominant colours, widest share first, as Eagle shows them. Each
 * swatch is as wide as the share it covers; clicking one filters by it.
 */
function MediaPalette({ media, onFilterColor }: { media: MediaItem; onFilterColor?: ((hex: string) => void) | undefined }) {
  const { state } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  // Re-render when this media's palette is measured.
  useSyncExternalStore(subscribeThumbnailStore, thumbnailStoreVersion);
  const palette = thumbnailPalette(media);
  if (!palette?.length) return null;
  const total = palette.reduce((sum, [, share]) => sum + share, 0) || 1;
  const label = c("Lọc theo màu này", "Filter by this colour");
  return (
    <div className="space-y-1.5" data-media-palette>
      <div className="flex h-5 overflow-hidden rounded-md border border-border/70" data-palette-strip>
        {palette.map(([hex, share]) => (
          <button
            key={hex}
            type="button"
            title={`${hex} · ${Math.round(share * 100)}% — ${label}`}
            aria-label={`${label} ${hex}`}
            disabled={!onFilterColor}
            onClick={() => onFilterColor?.(hex)}
            className="h-full transition-[filter] hover:brightness-110 disabled:cursor-default"
            style={{ backgroundColor: hex, flexGrow: share / total, flexBasis: 0 }}
          />
        ))}
      </div>
      {/* Hex codes to paste into a design tool: click one, or take them all. */}
      <div className="flex flex-wrap items-center gap-1">
        {palette.map(([hex]) => (
          <button
            key={hex}
            type="button"
            data-palette-hex={hex}
            onClick={() => { void copyText(hex.toUpperCase(), state.language); }}
            title={c("Sao chép mã màu", "Copy colour code")}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <span className="size-2.5 rounded-full border border-black/10" style={{ backgroundColor: hex }} />
            {hex.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          data-palette-copy-all
          onClick={() => { void copyText(paletteText(palette), state.language, c("bảng màu", "the palette")); }}
          title={c("Sao chép cả bảng màu", "Copy the whole palette")}
          aria-label={c("Sao chép cả bảng màu", "Copy the whole palette")}
          className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Copy className="size-3" />
        </button>
      </div>
    </div>
  );
}
