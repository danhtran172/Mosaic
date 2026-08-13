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
  return `${media.id}:${media.modified || 0}:${size}`;
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
  const key = keyFor(media, size);
  const knownUrl = urls.get(key);
  let url = knownUrl;
  if (!url) {
    const bridge = getInDeckBridge();
    if (!bridge) return null;
    const result = await bridge.ensureThumbnails([{
      id: media.id,
      path: media.path,
      type: media.type,
      modified: media.modified,
      vault: media.vault,
      contentUrl: media.contentUrl,
      thumbnailSize: size,
      thumbnailPriority: priority ? "high" : "buffer",
      thumbnailDistance: distance,
    }], requestId);
    url = result[media.id];
    if (!url) return null;
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
    const promise = createResource(media, size, priority, distance, requestId).finally(() => pending.delete(key));
    active = { requestId, consumers: new Set(), promise };
    pending.set(key, active);
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
        if (!current.consumers.size) void getInDeckBridge()?.cancelThumbnails(current.requestId);
      } else {
        const resource = resources.get(key);
        if (resource) { resource.leases = Math.max(0, resource.leases - 1); trim(); }
      }
    },
  };
}

export function cachedThumbnail(media: MediaItem, size: number) {
  const resource = resources.get(keyFor(media, size)) || null;
  if (resource) touch(resource);
  return resource;
}

export function thumbnailResourceMetrics() {
  return { resources: resources.size, pending: pending.size, urls: urls.size, bytes: usedBytes, budgetBytes: decodedBudgetBytes() };
}
