import { getInDeckBridge } from "@/lib/indeck/bridge";
import type { MediaItem } from "./types";

/**
 * Runtime thumbnail resources deliberately live outside the Library/React
 * state. A source rescan rebuilds metadata, but must not invalidate decoded
 * thumbnails that are still useful while the user is scrolling.
 */
export type ThumbnailResource = {
  key: string;
  url: string;
  bitmap: ImageBitmap | null;
  width: number;
  height: number;
  bytes: number;
  leases: number;
  lastUsed: number;
};

type PendingResource = {
  requestId: string;
  consumers: Set<symbol>;
  promise: Promise<ThumbnailResource | null>;
};

export type ThumbnailLease = {
  resource: ThumbnailResource | null;
  promise: Promise<ThumbnailResource | null>;
  release: () => void;
};

const resources = new Map<string, ThumbnailResource>();
const pending = new Map<string, PendingResource>();
const urls = new Map<string, string>();
let usedBytes = 0;

function decodedBudgetBytes() {
  const memoryGb = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8);
  // Decoded 320px RGBA thumbs take ~0.4 MB each. This keeps roughly one to
  // two thousand recently viewed cards warm on typical desktops, while still
  // reserving the majority of RAM for the app, browser and operating system.
  return Math.max(256, Math.min(768, memoryGb * 80)) * 1024 * 1024;
}

function keyFor(media: MediaItem, size: number) {
  return `${revisionOf(media)}:g${generations.get(media.id) || 0}:${size}`;
}

/** Same identity main.js uses for the cache: a replaced file with an unchanged mtime still differs in size. */
function revisionOf(media: MediaItem) {
  return `${media.id}:${media.modified || 0}:${media.size || 0}`;
}

// Average thumbnail colour by media id, measured in main.js. Placeholders use
// it so an undecoded card already reads as its media rather than a random hue.
type ColorEntry = { revision: string; color: string | null; palette?: Array<[string, number]> };
const colors = new Map<string, ColorEntry>();
let colorsRequested = false;
// Bumped by "Regenerate thumbnail". It is part of the cache key, so every card
// showing that media requests the rebuilt file instead of its decoded copy.
const generations = new Map<string, number>();
let storeVersion = 0;
const storeListeners = new Set<() => void>();

function notify() {
  storeVersion += 1;
  storeListeners.forEach((listener) => listener());
}

/** Load every colour main.js has measured for this Profile. Safe to call repeatedly. */
function loadThumbnailColors() {
  if (colorsRequested) return;
  colorsRequested = true;
  void getInDeckBridge()?.thumbnailColors?.().then((entries) => {
    for (const [id, entry] of Object.entries(entries || {})) {
      if (entry && !colors.has(id)) colors.set(id, entry);
    }
    // Placeholders paint before this IPC settles, so tell them to repaint.
    notify();
  }, () => { colorsRequested = false; });
}

/** useSyncExternalStore subscription: placeholder colours loaded, or a thumbnail regenerated. */
export function subscribeThumbnailStore(listener: () => void) {
  storeListeners.add(listener);
  loadThumbnailColors();
  return () => { storeListeners.delete(listener); };
}

export function thumbnailStoreVersion() {
  return storeVersion;
}

export function thumbnailGeneration(mediaId: string) {
  return generations.get(mediaId) || 0;
}

function bridgeAsset(media: MediaItem) {
  return { id: media.id, path: media.path, type: media.type, modified: media.modified, size: media.size, vault: media.vault, contentUrl: media.contentUrl };
}

/** Throw away every cached thumbnail of these media, on disk and decoded, so they are rebuilt. */
export async function regenerateThumbnails(medias: MediaItem[]) {
  const bridge = getInDeckBridge();
  if (!bridge?.regenerateThumbnails || !medias.length) return;
  await bridge.regenerateThumbnails(medias.map(bridgeAsset));
  for (const media of medias) {
    const prefix = `${revisionOf(media)}:g${generations.get(media.id) || 0}:`;
    for (const [key, resource] of [...resources]) {
      if (!key.startsWith(prefix)) continue;
      resources.delete(key);
      usedBytes -= resource.bytes;
      // A card still drawing it keeps the bitmap until it switches over.
      if (!resource.leases) resource.bitmap?.close();
    }
    for (const key of [...urls.keys()]) if (key.startsWith(prefix)) urls.delete(key);
    generations.set(media.id, (generations.get(media.id) || 0) + 1);
    colors.delete(media.id);
  }
  notify();
}

/**
 * The derived JPEG the Lightbox shows for a still Chromium cannot display
 * (RAW, HEIC, TIFF, PSD). main.js builds it at 2048 px on demand.
 */
export async function displayUrl(media: MediaItem) {
  const key = keyFor(media, DISPLAY_SIZE);
  const known = urls.get(key);
  if (known) return known;
  const result = await getInDeckBridge()?.ensureThumbnails([{ ...bridgeAsset(media), thumbnailSize: DISPLAY_SIZE, thumbnailPriority: "high", thumbnailDistance: 0 }]);
  const url = result?.[media.id]?.url;
  if (!url) return null;
  const versioned = withGeneration(url, media.id);
  urls.set(key, versioned);
  return versioned;
}
const DISPLAY_SIZE = 2048;

// Mirrors derivedImageExtensions in main.js.
const DERIVED_IMAGE = /\.(?:tiff?|heic|heif|psd|dng|cr2|cr3|nef|nrw|arw|raf|orf|rw2|pef|srw)$/i;

/** A still Chromium cannot display, shown through a derived JPEG instead of its original. */
export function needsDerivedPreview(media: MediaItem) {
  return media.type === "image" && DERIVED_IMAGE.test(media.name || media.path || "");
}

// A regenerated thumbnail keeps its file name, so the URL changes with the
// generation; otherwise Chromium would serve the old image from memory.
function withGeneration(url: string, mediaId: string) {
  const generation = generations.get(mediaId) || 0;
  return generation ? `${url}?g=${generation}` : url;
}

/** The measured colour for this exact revision of the media, if any. */
export function thumbnailColor(media: MediaItem) {
  const entry = colors.get(media.id);
  return entry && entry.revision === revisionOf(media) ? entry.color : null;
}

/** Dominant colours and the share of the image each covers, once measured. */
export function thumbnailPalette(media: MediaItem) {
  const entry = colors.get(media.id);
  return entry && entry.revision === revisionOf(media) && Array.isArray(entry.palette) ? entry.palette : null;
}

const labCache = new Map<string, [number, number, number]>();
/** sRGB hex → CIE L*a*b* (D65); the same conversion main.js uses. */
export function hexToLab(hex: string): [number, number, number] {
  const cached = labCache.get(hex);
  if (cached) return cached;
  const value = Number.parseInt(hex.replace("#", ""), 16) || 0;
  const linear = (channel: number) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const r = linear((value >> 16) & 255), g = linear((value >> 8) & 255), b = linear(value & 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const lab: [number, number, number] = [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  labCache.set(hex, lab);
  return lab;
}

// A colour must cover at least this much of the image to count: a red logo
// in a corner does not make a photo "red".
const MIN_COLOR_SHARE = 0.08;

/**
 * Whether the media contains the colour, within `tolerance` (CIE76 ΔE). Media
 * without a measured palette never match; analyzeColors() measures them.
 */
export function mediaMatchesColor(media: MediaItem, hex: string, tolerance: number) {
  const palette = thumbnailPalette(media);
  if (!palette) return false;
  const [l, a, b] = hexToLab(hex);
  return palette.some(([color, share]) => {
    if (share < MIN_COLOR_SHARE) return false;
    const [l2, a2, b2] = hexToLab(color);
    return Math.hypot(l - l2, a - a2, b - b2) <= tolerance;
  });
}

/**
 * Measure palettes for every media that has none, 40 at a time, so a colour
 * filter can cover media the user has not scrolled to. Results are kept, so
 * this runs once per media revision. Returns a function that stops it.
 */
export function analyzeColors(medias: MediaItem[], onProgress: (done: number, total: number) => void) {
  const bridge = getInDeckBridge();
  const pendingMedia = medias.filter((media) => (media.type === "image" || media.type === "video") && !thumbnailPalette(media));
  const total = pendingMedia.length;
  let stopped = false;
  const requestId = `colour-analysis:${crypto.randomUUID()}`;
  onProgress(0, total);
  if (!bridge?.analyzeThumbnailColors || !total) return () => {};
  void (async () => {
    for (let offset = 0; offset < total && !stopped; offset += 40) {
      const chunk = pendingMedia.slice(offset, offset + 40);
      const result: Record<string, Partial<ColorEntry>> = await bridge.analyzeThumbnailColors?.(chunk.map(bridgeAsset), requestId).catch(() => ({})) ?? {};
      if (stopped) return;
      for (const media of chunk) {
        const entry = result[media.id];
        colors.set(media.id, { revision: revisionOf(media), color: entry?.color ?? null, palette: entry?.palette ?? [] });
      }
      onProgress(Math.min(total, offset + chunk.length), total);
      notify();
    }
  })();
  return () => {
    stopped = true;
    void bridge.cancelThumbnails(requestId);
  };
}

function touch(resource: ThumbnailResource) {
  resource.lastUsed = performance.now();
  resources.delete(resource.key);
  resources.set(resource.key, resource);
}

function trim() {
  const budget = decodedBudgetBytes();
  for (const [key, resource] of resources) {
    if (usedBytes <= budget) break;
    if (resource.leases > 0) continue;
    resources.delete(key);
    usedBytes -= resource.bytes;
    resource.bitmap?.close();
  }
  // URL strings are tiny; cap them only to prevent unbounded metadata when a
  // profile has hundreds of thousands of media records.
  while (urls.size > 20_000) urls.delete(urls.keys().next().value as string);
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode thumbnail"));
    image.src = url;
  });
}

async function decode(url: string) {
  const image = await loadImage(url);
  try { await image.decode(); } catch { /* load completed; decode is best-effort */ }
  let bitmap: ImageBitmap | null = null;
  try {
    if (typeof createImageBitmap === "function") bitmap = await createImageBitmap(image);
  } catch {
    // A normal <img> remains a safe fallback on GPUs/codecs that cannot
    // create an ImageBitmap for a particular thumbnail.
  }
  return {
    bitmap,
    width: bitmap?.width || image.naturalWidth || 1,
    height: bitmap?.height || image.naturalHeight || 1,
  };
}

async function createResource(media: MediaItem, size: number, priority: boolean, distance: number, requestId: string) {
  try {
    return await createResourceUnsafe(media, size, priority, distance, requestId);
  } catch {
    return null;
  }
}

async function createResourceUnsafe(media: MediaItem, size: number, priority: boolean, distance: number, requestId: string) {
  const key = keyFor(media, size);
  const knownUrl = urls.get(key);
  let url = knownUrl;
  if (!url) {
    const bridge = getInDeckBridge();
    if (!bridge) return null;
    const result = await bridge.ensureThumbnails([{
      ...bridgeAsset(media),
      thumbnailSize: size,
      thumbnailPriority: priority ? "high" : "buffer",
      thumbnailDistance: distance,
    }], requestId);
    const entry = result[media.id];
    if (!entry?.url) return null;
    url = withGeneration(entry.url, media.id);
    if (entry.color) colors.set(media.id, { revision: revisionOf(media), color: entry.color, ...(entry.palette ? { palette: entry.palette } : {}) });
    urls.set(key, url);
  }
  const decoded = await decode(url);
  const resource: ThumbnailResource = {
    key,
    url,
    bitmap: decoded.bitmap,
    width: decoded.width,
    height: decoded.height,
    bytes: decoded.width * decoded.height * 4,
    leases: 0,
    lastUsed: performance.now(),
  };
  resources.set(key, resource);
  usedBytes += resource.bytes;
  trim();
  return resource;
}

/** Acquire a decoded thumbnail. Release the lease when its card unmounts. */
export function acquireThumbnail(media: MediaItem, size: number, priority: boolean, distance: number): ThumbnailLease {
  const key = keyFor(media, size);
  const token = Symbol(key);
  const cached = resources.get(key);
  if (cached) {
    cached.leases += 1;
    touch(cached);
    return { resource: cached, promise: Promise.resolve(cached), release: () => { cached.leases = Math.max(0, cached.leases - 1); trim(); } };
  }

  let active = pending.get(key);
  if (!active) {
    const requestId = `thumbnail-resource:${key}:${crypto.randomUUID()}`;
    const entry: PendingResource = { requestId, consumers: new Set(), promise: null as unknown as Promise<ThumbnailResource | null> };
    // Only clear the map when this very entry is still the current one. A
    // cancelled request may already have been replaced by a fresh attempt,
    // and dropping that one here would strand its consumers.
    entry.promise = createResource(media, size, priority, distance, requestId)
      .finally(() => { if (pending.get(key) === entry) pending.delete(key); });
    pending.set(key, entry);
    active = entry;
  }
  active.consumers.add(token);
  let released = false;
  return {
    resource: null,
    promise: active.promise.then((resource) => {
      if (!released && resource) {
        resource.leases += 1;
        touch(resource);
      }
      return resource;
    }),
    release: () => {
      if (released) return;
      released = true;
      const current = pending.get(key);
      if (current) {
        current.consumers.delete(token);
        if (!current.consumers.size) {
          // This request is about to resolve null. Retire it so a card that
          // asks for the same thumbnail a moment later starts a fresh request
          // instead of joining a doomed one and rendering blank forever.
          pending.delete(key);
          void getInDeckBridge()?.cancelThumbnails(current.requestId);
        }
      } else {
        const resource = resources.get(key);
        if (resource) { resource.leases = Math.max(0, resource.leases - 1); trim(); }
      }
    },
  };
}

/** A thumbnail file already served for this media, used as the image of a drag out of the app. */
export function knownThumbnailUrl(media: MediaItem) {
  const prefix = `${revisionOf(media)}:g${generations.get(media.id) || 0}:`;
  for (const [key, url] of urls) if (key.startsWith(prefix) && !key.endsWith(`:${DISPLAY_SIZE}`)) return url.split("?")[0];
  return null;
}

export function cachedThumbnail(media: MediaItem, size: number) {
  const resource = resources.get(keyFor(media, size)) || null;
  if (resource) touch(resource);
  return resource;
}

// The variants main.js generates, sharpest first.
const THUMBNAIL_VARIANTS = [512, 320, 160];

/**
 * The sharpest other size of this media that is already decoded. A zoom step
 * changes the requested size, and showing this while the new size loads keeps
 * every card from dropping back to its placeholder.
 */
export function fallbackThumbnail(media: MediaItem, size: number) {
  for (const variant of THUMBNAIL_VARIANTS) {
    if (variant === size) continue;
    const resource = resources.get(keyFor(media, variant));
    if (resource) return resource;
  }
  return null;
}

/** Hold an already decoded resource so the memory budget cannot close its bitmap while it is on screen. */
export function leaseThumbnail(resource: ThumbnailResource) {
  resource.leases += 1;
  touch(resource);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    resource.leases = Math.max(0, resource.leases - 1);
    trim();
  };
}

export function thumbnailResourceMetrics() {
  return { resources: resources.size, pending: pending.size, urls: urls.size, bytes: usedBytes, budgetBytes: decodedBudgetBytes() };
}
