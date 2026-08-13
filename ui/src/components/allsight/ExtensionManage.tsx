import { useMemo, useState } from "react";
import { ArrowLeft, Folder, Lock, Search, X } from "lucide-react";
import { useAllsight } from "@/lib/allsight/store";
import { cn } from "@/lib/utils";
import { LockOverlay } from "./LockOverlay";
import { useT } from "@/lib/allsight/i18n";

export function ExtensionManage({ onBack, unlockedFolderIds }: { onBack: () => void; unlockedFolderIds: string[] }) {
  const t = useT();
  const { state, setExtensionGallerySlots } = useAllsight();
  const [query, setQuery] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const galleries = useMemo(
    () =>
      state.folders.filter((folder) =>
        folder.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [query, state.folders],
  );
  const cover = (id: string) => {
    const folder = state.folders.find((item) => item.id === id);
    const media = state.media.find((item) => item.id === (folder?.coverId ?? folder?.mediaIds[0]));
    return media?.url || media?.originalUrl || media?.contentUrl;
  };
  const isLocked = (gallery: { id: string; locked: boolean }) => gallery.locked && !unlockedFolderIds.includes(gallery.id);
  const put = (index: number, id: string) => {
    const next = [...state.extensionGallerySlotIds];
    const old = next.indexOf(id);
    if (old >= 0) next[old] = null;
    next[index] = id;
    setExtensionGallerySlots(next);
  };
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="glass-panel flex items-center gap-3 rounded-none border-x-0 border-t-0 px-5 py-3">
        <button
          onClick={onBack}
          className="glass-btn inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium"
        >
          <ArrowLeft className="size-4" /> {t("backToLibrary")}
        </button>
        <div>
          <h1 className="font-display text-lg font-semibold">{t("extensionManager")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("extensionManagerHint")}
          </p>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 p-4">
        <div className="flex min-h-0 w-full overflow-hidden rounded-2xl border border-border/65 bg-secondary/15">
          <section className="flex w-[32%] min-w-72 flex-col border-r border-border/65 p-4">
            <label className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/45 px-2.5 py-2">
              <Search className="size-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchGalleries")}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>
            <div className="app-scroll mt-3 space-y-1 overflow-y-auto pr-1">
              {galleries.map((gallery) => (
                <button
                  key={gallery.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-indeck-gallery", gallery.id);
                    setDraggedId(gallery.id);
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setOver(null);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-accent/60",
                    draggedId === gallery.id && "opacity-45",
                  )}
                >
                  <span className="relative grid size-9 shrink-0 overflow-hidden rounded-lg bg-muted">
                    {cover(gallery.id) ? (
                      <>
                        <img src={cover(gallery.id)} alt="" className={cn("size-full object-cover", isLocked(gallery) && "scale-105 blur-md")} />
                        {isLocked(gallery) && <LockOverlay size="sm" />}
                      </>
                    ) : (
                      isLocked(gallery) ? <Lock className="m-auto size-4 text-muted-foreground" /> : <Folder className="m-auto size-4 text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {gallery.name}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="flex min-w-0 flex-1 flex-col p-5">
            <div>
              <h2 className="font-display text-lg font-semibold">{t("extensionGallerySlots")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("extensionGallerySlotsHint")}
              </p>
            </div>
            <div className="mt-5 grid min-h-0 flex-1 grid-cols-1 grid-rows-4 gap-3">
              {Array.from({ length: 4 }, (_, index) => {
                const id = state.extensionGallerySlotIds[index];
                const gallery = id ? state.folders.find((item) => item.id === id) : null;
                return (
                  <div
                    key={index}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOver(index);
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      const id =
                        event.dataTransfer.getData("application/x-indeck-gallery") || draggedId;
                      if (id) put(index, id);
                      setOver(null);
                      setDraggedId(null);
                    }}
                    className={cn(
                      "relative flex min-h-0 items-center gap-4 overflow-hidden rounded-2xl border border-dashed p-4 transition-colors",
                      over === index
                        ? "border-primary bg-primary/10 ring-2 ring-primary/35"
                        : "border-border/70 bg-background/35",
                      gallery && "border-solid",
                    )}
                  >
                    {gallery && (
                      <span className="relative grid size-24 shrink-0 overflow-hidden rounded-xl bg-muted shadow-lg">
                        {cover(gallery.id) ? (
                          <>
                            <img src={cover(gallery.id)} alt="" className={cn("size-full object-cover", isLocked(gallery) && "scale-105 blur-md")} />
                            {isLocked(gallery) && <LockOverlay size="md" />}
                          </>
                        ) : isLocked(gallery) ? (
                          <Lock className="m-auto size-6 text-muted-foreground" />
                        ) : (
                          <Folder className="m-auto size-6 text-muted-foreground" />
                        )}
                      </span>
                    )}
                    <div className="relative min-w-0">
                      <span className="text-xs text-muted-foreground">{t("slot", { number: index + 1 })}</span>
                      <p className="truncate text-sm font-semibold">
                        {gallery?.name ?? t("dropGalleryHere")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {gallery ? t("droppedImagesSaved") : ""}
                      </p>
                    </div>
                    {gallery && (
                      <button
                        onClick={() => {
                          const next = [...state.extensionGallerySlotIds];
                          next[index] = null;
                          setExtensionGallerySlots(next);
                        }}
                        className="absolute top-2 right-2 grid size-7 place-items-center rounded-lg bg-black/35 text-white backdrop-blur hover:bg-black/55"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
