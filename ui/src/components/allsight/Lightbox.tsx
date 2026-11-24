import { useEffect, useRef, useState } from "react";
import { AppWindow, ArrowLeft, ChevronLeft, ChevronRight, Code2, Copy, FolderOpen, Heart, Image as ImageIcon, Link2, Maximize2, Minimize2, Pipette, Play, Scan } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { LazyThumbnail } from "./Thumbnail";
import { displayUrl, needsDerivedPreview } from "@/lib/allsight/thumbnail-resource-manager";
import { canDragOut, copySvgMarkup, copyText, isSvgMedia, openWithChooser, startExternalDrag } from "@/lib/allsight/designer-tools";

/** Chromium's screen colour picker (EyeDropper API). */
type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };

const MAX_ZOOM = 8;
const ZOOM_STEP = 1.18;

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
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  // When the video last took a pointer press — see the fullscreen handling.
  const lastVideoPointer = useRef(0);
  // The last colour taken with the eyedropper, kept on screen to copy again.
  const [pickedColor, setPickedColor] = useState<string | null>(null);

  /**
   * Keep a zoomed photo within reach. It may travel until its own edge meets
   * the stage edge, plus some slack, in both directions — including along an
   * axis where it is still smaller than the stage, so it can always be moved
   * up and down as well as sideways — but it can never be flung out of view.
   */
  const clampPan = (position: { x: number; y: number }, scale: number) => {
    const stage = stageRef.current?.getBoundingClientRect();
    const media = mediaRef.current;
    if (!stage || !media || scale <= 1) return { x: 0, y: 0 };
    const width = media.offsetWidth * scale;
    const height = media.offsetHeight * scale;
    const limitX = Math.max(0, (width - stage.width) / 2) + Math.min(width, stage.width) * 0.4;
    const limitY = Math.max(0, (height - stage.height) / 2) + Math.min(height, stage.height) * 0.4;
    return {
      x: Math.max(-limitX, Math.min(limitX, position.x)),
      y: Math.max(-limitY, Math.min(limitY, position.y)),
    };
  };

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

  // Zoom is per media: moving to the next photo starts at fit again.
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [item?.id]);

  // The media whose original has finished decoding; until then its thumbnail
  // stands in for it.
  const [loadedId, setLoadedId] = useState<string | null>(null);

  // Decode the photos on either side ahead of time so stepping through them
  // shows the original at once instead of waiting on a large file each time.
  const previousMedia = items.length > 1 ? items[(index - 1 + items.length) % items.length] : undefined;
  const nextMedia = items.length > 1 ? items[(index + 1) % items.length] : undefined;
  const preloadUrls = [nextMedia, previousMedia]
    .filter((media): media is MediaItem => media?.type === "image" && Boolean(media.originalUrl) && !needsDerivedPreview(media))
    .map((media) => media.originalUrl);
  // RAW, HEIC, TIFF and PSD originals cannot be shown by Chromium; the
  // Lightbox shows a 2048 px JPEG main.js derives from them. Build the
  // neighbours' too, so stepping through a shoot does not wait on each one.
  const derived = Boolean(item && needsDerivedPreview(item));
  const [derivedView, setDerivedView] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!derived || !item) return;
    let live = true;
    const current = item;
    void displayUrl(current).then((url) => { if (live && url) setDerivedView({ id: current.id, url }); });
    for (const media of [nextMedia, previousMedia]) if (media && needsDerivedPreview(media)) void displayUrl(media);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, derived, nextMedia?.id, previousMedia?.id]);
  const imageSource = derived ? (derivedView?.id === item?.id ? derivedView?.url : undefined) : item?.originalUrl;
  const preloadKey = preloadUrls.join("\n");
  useEffect(() => {
    if (!preloadKey) return;
    for (const url of preloadKey.split("\n")) {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      void image.decode().catch(() => {});
    }
  }, [preloadKey]);

  // Keep the point under the cursor still while the scale changes, so the wheel
  // zooms into whatever the user is pointing at rather than the frame centre.
  const zoomAt = (factor: number, clientX: number, clientY: number, frame: DOMRect) => {
    const ceiling = Math.max(MAX_ZOOM, nativeZoom() * 4);
    setZoom((current) => {
      const next = Math.min(ceiling, Math.max(1, current * factor));
      if (next === current) return current;
      const offsetX = clientX - (frame.left + frame.width / 2);
      const offsetY = clientY - (frame.top + frame.height / 2);
      const ratio = next / current;
      setPan((position) => next === 1
        ? { x: 0, y: 0 }
        : clampPan({ x: offsetX - (offsetX - position.x) * ratio, y: offsetY - (offsetY - position.y) * ratio }, next));
      return next;
    });
  };

  // Chromium keeps Esc for itself while a video is in native fullscreen: the
  // key leaves fullscreen and is never shown to the page, so the keydown
  // handler below cannot see it. That is why Esc on a fullscreen video only
  // sometimes closed this view. The exit itself is visible, though, and one
  // the user clicked for — the controls' button, a double-click — comes right
  // after a pointer press on the video. Any other exit is that Esc.
  useEffect(() => {
    const onFullscreenChange = () => {
      if (document.fullscreenElement) return;
      if (performance.now() - lastVideoPointer.current > 1500) onClose();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // A video that was put into native fullscreen swallows the first Esc
        // to leave fullscreen, so the lightbox appeared to ignore it. Leave
        // fullscreen and close in the same keypress.
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        onClose();
      }
      // Moving to another media replaces the video element, which also ends
      // its fullscreen. That exit is not an Esc, so it must not close.
      if (event.key === "ArrowRight") { lastVideoPointer.current = performance.now(); onIndex((index + 1) % items.length); }
      if (event.key === "ArrowLeft") { lastVideoPointer.current = performance.now(); onIndex((index - 1 + items.length) % items.length); }
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
    // Capture phase: a context menu or dialog left mounted over the lightbox
    // handles Escape first and stops it, which is the other way Esc could go
    // nowhere. Seeing the key on the way down keeps closing reliable.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (hideSpeedTimer.current) window.clearTimeout(hideSpeedTimer.current);
    };
  }, [index, items.length, onClose, onIndex]);

  if (!item) return null;

  /**
   * The zoom at which one image pixel is one screen pixel. The element's
   * layout width is its size at zoom 1 (the transform does not change it);
   * the media's own width is the original's, so this holds for a derived
   * 2048 px view of a RAW too.
   */
  function nativeZoom() {
    const shown = mediaRef.current?.offsetWidth || 0;
    const current = items[index];
    if (!shown || !current?.width) return 1;
    return (current.width / shown) * window.devicePixelRatio ** -1;
  }
  const actualScale = item.type === "image" ? zoom / nativeZoom() : 1;
  const showOneToOne = () => {
    const target = nativeZoom();
    setPan({ x: 0, y: 0 });
    setZoom(Math.max(1, target));
  };
  const pickColor = async () => {
    const Dropper = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    if (!Dropper) {
      toast.error(c("Công cụ hút màu không có trên máy này.", "The colour picker is not available here."));
      return;
    }
    try {
      const { sRGBHex } = await new Dropper().open();
      const hex = sRGBHex.toUpperCase();
      setPickedColor(hex);
      void copyText(hex, state.language);
    } catch { /* Esc cancels the pick. */ }
  };

  const copyImageToClipboard = async () => {
    if (item.type !== "image") return;
    const copied = await getInDeckBridge()?.copyImage(item).catch(() => false) ?? false;
    if (copied) toast.success(state.language === "vi" ? "Đã sao chép ảnh." : "Image copied.");
    else toast.error(state.language === "vi" ? "Không thể sao chép ảnh." : "Unable to copy image.");
  };
  const openInFolder = async () => {
    const opened = await getInDeckBridge()?.showInFolder(item).catch(() => false) ?? false;
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
  // Until the original arrives the <img> has no intrinsic size, so give it the
  // box it is about to fill from the source metadata. The thumbnail shown
  // underneath then sits exactly where the photo will appear.
  const originalReady = loadedId === item.id;
  const loadingStyle = {
    width: state.lightboxFitMedia
      ? `min(82vw, calc(78vh * ${mediaRatio}))`
      : `min(${item.width ? `${item.width}px, ` : ""}calc(100vw - 8rem), calc(78vh * ${mediaRatio}))`,
    aspectRatio: `${mediaRatio}`,
  };

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
          {pickedColor && (
            <button
              type="button"
              data-picked-color={pickedColor}
              onClick={() => { void copyText(pickedColor, state.language); }}
              title={c("Sao chép mã màu", "Copy colour code")}
              className="glass-panel inline-flex h-9 items-center gap-2 rounded-lg px-2.5 font-mono text-xs"
            >
              <span className="size-4 rounded-full border border-white/40" style={{ backgroundColor: pickedColor }} />
              {pickedColor}
            </button>
          )}
          <button
            type="button"
            onClick={() => { void pickColor(); }}
            title={c("Hút màu trên màn hình (Esc để huỷ)", "Pick a colour from the screen (Esc to cancel)")}
            aria-label={c("Hút màu", "Pick colour")}
            data-eyedropper
            className="glass-panel grid size-9 place-items-center rounded-lg text-foreground transition-all hover:scale-[1.04]"
          >
            <Pipette className="size-4" />
          </button>
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

      <div
        ref={stageRef}
        className="relative flex flex-1 touch-none items-center justify-center overflow-hidden px-16 pb-10"
        // A photo is a native drag source: pressing on it and moving started
        // the browser's own image drag, which cancelled the pointer stream —
        // so a zoomed photo could not be panned at all.
        // At fit zoom, dragging hands the file to the OS instead, so it can be
        // dropped into another app.
        onDragStart={(event) => {
          event.preventDefault();
          if (zoom === 1 && item.type === "image") startExternalDrag([item]);
        }}
        onWheel={(event) => {
          // A video keeps its own controls and timeline; only stills zoom.
          if (item.type === "video" || event.deltaY === 0) return;
          zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
        }}
        onPointerDown={(event) => {
          if (zoom === 1 || event.button !== 0) return;
          // The arrows and the zoom controls keep their own clicks.
          if ((event.target as HTMLElement).closest("button")) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          panStart.current = { x: event.clientX, y: event.clientY, pan };
          setPanning(true);
        }}
        onPointerMove={(event) => {
          const start = panStart.current;
          if (!start) return;
          setPan(clampPan({ x: start.pan.x + (event.clientX - start.x), y: start.pan.y + (event.clientY - start.y) }, zoom));
        }}
        onPointerUp={() => { panStart.current = null; setPanning(false); }}
        onPointerCancel={() => { panStart.current = null; setPanning(false); }}
        onLostPointerCapture={() => { panStart.current = null; setPanning(false); }}
        onDoubleClick={(event) => {
          if (item.type === "video") return;
          if (zoom > 1) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
          zoomAt(2, event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
        }}
      >
        <button
          onClick={() => onIndex((index - 1 + items.length) % items.length)}
          aria-label={t("previous")}
          className="glass-panel absolute left-5 inline-flex size-11 items-center justify-center rounded-full transition-transform hover:scale-105"
        >
          <ChevronLeft className="size-5" />
        </button>

        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={mediaRef}
              className="relative flex max-h-full max-w-full items-center justify-center"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                cursor: zoom > 1 ? (panning ? "grabbing" : "grab") : "default",
                willChange: zoom > 1 ? "transform" : undefined,
              }}
            >
              {item.type === "video" ? (
                <>
                  <video
                    ref={videoRef}
                    key={item.id}
                    src={item.originalUrl}
                    controls
                    autoPlay
                    onPointerDown={() => { lastVideoPointer.current = performance.now(); }}
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
                <>
                  {!originalReady && (
                    <LazyThumbnail media={item} priority thumbnailSize={512} className="absolute inset-0 size-full rounded-[13px]" />
                  )}
                  <img
                    key={item.id}
                    src={imageSource}
                    alt={item.name}
                    draggable={zoom === 1 && canDragOut(item)}
                    decoding="async"
                    // Reveal the original only once it is decoded, so the
                    // swap from the thumbnail never shows an empty frame. A
                    // file that fails to load keeps the thumbnail on screen.
                    onLoad={(event) => {
                      const id = item.id;
                      void event.currentTarget.decode().catch(() => {}).then(() => setLoadedId(id));
                    }}
                    className={cn("relative", mediaSizeClass, !originalReady && "opacity-0")}
                    style={{
                      ...(originalReady ? fitStyle : loadingStyle),
                      // Past 2:1, show the real pixels rather than a blur, so
                      // edges and artefacts can be inspected. A derived view
                      // or an SVG has no original pixels to show.
                      imageRendering: actualScale >= 2 && !derived && !isSvgMedia(item) ? "pixelated" : undefined,
                    }}
                  />
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="glass-float w-56 rounded-xl">
            {item.type === "image" && (
              <ContextMenuItem className="gap-2" onSelect={() => { void copyImageToClipboard(); }}>
                <Copy className="size-4" /> {t("copyImage")}
              </ContextMenuItem>
            )}
            {isSvgMedia(item) && (
              <ContextMenuItem className="gap-2" onSelect={() => { void copySvgMarkup(item, state.language); }}>
                <Code2 className="size-4" /> {c("Sao chép mã SVG", "Copy SVG code")}
              </ContextMenuItem>
            )}
            <ContextMenuItem className="gap-2" onSelect={() => { void openInFolder(); }}>
              <FolderOpen className="size-4" /> {t("openInFolder")}
            </ContextMenuItem>
            <ContextMenuItem className="gap-2" disabled={!canDragOut(item)} onSelect={() => { void copyText(item.path, state.language, c("đường dẫn", "the path")); }}>
              <Link2 className="size-4" /> {c("Sao chép đường dẫn", "Copy path")}
            </ContextMenuItem>
            <ContextMenuItem className="gap-2" disabled={!canDragOut(item)} onSelect={() => { void openWithChooser(item, state.language); }}>
              <AppWindow className="size-4" /> {c("Mở bằng…", "Open with…")}
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

        <div className="absolute right-5 bottom-5 flex items-center gap-2">
          {item.type === "image" && (
            <>
              {/* Scale against the original's pixels, not against the fit. */}
              <button
                type="button"
                data-zoom-actual
                onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                disabled={zoom === 1}
                title={c("Tỉ lệ so với pixel gốc · bấm để về vừa khung", "Scale of the original pixels · click to fit")}
                className="glass-panel inline-flex h-10 items-center rounded-xl px-3 text-xs font-medium tabular-nums transition-all enabled:hover:scale-[1.04]"
              >
                {Math.round(actualScale * 100)}%
              </button>
              <button
                type="button"
                data-zoom-native
                onClick={showOneToOne}
                title={c("Xem đúng pixel (1:1)", "Actual pixels (1:1)")}
                aria-label={c("Xem đúng pixel (1:1)", "Actual pixels (1:1)")}
                className={cn("glass-panel inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-medium transition-all hover:scale-[1.04]", Math.abs(actualScale - 1) < 0.02 && "text-primary")}
              >
                <Scan className="size-4" /> 1:1
              </button>
            </>
          )}
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
