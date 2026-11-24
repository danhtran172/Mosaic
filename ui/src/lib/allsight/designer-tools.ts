import { toast } from "sonner";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { knownThumbnailUrl } from "./thumbnail-resource-manager";
import type { Language, MediaItem } from "./types";

/**
 * Small actions for people who take media from Mosaic into design tools:
 * copying a colour, a path or an SVG's markup, choosing the app to open a
 * file with, and dragging files out into another application.
 */

const say = (language: Language, vi: string, en: string) => (language === "en" ? en : vi);

export function isSvgMedia(media: MediaItem) {
  return media.type === "image" && /\.svg$/i.test(media.name || media.path || "");
}

/** Lower-case extension without the dot, e.g. "png"; "" when there is none. */
export function mediaExtension(media: MediaItem) {
  const match = (media.name || media.path || "").match(/\.([a-z0-9]+)$/i);
  return match ? match[1]!.toLowerCase() : "";
}

/** Copy text to the clipboard and say so. `what` names it in the toast. */
export async function copyText(text: string, language: Language, what?: string) {
  let copied = false;
  try { copied = (await getInDeckBridge()?.copyText?.(text)) ?? false; } catch { copied = false; }
  if (!copied) {
    try { await navigator.clipboard.writeText(text); copied = true; } catch { copied = false; }
  }
  const label = what ?? text;
  if (copied) toast.success(say(language, `Đã sao chép ${label}.`, `Copied ${label}.`));
  else toast.error(say(language, "Không thể sao chép.", "Unable to copy."));
  return copied;
}

/** Hex codes of a palette, one per line, widest share first. */
export function paletteText(palette: Array<[string, number]>) {
  return palette.map(([hex]) => hex.toUpperCase()).join("\n");
}

export async function copySvgMarkup(media: MediaItem, language: Language) {
  const copied = await getInDeckBridge()?.copySvg?.(media).catch(() => false) ?? false;
  if (copied) toast.success(say(language, "Đã sao chép mã SVG.", "SVG code copied."));
  else toast.error(say(language, "Không thể sao chép mã SVG.", "Unable to copy the SVG code."));
}

export async function openWithChooser(media: MediaItem, language: Language) {
  const opened = await getInDeckBridge()?.openWith?.(media).catch(() => false) ?? false;
  if (!opened) toast.error(say(language, "Không thể mở hộp chọn ứng dụng.", "Unable to open the app chooser."));
}

/** A Vault keeps no file on disk, so there is nothing to hand another app. */
export function canDragOut(media: MediaItem) {
  return !media.vault && Boolean(media.path);
}

/**
 * Start an OS drag of these media's files, so they can be dropped into Figma,
 * Photoshop, Explorer or a browser upload. Returns false when none of them
 * has a local file.
 */
export function startExternalDrag(medias: MediaItem[]) {
  const bridge = getInDeckBridge();
  const local = medias.filter(canDragOut);
  if (!bridge?.startDrag || !local.length) return false;
  bridge.startDrag(
    local.map((media) => ({ id: media.id, path: media.path, name: media.name, vault: media.vault })),
    knownThumbnailUrl(local[0]!) ?? undefined,
  );
  return true;
}

const COMMON_RATIOS: Array<[number, number]> = [[1, 1], [4, 3], [3, 2], [16, 9], [16, 10], [21, 9], [5, 4], [2, 1], [3, 1]];

/** "16:9", "4:5", or "1.85:1" when no common ratio is within 1%. */
export function aspectLabel(width: number, height: number) {
  if (!(width > 0 && height > 0)) return "";
  const ratio = width / height;
  for (const [a, b] of COMMON_RATIOS) {
    if (Math.abs(ratio - a / b) / (a / b) < 0.01) return `${a}:${b}`;
    if (a !== b && Math.abs(ratio - b / a) / (b / a) < 0.01) return `${b}:${a}`;
  }
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}

export function formatBytes(bytes: number | undefined) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Shape, resolution and file-format filters: the questions a designer asks of
 * a reference library ("a portrait at least 1920 px", "only the SVGs").
 */
export type MediaShape = "landscape" | "portrait" | "square" | "panorama";
export type DesignFilter = { shapes: MediaShape[]; minSide: number; formats: string[] };
export const EMPTY_DESIGN_FILTER: DesignFilter = { shapes: [], minSide: 0, formats: [] };

export function designFilterCount(filter: DesignFilter) {
  return filter.shapes.length + filter.formats.length + (filter.minSide > 0 ? 1 : 0);
}

/** Unknown dimensions (the 4×3 placeholder) match no shape or size. */
function knownSize(media: MediaItem) {
  return media.width > 4 && media.height > 3 ? { width: media.width, height: media.height } : null;
}

export function mediaHasShape(media: MediaItem, shape: MediaShape) {
  const size = knownSize(media);
  if (!size) return false;
  const ratio = size.width / size.height;
  if (shape === "square") return Math.abs(ratio - 1) <= 0.05;
  if (shape === "landscape") return ratio > 1.05;
  if (shape === "portrait") return ratio < 0.95;
  return ratio >= 2 || ratio <= 0.5;
}

export function mediaMatchesDesignFilter(media: MediaItem, filter: DesignFilter) {
  if (filter.shapes.length && !filter.shapes.some((shape) => mediaHasShape(media, shape))) return false;
  if (filter.minSide > 0) {
    const size = knownSize(media);
    // An SVG has no pixel size of its own: it renders at any resolution.
    if (!isSvgMedia(media) && (!size || Math.max(size.width, size.height) < filter.minSide)) return false;
  }
  if (filter.formats.length && !filter.formats.includes(formatGroup(mediaExtension(media)))) return false;
  return true;
}

/** Spellings of one format count as one choice. */
export function formatGroup(extension: string) {
  if (extension === "jpeg") return "jpg";
  if (extension === "tif") return "tiff";
  if (extension === "heif") return "heic";
  if (extension === "m4v") return "mp4";
  return extension;
}
