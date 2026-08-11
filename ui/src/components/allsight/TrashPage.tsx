import { useEffect, useState } from "react";
import { ArrowLeft, Folder, RotateCcw, Trash2 } from "lucide-react";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { cn } from "@/lib/utils";
import type { MediaItem, PersonalFolder } from "@/lib/allsight/types";

function Preview({ media }: { media: MediaItem }) {
  const { setMediaPreview } = useAllsight();
  useEffect(() => {
    if (media.url) return;
    const bridge = getInDeckBridge();
    if (!bridge) return;
    let active = true;
    void bridge.ensureThumbnails([{ id: media.id, path: media.path, type: media.type, modified: media.modified, vault: media.vault, contentUrl: media.contentUrl }])
      .then((urls) => { if (active && urls[media.id]) setMediaPreview(media.id, urls[media.id]!); });
    return () => { active = false; };
  }, [media, setMediaPreview]);
  return media.url ? <img src={media.url} alt="" className="size-full object-contain" /> : <span className="grid size-full place-items-center bg-muted text-xs text-muted-foreground">…</span>;
}

export function TrashPage({ onBack }: { onBack: () => void }) {
  const t = useT();
  const { state, restoreMedia, restoreFromFolderTrash, restoreFolder, purgeMedia, purgeFolder } = useAllsight();
  const [selected, setSelected] = useState<string[]>([]);
  const galleryTrash = state.folders.flatMap((gallery) => (gallery.discardedMediaIds ?? []).map((mediaId) => ({ gallery, media: state.media.find((media) => media.id === mediaId) })).filter((entry): entry is { gallery: PersonalFolder; media: MediaItem } => !!entry.media));
  const hidden = state.media.filter((media) => media.hidden);
  const select = (event: React.MouseEvent, key: string) => {
    if (event.ctrlKey || event.metaKey) {
      setSelected((items) => items.includes(key) ? items.filter((item) => item !== key) : [...items, key]);
      return;
    }
    setSelected([key]);
  };
  const restoreSelected = () => {
    selected.forEach((key) => {
      if (key.startsWith("folder:")) restoreFolder(key.slice(7));
      else if (key.startsWith("media:")) restoreMedia(key.slice(6));
      else { const [galleryId, mediaId] = key.slice(14).split(":"); if (galleryId && mediaId) restoreFromFolderTrash(galleryId, mediaId); }
    });
    setSelected([]);
  };
  const purgeSelected = () => { selected.forEach((key) => key.startsWith("folder:") ? purgeFolder(key.slice(7)) : purgeMedia(key.includes(":") ? key.split(":").at(-1)! : key)); setSelected([]); };
  const card = (key: string, media: MediaItem, label?: string) => <button key={key} onClick={(event) => select(event, key)} className={cn("group overflow-hidden rounded-xl border border-border/65 bg-secondary/20 text-left transition-colors", selected.includes(key) && "border-primary bg-primary/10 ring-1 ring-primary")}><div className="relative aspect-[4/3] bg-muted/55"><Preview media={media} />{label && <span className="absolute top-2 left-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">{label}</span>}</div><p className="truncate px-2.5 py-2 text-sm font-medium">{media.name}</p></button>;
  return <div className="flex h-screen flex-col overflow-hidden bg-background"><div className="window-titlebar flex h-[18px] shrink-0 items-center border-b border-border/55"><span className="pl-3 text-[11px] font-medium tracking-wide text-muted-foreground">Mosaic</span></div><main className="app-scroll flex-1 overflow-y-auto p-6"><header className="mb-6 flex items-center gap-3"><button onClick={onBack} className="glass-btn grid size-9 place-items-center rounded-lg"><ArrowLeft className="size-4" /></button><div><h1 className="font-display text-xl font-semibold">{t("trash")}</h1><p className="text-sm text-muted-foreground">{t("trashHint")}</p></div>{selected.length > 0 && <div className="ml-auto flex gap-2"><button onClick={restoreSelected} className="glass-btn flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm"><RotateCcw className="size-4" /> {t("restore")}</button><button onClick={purgeSelected} className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive"><Trash2 className="size-4" /> {t("deleteForever")}</button></div>}</header>{state.trashFolders.length === 0 && hidden.length === 0 && galleryTrash.length === 0 ? <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground">{t("emptyTrash")}</div> : <div className="space-y-7">{state.trashFolders.length > 0 && <section><h2 className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t("deletedGalleries")}</h2><div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">{state.trashFolders.map((folder) => <button key={folder.id} onClick={(event) => select(event, `folder:${folder.id}`)} className={cn("overflow-hidden rounded-xl border border-border/65 bg-secondary/20 text-left", selected.includes(`folder:${folder.id}`) && "border-primary ring-1 ring-primary")}><span className="grid aspect-[4/3] place-items-center bg-muted"><Folder className="size-8 text-muted-foreground" /></span><p className="truncate px-3 py-2 text-sm font-medium">{folder.name}</p></button>)}</div></section>}{hidden.length > 0 && <section><h2 className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t("hiddenImages")}</h2><div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{hidden.map((media) => card(`media:${media.id}`, media))}</div></section>}{galleryTrash.length > 0 && <section><h2 className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{t("galleryRemovedMedia")}</h2><div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{galleryTrash.map(({ gallery, media }) => card(`gallery-media:${gallery.id}:${media.id}`, media, gallery.name))}</div></section>}</div>}</main></div>;
}
