/**
 * Renderer-local LRU for preview URLs. Disk thumbnails remain durable; this
 * cache keeps recently decoded browser resources alive as cards recycle.
 */
type PreviewEntry = { url: string; size: number; bytes: number; blob: boolean };

const entries = new Map<string, PreviewEntry>();
let usedBytes = 0;

function budgetBytes() {
  const memoryGb = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8);
  return Math.max(96, Math.min(512, memoryGb * 48)) * 1024 * 1024;
}

function estimatedDecodedBytes(size: number) {
  return Math.max(160, size) ** 2 * 4;
}

export function getMemoryPreview(mediaId: string, minimumSize: number) {
  const entry = entries.get(mediaId);
  if (!entry || entry.size < minimumSize) return null;
  entries.delete(mediaId);
  entries.set(mediaId, entry);
  return entry;
}

export function rememberMemoryPreview(mediaId: string, url: string, size: number) {
  const existing = entries.get(mediaId);
  if (existing && existing.size > size) return [] as string[];
  if (existing) {
    entries.delete(mediaId);
    usedBytes -= existing.bytes;
    if (existing.blob && existing.url !== url) URL.revokeObjectURL(existing.url);
  }
  const entry: PreviewEntry = { url, size, bytes: estimatedDecodedBytes(size), blob: url.startsWith("blob:") };
  entries.set(mediaId, entry);
  usedBytes += entry.bytes;
  const evicted: string[] = [];
  while (usedBytes > budgetBytes() && entries.size > 1) {
    const [id, oldest] = entries.entries().next().value as [string, PreviewEntry];
    entries.delete(id);
    usedBytes -= oldest.bytes;
    if (oldest.blob) URL.revokeObjectURL(oldest.url);
    evicted.push(id);
  }
  return evicted;
}
