import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { MediaItem } from "@/lib/allsight/types";
import { acquireThumbnail, cachedThumbnail, fallbackThumbnail, leaseThumbnail, subscribeThumbnailStore, thumbnailColor, thumbnailGeneration, thumbnailStoreVersion, type ThumbnailResource } from "@/lib/allsight/thumbnail-resource-manager";
import { cn } from "@/lib/utils";

/** The media's measured thumbnail colour, else a stable hue derived from its id. */
export function placeholderColor(media: MediaItem) {
  const measured = thumbnailColor(media);
  return measured ? `${measured}b8` : hashedColor(media.id);
}

function hashedColor(id: string) {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) value = (value * 31 + id.charCodeAt(index)) >>> 0;
  return `hsl(${value % 360} 28% 32% / 0.72)`;
}

function BitmapThumbnail({ resource, className, style }: { resource: ThumbnailResource; className: string; style: CSSProperties | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const draw = useCallback(() => {
    const element = canvas.current;
    if (!element || !resource.bitmap) return;
    const box = element.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    if (element.width !== width || element.height !== height) { element.width = width; element.height = height; }
    const context = element.getContext("2d", { alpha: false });
    if (!context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    // A canvas has no CSS object-fit. Crop to cover instead of stretching a
    // decoded bitmap into the justified cell: a tiny rounding mismatch (or
    // EXIF orientation) must never visibly deform the photo.
    const sourceRatio = resource.width / resource.height;
    const targetRatio = width / height;
    let sx = 0, sy = 0, sw = resource.width, sh = resource.height;
    if (sourceRatio > targetRatio) {
      sw = resource.height * targetRatio;
      sx = (resource.width - sw) / 2;
    } else if (sourceRatio < targetRatio) {
      sh = resource.width / targetRatio;
      sy = (resource.height - sh) / 2;
    }
    context.drawImage(resource.bitmap, sx, sy, sw, sh, 0, 0, width, height);
  }, [resource]);
  useLayoutEffect(() => {
    draw();
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    return () => observer.disconnect();
  }, [draw]);
  // ImageBitmap is the normal path. Keep a browser-image fallback only for a
  // codec/GPU that cannot construct a bitmap for a particular media file.
  if (!resource.bitmap) return <img src={resource.url} alt="" draggable={false} decoding="async" className={className} style={style} />;
  return <canvas ref={canvas} aria-hidden className={className} style={style} />;
}

/**
 * The one preview surface for a MediaItem. Cards, covers and side panels all
 * read the shared thumbnail cache, so a video or an animated GIF shows the
 * decoded still the Gallery already has instead of falling back to the original
 * file — which an <img> cannot render for a video, and which costs several
 * megabytes of animation for a GIF.
 */
export function LazyThumbnail({ media, className, priority = false, thumbnailSize = 320, thumbnailDistance = Number.MAX_SAFE_INTEGER, style }: { media: MediaItem; className: string; priority?: boolean; thumbnailSize?: number; thumbnailDistance?: number; style?: CSSProperties }) {
  const target = useRef<HTMLSpanElement | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const [resource, setResource] = useState<ThumbnailResource | null>(() => cachedThumbnail(media, thumbnailSize) || fallbackThumbnail(media, thumbnailSize));
  // No thumbnail could be made (missing or unreadable file). Shown as a still
  // placeholder rather than one that pulses as if it were still loading.
  const [failed, setFailed] = useState(false);
  // The placeholder is only in the DOM while there is nothing to draw, so a
  // card recycled onto different media runs its effect before the placeholder
  // exists. Observing from the ref callback covers that ordering; without it a
  // recycled card never requests its thumbnail and stays blank forever.
  const attach = useCallback((node: HTMLSpanElement | null) => {
    target.current = node;
    if (node && observer.current) observer.current.observe(node);
  }, []);
  // `priority` and `thumbnailDistance` are queue-ordering hints, read once when
  // the request is made. In a virtualized Gallery the distance is derived from
  // scrollTop, so it changes on every scroll frame — listing it as a dependency
  // re-ran this effect continuously, which released the lease (cancelling the
  // in-flight request) and re-subscribed to the very promise that cancellation
  // was about to resolve as null. That is why cards went permanently blank and
  // why large Galleries stuttered. Keep them in a ref instead.
  const hints = useRef({ media, priority, thumbnailDistance });
  hints.current = { media, priority, thumbnailDistance };

  // The identity of `media` changes whenever the Library state is rebuilt, so
  // the effect keys off the same fields the thumbnail cache keys off.
  const mediaId = media.id;
  const mediaModified = media.modified;
  const mediaSize = media.size;

  // Repaint the placeholder once measured colours arrive from main.js, and
  // request the rebuilt file after "Regenerate thumbnail".
  useSyncExternalStore(subscribeThumbnailStore, thumbnailStoreVersion);
  const generation = thumbnailGeneration(media.id);

  useEffect(() => {
    let active = true;
    let release = () => {};
    let releaseFallback = () => {};
    const load = () => {
      const current = hints.current;
      const lease = acquireThumbnail(current.media, thumbnailSize, current.priority, current.thumbnailDistance);
      release = lease.release;
      if (lease.resource) {
        setResource(lease.resource);
        releaseFallback();
        return;
      }
      void lease.promise.then((next) => {
        if (!active) return;
        if (next) {
          setResource(next);
          releaseFallback();
        } else setFailed(true);
      });
    };
    // A recycled card and a swapped cover both point this component at
    // different media, so drop the previous photo rather than leave it on
    // screen until the new one decodes. The same media at another size is a
    // different matter: keep that on screen until this size is ready.
    const cached = cachedThumbnail(hints.current.media, thumbnailSize);
    const fallback = cached ? null : fallbackThumbnail(hints.current.media, thumbnailSize);
    if (fallback) releaseFallback = leaseThumbnail(fallback);
    setResource(cached || fallback);
    setFailed(false);
    // A card showing a fallback has no placeholder for the observer to watch,
    // and it was decoded because it was near the viewport, so load right away.
    if (cached || fallback || hints.current.priority) {
      load();
      return () => { active = false; release(); releaseFallback(); };
    }
    const pending = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      pending.disconnect();
      observer.current = null;
      load();
    }, { rootMargin: "600px 0px" });
    observer.current = pending;
    if (target.current) pending.observe(target.current);
    return () => { active = false; pending.disconnect(); observer.current = null; release(); };
  }, [mediaId, mediaModified, mediaSize, generation, thumbnailSize]);

  if (resource) return <BitmapThumbnail resource={resource} className={className} style={style} />;
  return <span ref={attach} className={cn("block", !failed && "animate-pulse", failed && "opacity-60", className)} style={{ backgroundColor: placeholderColor(media), ...style }} />;
}
