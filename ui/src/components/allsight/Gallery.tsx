import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
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

  Heart,
  Image as ImageIcon,
  Layers as LayersIcon,
  Maximize2,
  Minimize2,
  Play,
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
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAllsight } from "@/lib/allsight/store";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { useT } from "@/lib/allsight/i18n";
import type { MediaItem, OrderEntry } from "@/lib/allsight/types";
import { cn } from "@/lib/utils";
import type { ConfirmRequest } from "./ConfirmDialog";
import type { MediaGroupBy } from "@/lib/allsight/grouping";

const GAP = 8; // 30% tighter than the 12px base grid
const GROUP_PAD = 8; // 30% tighter than 12px
const EDGE = 50; // reorder hot zone on each side of a cell
const HOLD_MS = 1500;
const DWELL_MS = 500; // hovering an insertion point this long widens the gap
const SPREAD = 22; // extra room opened up on each side once dwelled
const menuItem = "gap-2";


type Row = { height: number; items: { item: MediaItem; width: number }[] };

function mediaRatio(item: MediaItem) {
  const width = Number.isFinite(item.width) && item.width > 0 ? item.width : 4;
  const height = Number.isFinite(item.height) && item.height > 0 ? item.height : 3;
  return Math.max(0.12, Math.min(8, width / height));
}

function equalJustifiedRows(items: MediaItem[], width: number, targetHeight: number): Row[] {
  if (!items.length) return [];
  const maxHeight = Math.max(100, Math.min(400, targetHeight));
  // At 175%/200% the old fixed five-card minimum kept the calculated row
  // height below the selected value, making zoom-in appear broken. Fewer
  // cards are allowed as the requested thumbnail height grows.
  const minItemsPerRow = Math.max(1, Math.min(5, Math.floor(width / (maxHeight * 1.25))));

  // Keep at least five cards per regular row, then add more only when needed
  // to fill a wide Gallery without exceeding the visual max height. A fixed
  // five-card row plus a height cap leaves a large empty strip for portrait
  // media whenever Inspector is closed (the usable width is then wider).
  const rows: MediaItem[][] = [];
  let row: MediaItem[] = [];
  let ratio = 0;
  for (const item of items) {
    row.push(item);
    ratio += mediaRatio(item);
    const gaps = GAP * (row.length - 1);
    const fillsAtMaxHeight = ratio * maxHeight + gaps >= width;
    if (row.length >= minItemsPerRow && fillsAtMaxHeight) {
      rows.push(row);
      row = [];
      ratio = 0;
    }
  }
  if (row.length) rows.push(row);

  return rows.map((row) => {
    const gaps = GAP * (row.length - 1);
    const availableWidth = Math.max(width - gaps, 80);
    const totalRatio = row.reduce((sum, item) => sum + mediaRatio(item), 0);
    const height = Math.min(availableWidth / totalRatio, maxHeight);
    return {
      height,
      items: row.map((item) => ({ item, width: mediaRatio(item) * height })),
    };
  });
}

function LazyThumbnail({ media, className, priority = false }: { media: MediaItem; className: string; priority?: boolean }) {
  const { setMediaDimensions, setMediaPreview } = useAllsight();
  const target = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (media.url || !target.current) return;
    const bridge = getInDeckBridge();
    if (!bridge) return;
    let active = true;
    const requestId = priority ? `gallery:${media.id}:${media.modified}:${crypto.randomUUID()}` : undefined;
    const load = () => {
      // A virtual Gallery card can be unmounted while its thumbnail request is
      // in flight.  `active` makes that request cancellable from the UI's
      // point of view: its result is never committed once the card is gone.
      // The main-process thumbnail pool remains bounded, so fast scrolling
      // cannot create an unbounded amount of native image work.
      void bridge.ensureThumbnails([{
        id: media.id,
        path: media.path,
        type: media.type,
        modified: media.modified,
        vault: media.vault,
        contentUrl: media.contentUrl,
      }], requestId).then((urls) => {
        if (active && urls[media.id]) setMediaPreview(media.id, urls[media.id]!);
      });
    };
    if (priority) {
      load();
      return () => {
        active = false;
        if (requestId) void bridge.cancelThumbnails(requestId);
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: "600px 0px" });
    observer.observe(target.current);
    return () => { active = false; observer.disconnect(); if (requestId) void bridge.cancelThumbnails(requestId); };
  }, [media, priority, setMediaPreview]);

  if (media.url) return (
    <img
      src={media.url}
      alt=""
      draggable={false}
      className={className}
      onLoad={(event) => setMediaDimensions(media.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
    />
  );
  return <span ref={target} className="block size-full bg-muted/60" />;
}

type DropInfo =
  | { type: "insert"; index: number; axis: "x" | "y" }
  | { type: "member-insert"; groupId: string; index: number; railMediaId?: string; railSide?: "left" | "right" }
  | { type: "hold"; kind: "group" | "media" | "ungroup"; id: string }
  | null;

export function Gallery({
  entries,
  visibleMediaIds,
  selected,
  setSelected,
  onOpen,
  onConfirm,
  currentFolderId,
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
  /** Changes synchronously whenever a sibling panel changes Gallery width. */
  layoutKey: string;
  /** Display-only multi-level grouping selected in the Library header. */
  groupBy: MediaGroupBy[];
}) {
  const t = useT();
  const {
    state,
    moveEntry,
    createGroup,
    addToGroup,
    moveGroupMember,
    insertIntoGroup,
    removeFromGroup,
    dissolveGroup,
    updateGroup,
    addToFolder,
    removeFromFolder,
    updateFolder,
    hideMedia,
    purgeMedia,
    discardFromFolder,
    duplicateMedia,
    addPropValue,
    toggleFavorite,
  } = useAllsight();

  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Start at a normal desktop width. A zero-width flex measurement is common
  // during Electron's first layout pass and must never shrink the whole grid
  // to the 320px safety minimum before the real width is available.
  const [width, setWidth] = useState(1000);
  const [viewportHeight, setViewportHeight] = useState(700);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollDirection = useRef<"up" | "down">("down");
  const [drag, setDrag] = useState<OrderEntry | null>(null);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<DropInfo>(null);
  // Keep a single, top-level rail for Library reordering.  Card-local rails
  // are fine for a group, but can be clipped by a justified Library row.
  const [libraryRail, setLibraryRail] = useState<{ x: number; y: number; height: number } | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const [dwelled, setDwelled] = useState(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [clipboard, setClipboard] = useState<Record<string, string[]>>({});
  const [addToGalleryFor, setAddToGalleryFor] = useState<string | null>(null);
  const [moveToGalleryFor, setMoveToGalleryFor] = useState<string | null>(null);
  const [addGroupToGalleryFor, setAddGroupToGalleryFor] = useState<string[] | null>(null);
  const [galleryPickerQuery, setGalleryPickerQuery] = useState("");

  const galleryPickerFolders = useMemo(() => {
    const needle = galleryPickerQuery.trim().toLowerCase();
    return state.folders.filter((folder) => !needle || folder.name.toLowerCase().includes(needle));
  }, [galleryPickerQuery, state.folders]);
  const galleryCover = (folderId: string) => {
    const folder = state.folders.find((item) => item.id === folderId);
    const media = state.media.find((item) => item.id === (folder?.coverId ?? folder?.mediaIds[0]));
    return media?.url || (media?.type === "image" ? media.originalUrl || media.contentUrl || null : null);
  };

  const pointerStart = useRef<{ x: number; y: number; entry: OrderEntry } | null>(null);
  const holdRef = useRef<{ key: string; start: number } | null>(null);
  const dwellRef = useRef<{ key: string; start: number } | null>(null);
  const dropRef = useRef<DropInfo>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const autoScroll = useRef(0);


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
      const measured = Math.floor(el.getBoundingClientRect().width);
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

  const mediaById = useCallback(
    (id: string) => state.media.find((m) => m.id === id),
    [state.media],
  );
  const visibleMediaIdSet = useMemo(() => new Set(visibleMediaIds), [visibleMediaIds]);
  const globalIndex = useCallback(
    (entry: OrderEntry) => state.order.findIndex((e) => e.kind === entry.kind && e.id === entry.id),
    [state.order],
  );

  useLayoutEffect(() => {
    const isLibraryInsert = drop?.type === "insert" && drop.axis === "x";
    if (!drag) {
      setLibraryRail(null);
      return;
    }
    if (drop?.type === "member-insert") { setLibraryRail(null); return; }
    if (!isLibraryInsert || !containerRef.current) { setLibraryRail(null); return; }

    const findEntry = (entry: OrderEntry | undefined) => {
      if (!entry) return undefined;
      // A collapsed group is represented by its cover card, while an expanded
      // group has a frame. Look for both, otherwise the outer Library rail
      // disappears whenever the seam touches a collapsed Group.
      const nodes = [
        ...document.querySelectorAll<HTMLElement>(`[data-entry-id="${entry.id}"][data-entry-kind="${entry.kind}"]`),
        ...(entry.kind === "group" ? document.querySelectorAll<HTMLElement>(`[data-group-id="${entry.id}"]`) : []),
      ];
      return [...nodes].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    };

    let beforeNode: HTMLElement | undefined;
    let afterNode: HTMLElement | undefined;
    const before = state.order[drop.index];
    const after = state.order[drop.index - 1];
    beforeNode = findEntry(before);
    afterNode = findEntry(after);
    const target = beforeNode ?? afterNode;
    if (!target) {
      setLibraryRail(null);
      return;
    }

    const root = containerRef.current;
    const rootRect = root.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const beforeRect = beforeNode?.getBoundingClientRect();
    const afterRect = afterNode?.getBoundingClientRect();
    // An insertion belongs to the seam, not to either neighbouring card.
    // Using the midpoint gives Library and group members exactly the same
    // single, stable rail even when their current gap has been widened.
    const seamX = beforeRect && afterRect
      ? afterRect.right + (beforeRect.left - afterRect.right) / 2
      : beforeRect ? beforeRect.left : afterRect!.right;
    const seamTop = beforeRect && afterRect ? Math.max(beforeRect.top, afterRect.top) : rect.top;
    const seamBottom = beforeRect && afterRect ? Math.min(beforeRect.bottom, afterRect.bottom) : rect.bottom;
    setLibraryRail({
      x: seamX - rootRect.left + root.scrollLeft - 2,
      y: seamTop - rootRect.top + root.scrollTop,
      height: Math.max(1, seamBottom - seamTop),
    });
  }, [drag, drop, state.order]);

  // ---- drag machinery -------------------------------------------------
  const finishHold = useCallback(() => {
    holdRef.current = null;
    setHoldProgress(0);
  }, []);

  useEffect(() => {
    if (!drag) return;
    let raf = 0;
    const tick = () => {
      if (holdRef.current) {
        const p = Math.min(1, (performance.now() - holdRef.current.start) / HOLD_MS);
        setHoldProgress(p);
      }
      setDwelled(!!dwellRef.current && performance.now() - dwellRef.current.start >= DWELL_MS);
      const el = containerRef.current;
      if (el && autoScroll.current !== 0) el.scrollTop += autoScroll.current;
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
        const g = state.groups.find((x) => x.memberIds.includes(info.id));
        return !!g && g.memberIds.length <= 2; // last two -> group disbands
      }
      return false; // adding to an existing group is instant
    },
    [state.groups],
  );

  const applyDrop = useCallback(() => {
    const source = pointerStart.current?.entry ?? drag;
    const info = dropRef.current;
    if (!source || !info) return;
    if (info.type === "insert") {
      moveEntry(source, info.index);
    } else if (info.type === "member-insert") {
      if (source.kind === "media") insertIntoGroup(info.groupId, source.id, info.index);
    } else if (info.type === "hold") {
      if (needsHold(info)) {
        const held = holdRef.current;
        const complete = held && performance.now() - held.start >= HOLD_MS;
        if (!complete) return;
      }
      if (info.kind === "media" && source.kind === "media") createGroup([info.id, source.id]);
      if (info.kind === "group" && source.kind === "media") addToGroup(info.id, source.id);
      if (info.kind === "ungroup" && source.kind === "media") {
        const g = state.groups.find((x) => x.memberIds.includes(source.id));
        if (g && g.memberIds.length <= 2) dissolveGroup(g.id);
        else removeFromGroup(source.id);
      }
    }
  }, [addToGroup, createGroup, dissolveGroup, drag, insertIntoGroup, moveEntry, moveGroupMember, needsHold, removeFromGroup, state.groups]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      setDragPoint({ x: e.clientX, y: e.clientY });
      const el = containerRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (e.clientY < r.top + 60) autoScroll.current = -14;
        else if (e.clientY > r.bottom - 60) autoScroll.current = 14;
        else autoScroll.current = 0;
      }
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      const mediaEl = stack.find((n) => (n as HTMLElement).dataset?.['mediaId']) as HTMLElement | undefined;
      const groupEl = stack.find((n) => (n as HTMLElement).dataset?.['groupId']) as HTMLElement | undefined;
      const rowEl = stack.find((n) => (n as HTMLElement).dataset?.['libraryRow']) as HTMLElement | undefined;
      let next: DropInfo = null;

      // Expanded groups contain ordinary media cards. A new image is inserted
      // between those cards directly, with the same seam/rail behaviour as
      // the Library — never a hold overlay.
      // `elementsFromPoint` may stop at the member card and omit its group
      // frame. The member itself carries the authoritative group id.
      const targetGroupId = groupEl?.dataset['groupId'] ?? mediaEl?.dataset['inGroup'];
      const sourceGroupId = drag.kind === "media" ? state.groups.find((group) => group.memberIds.includes(drag.id))?.id : undefined;
      const isDraggingWithinOwnGroup = Boolean(sourceGroupId && targetGroupId === sourceGroupId);
      // A member dragged inside its own expanded group must use the same
      // left/right 50px seams as Library, but reorder `memberIds` instead of
      // accidentally moving the whole group in the global Library order.
      if (sourceGroupId && targetGroupId === sourceGroupId && drag.kind === "media") {
        const group = state.groups.find((item) => item.id === sourceGroupId);
        const memberCards = [...document.querySelectorAll<HTMLElement>(`[data-in-group="${sourceGroupId}"]`)]
          .filter((card) => {
            const rect = card.getBoundingClientRect();
            return card.dataset['mediaId'] !== drag.id && e.clientY >= rect.top && e.clientY <= rect.bottom;
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        for (let i = 0; group && i < memberCards.length - 1; i += 1) {
          const left = memberCards[i]!;
          const right = memberCards[i + 1]!;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          if (e.clientX < leftRect.right - EDGE || e.clientX > rightRect.left + EDGE) continue;
          const index = group.memberIds.indexOf(right.dataset['mediaId']!);
          if (index >= 0) next = { type: "member-insert", groupId: sourceGroupId, index };
          break;
        }
        if (!next && mediaEl?.dataset['inGroup'] === sourceGroupId && mediaEl.dataset['mediaId'] !== drag.id && group) {
          const rect = mediaEl.getBoundingClientRect();
          const index = group.memberIds.indexOf(mediaEl.dataset['mediaId']!);
          if (index >= 0 && e.clientX - rect.left <= EDGE) next = { type: "member-insert", groupId: sourceGroupId, index };
          else if (index >= 0 && rect.right - e.clientX <= EDGE) next = { type: "member-insert", groupId: sourceGroupId, index: index + 1 };
        }
        // The far-right part of an expanded Group is empty panel, not a media
        // card. It is still the final member seam, so it must be a valid drop
        // target and show the same Rail as every other member seam.
        if (!next && groupEl?.dataset['groupId'] === sourceGroupId && group) {
          next = { type: "member-insert", groupId: sourceGroupId, index: group.memberIds.length };
        }
      }
      if (targetGroupId && drag.kind === "media" && sourceGroupId !== targetGroupId) {
        const group = state.groups.find((item) => item.id === targetGroupId);
        const members = [...document.querySelectorAll<HTMLElement>(`[data-in-group="${targetGroupId}"]`)]
          .filter((card) => {
            const rect = card.getBoundingClientRect();
            return e.clientY >= rect.top && e.clientY <= rect.bottom;
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        for (let i = 0; group && i < members.length - 1; i += 1) {
          const left = members[i]!;
          const right = members[i + 1]!;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          if (e.clientX < leftRect.right - EDGE || e.clientX > rightRect.left + EDGE) continue;
          const index = group.memberIds.indexOf(right.dataset['mediaId']!);
          if (index >= 0) next = { type: "member-insert", groupId: targetGroupId, index };
          break;
        }
        if (!next && mediaEl?.dataset['inGroup'] === targetGroupId && group) {
          const rect = mediaEl.getBoundingClientRect();
          const index = group.memberIds.indexOf(mediaEl.dataset['mediaId']!);
          if (index >= 0) next = { type: "member-insert", groupId: targetGroupId, index: e.clientX < rect.left + rect.width / 2 ? index : index + 1 };
        }
        // Every point in an expanded group resolves to its nearest member
        // seam. It must never fall back to the old hold/spinner treatment.
        if (!next && group) {
          const allMembers = [...document.querySelectorAll<HTMLElement>(`[data-in-group="${targetGroupId}"]`)];
          const nearest = allMembers.reduce<HTMLElement | null>((closest, card) => {
            if (!closest) return card;
            const a = closest.getBoundingClientRect();
            const b = card.getBoundingClientRect();
            const distance = (rect: DOMRect) => Math.hypot(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
            return distance(b) < distance(a) ? card : closest;
          }, null);
          if (nearest) {
            const rect = nearest.getBoundingClientRect();
            const index = group.memberIds.indexOf(nearest.dataset['mediaId']!);
            if (index >= 0) next = { type: "member-insert", groupId: targetGroupId, index: e.clientX < rect.left + rect.width / 2 ? index : index + 1 };
          }
        }
        // Do not ever turn an expanded group into a generic "drop on group".
        // Its final fallback is still a concrete member insertion at the end.
        if (!next && group) next = { type: "member-insert", groupId: targetGroupId, index: group.memberIds.length };
        if (!next) next = { type: "hold", kind: "group", id: targetGroupId };
      }

      // A seam is one continuous target: the physical gap plus the final/first
      // 50px of the two neighbouring cards. `elementsFromPoint` cannot see
      // the gap, which was why dragging to the exact middle did nothing.
      const rowCards = [...document.querySelectorAll<HTMLElement>("[data-media-id]")]
        .filter((card) => {
          const rect = card.getBoundingClientRect();
          return (
            card.dataset['entryId'] !== drag.id &&
            card.dataset['mediaId'] !== drag.id &&
            !(drag.kind === "group" && card.dataset['inGroup'] === drag.id) &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
          );
        })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      for (let i = 0; !next && drag.kind !== "group" && !isDraggingWithinOwnGroup && i < rowCards.length - 1; i += 1) {
        const left = rowCards[i]!;
        const right = rowCards[i + 1]!;
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        if (e.clientX < leftRect.right - EDGE || e.clientX > rightRect.left + EDGE) continue;
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

      if (!next && drag.kind !== "group" && !isDraggingWithinOwnGroup && mediaEl && mediaEl.dataset['mediaId'] !== drag.id && mediaEl.dataset['entryId'] !== drag.id) {
        const rect = mediaEl.getBoundingClientRect();
        const entryId = mediaEl.dataset['entryId']!;
        const entryKind = (mediaEl.dataset['entryKind'] ?? "media") as "media" | "group";
        const inGroup = mediaEl.dataset['inGroup'];
        // A member of an expanded group reorders around its group in the top-level order.
        const raw = globalIndex({ kind: entryKind, id: entryId });
        const idx = raw >= 0 ? raw : inGroup ? globalIndex({ kind: "group", id: inGroup }) : 0;
        if (e.clientX - rect.left <= EDGE) next = { type: "insert", index: Math.max(idx, 0), axis: "x" };
        else if (rect.right - e.clientX <= EDGE) next = { type: "insert", index: Math.max(idx, 0) + 1, axis: "x" };
        else if (entryKind === "group" && drag.kind === "media") next = { type: "hold", kind: "group", id: entryId };
        else if (drag.kind === "media") next = { type: "hold", kind: "media", id: mediaEl.dataset['mediaId']! };
      } else if (!isDraggingWithinOwnGroup && groupEl && groupEl.dataset['groupId'] !== drag.id) {
        const rect = groupEl.getBoundingClientRect();
        const idx = globalIndex({ kind: "group", id: groupEl.dataset['groupId']! });
        if (drag.kind === "group") {
          next =
            e.clientY < rect.top + rect.height / 2
              ? { type: "insert", index: idx, axis: "y" }
              : { type: "insert", index: idx + 1, axis: "y" };
        } else if (e.clientX - rect.left <= EDGE) next = { type: "insert", index: idx, axis: "x" };
        else if (rect.right - e.clientX <= EDGE) next = { type: "insert", index: idx + 1, axis: "x" };
        else next = { type: "hold", kind: "group", id: groupEl.dataset['groupId']! };
      } else if (drag.kind === "group" && rowEl) {
        const rowEntries = [...rowEl.querySelectorAll<HTMLElement>("[data-entry-id]")]
          .map((node) => ({
            index: globalIndex({ kind: (node.dataset['entryKind'] ?? "media") as "media" | "group", id: node.dataset['entryId']! }),
          }))
          .filter((entry) => entry.index >= 0)
          .map((entry) => entry.index);
        if (rowEntries.length) {
          const rect = rowEl.getBoundingClientRect();
          next = e.clientY < rect.top + rect.height / 2
            ? { type: "insert", index: Math.min(...rowEntries), axis: "y" }
            : { type: "insert", index: Math.max(...rowEntries) + 1, axis: "y" };
        }
      } else if (!isDraggingWithinOwnGroup && drag.kind === "media" && sourceGroupId) {
        // Dragging a member out must behave exactly like positioning an
        // ordinary Library card. Even a blank part of a row resolves to the
        // nearest top-level item and shows an insertion rail — never a hold.
        const candidates = [
          ...document.querySelectorAll<HTMLElement>("[data-entry-id]"),
          ...document.querySelectorAll<HTMLElement>("[data-group-id]"),
        ].filter((node, index, all) => all.indexOf(node) === index).filter((node) => {
          const entry = node.dataset['groupId']
            ? { kind: "group" as const, id: node.dataset['groupId']! }
            : { kind: (node.dataset['entryKind'] ?? "media") as "media" | "group", id: node.dataset['entryId']! };
          const rect = node.getBoundingClientRect();
          return globalIndex(entry) >= 0 && rect.width > 0 && rect.height > 0;
        });
        const nearest = candidates.reduce<HTMLElement | null>((closest, node) => {
          if (!closest) return node;
          const distance = (rect: DOMRect) => Math.hypot(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
          return distance(node.getBoundingClientRect()) < distance(closest.getBoundingClientRect()) ? node : closest;
        }, null);
        if (nearest) {
          const entry = nearest.dataset['groupId']
            ? { kind: "group" as const, id: nearest.dataset['groupId']! }
            : { kind: (nearest.dataset['entryKind'] ?? "media") as "media" | "group", id: nearest.dataset['entryId']! };
          const index = globalIndex(entry);
          const rect = nearest.getBoundingClientRect();
          if (index >= 0) next = { type: "insert", index: e.clientX < rect.left + rect.width / 2 ? index : index + 1, axis: "x" };
        }
        if (!next) next = { type: "hold", kind: "ungroup", id: drag.id };
      }

      const key = next?.type === "hold" && needsHold(next) ? `${next.kind}:${next.id}` : "";
      if (!key) {
        holdRef.current = null;
        setHoldProgress(0);
      } else if (holdRef.current?.key !== key) {
        holdRef.current = { key, start: performance.now() };
        setHoldProgress(0);
      }

      const dwellKey = next?.type === "insert" ? `${next.axis}:${next.index}` : next?.type === "member-insert" ? `${next.groupId}:${next.index}` : "";
      if (!dwellKey) {
        dwellRef.current = null;
        setDwelled(false);
      } else if (dwellRef.current?.key !== dwellKey) {
        dwellRef.current = { key: dwellKey, start: performance.now() };
        setDwelled(false);
      }

      if (next?.type === "member-insert") {
        const group = state.groups.find((item) => item.id === next.groupId);
        const beforeId = group?.memberIds[next.index];
        const afterId = group?.memberIds[next.index - 1];
        next = { ...next, railMediaId: beforeId ?? afterId, railSide: beforeId ? "left" : "right" };
      }
      dropRef.current = next;
      setDrop(next);
    };


    const onUp = () => {
      applyDrop();
      autoScroll.current = 0;
      pointerStart.current = null;
      dropRef.current = null;
      dwellRef.current = null;
      setDwelled(false);
      finishHold();
      setDrop(null);
      setDrag(null);
      setDragPoint(null);
    };


    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applyDrop, drag, finishHold, globalIndex, needsHold, state.groups]);

  const startPointer = (e: React.PointerEvent, entry: OrderEntry) => {
    if (e.button !== 0) return;
    pointerStart.current = { x: e.clientX, y: e.clientY, entry };
    const onMove = (ev: PointerEvent) => {
      const s = pointerStart.current;
      if (!s) return;
      if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 5) {
        setDrag(entry);
        setDragPoint({ x: ev.clientX, y: ev.clientY });
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
      el.querySelectorAll<HTMLElement>("[data-media-id]").forEach((node) => {
        const r = node.getBoundingClientRect();
        const nx = r.left - rect.left;
        const ny = r.top - rect.top + el.scrollTop;
        if (nx < box.x + box.w && nx + r.width > box.x && ny < box.y + box.h && ny + r.height > box.y)
          hits.push(node.dataset['mediaId']!);
      });
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

  const handleSelect = (e: React.MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
    } else {
      setSelected([id]);
    }
  };

  // Radix renders menus and dialogs in portals, but their React events still
  // bubble through this Gallery. Do not let an action click become a canvas
  // pointer-down: that starts marquee selection and can replace the selected
  // image ids before the menu action gets to use them.
  const stopCanvasPointerDown = (event: React.PointerEvent) => event.stopPropagation();

  // ---- context menu ---------------------------------------------------
  const selectionMenu = (ids: string[]) => {
    const hasClipboard = Object.values(clipboard).some((values) => values.length);
    return (
      <ContextMenuContent onPointerDown={stopCanvasPointerDown} className="glass-float w-64 rounded-xl">
        <ContextMenuItem className={menuItem} onSelect={() => { createGroup(ids); setSelected([]); }}>
          <Boxes className="size-4" /> Tạo group từ {ids.length} ảnh đã chọn
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => { setGalleryPickerQuery(""); setAddGroupToGalleryFor(ids); }}>
          <FolderPlus className="size-4" /> Thêm {ids.length} ảnh vào Gallery
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
            <ClipboardPaste className="size-4" /> Dán tag vào ảnh đã chọn
          </ContextMenuItem>
        )}
        {currentFolderId ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={cn(menuItem, "text-destructive")}
              onSelect={() => onConfirm({
                title: `Ẩn ${ids.length} ảnh khỏi Gallery?`,
                description: "Ảnh sẽ vào thùng rác của Gallery này. File gốc trong Folder nguồn vẫn được giữ.",
                onConfirm: () => {
                  ids.forEach((id) => discardFromFolder(currentFolderId, id));
                  setSelected([]);
                },
              })}
            >
              <EyeOff className="size-4" /> Ẩn {ids.length} ảnh khỏi Gallery
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={cn(menuItem, "text-destructive")}
              onSelect={() => onConfirm({
                title: `Ẩn ${ids.length} media khỏi Main Gallery?`,
                description: "Media sẽ vào thùng rác Mosaic và có thể khôi phục. File gốc không bị thay đổi.",
                onConfirm: () => { hideMedia(ids); setSelected([]); },
              })}
            >
              <EyeOff className="size-4" /> Ẩn {ids.length} media khỏi Main Gallery
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    );
  };

  const mediaMenu = (m: MediaItem) => {
    const selectedIds = selected.length >= 2 && selected.includes(m.id)
      ? [...new Set(selected)].filter((id) => state.media.some((media) => media.id === id))
      : [];
    // Right-clicking one of several selected cards is a bulk operation. Do
    // not expose open/copy/cover/delete-one actions in that situation.
    if (selectedIds.length >= 2) return selectionMenu(selectedIds);
    const group = state.groups.find((g) => g.memberIds.includes(m.id));
    const hasClipboard = Object.values(clipboard).some((v) => v.length);
    return (
      <ContextMenuContent onPointerDown={stopCanvasPointerDown} className="glass-float w-64 rounded-xl">
        <ContextMenuItem className={menuItem} onSelect={() => onOpen(m.id)}>
          <Maximize2 className="size-4" /> {t("open")}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => void 0}>
          <FolderOpen className="size-4" /> {t("openInFolder")}
        </ContextMenuItem>
        <ContextMenuItem
          className={menuItem}
          onSelect={() => {
            void navigator.clipboard?.writeText(m.url);
          }}
        >
          <Copy className="size-4" /> {t("copyImage")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {selected.length >= 2 && selected.includes(m.id) ? (
          <ContextMenuItem className={menuItem} onSelect={() => { createGroup([...selected]); setSelected([]); }}>
            <Boxes className="size-4" /> {t("createGroupSelected")}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem className={cn(menuItem, "opacity-50")} disabled>
            <Boxes className="size-4" /> {t("needTwoToGroup")}
          </ContextMenuItem>
        )}
        {group && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => {
              if (group.memberIds.length <= 2) dissolveGroup(group.id);
              else removeFromGroup(m.id);
            }}
          >
            <Ungroup className="size-4" /> {t("removeFromGroup")}
          </ContextMenuItem>
        )}
        {group && group.coverId !== m.id && (
          <ContextMenuItem className={menuItem} onSelect={() => updateGroup(group.id, { coverId: m.id })}>
            <LayersIcon className="size-4" /> Đặt làm ảnh đại diện group
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {state.propertyGroups.map((g) => (
          <ContextMenuItem
            key={g.id}
            className={menuItem}
            onSelect={() => setClipboard((c) => ({ ...c, [g.id]: m.props[g.id] ?? [] }))}
          >
            <Tag className="size-4" />
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
            <ClipboardPaste className="size-4" /> {t("pasteTags")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem className={menuItem} onSelect={() => duplicateMedia(m.id)}>
          <CopyPlus className="size-4" /> {t("duplicate")}
        </ContextMenuItem>
        {currentFolderId && (
          <ContextMenuItem
            className={menuItem}
            onSelect={() => updateFolder(currentFolderId, { coverId: m.id })}
          >
            <ImageIcon className="size-4" /> {t("setFolderCover")}
          </ContextMenuItem>
        )}
        <ContextMenuItem className={menuItem} onSelect={() => { setGalleryPickerQuery(""); setAddToGalleryFor(m.id); }}>
          <FolderPlus className="size-4" /> {t("addToFolder")}
        </ContextMenuItem>
        {currentFolderId && (
          <ContextMenuItem className={menuItem} onSelect={() => setMoveToGalleryFor(m.id)}>
            <FolderInput className="size-4" /> Move to Gallery
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {currentFolderId && (
          <ContextMenuItem
            className={cn(menuItem, "text-destructive")}
            onSelect={() => onConfirm({
              title: "Ẩn ảnh khỏi Gallery?",
              description: "Ảnh sẽ vào thùng rác của Gallery này. File gốc trong Folder nguồn vẫn được giữ.",
              onConfirm: () => discardFromFolder(currentFolderId, m.id),
            })}
          >
            <EyeOff className="size-4" /> Ẩn ảnh khỏi Gallery
          </ContextMenuItem>
        )}
        {!currentFolderId && (
          <ContextMenuItem
            className={cn(menuItem, "text-destructive")}
            onSelect={() => onConfirm({
              title: "Ẩn media khỏi Main Gallery?",
              description: "Media sẽ vào thùng rác Mosaic và có thể khôi phục. File gốc không bị thay đổi.",
              onConfirm: () => hideMedia([m.id]),
            })}
          >
            <EyeOff className="size-4" /> Ẩn media khỏi Main Gallery
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className={cn(menuItem, "text-destructive")}
          onSelect={() => onConfirm({
            title: "Đưa file vào Thùng rác máy tính?",
            description: "File gốc sẽ được chuyển vào Recycle Bin của Windows để có thể khôi phục.",
            onConfirm: () => {
              const bridge = getInDeckBridge();
              if (!bridge) return;
              void bridge.trashMedia({
                id: m.id,
                path: m.path,
                vault: m.vault,
                contentUrl: m.contentUrl,
              }).then((removed) => { if (removed) purgeMedia(m.id); });
            },
          })}
        >
          <Trash2 className="size-4" /> Đưa file vào Thùng rác máy tính
        </ContextMenuItem>
      </ContextMenuContent>
    );
  };

  const groupMenu = (groupId: string) => {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return null;
    return (
      <ContextMenuContent onPointerDown={stopCanvasPointerDown} className="glass-float w-64 rounded-xl">
        <ContextMenuItem className={menuItem} onSelect={() => setSelected(group.memberIds)}>
          <Users className="size-4" /> {t("selectGroupImages")}
        </ContextMenuItem>
        <ContextMenuItem className={menuItem} onSelect={() => { setGalleryPickerQuery(""); setAddGroupToGalleryFor(group.memberIds); }}>
          <FolderPlus className="size-4" /> {t("addGroupToFolder")}
        </ContextMenuItem>
        <ContextMenuItem
          className={menuItem}
          onSelect={() => updateGroup(group.id, { collapsed: !group.collapsed })}
        >
          {group.collapsed ? <Maximize2 className="size-4" /> : <Minimize2 className="size-4" />}
          {group.collapsed ? t("expandGroup") : t("collapseGroup")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={cn(menuItem, "text-destructive")}
          onSelect={() =>
            onConfirm({ title: t("dissolveGroup"), onConfirm: () => dissolveGroup(group.id) })
          }
        >
          <Ungroup className="size-4" /> {t("dissolveGroup")}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  };



  const renderMedia = (
    m: MediaItem,
    entry: OrderEntry,
    w: number,
    h: number,
    badge?: number,
    stack?: MediaItem[],
    inGroupId?: string,
    priorityThumbnail = false,
  ) => {
    const isSelected = selected.includes(m.id);
    const holding =
      drop?.type === "hold" &&
      ((drop.kind === "media" && drop.id === m.id) || (drop.kind === "group" && drop.id === entry.id));
    const memberRail = drop?.type === "member-insert" && drop.groupId === inGroupId && drop.railMediaId === m.id ? drop.railSide : null;
    return (
      <ContextMenu key={`${entry.kind}:${entry.id}:${m.id}`}>
        <ContextMenuTrigger asChild>
          <div
            data-media-id={m.id}
            data-entry-id={entry.id}
            data-entry-kind={entry.kind}
            data-in-group={inGroupId}
            style={{
              width: w,
              height: h,
              ...(stack ? { padding: `${GROUP_PAD}px ${GROUP_PAD / 2}px ${GROUP_PAD / 2}px ${GROUP_PAD}px` } : null),
            }}

            onPointerDown={(e) => startPointer(e, entry)}
            onClick={(e) => handleSelect(e, m.id)}
            onDoubleClick={() => onOpen(m.id)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpen(m.id);
              if (e.key === " ") {
                e.preventDefault();
                handleSelect(e as unknown as React.MouseEvent, m.id);
              }
            }}
            className={cn(
              "no-drag group relative shrink-0 rounded-lg border transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              stack ? "glass-panel overflow-visible" : "overflow-hidden",
              isSelected ? "border-primary ring-2 ring-primary/60" : "border-border/60 hover:shadow-lg",
              drag?.id === m.id && "opacity-40",
              memberRail && "z-20 overflow-visible",
            )}

          >
            {stack ? (
              <div className="relative size-full">
                {stack
                  .slice(1, 4)
                  .map((s, i) => (
                    <img
                      key={s.id}
                      src={s.url}
                      alt=""
                      draggable={false}
                      className="absolute inset-0 size-full rounded-md border border-border/50 object-cover shadow-soft"
                      style={{
                        transform: `translate(${(3 - i) * 2.25}px, ${(3 - i) * 2.25}px) rotate(${(3 - i) * 1.2}deg)`,
                        opacity: 0.55 + i * 0.1,
                        zIndex: i,
                      }}
                    />

                  ))
                  .reverse()}
                <img
                  src={m.url}
                  alt=""
                  draggable={false}
                  className="relative z-10 size-full rounded-md border border-border/60 object-cover"
                />
              </div>
            ) : (
              <LazyThumbnail media={m} className="size-full object-fill" priority={priorityThumbnail} />
            )}
            {m.type === "video" && !stack && (
              <span className="glass-panel absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full">
                <Play className="size-3" />
              </span>
            )}
            {!stack && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(m.id);
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
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  updateGroup(entry.id, { collapsed: false });
                }}
                title={t("expandGroup")}
                className="glass-float absolute right-2 bottom-2 z-20 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
              >
                <Boxes className="size-3" />
                {badge}
              </button>
            )}
            {stack && (
              <span
                onPointerDown={(e) => {
                  e.stopPropagation();
                  startPointer(e, entry);
                }}
                title={t("dragToReorder")}
                className="glass-float absolute bottom-2 left-2 z-20 grid size-6 cursor-grab place-items-center rounded-md opacity-0 transition-opacity group-hover:opacity-100"
              >
                <GripVertical className="size-3.5" />
              </span>
            )}
            {holding && needsHold(drop) && <HoldRing progress={holdProgress} />}
            {memberRail && <InsertBar side={memberRail} spread={false} />}

          </div>
        </ContextMenuTrigger>
        {stack ? groupMenu(entry.id) : mediaMenu(m)}
      </ContextMenu>
    );
  };

  // ---- blocks ---------------------------------------------------------
  const displaySections = useMemo(() => {
    if (groupBy.length === 0) return [{ entries, label: "" }];
    const mediaForEntry = (entry: OrderEntry) => entry.kind === "media"
      ? state.media.filter((media) => media.id === entry.id)
      : state.groups.find((group) => group.id === entry.id)?.memberIds
        .map((id) => state.media.find((media) => media.id === id))
        .filter((media): media is MediaItem => !!media && visibleMediaIdSet.has(media.id)) ?? [];
    // A Group by value is a display facet, rather than a mutually-exclusive
    // bucket. Return every matching value so a media item can be rendered in
    // each relevant section while all copies still point at its single ID.
    const keysFor = (entry: OrderEntry, group: MediaGroupBy) => {
      const media = mediaForEntry(entry);
      if (group.kind === "media-source") {
        const values = [...new Set(media.map((item) => state.sources.find((source) => source.id === item.sourceId)?.name ?? "Unknown source"))];
        return values.length ? values.sort() : ["Unknown source"];
      }
      if (group.kind === "gallery-source") {
        const values = [...new Set(media.flatMap((item) => state.folders.filter((folder) => folder.mediaIds.includes(item.id)).map((folder) => folder.name)))];
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
  }, [entries, groupBy, state.folders, state.groups, state.media, state.propertyGroups, state.sources, visibleMediaIdSet]);

  type Block =
    | {
        kind: "run";
        entries: OrderEntry[];
        items: MediaItem[];
        badges: (number | undefined)[];
        stacks: (MediaItem[] | undefined)[];
        section: number;
        sectionStart: boolean;
        sectionLabel: string;
      }
    | { kind: "group"; entry: OrderEntry; items: MediaItem[]; section: number; sectionStart: boolean; sectionLabel: string };

  const blocks: Block[] = [];
  const pushRun = (entry: OrderEntry, m: MediaItem, section: number, badge?: number, stack?: MediaItem[]) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "run" && last.section === section) {
      last.items.push(m);
      last.entries.push(entry);
      last.badges.push(badge);
      last.stacks.push(stack);
    } else
      blocks.push({ kind: "run", entries: [entry], items: [m], badges: [badge], stacks: [stack], section, sectionStart: false, sectionLabel: "" });
  };

  displaySections.forEach((displaySection, section) => displaySection.entries.forEach((entry) => {
    if (entry.kind === "group") {
      const g = state.groups.find((x) => x.id === entry.id);
      if (!g) return;
      const items = g.memberIds
        .map(mediaById)
        .filter((media): media is MediaItem => !!media && visibleMediaIdSet.has(media.id));
      if (g.collapsed) {
        const cover = items.find((media) => media.id === g.coverId) ?? items[0];
        if (!cover) return;
        const rest = items.filter((m) => m.id !== cover.id);
        pushRun(entry, cover, section, items.length, [cover, ...rest].slice(0, 4));
      } else {
        blocks.push({ kind: "group", entry, items, section, sectionStart: false, sectionLabel: "" });
      }
    } else {
      const m = mediaById(entry.id);
      if (!m) return;
      pushRun(entry, m, section);
    }
  }));
  const markedSections = new Set<number>();
  blocks.forEach((block) => {
    block.sectionStart = groupBy.length > 0 && !markedSections.has(block.section);
    block.sectionLabel = block.sectionStart ? displaySections[block.section]?.label ?? "" : "";
    markedSections.add(block.section);
  });

  // Large libraries used to build every justified row and every card at
  // once.  Even though thumbnails were lazy, thousands of DOM nodes, menus,
  // and event handlers still made opening and scrolling a Gallery janky.
  // Keep the rich justified/group layout for ordinary Galleries, and switch
  // to a windowed responsive grid for large ones.  The grid deliberately
  // works with rows (not individual cards) so the number of mounted nodes is
  // stable while scrolling and there are no blank strips at row boundaries.
  type VirtualCell = {
    item: MediaItem;
    entry: OrderEntry;
    badge?: number;
    stack?: MediaItem[];
    inGroupId?: string;
    sectionLabel?: string;
  };
  const virtualCells: VirtualCell[] = [];
  blocks.forEach((block) => {
    let sectionLabel = block.sectionStart ? block.sectionLabel : undefined;
    if (block.kind === "run") {
      block.items.forEach((item, index) => {
        virtualCells.push({
          item,
          entry: block.entries[index] ?? { kind: "media", id: item.id },
          badge: block.badges[index],
          stack: block.stacks[index],
          sectionLabel,
        });
        sectionLabel = undefined;
      });
      return;
    }
    block.items.forEach((item) => {
      virtualCells.push({
        item,
        entry: { kind: "media", id: item.id },
        inGroupId: block.entry.id,
        sectionLabel,
      });
      sectionLabel = undefined;
    });
  });
  const shouldVirtualize = virtualCells.length > 160;
  const virtualCardHeight = Math.max(100, Math.min(400, state.thumbHeight));
  const virtualColumns = Math.max(1, Math.floor((width + GAP) / (virtualCardHeight * 1.25 + GAP)));
  const virtualCardWidth = Math.max(80, (width - GAP * (virtualColumns - 1)) / virtualColumns);
  const virtualRowHeight = virtualCardHeight + GAP;
  const virtualRowCount = Math.ceil(virtualCells.length / virtualColumns);
  // Two full screens on either side give thumbnail loading enough lead time
  // without allowing a scroll fling to mount the entire Gallery.
  const virtualScreenRows = Math.max(2, Math.ceil(viewportHeight / virtualRowHeight));
  const virtualBehind = scrollDirection.current === "down" ? virtualScreenRows : virtualScreenRows * 2;
  const virtualAhead = scrollDirection.current === "down" ? virtualScreenRows * 2 : virtualScreenRows;
  const virtualFirstRow = Math.max(0, Math.floor(scrollTop / virtualRowHeight) - virtualBehind);
  const virtualLastRow = Math.min(virtualRowCount, Math.ceil((scrollTop + viewportHeight) / virtualRowHeight) + virtualAhead);

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-16 text-center">
        <p className="font-display text-lg font-medium">{t("noMedia")}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{t("noMediaHint")}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={onBackgroundPointerDown}
      onScroll={(event) => {
        const next = event.currentTarget.scrollTop;
        scrollDirection.current = next < scrollTop ? "up" : "down";
        setScrollTop(next);
      }}
      className="app-scroll relative min-w-0 flex-1 overflow-y-auto px-5 py-4"
    >
      {shouldVirtualize ? (
        <div ref={innerRef} className="relative w-full min-w-0" style={{ height: Math.max(0, virtualRowCount * virtualRowHeight - GAP) }}>
          {Array.from({ length: Math.max(0, virtualLastRow - virtualFirstRow) }, (_, offset) => {
            const rowIndex = virtualFirstRow + offset;
            const cells = virtualCells.slice(rowIndex * virtualColumns, (rowIndex + 1) * virtualColumns);
            const sectionLabel = cells.find((cell) => cell.sectionLabel)?.sectionLabel;
            return (
              <Fragment key={`virtual-${rowIndex}`}>
                {sectionLabel && (
                  <div className="absolute right-0 left-0" style={{ top: rowIndex * virtualRowHeight }}>
                    <GroupDivider label={sectionLabel} />
                  </div>
                )}
                <div
                  data-library-row
                  className="absolute right-0 left-0 flex"
                  style={{ top: rowIndex * virtualRowHeight + (sectionLabel ? 28 : 0), gap: GAP, height: virtualCardHeight }}
                >
                  {cells.map((cell) => renderMedia(
                    cell.item,
                    cell.entry,
                    virtualCardWidth,
                    Math.max(72, virtualCardHeight - (sectionLabel ? 28 : 0)),
                    cell.badge,
                    cell.stack,
                    cell.inGroupId,
                    true,
                  ))}
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : (
      <div ref={innerRef} className="flex w-full min-w-0 flex-col" style={{ gap: GAP }}>
        {blocks.map((block, bi) => {
          if (block.kind === "run") {
            return equalJustifiedRows(block.items, width, state.thumbHeight).map((row, ri) => {
              const cells = row.items.map(({ item, width: w }) => {
                const i = block.items.indexOf(item);
                const entry = block.entries[i] ?? { kind: "media" as const, id: item.id };
                return { item, w, entry, badge: block.badges[i], stack: block.stacks[i] };
              });
              const groupBar =
                drag?.kind === "group" && drop?.type === "insert"
                  ? cells.some((c) => drop.index === globalIndex(c.entry))
                    ? "before"
                    : cells.some((c) => drop.index === globalIndex(c.entry) + 1)
                      ? "after"
                      : null
                  : null;
              return (
                <Fragment key={`${bi}-${ri}`}>
                  {block.sectionStart && ri === 0 && <GroupDivider label={block.sectionLabel} />}
                  <div data-library-row className="relative flex" style={{ gap: GAP }}>
                    {cells.map(({ item, w, entry, badge, stack }) =>
                      renderMedia(item, entry, w, row.height, badge, stack),
                    )}
                    {groupBar === "before" && (
                      <span className="pointer-events-none absolute -top-[5px] right-1 left-1 h-[3px] rounded-full bg-primary" />
                    )}
                    {groupBar === "after" && (
                      <span className="pointer-events-none absolute -bottom-[5px] right-1 left-1 h-[3px] rounded-full bg-primary" />
                    )}
                  </div>
                </Fragment>
              );
            });
          }
          const group = state.groups.find((g) => g.id === block.entry.id)!;
          const gi = globalIndex(block.entry);
          const rows = equalJustifiedRows(block.items, Math.max(width - GROUP_PAD * 2, 100), state.thumbHeight);
          const holdingGroup = drop?.type === "hold" && drop.kind === "group" && drop.id === group.id;
          const insertY =
            drop?.type === "insert" && drop.axis === "y"
              ? drop.index === gi
                ? "before"
                : drop.index === gi + 1
                  ? "after"
                  : null
              : null;
          const insertX =
            drop?.type === "insert" && drop.axis === "x"
              ? drop.index === gi
                ? "before"
                : drop.index === gi + 1
                  ? "after"
                  : null
              : null;
          return (
            <Fragment key={group.id}>
              {block.sectionStart && <GroupDivider label={block.sectionLabel} />}
              <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  data-group-id={group.id}
                  style={{
                    padding: GROUP_PAD,
                    marginTop: dwelled && insertY === "before" ? SPREAD : undefined,
                    marginBottom: dwelled && insertY === "after" ? SPREAD : undefined,
                  }}
                  className={cn(
                    "glass-panel group/frame relative w-full rounded-xl transition-all",
                    drag?.id === group.id && "opacity-50",
                    holdingGroup && "ring-2 ring-primary/60",
                  )}
                >
                  <div className="flex flex-col" style={{ gap: GAP }}>
                    {!group.collapsed &&
                      rows.map((row, ri) => (
                        <div key={ri} className="flex" style={{ gap: GAP }}>
                          {row.items.map(({ item, width: w }) =>
                            renderMedia(
                              item,
                              { kind: "media", id: item.id },
                              w,
                              row.height,
                              undefined,
                              undefined,
                              group.id,
                            ),
                          )}
                        </div>
                      ))}
                    {group.collapsed && (
                      <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
                        {t("count", { count: block.items.length })}
                      </div>
                    )}
                  </div>
                  <button
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startPointer(e, block.entry);
                    }}
                    aria-label={t("dragToReorder")}
                    title={t("dragToReorder")}
                    className="glass-float absolute bottom-1.5 left-1.5 z-30 grid size-6 cursor-grab place-items-center rounded-md opacity-0 transition-opacity group-hover/frame:opacity-100 active:cursor-grabbing"
                  >
                    <GripVertical className="size-3.5" />
                  </button>
                  {holdingGroup && needsHold(drop) && <HoldRing progress={holdProgress} />}
                  {insertY === "before" && <InsertBar horizontal side="top" spread={dwelled} />}
                  {insertY === "after" && <InsertBar horizontal side="bottom" spread={dwelled} />}
                </div>

              </ContextMenuTrigger>
              {groupMenu(group.id)}
              </ContextMenu>
            </Fragment>
          );
        })}
      </div>
      )}

      {libraryRail && (
        <span
          aria-hidden
          className="pointer-events-none absolute z-50 block w-1 rounded-full border border-white/30 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_16px_rgb(255_255_255_/_0.3)]"
          style={{ left: libraryRail.x, top: libraryRail.y, height: libraryRail.height }}
        />
      )}

      {drag?.kind === "media" && dragPoint && mediaById(drag.id) && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[80] h-20 w-28 overflow-hidden rounded-lg border border-white/35 bg-background/35 opacity-60 shadow-2xl backdrop-blur-sm"
          style={{ left: dragPoint.x + 14, top: dragPoint.y + 14 }}
        >
          <img src={mediaById(drag.id)!.url} alt="" draggable={false} className="size-full object-cover" />
        </div>
      )}

      {marquee && (
        <div
          className="pointer-events-none absolute rounded-md border border-primary/70 bg-primary/10"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

      {drop?.type === "hold" && drop.kind === "ungroup" && needsHold(drop) && (
        <div className="glass-float pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full px-4 py-2 text-xs">
          {t("removeFromGroup")} · {((1 - holdProgress) * (HOLD_MS / 1000)).toFixed(1)}s
        </div>
      )}
      <Dialog open={!!addToGalleryFor} onOpenChange={(open) => !open && setAddToGalleryFor(null)}>
        <DialogContent onPointerDown={stopCanvasPointerDown} className="glass-float max-w-md rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">{t("addToFolder")}</DialogTitle></DialogHeader>
          <label className="glass-btn flex items-center gap-2 rounded-xl px-3 py-2"><Search className="size-3.5 text-muted-foreground" /><input autoFocus value={galleryPickerQuery} onChange={(event) => setGalleryPickerQuery(event.target.value)} placeholder="Tìm Gallery" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {galleryPickerFolders.map((folder) => {
              const alreadyAdded = !!addToGalleryFor && folder.mediaIds.includes(addToGalleryFor);
              const cover = galleryCover(folder.id);
              return <button key={folder.id} disabled={alreadyAdded} onClick={() => { if (addToGalleryFor) addToFolder(folder.id, [addToGalleryFor]); setAddToGalleryFor(null); }} className={cn("glass-btn flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", alreadyAdded && "cursor-not-allowed opacity-45")}>{cover ? <img src={cover} alt="" className="size-8 shrink-0 rounded-md object-cover" /> : <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary/60"><Folder className="size-4 text-muted-foreground" /></span>}<span className="flex-1 truncate">{folder.name}</span>{alreadyAdded ? <span className="text-xs text-muted-foreground">Đã thêm</span> : <FolderPlus className="size-4 text-muted-foreground" />}</button>;
            })}
            {state.folders.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Chưa có Gallery.</p>}
            {state.folders.length > 0 && galleryPickerFolders.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Không tìm thấy Gallery.</p>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!moveToGalleryFor} onOpenChange={(open) => !open && setMoveToGalleryFor(null)}>
        <DialogContent onPointerDown={stopCanvasPointerDown} className="glass-float max-w-md rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">Move to Gallery</DialogTitle></DialogHeader>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {state.folders.filter((folder) => folder.id !== currentFolderId).map((folder) => {
              const alreadyAdded = !!moveToGalleryFor && folder.mediaIds.includes(moveToGalleryFor);
              return <button key={folder.id} onClick={() => {
                if (!moveToGalleryFor || !currentFolderId) return;
                // Move is membership-only: keep the original file/source, add
                // it to the destination, then remove it from this Gallery.
                addToFolder(folder.id, [moveToGalleryFor]);
                removeFromFolder(currentFolderId, moveToGalleryFor);
                setMoveToGalleryFor(null);
              }} className="glass-btn flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"><Folder className="size-4 text-muted-foreground" /><span className="flex-1 truncate">{folder.name}</span>{alreadyAdded ? <span className="text-xs text-muted-foreground">Đã có</span> : <FolderInput className="size-4 text-muted-foreground" />}</button>;
            })}
            {state.folders.filter((folder) => folder.id !== currentFolderId).length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Chưa có Gallery khác.</p>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!addGroupToGalleryFor} onOpenChange={(open) => !open && setAddGroupToGalleryFor(null)}>
        <DialogContent onPointerDown={stopCanvasPointerDown} className="glass-float max-w-md rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">{t("addGroupToFolder")}</DialogTitle></DialogHeader>
          <label className="glass-btn flex items-center gap-2 rounded-xl px-3 py-2"><Search className="size-3.5 text-muted-foreground" /><input autoFocus value={galleryPickerQuery} onChange={(event) => setGalleryPickerQuery(event.target.value)} placeholder="Tìm Gallery" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {galleryPickerFolders.map((folder) => {
              const mediaIds = addGroupToGalleryFor ?? [];
              const alreadyAdded = mediaIds.length > 0 && mediaIds.every((id) => folder.mediaIds.includes(id));
              const cover = galleryCover(folder.id);
              return <button key={folder.id} disabled={alreadyAdded} onClick={() => { if (mediaIds.length) addToFolder(folder.id, mediaIds); setAddGroupToGalleryFor(null); }} className={cn("glass-btn flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", alreadyAdded && "cursor-not-allowed opacity-45")}>{cover ? <img src={cover} alt="" className="size-8 shrink-0 rounded-md object-cover" /> : <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary/60"><Folder className="size-4 text-muted-foreground" /></span>}<span className="flex-1 truncate">{folder.name}</span><FolderPlus className="size-4 text-muted-foreground" /></button>;
            })}
            {galleryPickerFolders.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Không tìm thấy Gallery.</p>}
          </div>
        </DialogContent>
      </Dialog>
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

/** Old-style insertion rail, restyled with the app's translucent glass material. */
function InsertBar({
  side,
  spread,
  horizontal,
}: {
  side: "left" | "right" | "top" | "bottom";
  spread: boolean;
  horizontal?: boolean;
}) {
  if (horizontal) {
    return (
      <span
        className={cn(
          "pointer-events-none absolute inset-x-1 z-30 block h-1 rounded-full border border-white/20 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_14px_rgb(255_255_255_/_0.22)] backdrop-blur-md transition-all",
          side === "top" ? "-top-[6px]" : "-bottom-[6px]",
          spread && "h-[5px]",
        )}
      />
    );
  }
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-y-0 z-30 block w-1 rounded-full border border-white/20 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_14px_rgb(255_255_255_/_0.22)] backdrop-blur-md transition-all",
        side === "left" ? "-left-[6px]" : "-right-[6px]",
        spread && "w-[5px]",
      )}
    />
  );
}



function HoldRing({ progress }: { progress: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/20 backdrop-blur-[1px]">
      <svg viewBox="0 0 36 36" className="size-12 -rotate-90">
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
