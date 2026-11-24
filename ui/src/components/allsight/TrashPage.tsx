import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, CheckSquare, Folder, RotateCcw, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import { getInDeckBridge, type InDeckProfile } from "@/lib/indeck/bridge";
import { cn } from "@/lib/utils";
import { LazyThumbnail } from "./Thumbnail";
import type { MediaItem, PersonalFolder } from "@/lib/allsight/types";
import type { ConfirmRequest } from "./ConfirmDialog";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Selection keys: `folder:<galleryId>` for a deleted Gallery, `media:<id>` for
 * media hidden from Main Gallery, `gallery-media:<galleryId>:<id>` for media
 * hidden from one Gallery.
 */
export function TrashPage({ onBack, onConfirm, confirmDialog }: {
  onBack: () => void;
  onConfirm: (request: ConfirmRequest) => void;
  /** The shared confirmation dialog, rendered inside this page. */
  confirmDialog?: ReactNode;
}) {
  const t = useT();
  const { state, restoreMedia, restoreFromFolderTrash, restoreFolder, purgeMedia, purgeFolder, purgeFromFolderTrash } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  const [selected, setSelected] = useState<string[]>([]);
  const [discardedProfiles, setDiscardedProfiles] = useState<InDeckProfile[]>([]);
  const [permanentTarget, setPermanentTarget] = useState<InDeckProfile | null>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const [working, setWorking] = useState(false);

  const refreshDiscardedProfiles = useCallback(async () => {
    const bridge = getInDeckBridge();
    if (!bridge) return;
    try {
      setDiscardedProfiles(await bridge.listDiscardedProfiles());
    } catch (error) {
      toast.error(errorMessage(error, c("Không thể tải Profile đã xóa.", "Could not load deleted Profiles.")));
    }
  }, [state.language]);

  useEffect(() => { void refreshDiscardedProfiles(); }, [refreshDiscardedProfiles]);

  const mediaById = useMemo(() => new Map(state.media.map((media) => [media.id, media])), [state.media]);
  const galleryTrash = useMemo(() => state.folders.flatMap((gallery) => (gallery.discardedMediaIds ?? [])
    .map((mediaId) => ({ gallery, media: mediaById.get(mediaId) }))
    .filter((entry): entry is { gallery: PersonalFolder; media: MediaItem } => !!entry.media)), [mediaById, state.folders]);
  const hidden = useMemo(() => state.media.filter((media) => media.hidden), [state.media]);
  const allKeys = useMemo(() => [
    ...state.trashFolders.map((folder) => `folder:${folder.id}`),
    ...hidden.map((media) => `media:${media.id}`),
    ...galleryTrash.map(({ gallery, media }) => `gallery-media:${gallery.id}:${media.id}`),
  ], [galleryTrash, hidden, state.trashFolders]);
  // Drop keys whose item has left the Trash some other way.
  const selectedKeys = selected.filter((key) => allKeys.includes(key));
  const allSelected = allKeys.length > 0 && selectedKeys.length === allKeys.length;

  const select = (event: React.MouseEvent, key: string) => {
    if (event.ctrlKey || event.metaKey) {
      setSelected((items) => items.includes(key) ? items.filter((item) => item !== key) : [...items, key]);
      return;
    }
    if (event.shiftKey && selectedKeys.length) {
      const anchor = allKeys.indexOf(selectedKeys[selectedKeys.length - 1]!);
      const target = allKeys.indexOf(key);
      const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
      setSelected(allKeys.slice(from, to + 1));
      return;
    }
    setSelected((items) => items.length === 1 && items[0] === key ? [] : [key]);
  };
  const restore = (keys: string[]) => {
    keys.forEach((key) => {
      if (key.startsWith("folder:")) restoreFolder(key.slice("folder:".length));
      else if (key.startsWith("media:")) restoreMedia(key.slice("media:".length));
      else {
        const [galleryId, mediaId] = key.slice("gallery-media:".length).split(":");
        if (galleryId && mediaId) restoreFromFolderTrash(galleryId, mediaId);
      }
    });
    setSelected([]);
    toast.success(c(`Đã khôi phục ${keys.length} mục.`, `Restored ${keys.length} item(s).`));
  };
  const purge = (keys: string[]) => {
    keys.forEach((key) => {
      if (key.startsWith("folder:")) purgeFolder(key.slice("folder:".length));
      // Hidden from Main Gallery: gone from Mosaic for good. Its file stays
      // where it is, so the removal is remembered or a rescan would bring it
      // straight back.
      else if (key.startsWith("media:")) purgeMedia(key.slice("media:".length), { remember: true });
      // Hidden from one Gallery: that Gallery forgets it. It used to be erased
      // from the whole Library, including every other Gallery it was in.
      else {
        const [galleryId, mediaId] = key.slice("gallery-media:".length).split(":");
        if (galleryId && mediaId) purgeFromFolderTrash(galleryId, mediaId);
      }
    });
    setSelected([]);
  };
  // Deleting forever cannot be undone, so it always asks first.
  const confirmPurge = (keys: string[]) => onConfirm({
    title: c(`Xóa vĩnh viễn ${keys.length} mục?`, `Delete ${keys.length} item(s) forever?`),
    description: c(
      "Không thể hoàn tác. File gốc trên máy không bị xóa; media chỉ bị gỡ khỏi Mosaic (hoặc khỏi Gallery tương ứng).",
      "This cannot be undone. Original files on disk are not deleted; media is only removed from Mosaic (or from its Gallery).",
    ),
    confirmLabel: t("deleteForever"),
    onConfirm: () => purge(keys),
  });
  const restoreProfile = async (profile: InDeckProfile) => {
    const bridge = getInDeckBridge();
    if (!bridge) return;
    setWorking(true);
    try {
      await bridge.recoverProfile(profile.id);
      await refreshDiscardedProfiles();
      toast.success(c("Đã khôi phục Profile.", "Profile restored."));
    } catch (error) {
      toast.error(errorMessage(error, c("Không thể khôi phục Profile.", "Could not restore the Profile.")));
    } finally {
      setWorking(false);
    }
  };
  const permanentlyDeleteProfile = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !permanentTarget) return;
    setWorking(true);
    try {
      await bridge.permanentlyDeleteProfile(permanentTarget.id, confirmationName);
      setPermanentTarget(null);
      setConfirmationName("");
      await refreshDiscardedProfiles();
      toast.success(c("Profile đã được xóa vĩnh viễn.", "Profile permanently deleted."));
    } catch (error) {
      toast.error(errorMessage(error, c("Không thể xóa vĩnh viễn Profile.", "Could not permanently delete the Profile.")));
    } finally {
      setWorking(false);
    }
  };
  const isSelected = (key: string) => selectedKeys.includes(key);
  const card = (key: string, media: MediaItem, label?: string) => (
    <button
      key={key}
      onClick={(event) => select(event, key)}
      onDoubleClick={() => restore([key])}
      title={c("Nhấp đúp để khôi phục", "Double-click to restore")}
      className={cn("group overflow-hidden rounded-xl border border-border/65 bg-secondary/20 text-left transition-colors hover:border-border", isSelected(key) && "border-primary bg-primary/10 ring-1 ring-primary")}
    >
      <div className="relative aspect-[4/3] bg-muted/55">
        <LazyThumbnail thumbnailSize={160} className="size-full object-cover" media={media} />
        {label && <span className="absolute top-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">{label}</span>}
      </div>
      <p className="truncate px-2.5 py-2 text-sm font-medium">{media.name}</p>
    </button>
  );
  const sectionTitle = (label: string, count: number) => (
    <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
      {label}<span className="rounded-md bg-secondary/60 px-1.5 py-0.5 text-[10px] tabular-nums">{count}</span>
    </h2>
  );
  const total = allKeys.length + discardedProfiles.length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="glass-panel flex shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0 px-5 py-3">
        <button onClick={onBack} className="glass-btn inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium"><ArrowLeft className="size-4" />{t("backToLibrary")}</button>
        <div className="min-w-0">
          <h1 className="font-display text-lg font-semibold">{t("trash")}</h1>
          <p className="truncate text-xs text-muted-foreground">{t("trashHint")}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {allKeys.length > 0 && (
            <button
              onClick={() => setSelected(allSelected ? [] : allKeys)}
              className={cn("glass-btn flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium", allSelected && "bg-primary/20")}
            >
              <CheckSquare className="size-3.5" /> {allSelected ? t("deselectAll") : t("selectAll")}
            </button>
          )}
          {selectedKeys.length > 0 && (
            <>
              <span className="px-1 text-xs text-muted-foreground tabular-nums">{c(`${selectedKeys.length} đã chọn`, `${selectedKeys.length} selected`)}</span>
              <button onClick={() => restore(selectedKeys)} className="glass-btn flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium"><RotateCcw className="size-3.5" /> {t("restore")}</button>
              <button onClick={() => confirmPurge(selectedKeys)} className="flex h-8 items-center gap-1.5 rounded-lg border border-destructive/30 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"><Trash2 className="size-3.5" /> {t("deleteForever")}</button>
            </>
          )}
        </div>
      </header>
      <main className="app-scroll min-h-0 flex-1 overflow-y-auto p-6">
        {total === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-sm text-muted-foreground"><Trash2 className="size-7 opacity-60" />{t("emptyTrash")}</div>
        ) : (
          <div className="space-y-7">
            {discardedProfiles.length > 0 && (
              <section>
                {sectionTitle(c("Profile đã xóa", "Deleted Profiles"), discardedProfiles.length)}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {discardedProfiles.map((profile) => (
                    <div key={profile.id} className="rounded-xl border border-border/65 bg-secondary/20 p-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary"><UserRound className="size-4" /></span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{profile.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{profile.mediaPath || c("Chưa thiết lập Library", "Library is not configured")}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button disabled={working} onClick={() => void restoreProfile(profile)} className="glass-btn flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-medium disabled:opacity-45"><RotateCcw className="size-3.5" /> {t("restore")}</button>
                        <button disabled={working} onClick={() => { setPermanentTarget(profile); setConfirmationName(""); }} title={t("deleteForever")} className="grid size-8 place-items-center rounded-lg border border-destructive/25 text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground disabled:opacity-45"><Trash2 className="size-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {state.trashFolders.length > 0 && (
              <section>
                {sectionTitle(t("deletedGalleries"), state.trashFolders.length)}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                  {state.trashFolders.map((folder) => {
                    const key = `folder:${folder.id}`;
                    const cover = mediaById.get(folder.coverId ?? folder.mediaIds[0] ?? "");
                    return (
                      <button key={folder.id} onClick={(event) => select(event, key)} onDoubleClick={() => restore([key])} className={cn("overflow-hidden rounded-xl border border-border/65 bg-secondary/20 text-left transition-colors hover:border-border", isSelected(key) && "border-primary ring-1 ring-primary")}>
                        <span className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-muted">
                          {cover ? <LazyThumbnail media={cover} thumbnailSize={320} className="size-full object-cover opacity-80" /> : <Folder className="size-8 text-muted-foreground" />}
                        </span>
                        <span className="block px-3 py-2">
                          <span className="block truncate text-sm font-medium">{folder.name}</span>
                          <span className="block text-xs text-muted-foreground">{t("count", { count: folder.mediaIds.length })}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            {hidden.length > 0 && (
              <section>
                {sectionTitle(t("hiddenImages"), hidden.length)}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{hidden.map((media) => card(`media:${media.id}`, media))}</div>
              </section>
            )}
            {galleryTrash.length > 0 && (
              <section>
                {sectionTitle(t("galleryRemovedMedia"), galleryTrash.length)}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{galleryTrash.map(({ gallery, media }) => card(`gallery-media:${gallery.id}:${media.id}`, media, gallery.name))}</div>
              </section>
            )}
          </div>
        )}
      </main>
      <Dialog open={Boolean(permanentTarget)} onOpenChange={(open) => { if (!open) { setPermanentTarget(null); setConfirmationName(""); } }}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-destructive">{c("Xóa vĩnh viễn Profile", "Permanently delete Profile")}</DialogTitle>
            <DialogDescription>{c("Profile này sẽ không thể khôi phục lại. Dữ liệu Library và MosaicMedia vẫn được giữ nguyên.", "This Profile will no longer be recoverable. Library data and MosaicMedia remain intact.")}</DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5 text-sm">
            <span>{c("Nhập", "Type")} <b>{permanentTarget?.name}</b> {c("để xác nhận", "to confirm")}</span>
            <input
              autoFocus
              value={confirmationName}
              onChange={(event) => setConfirmationName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && confirmationName.trim() && !working) void permanentlyDeleteProfile(); }}
              className="w-full rounded-xl border border-border/70 bg-background/55 px-3 py-2 text-sm outline-none transition focus:border-primary/55 focus:ring-2 focus:ring-ring"
            />
          </label>
          <DialogFooter className="gap-2">
            <button onClick={() => setPermanentTarget(null)} disabled={working} className="glass-btn rounded-xl px-4 py-2 text-sm">{c("Hủy", "Cancel")}</button>
            <button onClick={() => void permanentlyDeleteProfile()} disabled={!confirmationName.trim() || working} className="rounded-xl bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-45">{t("deleteForever")}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
