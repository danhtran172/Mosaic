import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, FolderOpen, Heart, Image as ImageIcon, Maximize2, Minimize2, Play } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { MediaItem } from "@/lib/allsight/types";
import { useT } from "@/lib/allsight/i18n";
import { useAllsight } from "@/lib/allsight/store";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { toast } from "sonner";

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  currentFolderId,
}: {
  items: MediaItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  currentFolderId: string | null;
}) {
  const t = useT();
  const { state, setLightboxFitMedia, toggleFavorite, updateFolder } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  const item = items[index];
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideSpeedTimer = useRef<number | null>(null);
  const [speedVisible, setSpeedVisible] = useState(false);
  const [speed, setSpeed] = useState(1);

  const syncFullscreenSpeedCue = (video: HTMLVideoElement, visible: boolean) => {
    if (!window.VTTCue) return;
    const track = (video as HTMLVideoElement & { indeckSpeedTrack?: TextTrack }).indeckSpeedTrack
      ?? video.addTextTrack("captions", "Playback speed", "en");
    (video as HTMLVideoElement & { indeckSpeedTrack?: TextTrack }).indeckSpeedTrack = track;
    while (track.cues?.length) track.removeCue(track.cues[0]);
    const cue = new VTTCue(0, 2147483647, `${video.playbackRate.toFixed(2)}×`);
    cue.line = 0;
    cue.position = 100;
    cue.align = "end";
    track.addCue(cue);
    track.mode = document.fullscreenElement === video && visible ? "showing" : "disabled";
  };

  const changeSpeed = (next: number) => {
    const video = videoRef.current;
    if (!video) return;
    const rate = Math.max(0.25, Math.min(4, Math.round(next * 100) / 100));
    video.playbackRate = rate;
    video.defaultPlaybackRate = rate;
    setSpeed(rate);
    setSpeedVisible(true);
    syncFullscreenSpeedCue(video, true);
    if (hideSpeedTimer.current) window.clearTimeout(hideSpeedTimer.current);
    hideSpeedTimer.current = window.setTimeout(() => {
      setSpeedVisible(false);
      syncFullscreenSpeedCue(video, false);
    }, 1000);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") onIndex((index + 1) % items.length);
      if (event.key === "ArrowLeft") onIndex((index - 1 + items.length) % items.length);
      if (!videoRef.current || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === "NumpadAdd") {
        event.preventDefault();
        changeSpeed(videoRef.current.playbackRate + 0.25);
      }
      if (event.code === "NumpadSubtract") {
        event.preventDefault();
        changeSpeed(videoRef.current.playbackRate - 0.25);
      }
      if (event.code === "NumpadMultiply") {
        event.preventDefault();
        changeSpeed(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (hideSpeedTimer.current) window.clearTimeout(hideSpeedTimer.current);
    };
  }, [index, items.length, onClose, onIndex]);

  if (!item) return null;

  const copyImageToClipboard = async () => {
    if (item.type !== "image") return;
    const copied = await getInDeckBridge()?.copyImage(item) ?? false;
    if (copied) toast.success(state.language === "vi" ? "Đã sao chép ảnh." : "Image copied.");
    else toast.error(state.language === "vi" ? "Không thể sao chép ảnh." : "Unable to copy image.");
  };
  const openInFolder = async () => {
    const opened = await getInDeckBridge()?.showInFolder(item) ?? false;
    if (!opened) toast.error(state.language === "vi" ? "Không thể mở vị trí tệp." : "Unable to open the file location.");
  };

  const mediaRatio = Math.max(0.12, Math.min(8, (item.width || 4) / (item.height || 3)));
  const mediaSizeClass = state.lightboxFitMedia
    ? "max-h-[78vh] max-w-[82vw] rounded-[13px] object-contain"
    : "max-h-[78vh] max-w-full rounded-[13px] object-contain";
  // In Fit mode the element itself follows the image ratio. That makes the
  // rounded corners apply to the visible image rather than an empty contain
  // box around it.
  const fitStyle = state.lightboxFitMedia
    ? { width: `min(82vw, calc(78vh * ${mediaRatio}))`, height: "auto" }
    : undefined;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/65 backdrop-blur-[48px]">
      <div className="flex items-center justify-between px-5 py-3">
        <button
          onClick={onClose}
          className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-secondary/60 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          <ArrowLeft className="size-4" />
          {t("backToLibrary")}
        </button>
        <p className="truncate px-4 text-sm text-muted-foreground">{item.name}</p>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-border/70 bg-secondary/60 px-3 py-1.5 text-sm tabular-nums">
            {index + 1} {t("of")} {items.length}
          </span>
          <button
            type="button"
            onClick={() => toggleFavorite(item.id)}
            title={t("favorite")}
            aria-label={t("favorite")}
            aria-pressed={item.favorite}
            className={"glass-panel grid size-9 place-items-center rounded-lg transition-all hover:scale-[1.04] " + (item.favorite ? "text-favorite" : "text-foreground")}
          >
            <Heart className={"size-4 " + (item.favorite ? "fill-favorite" : "")} />
          </button>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-16 pb-10">
        <button
          onClick={() => onIndex((index - 1 + items.length) % items.length)}
          aria-label={t("previous")}
          className="glass-panel absolute left-5 inline-flex size-11 items-center justify-center rounded-full transition-transform hover:scale-105"
        >
          <ChevronLeft className="size-5" />
        </button>

        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="relative flex max-h-full max-w-full items-center justify-center">
              {item.type === "video" ? (
                <>
                  <video
                    ref={videoRef}
                    key={item.id}
                    src={item.originalUrl ?? item.url}
                    controls
                    autoPlay
                    onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)}
                    className={mediaSizeClass}
                    style={fitStyle}
                  />
                  <span className="glass-panel absolute bottom-4 left-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs">
                    <Play className="size-3" /> Video
                  </span>
                  <span className={`glass-panel pointer-events-none absolute right-4 bottom-4 rounded-full px-3 py-1 text-sm transition-opacity ${speedVisible ? "opacity-100" : "opacity-0"}`}>
                    {speed.toFixed(2)}×
                  </span>
                </>
              ) : (
                <img
                  src={item.originalUrl ?? item.url}
                  alt={item.name}
                  className={mediaSizeClass}
                  style={fitStyle}
                />
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="glass-float w-56 rounded-xl">
            {item.type === "image" && (
              <ContextMenuItem className="gap-2" onSelect={() => { void copyImageToClipboard(); }}>
                <Copy className="size-4" /> {t("copyImage")}
              </ContextMenuItem>
            )}
            <ContextMenuItem className="gap-2" onSelect={() => { void openInFolder(); }}>
              <FolderOpen className="size-4" /> {t("openInFolder")}
            </ContextMenuItem>
            {currentFolderId && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem className="gap-2" onSelect={() => updateFolder(currentFolderId, { coverId: item.id })}>
                  <ImageIcon className="size-4" /> {t("setFolderCover")}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>

        <button
          onClick={() => onIndex((index + 1) % items.length)}
          aria-label={t("next")}
          className="glass-panel absolute right-5 inline-flex size-11 items-center justify-center rounded-full transition-transform hover:scale-105"
        >
          <ChevronRight className="size-5" />
        </button>

        <div className="absolute right-5 bottom-5">
          <button
            type="button"
            onClick={() => setLightboxFitMedia(!state.lightboxFitMedia)}
            title={state.lightboxFitMedia ? c("Kích thước gốc", "Original size") : c("Phóng to", "Zoom in")}
            aria-label={state.lightboxFitMedia ? c("Kích thước gốc", "Original size") : c("Phóng to", "Zoom in")}
            className={"glass-panel inline-flex h-10 items-center gap-2 rounded-xl px-3 text-xs font-medium transition-all hover:scale-[1.04] " + (state.lightboxFitMedia ? "text-primary" : "text-foreground")}
          >
            {state.lightboxFitMedia ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            <span>{state.lightboxFitMedia ? c("Kích thước gốc", "Original size") : c("Phóng to", "Zoom in")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
