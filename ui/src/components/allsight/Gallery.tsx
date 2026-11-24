import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AppWindow,
  Boxes,
  Code2,
  Link2,
  Shapes,
  ClipboardPaste,
  Copy,
  CopyPlus,
  EyeOff,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GripVertical,
  ChevronLeft,
  ChevronRight,

  Group,
  Heart,
  Image as ImageIcon,
  Layers as LayersIcon,
  Maximize2,
  Minimize2,
  Pencil,
  Play,
  RefreshCw,
  Scissors,
  Search,
  Tag,
  Trash2,
  Ungroup,
  Users,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAllsight } from "@/lib/allsight/store";
import { LazyThumbnail } from "./Thumbnail";
import { VideoHoverPreview } from "./VideoHoverPreview";
import { regenerateThumbnails } from "@/lib/allsight/thumbnail-resource-manager";
import { beginMediaDrag, finishMediaDrag } from "@/lib/allsight/media-drag-transfer";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { canDragOut, copySvgMarkup, copyText, isSvgMedia, openWithChooser, startExternalDrag } from "@/lib/allsight/designer-tools";
import { useT } from "@/lib/allsight/i18n";
import { toast } from "sonner";
import type { GalleryLayout, MediaItem, OrderEntry } from "@/lib/allsight/types";
import { cn } from "@/lib/utils";
import type { ConfirmRequest } from "./ConfirmDialog";
import type { MediaGroupBy } from "@/lib/allsight/grouping";

const GAP = 8; // 30% tighter than the 12px base grid
// Media in an expanded Group always keeps this much clear space from every
// inner edge of the frame. The border is accounted for separately below.
const GROUP_PAD = 8;
const GROUP_BORDER = 1;
const GROUP_INSET = GROUP_PAD + GROUP_BORDER;
// Every Group frame opens with a title band — icon, name, count and its
// controls — so it reads as one container at a glance and none of those
// controls ever sits on top of a photo. This is the distance from the frame's
// outer top edge to its first row of media, the band included.
const GROUP_HEADER = 24;
const GROUP_TOP_INSET = GROUP_BORDER + GROUP_HEADER;
// Vertical room a Group frame takes from a row on top of its media.
const GROUP_CHROME_Y = GROUP_TOP_INSET + GROUP_INSET;
// Keep a small safety gutter at row end. Browser sub-pixel rounding can
// otherwise consume the visual right padding when a Group row fills exactly.
const GROUP_ROW_END_GUTTER = 8;
// A collapsed Group is drawn as a small pile of tilted photos behind its
// cover. Each edge of the frame is sized on its own: see stackInsets.
const STACK_MAX_ITEMS = 4;
// Maximum lean, in degrees, of a photo behind the cover. This is the main
// knob for how much frame the effect asks for — a tilted photo reaches past
// the cover by roughly (other side) x sin(tilt).
const STACK_TILT = 4;
// How far apart consecutive photos in the pile sit.
const STACK_STEP = 2.5;
const MAIN_GALLERY_DROP_ID = "__mosaic-main-gallery__";
const EDGE = 50; // reorder hot zone on each side of a cell
/**
 * The reorder hot zone, scaled to the card it belongs to. A fixed 50px ate a
 * whole card once zoom took it under 100px wide: both edges met in the middle,
 * so the centre — the hold-to-group target — became unreachable and media
 * could no longer be dragged onto each other at small zoom levels.
 */
function edgeFor(rect: DOMRect) {
  // A quarter of the card each side leaves half of it as the hold target even
  // for the narrow portrait cards of the smallest zoom level.
  return Math.min(EDGE, Math.max(6, rect.width * 0.25));
}
/**
 * Once a hold-to-group has started on a card, the pointer may drift this far
 * into the card's reorder edges without abandoning it. Holding still for 1.5s
 * over a small card was otherwise nearly impossible: any tremor reset it.
 */
function holdKeepFor(rect: DOMRect) {
  return Math.max(3, rect.width * 0.08);
}
const HOLD_MS = 1500;
const menuItem = "gap-2";


/**
 * One solved cell. `width` is the cell's own box. A member of a fitted Group
 * also carries its own `height`: the Group's frame takes the full row height
 * and its media sit inside the frame's chrome, so they are shorter than the
 * loose cards beside them.
 */
type RowItem = { item: MediaItem; width: number; height?: number | undefined };
type Row = { height: number; items: RowItem[] };

/**
 * Scroll offset per Gallery, surviving navigation away and back for as long as
 * the app is open. It lives outside React so that restoring a position is a
 * plain DOM write during layout rather than another render.
 */
const galleryScrollMemory = new Map<string, number>();
const MAIN_GALLERY_SCROLL_KEY = "__main__";

/** The solved geometry of one virtualized row, in Gallery content coordinates. */
type PositionedVirtualRow = {
  top: number;
  height: number;
  sectionLabel?: string | undefined;
  groupId?: string | undefined;
  cells: { item: MediaItem; width: number; height?: number | undefined; fitGroupId?: string | undefined }[];
};

/**
 * Where each card of a row sits, relative to the row's own top-left corner.
 * Mirrors the flex layout the row is rendered with: a fitted Group's frame
 * adds its chrome around its members, which the members are inset by.
 */
function rowCellBoxes(row: PositionedVirtualRow) {
  const boxes: { id: string; left: number; top: number; width: number; height: number }[] = [];
  let x = 0;
  row.cells.forEach((cell, index) => {
    const fit = cell.fitGroupId;
    if (fit && fit !== row.cells[index - 1]?.fitGroupId) x += GROUP_INSET;
    const height = cell.height ?? row.height;
    // A fitted Group's frame is the full row height; its members sit below
    // the title band.
    const top = fit ? GROUP_TOP_INSET : (row.height - height) / 2;
    boxes.push({ id: cell.item.id, left: x, top, width: cell.width, height });
    x += cell.width;
    if (fit && fit !== row.cells[index + 1]?.fitGroupId) x += GROUP_INSET;
    x += GAP;
  });
  return boxes;
}

function justifiedMaxHeight(targetHeight: number) {
  return Math.max(100, Math.min(400, targetHeight));
}

function mediaRatio(item: MediaItem) {
  const width = Number.isFinite(item.width) && item.width > 0 ? item.width : 4;
  const height = Number.isFinite(item.height) && item.height > 0 ? item.height : 3;
  return Math.max(0.12, Math.min(8, width / height));
}

/**
 * `atomic` names the fitted Group each item belongs to, or undefined for a
 * loose card. A row may never break between two items that share a name: a
 * Group set to fit its media has to stay on one row for its frame to mean
 * anything, and that is also the promise the option makes to the user.
 */
type AtomicKey = (index: number) => string | undefined;

/** Would breaking the row before `index` split a fitted Group in half? */
function splitsGroup(atomic: AtomicKey | undefined, index: number) {
  if (!atomic || index <= 0) return false;
  const key = atomic(index);
  return Boolean(key) && key === atomic(index - 1);
}

// `extraWidth` reports the horizontal room a cell needs on top of its image
// width — collapsed Groups, whose frame grows to host the tilted pile.
//
// Every row is solved exactly: its width is linear in the row height,
//   width(h) = A·h + B
// where A is the summed aspect ratio of its media and B collects everything
// that does not scale with h — the gaps, a pile's extra room, and a fitted
// Group's frame (2·inset wide, and its members lose GROUP_CHROME_Y of
// height, i.e. −ratio·GROUP_CHROME_Y of width each). Solving for the height
// that makes the row exactly as wide as the Gallery keeps every full row
// flush with both edges. Charging a pile's room to the row but not to the
// pile's own cell, as before, left each such row short of the right edge.
function equalJustifiedRows(items: MediaItem[], width: number, targetHeight: number, extraWidth?: (item: MediaItem, index: number) => number, atomic?: AtomicKey): Row[] {
  if (!items.length) return [];
  const maxHeight = justifiedMaxHeight(targetHeight);
  // At 175%/200% the old fixed five-card minimum kept the calculated row
  // height below the selected value, making zoom-in appear broken. Fewer
  // cards are allowed as the requested thumbnail height grows.
  const minItemsPerRow = Math.max(1, Math.min(5, Math.floor(width / (maxHeight * 1.25))));

  type Cell = { item: MediaItem; ratio: number; extra: number; fit: string | undefined };
  const rows: { cells: Cell[]; a: number; b: number }[] = [];
  let row: Cell[] = [];
  let a = 0;
  let b = 0;
  items.forEach((item, index) => {
    const ratio = mediaRatio(item);
    const fit = atomic?.(index);
    const extra = fit ? 0 : extraWidth?.(item, index) ?? 0;
    if (fit) {
      b -= ratio * GROUP_CHROME_Y;
      // The frame's horizontal chrome is paid once per Group per row.
      if (fit !== row[row.length - 1]?.fit) b += GROUP_INSET * 2;
    } else b += extra;
    a += ratio;
    row.push({ item, ratio, extra, fit });
    const fillsAtMaxHeight = a * maxHeight + b + GAP * (row.length - 1) >= width;
    // Never close a row between two members of the same fitted Group.
    if (row.length >= minItemsPerRow && fillsAtMaxHeight && !splitsGroup(atomic, index + 1)) {
      rows.push({ cells: row, a, b });
      row = [];
      a = 0;
      b = 0;
    }
  });
  if (row.length) rows.push({ cells: row, a, b });

  return rows.map(({ cells, a, b }) => {
    const gaps = GAP * (cells.length - 1);
    const solved = (width - gaps - b) / a;
    // A fitted Group needs some room for its media beneath the chrome.
    const floor = cells.some((cell) => cell.fit) ? GROUP_CHROME_Y + 24 : 24;
    const height = Math.max(floor, Math.min(solved, maxHeight));
    return {
      height,
      items: cells.map(({ item, ratio, extra, fit }) => fit
        ? { item, width: ratio * (height - GROUP_CHROME_Y), height: height - GROUP_CHROME_Y }
        : { item, width: ratio * height + extra }),
    };
  });
}

// A square row always spans its container exactly. Holding the cards at the
// requested size and flooring the column count left the leftover width as a
// dead strip down the right-hand side of the Gallery, which is wider the
// closer the fit came to fitting one more card.
// The requested (zoom) size chooses the column count rather than the card
// size: rounding to the nearest count keeps the cards close to what the user
// asked for, then they stretch to consume the row.
function squareRows(items: MediaItem[], width: number, targetHeight: number, atomic?: AtomicKey): Row[] {
  if (!items.length) return [];
  const columns = squareColumns(width, targetHeight);
  const side = Math.max(1, (width - GAP * (columns - 1)) / columns);
  const rows: Row[] = [];
  let row: { item: MediaItem; fit: string | undefined }[] = [];
  const flush = () => {
    if (!row.length) return;
    // A fitted Group keeps exactly the slots its members would take as loose
    // cards, so the row stays flush; its chrome comes out of its members.
    const sizes = new Map<string, number>();
    row.forEach(({ fit }) => { if (fit) sizes.set(fit, (sizes.get(fit) ?? 0) + 1); });
    rows.push({
      height: side,
      items: row.map(({ item, fit }) => fit
        ? { item, width: Math.max(1, side - (GROUP_INSET * 2) / sizes.get(fit)!), height: Math.max(1, side - GROUP_CHROME_Y) }
        : { item, width: side }),
    });
    row = [];
  };
  for (let index = 0; index < items.length; index += 1) {
    // A fitted Group takes one slot per member, exactly as the same number of
    // loose cards would. Reserve them all before starting it: closing the row
    // afterwards instead would either cut the Group in half or push the row
    // past the budget the current zoom allows.
    let needed = 1;
    const key = atomic?.(index);
    if (key && !splitsGroup(atomic, index)) while (atomic?.(index + needed) === key) needed += 1;
    if (row.length && row.length + needed > columns) flush();
    row.push({ item: items[index]!, fit: key });
    if (row.length >= columns && !splitsGroup(atomic, index + 1)) flush();
  }
  flush();
  return rows;
}
/** How many cards one row holds at this width and zoom — the fit budget. */
function squareColumns(width: number, targetHeight: number) {
  const requestedSide = Math.max(100, Math.min(400, targetHeight));
  return Math.max(1, Math.round((width + GAP) / (requestedSide + GAP)));
}

function layoutRows(
  items: MediaItem[],
  width: number,
  targetHeight: number,
  layout: GalleryLayout,
  extraWidth?: (item: MediaItem, index: number) => number,
  atomic?: AtomicKey,
) {
  return layout === "justified"
    ? equalJustifiedRows(items, width, targetHeight, extraWidth, atomic)
    : squareRows(items, width, targetHeight, atomic);
}

function groupContentWidth(width: number) {
  // The group frame is border-box. Its cards must fit inside both the inner
  // padding and its stronger 2px border, not just inside the outer Gallery
  // width.
  return Math.max(width - GROUP_INSET * 2 - GROUP_ROW_END_GUTTER, 100);
}

function groupRows(items: MediaItem[], width: number, targetHeight: number, layout: GalleryLayout) {
  const contentWidth = groupContentWidth(width);
  return layout === "square"
    ? squareRows(items, contentWidth, targetHeight)
    : equalJustifiedRows(items, contentWidth, targetHeight);
}

function thumbnailSizeForBox(width: number, height: number) {
  const devicePixels = Math.max(width, height) * (window.devicePixelRatio || 1);
  if (devicePixels <= 160) return 160;
  if (devicePixels <= 320) return 320;
  return 512;
}

function stackJitter(id: string) {
  let value = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return ((value >>> 16) & 0xff) / 255 - 0.5;
}

// Photos behind the cover alternate which way they lean so two neighbours
// never land on the same angle, and the hash decides how far each one leans
// within STACK_TILT. Never exceeds STACK_TILT, which stackBleed relies on.
function stackTilt(id: string, depth: number) {
  const magnitude = STACK_TILT * (0.5 + Math.abs(stackJitter(id)));
  return depth % 2 === 0 ? magnitude : -magnitude;
}

// How far the tilted photos reach past each edge of the cover. Measured at
// the STACK_TILT cap rather than at each card's actual angles, so every
// collapsed Group of the same cell size asks for the same frame and a row
// cannot end up with cards of slightly different heights.
function stackBleed(coverWidth: number, coverHeight: number, count: number) {
  const layers = Math.max(1, Math.min(count, STACK_MAX_ITEMS));
  if (layers < 2) return { left: 0, right: 0, top: 0, bottom: 0 };
  const radians = (STACK_TILT * Math.PI) / 180;
  // A rectangle rotated by t occupies (w·cos t + h·sin t) x (w·sin t + h·cos t).
  const halfWidth = (coverWidth * Math.cos(radians) + coverHeight * Math.sin(radians)) / 2;
  const halfHeight = (coverWidth * Math.sin(radians) + coverHeight * Math.cos(radians)) / 2;
  // The fan runs down-right, so the deepest photo sets the right/bottom reach
  // while the shallowest one sets left/top.
  const far = (layers - 1) * STACK_STEP;
  const near = STACK_STEP;
  return {
    left: Math.max(0, halfWidth - near - coverWidth / 2),
    right: Math.max(0, halfWidth + far - coverWidth / 2),
    top: Math.max(0, halfHeight - near - coverHeight / 2),
    bottom: Math.max(0, halfHeight + far - coverHeight / 2),
  };
}

// Distance from the frame edge to the cover edge, decided per edge. An edge
// the effect barely reaches into keeps the full default padding and simply
// contains the effect within it. Once the effect would take half that padding
// or more, the padding on that edge halves and the frame is pushed out so the
// effect gets its own room on top of the remaining padding.
function stackInsets(coverWidth: number, coverHeight: number, count: number) {
  const bleed = stackBleed(coverWidth, coverHeight, count);
  // max() expresses both halves of that rule at once, and is continuous at
  // the crossover: below GROUP_PAD / 2 of bleed the first term wins.
  const edge = (reach: number) => Math.max(GROUP_PAD, reach + GROUP_PAD / 2);
  return {
    left: edge(bleed.left),
    right: edge(bleed.right),
    top: edge(bleed.top),
    bottom: edge(bleed.bottom),
  };
}

// The frame is locked to its cell in both layouts, so a collapsed Group is
// exactly as tall as the media beside it and the pile leans inside the cell
// rather than pushing the row taller. The cover shrinks until it plus its
// insets fit. The insets depend on the cover size, so this is iterated — it
// settles within a few rounds because the effect grows far slower than the
// cover it is measured against.
function stackFrame(cellWidth: number, cellHeight: number, count: number) {
  let width = cellWidth;
  let height = cellHeight;
  let insets = stackInsets(width, height, count);
  for (let round = 0; round < 8; round += 1) {
    const nextWidth = Math.max(16, cellWidth - insets.left - insets.right);
    const nextHeight = Math.max(16, cellHeight - insets.top - insets.bottom);
    const settled = Math.abs(nextWidth - width) < 0.05 && Math.abs(nextHeight - height) < 0.05;
    width = nextWidth;
    height = nextHeight;
    insets = stackInsets(width, height, count);
    if (settled) break;
  }
  return { width, height, insets };
}

type DropInfo =
  /** `railY` places the horizontal rail of a whole-row insertion, in content coordinates. */
  | { type: "insert"; index: number; axis: "x" | "y"; railY?: number | undefined }
  | { type: "member-insert"; groupId: string; index: number; railMediaId?: string | undefined; railSide?: "left" | "right" | undefined }
  | { type: "hold"; kind: "group" | "media" | "ungroup"; id: string }
  | null;

const sameDrop = (a: DropInfo, b: DropInfo) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** A vertical slice of the Gallery a dragged expanded Group can land before or after. */
type GroupBand = { top: number; bottom: number; first: number; last: number; groupId?: string | undefined };

export function Gallery({
  entries,
  visibleMediaIds,
  selected,
  setSelected,
  onOpen,
  onConfirm,
  currentFolderId,
  galleryLayout,
  layoutKey,
  groupBy,
}: {
  entries: OrderEntry[];
  /** Individual media that pass the current view's hidden/filter rules. */
  visibleMediaIds: string[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  onOpen: (id: string) => void;
  onConfirm: (r: ConfirmRequest) => void;
  currentFolderId: string | null;
  galleryLayout: GalleryLayout;
  /** Changes synchronously whenever a sibling panel changes Gallery width. */
  layoutKey: string;
  /** Display-only multi-level grouping selected in the Library header. */
  groupBy: MediaGroupBy[];
}) {
  const t = useT();
  const {
    state,
    moveEntry,
    moveEntriesAfter,
    moveEntriesTo,
    createGroup,
    insertManyIntoGroup,
    removeFromGroup,
    dissolveGroup,
    updateGroup,
    addToFolder,
    moveToFolder,
    removeFromFolder,
    updateFolder,
    hideMedia,
    purgeMedia,
    discardFromFolder,
    duplicateMedia,
    addPropValue,
    toggleFavorite,
  } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;

  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Start at a normal desktop width. A zero-width flex measurement is common
  // during Electron's first layout pass and must never shrink the whole grid
  // to the 320px safety minimum before the real width is available.
  const [width, setWidth] = useState(1000);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollDirection = useRef<"up" | "down">("down");
  const scrollFrame = useRef(0);
  const pendingScrollTop = useRef(0);
  const committedScrollTop = useRef(0);
  const [drag, setDrag] = useState<OrderEntry | null>(null);
  // Where the pointer was when a drag began. The preview follows the pointer
  // by itself from there: tracking every pointer move in Gallery state re-
  // rendered the whole Gallery on each one, which is what made dragging lag.
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number } | null>(null);
  const [dragPreviewId, setDragPreviewId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropInfo>(null);
  // Keep a single, top-level rail for Library reordering.  Card-local rails
  // are fine for a group, but can be clipped by a justified Library row.
  const [libraryRail, setLibraryRail] = useState<{ x: number; y: number; height: number } | null>(null);
  // When the current hold-to-group began. The ring animates itself from it.
  const [holdStart, setHoldStart] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // The card or Group the one shared context menu was opened on.
  const [menuTarget, setMenuTarget] = useState<{ kind: "media" | "group"; id: string } | null>(null);
  const [clipboard, setClipboard] = useState<Record<string, string[]>>({});
  // Media waiting to be pasted somewhere else in the order. Deliberately its
  // own clipboard: `clipboard` above holds copied Property values, and pasting
  // one must never be mistaken for pasting the other.
  const [cutEntries, setCutEntries] = useState<OrderEntry[]>([]);
  const [addToGalleryFor, setAddToGalleryFor] = useState<string | null>(null);
  const [moveToGalleryFor, setMoveToGalleryFor] = useState<string | null>(null);
  const [addGroupToGalleryFor, setAddGroupToGalleryFor] = useState<string[] | null>(null);
  const [galleryPickerQuery, setGalleryPickerQuery] = useState("");
  const [groupNameDialog, setGroupNameDialog] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => () => { if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current); }, []);

  // Ctrl/Cmd+X and Ctrl/Cmd+V on the current selection. Paste needs exactly one
  // selected card to aim at, since the cut media land directly after it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "x" && selected.length) {
        event.preventDefault();
        const chosen = new Set(selected);
        setCutEntries(state.order.filter((entry) => entry.kind === "media" && chosen.has(entry.id)));
        return;
      }
      if (key !== "v" || !cutEntries.length || selected.length !== 1) return;
      const anchor = selected[0]!;
      if (cutEntries.some((entry) => entry.kind === "media" && entry.id === anchor)) return;
      event.preventDefault();
      moveEntriesAfter({ kind: "media", id: anchor }, cutEntries);
      setCutEntries([]);
      setSelected([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cutEntries, moveEntriesAfter, selected, setSelected, state.order]);

  const galleryPickerFolders = useMemo(() => {
    const needle = galleryPickerQuery.trim().toLowerCase();
    return state.folders.filter((folder) => !needle || folder.name.toLowerCase().includes(needle));
  }, [galleryPickerQuery, state.folders]);
  const galleryCover = (folderId: string) => {
    const folder = state.folders.find((item) => item.id === folderId);
    return state.media.find((item) => item.id === (folder?.coverId ?? folder?.mediaIds[0])) ?? null;
  };
  const copyImageToClipboard = async (media: MediaItem) => {
    if (media.type !== "image") return;
    // Browser Clipboard only received the preview URL before, which is why
    // pasting produced text instead of an image. Electron writes the native
    // image bitmap so it can be pasted into image-aware applications.
    const copied = await getInDeckBridge()?.copyImage(media).catch(() => false) ?? false;
    if (copied) toast.success(state.language === "vi" ? "Đã sao chép ảnh." : "Image copied.");
    else toast.error(state.language === "vi" ? "Không thể sao chép ảnh." : "Unable to copy image.");
  };
  // A thumbnail made before a codec was installed, or a video cover that
  // missed the moment, is otherwise kept until the file itself changes.
  const regenerate = async (ids: string[]) => {
    const medias = ids.map((id) => mediaById(id)).filter((media): media is MediaItem => !!media);
    try {
      await regenerateThumbnails(medias);
      toast.success(c(`Đang tạo lại thumbnail cho ${medias.length} media.`, `Regenerating thumbnails for ${medias.length} media.`));
    } catch {
      toast.error(c("Không thể tạo lại thumbnail.", "Unable to regenerate thumbnails."));
    }
  };
  const openInFolder = async (media: MediaItem) => {
    const opened = await getInDeckBridge()?.showInFolder(media).catch(() => false) ?? false;
    if (!opened) toast.error(c("Không thể mở vị trí tệp.", "Unable to open the file location."));
  };

  const pointerStart = useRef<{ x: number; y: number; entry: OrderEntry } | null>(null);
  const holdRef = useRef<{ key: string; start: number } | null>(null);
  const dropRef = useRef<DropInfo>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const autoScroll = useRef(0);
  // A click that ends a drag is not a selection. Without this, dropping a
  // card back onto itself toggled its selection as the pointer came up.
  const suppressClickUntil = useRef(0);
  // Marquee selection and Group dragging read row geometry rather than the
  // DOM: only a couple of screens of cards are mounted at any time.
  const virtualGeometry = useRef<{ rows: PositionedVirtualRow[] }>({ rows: [] });
  const groupBandsRef = useRef<GroupBand[]>([]);

  // Where the user had scrolled to in each Gallery, so reopening one returns
  // them to what they were looking at instead of the top. Kept outside React
  // state: restoring it must not itself cause a render.
  const scrollMemoryKey = currentFolderId ?? MAIN_GALLERY_SCROLL_KEY;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const remembered = galleryScrollMemory.get(scrollMemoryKey) ?? 0;
    const apply = () => {
      el.scrollTop = remembered;
      committedScrollTop.current = el.scrollTop;
      pendingScrollTop.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    };
    apply();
    // On the very first mount the Library may still be hydrating, so the
    // content is not yet tall enough and the browser clamps the offset to 0.
    // Retry once the next frame has a real height — but only while the user
    // has not scrolled themselves, so this never fights a deliberate scroll.
    const frame = remembered > 0 && el.scrollTop < remembered
      ? window.requestAnimationFrame(() => { if (el.scrollTop === 0) apply(); })
      : 0;
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      galleryScrollMemory.set(scrollMemoryKey, el.scrollTop);
    };
  }, [scrollMemoryKey]);


  // Desktop state hydrates asynchronously. On the first render the empty
  // state has no scroll container, so rerun once media arrives and attach
  // the observer to the actual Gallery viewport.
  useLayoutEffect(() => {
    // Measure the scrolling viewport, not the content column. A column with
    // only narrow portrait cards is allowed to shrink to its min-content
    // width, which fed ~80px into `justify()` and produced tiny thumbnails.
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      // clientWidth, not getBoundingClientRect(): the border box includes the
      // vertical scrollbar, which the content box cannot use. A Gallery large
      // enough to scroll always has one, so measuring the border box made
      // every justified row solve for ~10px more than it had and overflow the
      // right edge. Square layouts absorbed the error in their column count,
      // which is why only justified looked wrong.
      const measured = Math.floor(el.clientWidth);
      // Preserve the last valid layout until the flex parent has a real size.
      if (measured <= 40) return;
      const next = Math.max(320, measured - 40);
      setWidth((current) => current === next ? current : next);
      const nextHeight = Math.max(1, Math.floor(el.clientHeight));
      setViewportHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    // A sibling flex item can finish its width transition after the first
    // layout pass in Chromium. Measure one frame later as well.
    const frame = window.requestAnimationFrame(measure);
    return () => { ro.disconnect(); window.cancelAnimationFrame(frame); };
  }, [entries.length, layoutKey]);

  // Building the Gallery no longer repeatedly scans every media item for
  // every card/group. These maps are rebuilt only when their data changes,
  // never while the user merely scrolls or drags.
  const mediaById = useMemo(() => {
    const byId = new Map(state.media.map((media) => [media.id, media]));
    return (id: string) => byId.get(id);
  }, [state.media]);
  const visibleMediaIdSet = useMemo(() => new Set(visibleMediaIds), [visibleMediaIds]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const groupById = useMemo(() => new Map(state.groups.map((group) => [group.id, group])), [state.groups]);
  const groupOfMedia = useMemo(() => {
    const byMember = new Map<string, (typeof state.groups)[number]>();
    for (const group of state.groups) for (const id of group.memberIds) if (!byMember.has(id)) byMember.set(id, group);
    return byMember;
  }, [state.groups]);

  // Ctrl/Cmd+G groups the selection; Ctrl/Cmd+Shift+G takes it back out of its
  // Groups, dissolving any Group that would be left with fewer than two media.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "g") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu]")) return;
      if (!event.shiftKey) {
        if (selected.length < 2) return;
        event.preventDefault();
        createGroup([...selected], selected[0]);
        setSelected([]);
        return;
      }
      const leaving = new Map<string, string[]>();
      for (const id of selected) {
        const group = groupOfMedia.get(id);
        if (group) leaving.set(group.id, [...(leaving.get(group.id) ?? []), id]);
      }
      if (!leaving.size) return;
      event.preventDefault();
      for (const [groupId, ids] of leaving) {
        const group = groupById.get(groupId);
        if (!group) continue;
        if (group.memberIds.length - ids.length < 2) dissolveGroup(groupId);
        else for (const id of ids) removeFromGroup(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createGroup, dissolveGroup, groupById, groupOfMedia, removeFromGroup, selected, setSelected]);
  // Position of every entry in the order. Hit testing asks for this for every
  // candidate card on every pointer move, so a linear search per question
  // (as before) multiplied into millions of comparisons on a large Library.
  const orderIndex = useMemo(() => {
    const byKey = new Map<string, number>();
    state.order.forEach((entry, index) => {
      const key = `${entry.kind}:${entry.id}`;
      if (!byKey.has(key)) byKey.set(key, index);
    });
    return byKey;
  }, [state.order]);
  const globalIndex = useCallback(
    (entry: OrderEntry) => orderIndex.get(`${entry.kind}:${entry.id}`) ?? -1,
    [orderIndex],
  );

  useLayoutEffect(() => {
    const isLibraryInsert = drop?.type === "insert" && drop.axis === "x";
    if (!drag || !isLibraryInsert || !containerRef.current) {
      setLibraryRail(null);
      return;
    }
    const root = containerRef.current;

    const findEntry = (entry: OrderEntry | undefined) => {
      if (!entry) return undefined;
      // A collapsed group is represented by its cover card, while an expanded
      // or fitted group has a frame. Look for both, otherwise the outer
      // Library rail disappears whenever the seam touches a Group.
      const nodes = [
        ...root.querySelectorAll<HTMLElement>(`[data-entry-id="${entry.id}"][data-entry-kind="${entry.kind}"]`),
        ...(entry.kind === "group" ? root.querySelectorAll<HTMLElement>(`[data-group-id="${entry.id}"]`) : []),
      ];
      return [...nodes].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    };

    const beforeNode = findEntry(state.order[drop.index]);
    const afterNode = findEntry(state.order[drop.index - 1]);
    const target = beforeNode ?? afterNode;
    if (!target) {
      setLibraryRail(null);
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const beforeRect = beforeNode?.getBoundingClientRect();
    const afterRect = afterNode?.getBoundingClientRect();
    // An insertion belongs to the seam, not to either neighbouring card.
    // Using the midpoint gives Library and group members exactly the same
    // single, stable rail even when their current gap has been widened.
    // That only holds while both neighbours share a row. Across a row break —
    // a wrap, or the last card of a run followed by a Group block that starts
    // its own full-width row — they overlap in no vertical band at all, so the
    // midpoint lands in empty space and Math.min(bottom) - Math.max(top) goes
    // negative, collapsing the rail to an invisible 1px sliver. That is why
    // dropping right after the last image before a Group looked impossible.
    // Anchor to the trailing edge of the preceding card in that case: it is
    // exactly the "insert right after this one" the drag is aiming at.
    const sharesRow = Boolean(beforeRect && afterRect
      && Math.min(beforeRect.bottom, afterRect.bottom) - Math.max(beforeRect.top, afterRect.top) > 0);
    const anchorRect = sharesRow ? null : afterRect ?? beforeRect ?? rect;
    const seamX = sharesRow
      ? afterRect!.right + (beforeRect!.left - afterRect!.right) / 2
      : afterRect
        ? anchorRect!.right + GAP / 2
        : anchorRect!.left - GAP / 2;
    const seamTop = sharesRow ? Math.max(beforeRect!.top, afterRect!.top) : anchorRect!.top;
    const seamBottom = sharesRow ? Math.min(beforeRect!.bottom, afterRect!.bottom) : anchorRect!.bottom;
    setLibraryRail({
      x: seamX - rootRect.left + root.scrollLeft - 2,
      y: seamTop - rootRect.top + root.scrollTop,
      height: Math.max(1, seamBottom - seamTop),
    });
  }, [drag, drop, state.order]);

  // ---- drag machinery -------------------------------------------------
  const finishHold = useCallback(() => {
    holdRef.current = null;
    setHoldStart(null);
  }, []);

  // The last pointer position of the current drag, and the hit test bound to
  // the current render. Auto-scroll moves content under a still pointer, so
  // it re-runs the hit test from here instead of waiting for a pointer move.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const hitTestRef = useRef<(x: number, y: number) => void>(() => {});

  useEffect(() => {
    if (!drag) return;
    let raf = 0;
    const tick = () => {
      const el = containerRef.current;
      if (el && autoScroll.current !== 0) {
        el.scrollTop += autoScroll.current;
        const point = lastPointer.current;
        if (point) hitTestRef.current(point.x, point.y);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drag]);

  /** Only destructive/creating gestures need the 1.5s hold. */
  const needsHold = useCallback(
    (info: DropInfo) => {
      if (!info || info.type !== "hold") return false;
      if (info.kind === "media") return true; // creating a new group
      if (info.kind === "ungroup") {
        const g = groupOfMedia.get(info.id);
        return !!g && g.memberIds.length <= 2; // last two -> group disbands
      }
      return false; // adding to an existing group is instant
    },
    [groupOfMedia],
  );

  /**
   * The media a drag is carrying: the whole selection when the card under the
   * pointer is part of it, otherwise just that card. Returned in Gallery order
   * so a batch keeps the sequence it already had wherever it lands.
   */
  const draggedMediaIds = useCallback((source: OrderEntry) => {
    if (source.kind !== "media" || selected.length < 2 || !selectedSet.has(source.id)) return [source.id];
    const ordered = state.media.filter((media) => selectedSet.has(media.id)).map((media) => media.id);
    return ordered.length ? ordered : [source.id];
  }, [selected.length, selectedSet, state.media]);

  /** Apply the current drop target. Reports whether anything changed. */
  const applyDrop = useCallback(() => {
    const source = pointerStart.current?.entry ?? drag;
    const info = dropRef.current;
    if (!source || !info) return false;
    if (info.type === "insert") {
      // Dragging one of several selected cards reorders the whole selection,
      // as a block and in the sequence it already had, rather than pulling out
      // the single card that happened to be under the pointer.
      const block = source.kind === "media" && selected.length > 1 && selectedSet.has(source.id)
        ? state.order.filter((entry) => entry.kind === "media" && selectedSet.has(entry.id))
        : [];
      if (block.length > 1) moveEntriesTo(block, info.index);
      else moveEntry(source, info.index);
      return true;
    }
    if (info.type === "member-insert") {
      if (source.kind !== "media") return false;
      insertManyIntoGroup(info.groupId, draggedMediaIds(source), info.index);
      return true;
    }
    if (needsHold(info)) {
      const held = holdRef.current;
      const complete = held && performance.now() - held.start >= HOLD_MS;
      if (!complete) return false;
    }
    if (source.kind !== "media") return false;
    // A new Group takes the place of the card it was dropped onto.
    if (info.kind === "media") createGroup([info.id, ...draggedMediaIds(source)], info.id);
    if (info.kind === "group") {
      const group = groupById.get(info.id);
      insertManyIntoGroup(info.id, draggedMediaIds(source), group?.memberIds.length ?? 0);
    }
    if (info.kind === "ungroup") {
      const g = groupOfMedia.get(source.id);
      if (g && g.memberIds.length <= 2) dissolveGroup(g.id);
      else removeFromGroup(source.id);
    }
    return true;
  }, [createGroup, dissolveGroup, drag, draggedMediaIds, groupById, groupOfMedia, insertManyIntoGroup, moveEntriesTo, moveEntry, needsHold, removeFromGroup, selected.length, selectedSet, state.order]);

  // Groups drawn inline in a row — collapsed to a pile, or fitted to their
  // media — sit among the cards, so dragging one positions it like a card.
  // Only an expanded full-width Group moves between whole rows.
  const inlineGroupIds = useRef(new Set<string>());

  // What the pointer is over right now, as a drop target. Pure with respect
  // to React state apart from the setters at the end, and cheap enough to run
  // once per animation frame.
  const hitTest = (x: number, y: number) => {
    if (!drag) return;
    const root = containerRef.current;
    if (!root) return;
    const previous = dropRef.current;
    let next: DropInfo = null;

    const draggingInlineGroup = drag.kind === "group" && inlineGroupIds.current.has(drag.id);
    const dragActsAsCard = drag.kind === "media" || draggingInlineGroup;

    if (drag.kind === "group" && !draggingInlineGroup) {
      // An expanded Group owns whole rows, so it lands between rows: before
      // or after the band under the pointer — a row of media or another
      // Group alike. Geometry, not the DOM, so the gaps between rows and the
      // rows that are not mounted resolve just as well.
      const inner = innerRef.current;
      const bands = groupBandsRef.current;
      if (inner && bands.length) {
        const cy = y - inner.getBoundingClientRect().top;
        const index = bands.findIndex((band) => cy < band.bottom + GAP / 2);
        if (index < 0) {
          const last = bands[bands.length - 1]!;
          if (last.groupId !== drag.id) next = { type: "insert", index: last.last + 1, axis: "y", railY: last.bottom + GAP / 2 };
        } else {
          const band = bands[index]!;
          if (band.groupId !== drag.id) {
            next = cy < (band.top + band.bottom) / 2
              ? { type: "insert", index: band.first, axis: "y", railY: band.top - GAP / 2 }
              : { type: "insert", index: band.last + 1, axis: "y", railY: band.bottom + GAP / 2 };
          }
        }
      }
    } else {
      const stack = document.elementsFromPoint(x, y);
      const mediaEl = stack.find((n) => (n as HTMLElement).dataset?.['mediaId']) as HTMLElement | undefined;
      const groupEl = stack.find((n) => (n as HTMLElement).dataset?.['groupId']) as HTMLElement | undefined;

      // Expanded groups contain ordinary media cards. A new image is inserted
      // between those cards directly, with the same seam/rail behaviour as
      // the Library — never a hold overlay.
      // `elementsFromPoint` may stop at the member card and omit its group
      // frame. The member itself carries the authoritative group id.
      const targetGroupId = groupEl?.dataset['groupId'] ?? mediaEl?.dataset['inGroup'];
      const sourceGroupId = drag.kind === "media" ? groupOfMedia.get(drag.id)?.id : undefined;
      const isDraggingWithinOwnGroup = Boolean(sourceGroupId && targetGroupId === sourceGroupId);
      const memberCards = (groupId: string) => [...root.querySelectorAll<HTMLElement>(`[data-in-group="${groupId}"]`)];

      // Holding over a card to group with it survives small drift into the
      // card's reorder edges once the hold has begun.
      if (drag.kind === "media" && previous?.type === "hold" && (previous.kind === "media" || previous.kind === "group") && mediaEl && !mediaEl.dataset['inGroup']) {
        const heldId = previous.kind === "media" ? mediaEl.dataset['mediaId'] : mediaEl.dataset['entryKind'] === "group" ? mediaEl.dataset['entryId'] : undefined;
        if (heldId === previous.id) {
          const rect = mediaEl.getBoundingClientRect();
          const keep = holdKeepFor(rect);
          if (x >= rect.left + keep && x <= rect.right - keep) next = previous;
        }
      }

      // A member dragged inside its own expanded group must use the same
      // left/right seams as Library, but reorder `memberIds` instead of
      // accidentally moving the whole group in the global Library order.
      if (!next && sourceGroupId && targetGroupId === sourceGroupId && drag.kind === "media") {
        const group = groupById.get(sourceGroupId);
        const rowMembers = memberCards(sourceGroupId)
          .filter((card) => {
            const rect = card.getBoundingClientRect();
            return card.dataset['mediaId'] !== drag.id && y >= rect.top && y <= rect.bottom;
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        for (let i = 0; group && i < rowMembers.length - 1; i += 1) {
          const left = rowMembers[i]!;
          const right = rowMembers[i + 1]!;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          if (x < leftRect.right - edgeFor(leftRect) || x > rightRect.left + edgeFor(rightRect)) continue;
          const index = group.memberIds.indexOf(right.dataset['mediaId']!);
          if (index >= 0) next = { type: "member-insert", groupId: sourceGroupId, index };
          break;
        }
        if (!next && mediaEl?.dataset['inGroup'] === sourceGroupId && mediaEl.dataset['mediaId'] !== drag.id && group) {
          const rect = mediaEl.getBoundingClientRect();
          const index = group.memberIds.indexOf(mediaEl.dataset['mediaId']!);
          if (index >= 0 && x - rect.left <= edgeFor(rect)) next = { type: "member-insert", groupId: sourceGroupId, index };
          else if (index >= 0 && rect.right - x <= edgeFor(rect)) next = { type: "member-insert", groupId: sourceGroupId, index: index + 1 };
        }
        // The far-right part of an expanded Group is empty panel, not a media
        // card. It is still the final member seam, so it must be a valid drop
        // target and show the same Rail as every other member seam.
        if (!next && groupEl?.dataset['groupId'] === sourceGroupId && group) {
          next = { type: "member-insert", groupId: sourceGroupId, index: group.memberIds.length };
        }
      }
      if (!next && targetGroupId && drag.kind === "media" && sourceGroupId !== targetGroupId) {
        const group = groupById.get(targetGroupId);
        const members = memberCards(targetGroupId);
        const rowMembers = members
          .filter((card) => {
            const rect = card.getBoundingClientRect();
            return y >= rect.top && y <= rect.bottom;
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        for (let i = 0; group && i < rowMembers.length - 1; i += 1) {
          const left = rowMembers[i]!;
          const right = rowMembers[i + 1]!;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          if (x < leftRect.right - edgeFor(leftRect) || x > rightRect.left + edgeFor(rightRect)) continue;
          const index = group.memberIds.indexOf(right.dataset['mediaId']!);
          if (index >= 0) next = { type: "member-insert", groupId: targetGroupId, index };
          break;
        }
        if (!next && mediaEl?.dataset['inGroup'] === targetGroupId && group) {
          const rect = mediaEl.getBoundingClientRect();
          const index = group.memberIds.indexOf(mediaEl.dataset['mediaId']!);
          if (index >= 0) next = { type: "member-insert", groupId: targetGroupId, index: x < rect.left + rect.width / 2 ? index : index + 1 };
        }
        // Every point in an expanded group resolves to its nearest member
        // seam. It must never fall back to the old hold/spinner treatment.
        if (!next && group) {
          const distance = (rect: DOMRect) => Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
          const nearest = members.reduce<HTMLElement | null>((closest, card) => {
            if (!closest) return card;
            return distance(card.getBoundingClientRect()) < distance(closest.getBoundingClientRect()) ? card : closest;
          }, null);
          if (nearest) {
            const rect = nearest.getBoundingClientRect();
            const index = group.memberIds.indexOf(nearest.dataset['mediaId']!);
            if (index >= 0) next = { type: "member-insert", groupId: targetGroupId, index: x < rect.left + rect.width / 2 ? index : index + 1 };
          }
        }
        // Do not ever turn an expanded group into a generic "drop on group".
        // Its final fallback is still a concrete member insertion at the end.
        if (!next && group) next = { type: "member-insert", groupId: targetGroupId, index: group.memberIds.length };
        if (!next) next = { type: "hold", kind: "group", id: targetGroupId };
      }

      // A seam is one continuous target: the physical gap plus the outer
      // edges of the two neighbouring cards. `elementsFromPoint` cannot see
      // the gap, which was why dragging to the exact middle did nothing.
      if (!next && dragActsAsCard && !isDraggingWithinOwnGroup) {
        const rowCards = [...root.querySelectorAll<HTMLElement>("[data-media-id]")]
          .filter((card) => {
            const rect = card.getBoundingClientRect();
            return (
              card.dataset['entryId'] !== drag.id &&
              card.dataset['mediaId'] !== drag.id &&
              !(drag.kind === "group" && card.dataset['inGroup'] === drag.id) &&
              y >= rect.top &&
              y <= rect.bottom
            );
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        for (let i = 0; i < rowCards.length - 1; i += 1) {
          const left = rowCards[i]!;
          const right = rowCards[i + 1]!;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          if (x < leftRect.right - edgeFor(leftRect) || x > rightRect.left + edgeFor(rightRect)) continue;
          const rightEntry = {
            kind: (right.dataset['entryKind'] ?? "media") as "media" | "group",
            id: right.dataset['entryId']!,
          };
          const raw = globalIndex(rightEntry);
          const inGroup = right.dataset['inGroup'];
          const insertionIndex = raw >= 0 ? raw : inGroup ? globalIndex({ kind: "group", id: inGroup }) : -1;
          if (insertionIndex >= 0) next = { type: "insert", index: insertionIndex, axis: "x" };
          break;
        }
      }

      if (next) {
        // Resolved above.
      } else if (dragActsAsCard && !isDraggingWithinOwnGroup && mediaEl && mediaEl.dataset['mediaId'] !== drag.id && mediaEl.dataset['entryId'] !== drag.id) {
        const rect = mediaEl.getBoundingClientRect();
        const entryId = mediaEl.dataset['entryId']!;
        const entryKind = (mediaEl.dataset['entryKind'] ?? "media") as "media" | "group";
        const inGroup = mediaEl.dataset['inGroup'];
        // A member of a Group reorders around its Group in the top-level order.
        const raw = globalIndex({ kind: entryKind, id: entryId });
        const idx = raw >= 0 ? raw : inGroup ? globalIndex({ kind: "group", id: inGroup }) : 0;
        if (x - rect.left <= edgeFor(rect)) next = { type: "insert", index: Math.max(idx, 0), axis: "x" };
        else if (rect.right - x <= edgeFor(rect)) next = { type: "insert", index: Math.max(idx, 0) + 1, axis: "x" };
        else if (entryKind === "group" && drag.kind === "media") next = { type: "hold", kind: "group", id: entryId };
        else if (drag.kind === "media" && !inGroup) next = { type: "hold", kind: "media", id: mediaEl.dataset['mediaId']! };
      } else if (!isDraggingWithinOwnGroup && groupEl && groupEl.dataset['groupId'] !== drag.id) {
        const rect = groupEl.getBoundingClientRect();
        const idx = globalIndex({ kind: "group", id: groupEl.dataset['groupId']! });
        if (x - rect.left <= edgeFor(rect)) next = { type: "insert", index: idx, axis: "x" };
        else if (rect.right - x <= edgeFor(rect)) next = { type: "insert", index: idx + 1, axis: "x" };
        // A Group cannot be nested into another Group, so the hold target
        // does not apply — it falls back to the nearer side instead.
        else if (draggingInlineGroup) {
          next = { type: "insert", index: x < rect.left + rect.width / 2 ? idx : idx + 1, axis: "x" };
        } else next = { type: "hold", kind: "group", id: groupEl.dataset['groupId']! };
      } else if (!isDraggingWithinOwnGroup && ((drag.kind === "media" && sourceGroupId) || draggingInlineGroup)) {
        // Dragging a member out — or dragging an inline Group, which is a
        // card like any other — must behave exactly like positioning an
        // ordinary Library card. Even a blank part of a row resolves to the
        // nearest top-level item and shows an insertion rail — never a hold.
        const candidates = [
          ...root.querySelectorAll<HTMLElement>("[data-entry-id]"),
          ...root.querySelectorAll<HTMLElement>("[data-group-id]"),
        ].filter((node, index, all) => all.indexOf(node) === index).filter((node) => {
          const entry = node.dataset['groupId']
            ? { kind: "group" as const, id: node.dataset['groupId']! }
            : { kind: (node.dataset['entryKind'] ?? "media") as "media" | "group", id: node.dataset['entryId']! };
          const rect = node.getBoundingClientRect();
          // The card being dragged is not a target for itself.
          if (entry.id === drag.id) return false;
          return globalIndex(entry) >= 0 && rect.width > 0 && rect.height > 0;
        });
        const distance = (rect: DOMRect) => Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
        const nearest = candidates.reduce<HTMLElement | null>((closest, node) => {
          if (!closest) return node;
          return distance(node.getBoundingClientRect()) < distance(closest.getBoundingClientRect()) ? node : closest;
        }, null);
        if (nearest) {
          const entry = nearest.dataset['groupId']
            ? { kind: "group" as const, id: nearest.dataset['groupId']! }
            : { kind: (nearest.dataset['entryKind'] ?? "media") as "media" | "group", id: nearest.dataset['entryId']! };
          const index = globalIndex(entry);
          const rect = nearest.getBoundingClientRect();
          if (index >= 0) next = { type: "insert", index: x < rect.left + rect.width / 2 ? index : index + 1, axis: "x" };
        }
        // Only a media card can be pulled out of its Group; a Group itself has
        // nothing to ungroup into, so it simply finds no target.
        if (!next && drag.kind === "media") next = { type: "hold", kind: "ungroup", id: drag.id };
      }

      // Blank canvas is a real drop target, resolved to the nearest card's
      // near seam. Every earlier branch needs a card under the pointer, so the
      // empty area past the final card produced no target at all — which is
      // why an item could never be ordered after the last media.
      if (!next && dragActsAsCard && !isDraggingWithinOwnGroup) {
        const distance = (rect: DOMRect) => Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
        const candidates = [...root.querySelectorAll<HTMLElement>("[data-entry-id]")].filter((node) => {
          const rect = node.getBoundingClientRect();
          // Members of a Group belong to the member-insert path.
          return node.dataset['entryId'] !== drag.id && !node.dataset['inGroup'] && rect.width > 0 && rect.height > 0;
        });
        const nearest = candidates.reduce<HTMLElement | null>(
          (closest, node) => (!closest || distance(node.getBoundingClientRect()) < distance(closest.getBoundingClientRect()) ? node : closest),
          null,
        );
        if (nearest) {
          const rect = nearest.getBoundingClientRect();
          const index = globalIndex({
            kind: (nearest.dataset['entryKind'] ?? "media") as "media" | "group",
            id: nearest.dataset['entryId']!,
          });
          // Below the card's row, or past its midpoint on the same row, means
          // the seam after it — that is the trailing position of the Gallery.
          const after = y > rect.bottom || (y >= rect.top && x > rect.left + rect.width / 2);
          if (index >= 0) next = { type: "insert", index: after ? index + 1 : index, axis: "x" };
        }
      }
    }

    const key = next?.type === "hold" && needsHold(next) ? `${next.kind}:${next.id}` : "";
    if (!key) {
      if (holdRef.current) finishHold();
    } else if (holdRef.current?.key !== key) {
      const start = performance.now();
      holdRef.current = { key, start };
      setHoldStart(start);
    }

    if (next?.type === "member-insert") {
      const group = groupById.get(next.groupId);
      const beforeId = group?.memberIds[next.index];
      const afterId = group?.memberIds[next.index - 1];
      next = { ...next, railMediaId: beforeId ?? afterId, railSide: beforeId ? "left" : "right" };
    }
    dropRef.current = next;
    // Re-rendering the Gallery only when the target actually changes, rather
    // than on every pointer move, is most of what keeps a drag smooth.
    if (!sameDrop(previous, next)) setDrop(next);
  };
  hitTestRef.current = hitTest;

  useEffect(() => {
    if (!drag) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      // Carrying media past the window's edge hands it to the OS as files,
      // so it can be dropped into Figma, Photoshop, Explorer or a browser.
      // The in-app drag ends there: nothing inside Mosaic is the target.
      const outside = e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
      if (outside && drag.kind === "media") {
        const ids = selected.includes(drag.id) ? selected : [drag.id];
        const medias = ids.map((id) => mediaById(id)).filter((media): media is MediaItem => !!media);
        if (startExternalDrag(medias)) {
          if (frame) { cancelAnimationFrame(frame); frame = 0; }
          suppressClickUntil.current = performance.now() + 250;
          autoScroll.current = 0;
          lastPointer.current = null;
          pointerStart.current = null;
          dropRef.current = null;
          finishHold();
          setDrop(null);
          setDrag(null);
          setDragOrigin(null);
          setDragPreviewId(null);
          finishMediaDrag();
          return;
        }
      }
      lastPointer.current = { x: e.clientX, y: e.clientY };
      const el = containerRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        // Drag auto-scroll belongs to the pane the pointer is actually over.
        // Testing clientY alone meant carrying a card up the Sidebar scrolled
        // the Gallery behind it too, on top of the Sidebar's own scrolling.
        const overGallery = e.clientX >= r.left && e.clientX <= r.right;
        if (!overGallery) autoScroll.current = 0;
        else if (e.clientY < r.top + 60) autoScroll.current = -14;
        else if (e.clientY > r.bottom - 60) autoScroll.current = 14;
        else autoScroll.current = 0;
      }
      // Pointer events can arrive several times per frame. Hit testing reads
      // the layout of every mounted card, so do it at most once per frame,
      // for the latest position.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const point = lastPointer.current;
        if (point) hitTestRef.current(point.x, point.y);
      });
    };

    const onUp = (event: PointerEvent) => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      // Sidebar rows are outside the Gallery's React subtree, so handling the
      // final pointer position here is more reliable than depending on a
      // cross-panel pointerenter/drop event in Electron. It also leaves the
      // same pointer gesture free for Library ordering and hover-to-group.
      const targetGalleryId = drag.kind === "media"
        ? document.elementsFromPoint(event.clientX, event.clientY)
          .map((element) => (element as HTMLElement).closest<HTMLElement>("[data-gallery-media-drop-id]"))
          .find((element): element is HTMLElement => !!element)
          ?.dataset['galleryMediaDropId']
        : undefined;
      let changed = false;
      if (targetGalleryId) {
        const mediaIds = selected.includes(drag.id) ? selected : [drag.id];
        if (targetGalleryId === MAIN_GALLERY_DROP_ID) {
          // Main Gallery is the complete media set, rather than a second
          // membership list. Returning media to it simply removes the
          // Gallery-specific membership it was dragged out of.
          if (currentFolderId) mediaIds.forEach((mediaId) => removeFromFolder(currentFolderId, mediaId));
        } else {
          moveToFolder(targetGalleryId, mediaIds, currentFolderId);
        }
        changed = true;
      } else {
        // Resolve the target for the exact release point: the last frame's
        // hit test may be a few pixels behind it.
        hitTestRef.current(event.clientX, event.clientY);
        changed = applyDrop();
      }
      // The dragged batch has just been acted on. Leaving it selected is what
      // let the next Ctrl/Cmd-click add to that stale, already-moved batch
      // instead of starting a fresh pick.
      if (changed) setSelected([]);
      suppressClickUntil.current = performance.now() + 250;
      autoScroll.current = 0;
      lastPointer.current = null;
      pointerStart.current = null;
      dropRef.current = null;
      finishHold();
      setDrop(null);
      setDrag(null);
      setDragOrigin(null);
      setDragPreviewId(null);
      // Sidebar also observes the same pointer drag as a reliable fallback
      // for Electron builds that suppress native HTML drag/drop events.
      finishMediaDrag();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applyDrop, currentFolderId, drag, finishHold, mediaById, moveToFolder, removeFromFolder, selected, setSelected]);

  const startPointer = (e: React.PointerEvent, entry: OrderEntry, previewMediaId?: string) => {
    if (e.button !== 0) return;
    pointerStart.current = { x: e.clientX, y: e.clientY, entry };
    const onMove = (ev: PointerEvent) => {
      const s = pointerStart.current;
      if (!s) return;
      if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 5) {
        if (entry.kind === "media") {
          const mediaIds = selected.includes(entry.id) ? selected : [entry.id];
          beginMediaDrag({ mediaIds, sourceFolderId: currentFolderId ?? null });
        }
        lastPointer.current = { x: ev.clientX, y: ev.clientY };
        setDrag(entry);
        setDragOrigin({ x: ev.clientX, y: ev.clientY });
        setDragPreviewId(previewMediaId ?? null);
        window.removeEventListener("pointermove", onMove);
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- marquee --------------------------------------------------------
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-media-id],[data-group-id]")) return;
    const el = containerRef.current!;
    const rect = el.getBoundingClientRect();
    marqueeStart.current = { x: e.clientX - rect.left, y: e.clientY - rect.top + el.scrollTop };
    setSelected([]);

    const move = (ev: PointerEvent) => {
      const s = marqueeStart.current;
      if (!s) return;
      const x2 = ev.clientX - rect.left;
      const y2 = ev.clientY - rect.top + el.scrollTop;
      const box = {
        x: Math.min(s.x, x2),
        y: Math.min(s.y, y2),
        w: Math.abs(x2 - s.x),
        h: Math.abs(y2 - s.y),
      };
      setMarquee(box);
      const hits: string[] = [];
      const inner = innerRef.current;
      if (inner) {
        // Only a couple of screens of cards are mounted, so the box is tested
        // against the solved row geometry instead of the DOM; a DOM sweep
        // silently dropped every media the box covered outside that window.
        // Content coordinates start at the scroll container's border box,
        // while a row's `top` is measured from the inner box, so the two
        // differ by the container's padding.
        const innerRect = inner.getBoundingClientRect();
        const offsetX = innerRect.left - rect.left;
        const offsetY = innerRect.top - rect.top + el.scrollTop;
        for (const row of virtualGeometry.current.rows) {
          const top = row.top + offsetY;
          if (top >= box.y + box.h || top + row.height <= box.y) continue;
          const left = offsetX + (row.groupId ? GROUP_INSET : 0);
          for (const cell of rowCellBoxes(row)) {
            const x = left + cell.left;
            const y = top + cell.top;
            if (x < box.x + box.w && x + cell.width > box.x && y < box.y + box.h && y + cell.height > box.y) hits.push(cell.id);
          }
        }
      }
      setSelected(hits);
    };
    const up = () => {
      marqueeStart.current = null;
      setMarquee(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handleSelect = (e: React.MouseEvent | React.KeyboardEvent, id: string) => {
    if (performance.now() < suppressClickUntil.current) return;
    if (e.metaKey || e.ctrlKey) {
      setSelected(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
      return;
    }
    // Clicking the card that is already the whole selection clears it, so the
    // same plain click both selects and unselects. `detail` counts clicks in
    // the current sequence: skipping it at 2 keeps the second click of a
    // double-click — the one that opens the Lightbox — from unselecting.
    const detail = "detail" in e ? e.detail : 1;
    if (detail < 2 && selected.length === 1 && selected[0] === id) {
      setSelected([]);
      return;
    }
    // Clicking one of several selected cards narrows down to it rather than
    // dropping it, which is what keeps a multi-selection collapsible.
    setSelected([id]);
  };

  // Cards are memoized, so they receive one stable set of handlers that
  // always forwards to the handlers of the latest render.
  const cardHandlers = useRef<CardActions | null>(null);
  cardHandlers.current = {
    pointerDown: startPointer,
    select: handleSelect,
    open: onOpen,
    toggleFavorite,
    expandGroup: (groupId) => updateGroup(groupId, { collapsed: false }),
  };
  const cardActions = useMemo<CardActions>(() => ({
    pointerDown: (event, entry, mediaId) => cardHandlers.current!.pointerDown(event, entry, mediaId),
    select: (event, id) => cardHandlers.current!.select(event, id),
    open: (id) => cardHandlers.current!.open(id),
    toggleFavorite: (id) => cardHandlers.current!.toggleFavorite(id),
    expandGroup: (groupId) => cardHandlers.current!.expandGroup(groupId),
  }), []);
  const cardLabels = useMemo(() => ({ expandGroup: t("expandGroup"), dragToReorder: t("dragToReorder") }), [t]);

  // One context menu for the whole Gallery. A Radix menu per card mounted
  // hundreds of menu roots, and rebuilt every card's menu items on every
  // render; this one builds the menu for the card actually right-clicked.
  const onGalleryContextMenu = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>("[data-media-id]");
    if (card && containerRef.current?.contains(card)) {
      if (card.dataset['entryKind'] === "group") setMenuTarget({ kind: "group", id: card.dataset['entryId']! });
      else setMenuTarget({ kind: "media", id: card.dataset['mediaId']! });
      return;
    }
    const frame = target.closest<HTMLElement>("[data-group-id]");
    if (frame && containerRef.current?.contains(frame)) {
      setMenuTarget({ kind: "group", id: frame.dataset['groupId']! });
      return;
    }
    // Blank canvas has no menu.
    event.preventDefault();
  };

  // Radix renders menus and dialogs in portals, but their React events still
  // bubble through this Gallery. Do not let an action click become a canvas
  // pointer-down: that starts marquee selection and can replace the selected
  // image ids before the menu action gets to use them.
  const stopCanvasPointerDown = (event: React.PointerEvent) => event.stopPropagation();

  // ---- context menu ---------------------------------------------------
  // `anchorId` is the card the menu was opened on: a Group made from the
  // selection appears in its place, rather than wherever the last-clicked
  // member happened to sit.
  const selectionMenu = (ids: string[], anchorId: string) => {
    const hasClipboard = Object.values(clipboard).some((values) => values.length);
    return (
      <ContextMenuContent onPointerDown={stopCanvasPointerDown} className="glass-float w-64 rounded-xl">
        <ContextMenuItem className={menuItem} onSelect={() => { createGroup(ids, anchorId); setSelected([]); }}>
          <Shapes className="size-4 text-[#A56F63]" /> {c(`Tạo group từ ${ids.length} ảnh đã chọn`, `Create group from ${ids.length} selected images`)}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => { setGalleryPickerQuery(""); setAddGroupToGalleryFor(ids); }}>
          <FolderPlus className="size-4 text-[#C59A18]" /> {c(`Thêm ${ids.length} ảnh vào Gallery`, `Add ${ids.length} images to Gallery`)}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => setCutEntries(ids.map((id) => ({ kind: "media", id })))}>
          <Scissors className="size-4 text-[#8E7CC3]" /> {c(`Cắt ${ids.length} media`, `Cut ${ids.length} media`)}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => { void regenerate(ids); }}>
          <RefreshCw className="size-4 text-[#5F839A]" /> {c(`Tạo lại thumbnail cho ${ids.length} media`, `Regenerate thumbnails for ${ids.length} media`)}
        </ContextMenuItem>
        <ContextMenuItem
          className={menuItem}
          onSelect={() => {
            const paths = ids.map((id) => mediaById(id)).filter((media): media is MediaItem => !!media && canDragOut(media)).map((media) => media.path);
            if (paths.length) void copyText(paths.join("\n"), state.language, c(`${paths.length} đường dẫn`, `${paths.length} paths`));
          }}
        >
          <Link2 className="size-4 text-[#5F839A]" /> {c(`Sao chép ${ids.length} đường dẫn`, `Copy ${ids.length} paths`)}
        </ContextMenuItem>
        {hasClipboard && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => {
              for (const [groupId, values] of Object.entries(clipboard)) {
                for (const value of values) addPropValue(ids, groupId, value);
              }
            }}
          >
            <ClipboardPaste className="size-4 text-[#5F839A]" /> {c("Dán thẻ vào ảnh đã chọn", "Paste tags to selected images")}
          </ContextMenuItem>
        )}
        {currentFolderId ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={menuItem}
              onSelect={() => onConfirm({
                title: c(`Ẩn ${ids.length} ảnh khỏi Gallery?`, `Hide ${ids.length} images from this Gallery?`),
                description: c("Ảnh sẽ vào thùng rác của Gallery này. File gốc trong Folder nguồn vẫn được giữ.", "The images will enter this Gallery's trash. Original files in source folders are kept."),
                onConfirm: () => {
                  ids.forEach((id) => discardFromFolder(currentFolderId, id));
                  setSelected([]);
                },
              })}
            >
              <EyeOff className="size-4 text-[#FB6C00]" /> {c(`Ẩn ${ids.length} ảnh khỏi Gallery`, `Hide ${ids.length} images from Gallery`)}
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={menuItem}
              onSelect={() => onConfirm({
                title: c(`Ẩn ${ids.length} media khỏi Main Gallery?`, `Hide ${ids.length} media from Main Gallery?`),
                description: c("Media sẽ vào thùng rác Mosaic và có thể khôi phục. File gốc không bị thay đổi.", "Media will enter Mosaic trash and can be restored. Original files are unchanged."),
                onConfirm: () => { hideMedia(ids); setSelected([]); },
              })}
            >
              <EyeOff className="size-4 text-[#FB6C00]" /> {c(`Ẩn ${ids.length} media khỏi Main Gallery`, `Hide ${ids.length} media from Main Gallery`)}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    );
  };

  const mediaMenu = (m: MediaItem) => {
    const mediaEntry: OrderEntry = { kind: "media", id: m.id };
    const selectedIds = selected.length >= 2 && selectedSet.has(m.id)
      ? [...new Set(selected)].filter((id) => !!mediaById(id))
      : [];
    // Right-clicking one of several selected cards is a bulk operation. Do
    // not expose open/copy/cover/delete-one actions in that situation.
    if (selectedIds.length >= 2) return selectionMenu(selectedIds, m.id);
    const group = groupOfMedia.get(m.id);
    const hasClipboard = Object.values(clipboard).some((v) => v.length);
    return (
      <ContextMenuContent onPointerDown={stopCanvasPointerDown} className="glass-float w-64 rounded-xl">
        <ContextMenuItem className={menuItem} onSelect={() => onOpen(m.id)}>
          <Maximize2 className="size-4 text-[#1686DC]" /> {t("open")}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => { void openInFolder(m); }}>
          <FolderOpen className="size-4 text-[#C59A18]" /> {t("openInFolder")}
        </ContextMenuItem>
        <ContextMenuItem
          className={menuItem}
          // RAW/HEIC/TIFF/PSD and SVG copy the 2048 px rendering main.js makes.
          disabled={m.type !== "image"}
          onSelect={() => { void copyImageToClipboard(m); }}
        >
          <Copy className="size-4 text-[#4A9D72]" /> {t("copyImage")}
        </ContextMenuItem>
        {isSvgMedia(m) && (
          <ContextMenuItem className={menuItem} onSelect={() => { void copySvgMarkup(m, state.language); }}>
            <Code2 className="size-4 text-[#4A9D72]" /> {c("Sao chép mã SVG", "Copy SVG code")}
          </ContextMenuItem>
        )}
        <ContextMenuItem className={menuItem} disabled={!canDragOut(m)} onSelect={() => { void copyText(m.path, state.language, c("đường dẫn", "the path")); }}>
          <Link2 className="size-4 text-[#5F839A]" /> {c("Sao chép đường dẫn", "Copy path")}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} disabled={!canDragOut(m)} onSelect={() => { void openWithChooser(m, state.language); }}>
          <AppWindow className="size-4 text-[#1686DC]" /> {c("Mở bằng…", "Open with…")}
        </ContextMenuItem>
        {selected.length >= 2 && selectedSet.has(m.id) && (
          <ContextMenuItem className={menuItem} onSelect={() => { createGroup([...selected], m.id); setSelected([]); }}>
            <Boxes className="size-4" /> {t("createGroupSelected")}
            <ContextMenuShortcut>Ctrl+G</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {group && (
          <>
            <ContextMenuSeparator className="bg-gradient-to-r from-[#B81E2D]/45 via-border to-[#A5D6A7]/45" />
            <ContextMenuItem
              className={menuItem}
              onSelect={() => {
                if (group.memberIds.length <= 2) dissolveGroup(group.id);
                else removeFromGroup(m.id);
              }}
            >
              <Ungroup className="size-4" /> {t("removeFromGroup")}
              <ContextMenuShortcut>Ctrl+Shift+G</ContextMenuShortcut>
            </ContextMenuItem>
            {group.coverId !== m.id && (
              <ContextMenuItem className={menuItem} onSelect={() => updateGroup(group.id, { coverId: m.id })}>
                <ImageIcon className="size-4 text-[#A5D6A7]" /> {c("Đặt làm ảnh đại diện group", "Set as group cover")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator className="bg-gradient-to-r from-[#B81E2D]/45 via-border to-[#A5D6A7]/45" />
          </>
        )}
        {!group && <ContextMenuSeparator />}
        <ContextMenuItem className={menuItem} onSelect={() => setCutEntries([mediaEntry])}>
          <Scissors className="size-4 text-[#8E7CC3]" /> {c("Cắt media", "Cut media")}
        </ContextMenuItem>
        {cutEntries.length > 0 && !cutEntries.some((item) => item.kind === "media" && item.id === m.id) && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => { moveEntriesAfter(mediaEntry, cutEntries); setCutEntries([]); setSelected([]); }}
          >
            <ClipboardPaste className="size-4 text-[#8E7CC3]" />
            {c(`Dán ${cutEntries.length} media vào sau ảnh này`, `Paste ${cutEntries.length} media after this one`)}
          </ContextMenuItem>
        )}
        {state.propertyGroups.map((g) => (
          <ContextMenuItem
            key={g.id}
            className={menuItem}
            onSelect={() => setClipboard((c) => ({ ...c, [g.id]: m.props[g.id] ?? [] }))}
          >
            <Tag className="size-4 text-[#5F839A]" />
            {g.id === "character" ? t("copyCharacter") : `${t("copyTheme").split(" ")[0]} ${g.name}`}
          </ContextMenuItem>
        ))}
        {hasClipboard && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => {
              for (const [gid, values] of Object.entries(clipboard))
                for (const v of values) addPropValue([m.id], gid, v);
            }}
          >
            <ClipboardPaste className="size-4 text-[#24B1B1]" /> {t("pasteTags")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem className={menuItem} onSelect={() => duplicateMedia(m.id)}>
          <CopyPlus className="size-4 text-[#24B1B1]" /> {t("duplicate")}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => { void regenerate([m.id]); }}>
          <RefreshCw className="size-4 text-[#5F839A]" /> {c("Tạo lại thumbnail", "Regenerate thumbnail")}
        </ContextMenuItem>
        {currentFolderId && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => updateFolder(currentFolderId, { coverId: m.id })}
          >
            <ImageIcon className="size-4 text-[#A5D6A7]" /> {t("setFolderCover")}
          </ContextMenuItem>
        )}
        <ContextMenuItem className={menuItem} onSelect={() => { setGalleryPickerQuery(""); setAddToGalleryFor(m.id); }}>
          <FolderPlus className="size-4 text-[#FFC349]" /> {t("addToFolder")}
        </ContextMenuItem>
        {currentFolderId && (
          <ContextMenuItem className={menuItem} onSelect={() => setMoveToGalleryFor(m.id)}>
            <FolderInput className="size-4 text-[#FF9A00]" /> {c("Chuyển vào Gallery", "Move to Gallery")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {currentFolderId && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => onConfirm({
              title: c("Ẩn ảnh khỏi Gallery?", "Hide image from Gallery?"),
              description: c("Ảnh sẽ vào thùng rác của Gallery này. File gốc trong Folder nguồn vẫn được giữ.", "The image will enter this Gallery's trash. Original files in source folders are kept."),
              onConfirm: () => discardFromFolder(currentFolderId, m.id),
            })}
          >
            <EyeOff className="size-4 text-[#FB6C00]" /> {c("Ẩn ảnh khỏi Gallery", "Hide image from Gallery")}
          </ContextMenuItem>
        )}
        {!currentFolderId && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => onConfirm({
              title: c("Ẩn media khỏi Main Gallery?", "Hide media from Main Gallery?"),
              description: c("Media sẽ vào thùng rác Mosaic và có thể khôi phục. File gốc không bị thay đổi.", "Media will enter Mosaic trash and can be restored. Original files are unchanged."),
              onConfirm: () => hideMedia([m.id]),
            })}
          >
            <EyeOff className="size-4 text-[#FB6C00]" /> {c("Ẩn media khỏi Main Gallery", "Hide media from Main Gallery")}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className={menuItem}
          // A Vault keeps no file on disk, so it answers with its own trash
          // instead of the Recycle Bin. Both are recoverable, so the wording
          // only has to name the right destination.
          onSelect={() => onConfirm({
            title: m.vault
              ? c("Đưa file vào Thùng rác của Vault?", "Move file to the Vault trash?")
              : c("Đưa file vào Thùng rác máy tính?", "Move file to the Windows Recycle Bin?"),
            description: m.vault
              ? c("File vẫn được mã hóa trong Vault và có thể khôi phục từ Thùng rác của Vault.", "The file stays encrypted inside the Vault and can be restored from the Vault trash.")
              : c("File gốc sẽ được chuyển vào Thùng rác của Windows để có thể khôi phục.", "The original file will be moved to the Windows Recycle Bin and can be restored."),
            onConfirm: () => {
              const bridge = getInDeckBridge();
              if (!bridge) return;
              void bridge.trashMedia({
                id: m.id,
                path: m.path,
                vault: m.vault,
                contentUrl: m.contentUrl,
              }).catch(() => false).then((result) => {
                if (result === true) {
                  purgeMedia(m.id);
                  return;
                }
                // Silence here read as "nothing happened" after a confirmation
                // that promised the file was going somewhere recoverable.
                const reason = typeof result === "object" && result ? result.reason : undefined;
                if (reason === "vault-no-trash") {
                  toast.error(c(
                    "Vault đang chạy chưa hỗ trợ thùng rác nên file được giữ nguyên. Hãy cập nhật Vault rồi thử lại.",
                    "The running Vault has no trash yet, so the file was kept. Update Vault and try again.",
                  ));
                } else if (reason === "vault-unavailable") {
                  toast.error(c("Không kết nối được Vault. Hãy mở Vault rồi thử lại.", "Vault could not be reached. Open Vault and try again."));
                } else if (m.vault) toast.error(c("Không thể đưa file vào Thùng rác của Vault.", "Unable to move the file to the Vault trash."));
                else toast.error(c("Không thể chuyển file vào Thùng rác.", "Unable to move the file to the Recycle Bin."));
              });
            },
          })}
        >
          <Trash2 className="size-4 text-[#B81E2D]" /> {m.vault
            ? c("Đưa file vào Thùng rác của Vault", "Move file to Vault trash")
            : c("Đưa file vào Thùng rác máy tính", "Move file to Windows Recycle Bin")}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  };

  const groupMenu = (groupId: string) => {
    const group = groupById.get(groupId);
    if (!group) return null;
    const hasName = Boolean(group.name.trim());
    return (
      <ContextMenuContent onPointerDown={stopCanvasPointerDown} className="glass-float w-64 rounded-xl">
        <ContextMenuItem className={menuItem} onSelect={() => setSelected(group.memberIds)}>
          <Users className="size-4 text-[#86BCBD]" /> {t("selectGroupImages")}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => { setGalleryPickerQuery(""); setAddGroupToGalleryFor(group.memberIds); }}>
          <FolderPlus className="size-4 text-[#FFC349]" /> {t("addGroupToFolder")}
        </ContextMenuItem>
        <ContextMenuItem
          className={menuItem}
          onSelect={() => updateGroup(group.id, { collapsed: !group.collapsed })}
        >
          {group.collapsed ? <Maximize2 className="size-4 text-[#6FCF97]" /> : <Minimize2 className="size-4 text-[#325E6A]" />}
          {group.collapsed ? t("expandGroup") : t("collapseGroup")}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => setGroupNameDialog({ id: group.id, name: group.name })}>
          <Pencil className="size-4 text-[#5F839A]" /> {c(hasName ? "Đổi tên group" : "Đặt tên group", hasName ? "Rename group" : "Set Group Name")}
        </ContextMenuItem>
        {cutEntries.length > 0 && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => {
              insertManyIntoGroup(group.id, cutEntries.filter((entry) => entry.kind === "media").map((entry) => entry.id), group.memberIds.length);
              setCutEntries([]);
              setSelected([]);
            }}
          >
            <ClipboardPaste className="size-4 text-[#8E7CC3]" />
            {c(`Dán ${cutEntries.length} media vào group`, `Paste ${cutEntries.length} media into this group`)}
          </ContextMenuItem>
        )}
        {!group.collapsed && (
          <ContextMenuItem className={menuItem} onSelect={() => updateGroup(group.id, { fit: !group.fit })}>
            <Group className="size-4 text-[#8E7CC3]" />
            {group.fit
              ? c("Bỏ vừa với media", "Stop fitting to media")
              : c("Vừa với media", "Fit to media")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          className={menuItem}
          onSelect={() =>
            onConfirm({ title: t("dissolveGroup"), onConfirm: () => dissolveGroup(group.id) })
          }
        >
          <Ungroup className="size-4 text-[#7B2525]" /> {t("dissolveGroup")}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  };

  // While a selection is being dragged, every card in it is on the move.
  const draggingIds = useMemo(() => {
    if (drag?.kind !== "media") return null;
    return selectedSet.has(drag.id) && selectedSet.size > 1 ? selectedSet : new Set([drag.id]);
  }, [drag, selectedSet]);

  const renderCard = (
    m: MediaItem,
    entry: OrderEntry,
    w: number,
    h: number,
    options: {
      badge?: number | undefined;
      stack?: MediaItem[] | undefined;
      inGroupId?: string | undefined;
      priority: boolean;
      distance: number;
    },
  ) => {
    const { badge, stack, inGroupId, priority, distance } = options;
    const holdTarget = drop?.type === "hold" && needsHold(drop)
      && ((drop.kind === "media" && entry.kind === "media" && drop.id === m.id) || (drop.kind === "group" && entry.kind === "group" && drop.id === entry.id));
    const memberRail = drop?.type === "member-insert" && drop.groupId === inGroupId && drop.railMediaId === m.id ? drop.railSide ?? null : null;
    const groupName = entry.kind === "group" && !inGroupId ? groupById.get(entry.id)?.name.trim() : undefined;
    const dimmed = Boolean(draggingIds?.has(m.id) && entry.kind === "media") || (drag?.kind === "group" && entry.kind === "group" && drag.id === entry.id);
    return (
      <MediaCard
        key={`${entry.kind}:${entry.id}:${m.id}`}
        media={m}
        entryKind={entry.kind}
        entryId={entry.id}
        width={w}
        height={h}
        badge={badge}
        stack={stack}
        inGroupId={inGroupId}
        priority={priority}
        distance={distance}
        selected={selectedSet.has(m.id)}
        dimmed={dimmed}
        holdStart={holdTarget ? holdStart : null}
        memberRail={memberRail}
        groupName={groupName || undefined}
        labels={cardLabels}
        actions={cardActions}
      />
    );
  };

  // ---- blocks ---------------------------------------------------------
  const displaySections = useMemo(() => {
    if (groupBy.length === 0) return [{ entries, label: "" }];
    // Gallery membership per media, built once instead of scanning every
    // Gallery for every media of every section.
    const galleriesOfMedia = new Map<string, string[]>();
    for (const folder of state.folders) {
      for (const id of folder.mediaIds) {
        const names = galleriesOfMedia.get(id);
        if (names) names.push(folder.name);
        else galleriesOfMedia.set(id, [folder.name]);
      }
    }
    const sourceNames = new Map(state.sources.map((source) => [source.id, source.name]));
    const mediaForEntry = (entry: OrderEntry): MediaItem[] => {
      if (entry.kind === "media") {
        const media = mediaById(entry.id);
        return media ? [media] : [];
      }
      return (groupById.get(entry.id)?.memberIds ?? [])
        .map(mediaById)
        .filter((media): media is MediaItem => !!media && visibleMediaIdSet.has(media.id));
    };
    // A Group by value is a display facet, rather than a mutually-exclusive
    // bucket. Return every matching value so a media item can be rendered in
    // each relevant section while all copies still point at its single ID.
    const keysFor = (entry: OrderEntry, group: MediaGroupBy) => {
      const media = mediaForEntry(entry);
      if (group.kind === "media-source") {
        const values = [...new Set(media.map((item) => sourceNames.get(item.sourceId) ?? "Unknown source"))];
        return values.length ? values.sort() : ["Unknown source"];
      }
      if (group.kind === "gallery-source") {
        const values = [...new Set(media.flatMap((item) => galleriesOfMedia.get(item.id) ?? []))];
        return values.length ? values.sort() : ["No Gallery source"];
      }
      const values = [...new Set(media.flatMap((item) => item.props[group.propertyId] ?? []))];
      const property = state.propertyGroups.find((item) => item.id === group.propertyId);
      return values.length ? values.sort() : [`No ${property?.name ?? "Property"}`];
    };
    let sections: Array<{ entries: OrderEntry[]; label: string }> = [{ entries, label: "" }];
    for (const grouping of groupBy) {
      sections = sections.flatMap((section) => {
        const buckets = new Map<string, OrderEntry[]>();
        section.entries.forEach((entry) => {
          keysFor(entry, grouping).forEach((key) => {
            const bucket = buckets.get(key) ?? [];
            bucket.push(entry);
            buckets.set(key, bucket);
          });
        });
        return [...buckets.entries()].map(([key, groupedEntries]) => ({
          entries: groupedEntries,
          label: section.label ? `${section.label} / ${key}` : key,
        }));
      });
    }
    return sections;
  }, [entries, groupBy, groupById, mediaById, state.folders, state.propertyGroups, state.sources, visibleMediaIdSet]);

  type Block =
    | {
        kind: "run";
        entries: OrderEntry[];
        items: MediaItem[];
        badges: (number | undefined)[];
        stacks: (MediaItem[] | undefined)[];
        /** For each item, the fitted Group it belongs to, if any. */
        fits: (string | undefined)[];
        section: number;
        sectionStart: boolean;
        sectionLabel: string;
      }
    | { kind: "group"; entry: OrderEntry; items: MediaItem[]; section: number; sectionStart: boolean; sectionLabel: string };

  // How many cards one row holds right now. A Group may only fit into a row if
  // its whole membership stays within that budget; past it the Group keeps its
  // full-width frame, so zooming in pushes an over-long fitted Group back to
  // rows of its own rather than silently cutting it in half.
  const fitBudget = galleryLayout === "square"
    ? squareColumns(width, state.thumbHeight)
    : Math.max(1, Math.floor(width / (justifiedMaxHeight(state.thumbHeight) * 0.55)));

  const blocks = useMemo(() => {
    const nextBlocks: Block[] = [];
    const inline = new Set<string>();
    const pushRun = (entry: OrderEntry, m: MediaItem, section: number, badge?: number, stack?: MediaItem[], fitGroupId?: string) => {
      const last = nextBlocks[nextBlocks.length - 1];
      if (last && last.kind === "run" && last.section === section) {
        last.items.push(m);
        last.entries.push(entry);
        last.badges.push(badge);
        last.stacks.push(stack);
        last.fits.push(fitGroupId);
      } else {
        nextBlocks.push({ kind: "run", entries: [entry], items: [m], badges: [badge], stacks: [stack], fits: [fitGroupId], section, sectionStart: false, sectionLabel: "" });
      }
    };
    displaySections.forEach((displaySection, section) => displaySection.entries.forEach((entry) => {
      if (entry.kind === "group") {
        const group = groupById.get(entry.id);
        if (!group) return;
        const items = group.memberIds
          .map(mediaById)
          .filter((media): media is MediaItem => !!media && visibleMediaIdSet.has(media.id));
        if (group.collapsed) {
          const cover = items.find((media) => media.id === group.coverId) ?? items[0];
          if (!cover) return;
          const rest = items.filter((media) => media.id !== cover.id);
          inline.add(group.id);
          pushRun(entry, cover, section, items.length, [cover, ...rest].slice(0, STACK_MAX_ITEMS));
        } else if (group.fit && items.length > 1 && items.length <= fitBudget) {
          // Small enough to sit in an ordinary row: its members become cells
          // like any other card, tagged so the solver keeps them together and
          // the row draws one frame around them. Each is still a member, so
          // it behaves exactly like a member of an expanded Group.
          inline.add(group.id);
          items.forEach((media) => pushRun({ kind: "media", id: media.id }, media, section, undefined, undefined, group.id));
        } else {
          nextBlocks.push({ kind: "group", entry, items, section, sectionStart: false, sectionLabel: "" });
        }
      } else {
        const media = mediaById(entry.id);
        if (media) pushRun(entry, media, section);
      }
    }));
    const markedSections = new Set<number>();
    nextBlocks.forEach((block) => {
      block.sectionStart = groupBy.length > 0 && !markedSections.has(block.section);
      block.sectionLabel = block.sectionStart ? displaySections[block.section]?.label ?? "" : "";
      markedSections.add(block.section);
    });
    return { blocks: nextBlocks, inline };
  }, [displaySections, fitBudget, groupBy.length, groupById, mediaById, visibleMediaIdSet]);
  inlineGroupIds.current = blocks.inline;

  // Collapsed Groups in a justified row occupy a wider frame than their image
  // so the tilted pile gets its own room. The row solver has to know that
  // width up front, and it is measured at the row's height cap: the pile's
  // reach only shrinks as the row comes out shorter than that.
  const runStackExtra = useCallback(
    (block: Extract<Block, { kind: "run" }>) => {
      if (galleryLayout !== "justified") return undefined;
      const capHeight = justifiedMaxHeight(state.thumbHeight);
      return (item: MediaItem, index: number) => {
        const stack = block.stacks[index];
        if (!stack) return 0;
        const { insets } = stackFrame(mediaRatio(item) * capHeight, capHeight, stack.length);
        return insets.left + insets.right;
      };
    },
    [galleryLayout, state.thumbHeight],
  );

  type VirtualCell = {
    item: MediaItem;
    entry: OrderEntry;
    width: number;
    /** Set on the members of a fitted Group, which sit inside its frame. */
    height?: number | undefined;
    badge?: number | undefined;
    stack?: MediaItem[] | undefined;
    inGroupId?: string | undefined;
    /** Set when this cell is one member of a Group laid out to fit its media. */
    fitGroupId?: string | undefined;
  };
  type VirtualLayoutRow = {
    cells: VirtualCell[];
    height: number;
    sectionLabel?: string | undefined;
    groupKey?: string | undefined;
    groupId?: string | undefined;
    groupStart?: boolean | undefined;
    groupEnd?: boolean | undefined;
  };
  // This is deliberately independent of scrollTop. The justified row
  // geometry is expensive but only changes when the Gallery data, width, or
  // requested thumbnail height changes.
  const virtualLayout = useMemo(() => {
    const virtualRows: VirtualLayoutRow[] = [];
    blocks.blocks.forEach((block) => {
      const groupKey = block.kind === "group" ? `${block.section}:${block.entry.id}:${virtualRows.length}` : undefined;
      const rows = block.kind === "group"
        ? groupRows(block.items, width, state.thumbHeight, galleryLayout)
        : layoutRows(block.items, width, state.thumbHeight, galleryLayout, runStackExtra(block), (index) => block.fits[index]);
      let itemOffset = 0;
      rows.forEach((row, rowIndex) => {
        const sectionLabel = block.sectionStart && rowIndex === 0 ? block.sectionLabel : undefined;
        if (block.kind === "run") {
          const cells = row.items.map(({ item, width: cellWidth, height: cellHeight }, index) => {
            const itemIndex = itemOffset + index;
            return {
              item,
              width: cellWidth,
              height: cellHeight,
              entry: block.entries[itemIndex] ?? { kind: "media" as const, id: item.id },
              badge: block.badges[itemIndex],
              stack: block.stacks[itemIndex],
              fitGroupId: block.fits[itemIndex],
            };
          });
          virtualRows.push({ height: row.height, sectionLabel, cells });
        } else {
          virtualRows.push({
            height: row.height,
            sectionLabel,
            groupKey,
            groupId: block.entry.id,
            groupStart: rowIndex === 0,
            groupEnd: rowIndex === rows.length - 1,
            cells: row.items.map(({ item, width: cellWidth }) => ({
              item,
              width: cellWidth,
              entry: { kind: "media" as const, id: item.id },
              inGroupId: block.entry.id,
            })),
          });
        }
        itemOffset += row.items.length;
      });
    });
    // A section label sits above its row, and an expanded Group's title band
    // and padding sit between the label and the Group's first row of media.
    let y = 0;
    const positionedVirtualRows = virtualRows.map((row) => {
      let labelTop: number | undefined;
      if (row.sectionLabel) {
        labelTop = y;
        y += SECTION_LABEL_HEIGHT;
      }
      const top = y + (row.groupStart ? GROUP_TOP_INSET : 0);
      y = top + row.height + (row.groupEnd ? GROUP_INSET : 0) + GAP;
      return { ...row, top, labelTop };
    });
    const groupFrames = new Map<string, { key: string; id: string; top: number; bottom: number }>();
    positionedVirtualRows.forEach((row) => {
      if (!row.groupKey) return;
      const frame = groupFrames.get(row.groupKey) ?? { key: row.groupKey, id: row.groupId ?? "", top: row.top - GROUP_TOP_INSET, bottom: row.top + row.height };
      if (row.groupStart) frame.top = row.top - GROUP_TOP_INSET;
      frame.bottom = Math.max(frame.bottom, row.top + row.height + (row.groupEnd ? GROUP_INSET : 0));
      groupFrames.set(row.groupKey, frame);
    });
    return {
      positionedVirtualRows,
      virtualGroupFrames: [...groupFrames.values()],
      virtualHeight: Math.max(0, y - GAP),
    };
  }, [blocks, galleryLayout, runStackExtra, state.thumbHeight, width]);
  const { positionedVirtualRows, virtualGroupFrames, virtualHeight } = virtualLayout;
  virtualGeometry.current = { rows: positionedVirtualRows };

  // The vertical bands an expanded Group can be dropped before or after:
  // every ordinary row, and every other expanded Group as one block.
  groupBandsRef.current = useMemo(() => {
    const bands: GroupBand[] = [];
    for (const row of positionedVirtualRows) {
      if (row.groupId) continue;
      let first = Infinity;
      let last = -Infinity;
      for (const cell of row.cells) {
        const index = cell.fitGroupId ? globalIndex({ kind: "group", id: cell.fitGroupId }) : globalIndex(cell.entry);
        if (index < 0) continue;
        first = Math.min(first, index);
        last = Math.max(last, index);
      }
      if (first <= last) bands.push({ top: row.top, bottom: row.top + row.height, first, last });
    }
    for (const frame of virtualGroupFrames) {
      const index = globalIndex({ kind: "group", id: frame.id });
      if (index >= 0) bands.push({ top: frame.top, bottom: frame.bottom, first: index, last: index, groupId: frame.id });
    }
    return bands.sort((a, b) => a.top - b.top);
  }, [globalIndex, positionedVirtualRows, virtualGroupFrames]);

  // Two full screens on either side give thumbnail loading enough lead time
  // without allowing a scroll fling to mount the entire Gallery.
  const virtualOverscan = Math.max(viewportHeight * 2, 640);
  const virtualStart = Math.max(0, scrollTop - (scrollDirection.current === "down" ? virtualOverscan : virtualOverscan * 1.5));
  const virtualEnd = scrollTop + viewportHeight + (scrollDirection.current === "down" ? virtualOverscan * 1.5 : virtualOverscan);
  // Rows are sorted by position, so the visible window is found by bisection
  // rather than by walking every row from the top on every scroll frame.
  let low = 0;
  let high = positionedVirtualRows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const row = positionedVirtualRows[mid]!;
    if (row.top + row.height < virtualStart) low = mid + 1;
    else high = mid;
  }
  const virtualFirstRow = low;
  let virtualLastRow = virtualFirstRow;
  while (virtualLastRow < positionedVirtualRows.length && positionedVirtualRows[virtualLastRow]!.top < virtualEnd) virtualLastRow += 1;

  const menuContent = (() => {
    if (!menuTarget) return null;
    if (menuTarget.kind === "group") return groupMenu(menuTarget.id);
    const media = mediaById(menuTarget.id);
    return media ? mediaMenu(media) : null;
  })();

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-16 text-center">
        <p className="font-display text-lg font-medium">{t("noMedia")}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{t("noMediaHint")}</p>
      </div>
    );
  }

  const groupHeaderLabels = { group: c("Group", "Group"), collapse: t("collapseGroup"), drag: t("dragToReorder") };
  const yRail = drop?.type === "insert" && drop.axis === "y" ? drop.railY : undefined;

  return (
    <ContextMenu onOpenChange={(open) => { if (!open) setMenuTarget(null); }}>
    <ContextMenuTrigger asChild>
    <div
      ref={containerRef}
      onPointerDown={onBackgroundPointerDown}
      onContextMenu={onGalleryContextMenu}
      onScroll={(event) => {
        const next = event.currentTarget.scrollTop;
        pendingScrollTop.current = next;
        if (scrollFrame.current) return;
        scrollFrame.current = requestAnimationFrame(() => {
          scrollFrame.current = 0;
          const committed = pendingScrollTop.current;
          scrollDirection.current = committed < committedScrollTop.current ? "up" : "down";
          committedScrollTop.current = committed;
          setScrollTop(committed);
        });
      }}
      className="app-scroll relative min-w-0 flex-1 overflow-y-auto px-5 py-4"
      >
        <div ref={innerRef} className="relative w-full min-w-0" style={{ height: virtualHeight }}>
          {/* An expanded Group's frame, title band and controls. The frame
              is painted before the rows, so the member cards above it still
              receive their own clicks; the band itself sits above the first
              row of media and is never covered by one. */}
          {virtualGroupFrames.map((frame) => {
            const group = groupById.get(frame.id);
            if (!group) return null;
            const holdingGroup = drop?.type === "hold" && drop.kind === "group" && drop.id === group.id;
            return (
              <div
                key={frame.key}
                data-group-id={group.id}
                className={cn(
                  GROUP_FRAME_CLASS,
                  "absolute right-0 left-0 transition-opacity",
                  drag?.id === group.id && "opacity-50",
                  holdingGroup && "ring-2 ring-primary/60",
                )}
                style={{ top: frame.top, height: frame.bottom - frame.top }}
              >
                <GroupHeader
                  name={group.name.trim()}
                  count={group.memberIds.filter((id) => visibleMediaIdSet.has(id)).length}
                  labels={groupHeaderLabels}
                  onGripPointerDown={(event) => {
                    event.stopPropagation();
                    startPointer(event, { kind: "group", id: group.id });
                  }}
                  onCollapse={() => updateGroup(group.id, { collapsed: true })}
                />
              </div>
            );
          })}
          {positionedVirtualRows.slice(virtualFirstRow, virtualLastRow).map((row, offset) => {
            const rowIndex = virtualFirstRow + offset;
            // A fitted Group's members sit in an ordinary row beside loose
            // cards, so only the rows of an expanded Group take the inset.
            const inGroup = Boolean(row.groupId);
            const priority = row.top + row.height >= scrollTop - 120
              && row.top <= scrollTop + viewportHeight + 320;
            const distance = Math.abs(row.top + row.height / 2 - (scrollTop + viewportHeight / 2));
            // Consecutive members of one fitted Group are wrapped in its frame.
            const segments: Array<{ fitGroupId?: string | undefined; cells: VirtualCell[] }> = [];
            for (const cell of row.cells) {
              const last = segments[segments.length - 1];
              if (cell.fitGroupId && last?.fitGroupId === cell.fitGroupId) last.cells.push(cell);
              else segments.push({ fitGroupId: cell.fitGroupId, cells: [cell] });
            }
            const card = (cell: VirtualCell) => renderCard(cell.item, cell.entry, cell.width, cell.height ?? row.height, {
              badge: cell.badge,
              stack: cell.stack,
              inGroupId: cell.inGroupId ?? cell.fitGroupId,
              priority,
              distance,
            });
            return (
              <Fragment key={`virtual-${rowIndex}`}>
                {row.labelTop !== undefined && row.sectionLabel && (
                  <div className="absolute right-0 left-0" style={{ top: row.labelTop }}>
                    <GroupDivider label={row.sectionLabel} />
                  </div>
                )}
                <div
                  data-library-row
                  // A Group's rows are painted over its frame, so the row box
                  // would otherwise swallow every right-click that lands in a
                  // gap between cards or in the blank tail of a short row, and
                  // the Group would only answer on the thin strips of padding
                  // the rows do not cover. The row itself needs no pointer
                  // events — only its cards do — so let the rest fall through
                  // to the frame beneath.
                  className={cn("absolute flex items-center", inGroup && "pointer-events-none")}
                  style={{
                    top: row.top,
                    left: inGroup ? GROUP_INSET : 0,
                    right: inGroup ? GROUP_INSET : 0,
                    gap: GAP,
                    height: row.height,
                  }}
                >
                  {segments.flatMap((segment) => {
                    if (!segment.fitGroupId) return segment.cells.map(card);
                    const group = groupById.get(segment.fitGroupId);
                    if (!group) return segment.cells.map(card);
                    // A Group fitted to its media: one frame around exactly
                    // its members, the same span they would take as loose
                    // cards, with the same title band as an expanded Group.
                    return (
                      <div
                        key={`fit-${group.id}`}
                        data-group-id={group.id}
                        className={cn(GROUP_FRAME_CLASS, "relative flex shrink-0 items-start transition-opacity", drag?.id === group.id && "opacity-50")}
                        style={{
                          height: row.height,
                          gap: GAP,
                          paddingTop: GROUP_HEADER,
                          paddingRight: GROUP_PAD,
                          paddingBottom: GROUP_PAD,
                          paddingLeft: GROUP_PAD,
                        }}
                      >
                        <GroupHeader
                          name={group.name.trim()}
                          count={segment.cells.length}
                          labels={groupHeaderLabels}
                          compact
                          onGripPointerDown={(event) => {
                            event.stopPropagation();
                            startPointer(event, { kind: "group", id: group.id });
                          }}
                          onCollapse={() => updateGroup(group.id, { collapsed: true })}
                        />
                        {segment.cells.map(card)}
                      </div>
                    );
                  })}
                </div>
              </Fragment>
            );
          })}
          {/* Where a dragged expanded Group will land: between two rows. */}
          {yRail !== undefined && (
            <span
              aria-hidden
              className="pointer-events-none absolute right-0 left-0 z-50 block h-1 rounded-full border border-white/30 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_16px_rgb(255_255_255_/_0.3)]"
              style={{ top: yRail - 2 }}
            />
          )}
        </div>

      {libraryRail && (
        <span
          aria-hidden
          className="pointer-events-none absolute z-50 block w-1 rounded-full border border-white/30 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_16px_rgb(255_255_255_/_0.3)]"
          style={{ left: libraryRail.x, top: libraryRail.y, height: libraryRail.height }}
        />
      )}

      {dragPreviewId && dragOrigin && mediaById(dragPreviewId) && (
        <DragPreview
          media={mediaById(dragPreviewId)!}
          origin={dragOrigin}
          count={selectedSet.has(dragPreviewId) && selected.length > 1 ? selected.length : 1}
        />
      )}

      {marquee && (
        <div
          className="pointer-events-none absolute rounded-md border border-primary/70 bg-primary/10"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

      {drop?.type === "hold" && drop.kind === "ungroup" && needsHold(drop) && holdStart !== null && (
        <div className="glass-float pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-xs">
          {t("removeFromGroup")} · <HoldCountdown start={holdStart} />
        </div>
      )}

      <Dialog open={!!groupNameDialog} onOpenChange={(open) => !open && setGroupNameDialog(null)}>
        <DialogContent onPointerDown={stopCanvasPointerDown} className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{c(groupNameDialog?.name.trim() ? "Đổi tên group" : "Đặt tên group", groupNameDialog?.name.trim() ? "Rename group" : "Set Group Name")}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={groupNameDialog?.name ?? ""}
            onChange={(event) => setGroupNameDialog((group) => group ? { ...group, name: event.target.value } : group)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const name = groupNameDialog?.name.trim();
              if (!groupNameDialog || !name) return;
              updateGroup(groupNameDialog.id, { name });
              setGroupNameDialog(null);
            }}
            placeholder={c("Tên group", "Group name")}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setGroupNameDialog(null)} className="glass-btn rounded-lg px-4 py-2 text-sm">{c("Hủy", "Cancel")}</button>
            <button
              disabled={!groupNameDialog?.name.trim()}
              onClick={() => {
                const name = groupNameDialog?.name.trim();
                if (!groupNameDialog || !name) return;
                updateGroup(groupNameDialog.id, { name });
                setGroupNameDialog(null);
              }}
              className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-45"
            >
              {c("Lưu", "Save")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!addToGalleryFor} onOpenChange={(open) => !open && setAddToGalleryFor(null)}>
        <DialogContent onPointerDown={stopCanvasPointerDown} className="glass-float max-w-md rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">{t("addToFolder")}</DialogTitle></DialogHeader>
          <label className="glass-btn flex items-center gap-2 rounded-xl px-3 py-2"><Search className="size-3.5 text-muted-foreground" /><input autoFocus value={galleryPickerQuery} onChange={(event) => setGalleryPickerQuery(event.target.value)} placeholder={t("searchGallery")} className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {galleryPickerFolders.map((folder) => {
              const alreadyAdded = !!addToGalleryFor && folder.mediaIds.includes(addToGalleryFor);
              const cover = galleryCover(folder.id);
              return <button key={folder.id} disabled={alreadyAdded} onClick={() => { if (addToGalleryFor) addToFolder(folder.id, [addToGalleryFor]); setAddToGalleryFor(null); }} className={cn("glass-btn flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", alreadyAdded && "cursor-not-allowed opacity-45")}>{cover ? <LazyThumbnail media={cover} priority thumbnailSize={160} className="size-8 shrink-0 rounded-md object-cover" /> : <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary/60"><Folder className="size-4 text-muted-foreground" /></span>}<span className="flex-1 truncate">{folder.name}</span>{alreadyAdded ? <span className="text-xs text-muted-foreground">{t("added")}</span> : <FolderPlus className="size-4 text-muted-foreground" />}</button>;
            })}
            {state.folders.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("noGalleries")}</p>}
            {state.folders.length > 0 && galleryPickerFolders.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("galleryNotFound")}</p>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!moveToGalleryFor} onOpenChange={(open) => !open && setMoveToGalleryFor(null)}>
        <DialogContent onPointerDown={stopCanvasPointerDown} className="glass-float max-w-md rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">{c("Chuyển vào Gallery", "Move to Gallery")}</DialogTitle></DialogHeader>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {state.folders.filter((folder) => folder.id !== currentFolderId).map((folder) => {
              const alreadyAdded = !!moveToGalleryFor && folder.mediaIds.includes(moveToGalleryFor);
              return <button key={folder.id} onClick={() => {
                if (!moveToGalleryFor || !currentFolderId) return;
                // Move is membership-only: keep the original file/source, add
                // it to the destination, then remove it from this Gallery.
                moveToFolder(folder.id, [moveToGalleryFor], currentFolderId);
                setMoveToGalleryFor(null);
              }} className="glass-btn flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"><Folder className="size-4 text-muted-foreground" /><span className="flex-1 truncate">{folder.name}</span>{alreadyAdded ? <span className="text-xs text-muted-foreground">{t("alreadyAdded")}</span> : <FolderInput className="size-4 text-muted-foreground" />}</button>;
            })}
            {state.folders.filter((folder) => folder.id !== currentFolderId).length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("noOtherGalleries")}</p>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!addGroupToGalleryFor} onOpenChange={(open) => !open && setAddGroupToGalleryFor(null)}>
        <DialogContent onPointerDown={stopCanvasPointerDown} className="glass-float max-w-md rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">{t("addGroupToFolder")}</DialogTitle></DialogHeader>
          <label className="glass-btn flex items-center gap-2 rounded-xl px-3 py-2"><Search className="size-3.5 text-muted-foreground" /><input autoFocus value={galleryPickerQuery} onChange={(event) => setGalleryPickerQuery(event.target.value)} placeholder={t("searchGallery")} className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {galleryPickerFolders.map((folder) => {
              const mediaIds = addGroupToGalleryFor ?? [];
              const alreadyAdded = mediaIds.length > 0 && mediaIds.every((id) => folder.mediaIds.includes(id));
              const cover = galleryCover(folder.id);
              return <button key={folder.id} disabled={alreadyAdded} onClick={() => { if (mediaIds.length) addToFolder(folder.id, mediaIds); setAddGroupToGalleryFor(null); setSelected([]); }} className={cn("glass-btn flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", alreadyAdded && "cursor-not-allowed opacity-45")}>{cover ? <LazyThumbnail media={cover} priority thumbnailSize={160} className="size-8 shrink-0 rounded-md object-cover" /> : <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary/60"><Folder className="size-4 text-muted-foreground" /></span>}<span className="flex-1 truncate">{folder.name}</span><FolderPlus className="size-4 text-muted-foreground" /></button>;
            })}
            {galleryPickerFolders.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("galleryNotFound")}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </ContextMenuTrigger>
    {menuContent}
    </ContextMenu>
  );
}

const SECTION_LABEL_HEIGHT = 28;

/**
 * One look for every Group frame — expanded, or fitted to its media. A clear
 * tinted tray with a strong border, so a Group reads as a single container
 * among loose cards at any zoom level.
 */
const GROUP_FRAME_CLASS =
  "box-border rounded-xl border border-primary/30 bg-primary/[0.05] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]";

/**
 * The title band across the top of a Group frame: drag handle, Group icon,
 * name, member count and the collapse control. It lives in the frame's own top
 * padding, so it never covers a photo.
 */
function GroupHeader({ name, count, labels, compact = false, onGripPointerDown, onCollapse }: {
  name: string;
  count: number;
  labels: { group: string; collapse: string; drag: string };
  compact?: boolean;
  onGripPointerDown: (event: React.PointerEvent) => void;
  onCollapse: () => void;
}) {
  return (
    <div
      className="absolute top-0 right-0 left-0 flex items-center gap-1 rounded-t-[11px] border-b border-primary/15 bg-primary/[0.06] px-1 text-[11px] leading-none"
      style={{ height: GROUP_HEADER - 4 }}
    >
      <button
        type="button"
        onPointerDown={onGripPointerDown}
        aria-label={labels.drag}
        title={labels.drag}
        className="grid size-5 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-primary/15 hover:text-primary active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <LayersIcon className="size-3.5 shrink-0 text-primary/75" aria-hidden />
      <span
        className={cn(
          "min-w-0 truncate font-medium tracking-tight",
          name ? "text-foreground/85" : "text-muted-foreground",
          compact && !name && "sr-only",
        )}
      >
        {name || labels.group}
      </span>
      <span className="min-w-1 flex-1" />
      <GroupCountPill count={count} collapsed={false} onToggle={onCollapse} label={labels.collapse} className="shrink-0" />
    </div>
  );
}

function GroupDivider({ label }: { label: string }) {
  return (
    <div className="flex h-5 items-center gap-2 text-[11px] font-medium text-muted-foreground" aria-label={label}>
      <span className="h-px w-8 shrink-0 bg-border/70" />
      <span className="shrink-0">{label}</span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

/**
 * A Media Group's member count, which doubles as its expand/collapse control.
 * Hovering swaps the count for the action it performs. Both live in the same
 * grid cell behind a fixed height, so the pill never resizes as they trade
 * places.
 */
function GroupCountPill({ count, collapsed, onToggle, label, className, style }: {
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const Icon = collapsed ? Maximize2 : Minimize2;
  return (
    <button
      type="button"
      // The card underneath starts a drag on pointerdown, so the press that
      // opens this control must not also pick the Group up.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
      title={label}
      aria-label={label}
      style={style}
      className={cn(
        "grid h-[18px] min-w-[30px] place-items-center rounded-md border border-primary/35 bg-background/85 px-1.5 text-[11px] leading-none font-medium text-foreground/85 shadow-sm backdrop-blur-md transition-colors",
        "hover:border-primary hover:bg-primary hover:text-primary-foreground",
        "group/count",
        className,
      )}
    >
      <span className="col-start-1 row-start-1 inline-flex items-center gap-1 transition-opacity group-hover/count:opacity-0">
        <LayersIcon className="size-3 text-primary/75" aria-hidden />
        {count}
      </span>
      <Icon className="col-start-1 row-start-1 size-3 opacity-0 transition-opacity group-hover/count:opacity-100" />
    </button>
  );
}

/** Old-style insertion rail, restyled with the app's translucent glass material. */
function InsertBar({ side }: { side: "left" | "right" }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-y-0 z-30 block w-1 rounded-full border border-white/20 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_14px_rgb(255_255_255_/_0.22)] backdrop-blur-md transition-all",
        side === "left" ? "-left-[6px]" : "-right-[6px]",
      )}
    />
  );
}

/** Seconds left on a hold that started at `start`, counting itself down. */
function useHoldProgress(start: number) {
  const [progress, setProgress] = useState(() => Math.min(1, (performance.now() - start) / HOLD_MS));
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const next = Math.min(1, (performance.now() - start) / HOLD_MS);
      setProgress(next);
      if (next < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start]);
  return progress;
}

/**
 * The hold-to-group ring. It animates itself from the moment the hold began,
 * so only this ring re-renders each frame, not the whole Gallery.
 */
function HoldRing({ start }: { start: number }) {
  const progress = useHoldProgress(start);
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-background/20 backdrop-blur-[1px]">
      <svg viewBox="0 0 36 36" className="size-12 max-h-[70%] max-w-[70%] -rotate-90">
        <circle cx="18" cy="18" r="15" className="fill-none stroke-border/40" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r="15"
          className="fill-none stroke-primary/60"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * 15}
          strokeDashoffset={2 * Math.PI * 15 * (1 - progress)}
        />
      </svg>
    </div>
  );
}

function HoldCountdown({ start }: { start: number }) {
  const progress = useHoldProgress(start);
  return <>{((1 - progress) * (HOLD_MS / 1000)).toFixed(1)}s</>;
}

/**
 * The card that follows the pointer during a drag. It moves itself with a
 * transform on every pointer move instead of through React state, so the
 * Gallery underneath is not re-rendered to move it.
 */
const DragPreview = memo(function DragPreview({ media, origin, count }: { media: MediaItem; origin: { x: number; y: number }; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const element = ref.current;
      if (element) element.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0)`;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-[80] h-20 w-28 overflow-hidden rounded-lg border border-white/35 bg-background/35 opacity-60 shadow-2xl backdrop-blur-sm will-change-transform"
      style={{ transform: `translate3d(${origin.x + 14}px, ${origin.y + 14}px, 0)` }}
    >
      {count > 1 ? (
        <span className="grid size-full place-items-center bg-background/70 px-2 text-center text-sm font-medium text-foreground">
          {count} items
        </span>
      ) : (
        <LazyThumbnail media={media} priority className="size-full object-cover" thumbnailSize={160} />
      )}
    </div>
  );
});

type CardActions = {
  pointerDown: (event: React.PointerEvent, entry: OrderEntry, mediaId?: string) => void;
  select: (event: React.MouseEvent | React.KeyboardEvent, id: string) => void;
  open: (id: string) => void;
  toggleFavorite: (id: string) => void;
  expandGroup: (groupId: string) => void;
};

type MediaCardProps = {
  media: MediaItem;
  entryKind: "media" | "group";
  entryId: string;
  width: number;
  height: number;
  badge?: number | undefined;
  stack?: MediaItem[] | undefined;
  inGroupId?: string | undefined;
  priority: boolean;
  /** A queue-ordering hint read once when the thumbnail is requested. */
  distance: number;
  selected: boolean;
  dimmed: boolean;
  /** When the hold-to-group on this card began, if it is the hold target. */
  holdStart: number | null;
  memberRail: "left" | "right" | null;
  groupName?: string | undefined;
  labels: { expandGroup: string; dragToReorder: string };
  actions: CardActions;
};

// `distance` changes on every scroll frame but is only read when a thumbnail
// is first requested; re-rendering every visible card for it is what made
// scrolling heavy. Everything else is compared as usual.
function cardPropsEqual(previous: MediaCardProps, next: MediaCardProps) {
  for (const key of Object.keys(next) as (keyof MediaCardProps)[]) {
    if (key === "distance") continue;
    if (previous[key] !== next[key]) return false;
  }
  return true;
}

/**
 * One card of the Gallery: a media, or the cover of a collapsed Group. Memo-
 * ized, so a drag, a hover or a scroll only re-renders the cards it changes.
 */
const MediaCard = memo(function MediaCard({
  media: m,
  entryKind,
  entryId,
  width: w,
  height: h,
  badge,
  stack,
  inGroupId,
  priority,
  distance,
  selected: isSelected,
  dimmed,
  holdStart,
  memberRail,
  groupName,
  labels,
  actions,
}: MediaCardProps) {
  const pile = stack ? stackFrame(w, h, stack.length) : null;
  return (
    <div
      data-media-id={m.id}
      data-entry-id={entryId}
      data-entry-kind={entryKind}
      data-in-group={inGroupId}
      style={pile
        ? {
            width: pile.width + pile.insets.left + pile.insets.right,
            height: pile.height + pile.insets.top + pile.insets.bottom,
            // The frame is border-box and carries a 2px border, so the
            // padding is the inset less that border. The content box is
            // then exactly the cover.
            paddingTop: pile.insets.top - 2,
            paddingRight: pile.insets.right - 2,
            paddingBottom: pile.insets.bottom - 2,
            paddingLeft: pile.insets.left - 2,
          }
        : { width: w, height: h }}
      onPointerDown={(e) => actions.pointerDown(e, { kind: entryKind, id: entryId }, m.id)}
      onClick={(e) => actions.select(e, m.id)}
      onDoubleClick={() => actions.open(m.id)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") actions.open(m.id);
        if (e.key === " ") {
          e.preventDefault();
          actions.select(e, m.id);
        }
      }}
      className={cn(
        // Keep text unselectable while pointer dragging. The drag
        // gesture is handled in the renderer so Gallery reordering,
        // hover-to-group, and dropping onto the Sidebar share it.
        // pointer-events-auto: a Group's row is transparent to pointer
        // events so its frame can answer the gaps; the cards must opt
        // back in.
        "pointer-events-auto select-none group relative shrink-0 rounded-lg border transition-[box-shadow,opacity,border-color] duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        stack ? "box-border overflow-visible border-2 border-primary/40 bg-primary/[0.06] shadow-[0_0_0_1px_rgb(0_0_0_/_0.25)]" : "overflow-hidden",
        isSelected
          ? "border-primary ring-[3px] ring-primary/90 shadow-[0_0_0_1px_rgb(255_255_255_/_0.7)]"
          : stack ? "hover:shadow-lg" : "border-border/60 hover:shadow-lg",
        dimmed && "opacity-40",
        memberRail && "z-20 overflow-visible",
      )}
    >
      {stack && pile ? (
        // The content box is exactly the cover, so every photo is
        // `inset-0` and the photos behind simply lean and fan out of it
        // into the padding the insets already reserved for them.
        <div className="relative size-full">
          {stack.map((s, depth) => ({ s, depth })).reverse().map(({ s, depth }) => {
            const isCover = depth === 0;
            return (
              <LazyThumbnail
                key={s.id}
                media={s}
                className={cn(
                  "absolute inset-0 size-full rounded-md border object-cover",
                  isCover ? "border-border/70 shadow-lg" : "border-border/50 shadow-soft",
                )}
                priority={priority}
                thumbnailDistance={distance}
                thumbnailSize={thumbnailSizeForBox(pile.width, pile.height)}
                style={{
                  transform: isCover
                    ? undefined
                    : `translate(${depth * STACK_STEP}px, ${depth * STACK_STEP}px) rotate(${stackTilt(s.id, depth)}deg)`,
                  zIndex: stack.length - depth,
                }}
              />
            );
          })}
        </div>
      ) : (
        <LazyThumbnail media={m} className="size-full object-cover" priority={priority} thumbnailDistance={distance} thumbnailSize={thumbnailSizeForBox(w, h)} />
      )}
      {m.type === "video" && !stack && <VideoHoverPreview media={m} compact={w < 96 || h < 72} />}
      {m.type === "video" && !stack && (
        <span className="glass-panel pointer-events-none absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full">
          <Play className="size-3" />
        </span>
      )}
      {!stack && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            actions.toggleFavorite(m.id);
          }}
          className={cn(
            "absolute top-1 right-1 grid size-5 place-items-center rounded-full border border-glass-border/50 bg-glass/40 shadow-soft backdrop-blur-md transition-opacity",
            m.favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <Heart className={cn("size-2.5", m.favorite && "fill-favorite text-favorite")} />
        </button>
      )}
      {badge !== undefined && (
        <GroupCountPill
          count={badge}
          collapsed
          onToggle={() => actions.expandGroup(entryId)}
          label={labels.expandGroup}
          className="absolute right-2 bottom-2 z-20"
        />
      )}
      {stack && (
        <span
          onPointerDown={(e) => {
            e.stopPropagation();
            actions.pointerDown(e, { kind: entryKind, id: entryId }, m.id);
          }}
          title={labels.dragToReorder}
          className="glass-float absolute bottom-2 left-2 z-20 grid size-6 cursor-grab place-items-center rounded-md opacity-0 transition-opacity group-hover:opacity-100"
        >
          <GripVertical className="size-3.5" />
        </span>
      )}
      {groupName && (
        <span className="pointer-events-none absolute top-[3px] left-[3px] z-30 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 truncate whitespace-nowrap rounded-md border border-primary/30 bg-background/80 px-1.5 py-0.5 text-[11px] leading-none font-medium tracking-tight text-foreground/90 shadow-sm backdrop-blur-md">
          <LayersIcon className="size-3 shrink-0 text-primary/75" aria-hidden />
          <span className="truncate">{groupName}</span>
        </span>
      )}
      {holdStart !== null && <HoldRing start={holdStart} />}
      {memberRail && <InsertBar side={memberRail} />}
    </div>
  );
}, cardPropsEqual);
