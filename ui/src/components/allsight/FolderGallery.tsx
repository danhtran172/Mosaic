import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, Layers, Lock, LockOpen, Pencil, Ungroup } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import { LockOverlay } from "./LockOverlay";
import { cn } from "@/lib/utils";
import type { GalleryGroup, GalleryOrderEntry, PersonalFolder } from "@/lib/allsight/types";
import type { View } from "./Sidebar";

type Props = { onOpen: (v: View) => void; unlockedFolderIds: string[] };
type DragEntry = GalleryOrderEntry;
type LibraryDrop =
  | { type: "reorder"; index: number }
  | { type: "create-group"; folderId: string }
  | { type: "add-to-group"; groupId: string }
  | { type: "member-reorder"; groupId: string; folderId: string; index: number }
  | null;

const DRAG_THRESHOLD = 5;
const EDGE = 50;
const HOLD_MS = 1500;

/**
 * The Gallery board intentionally uses the same direct-manipulation model as
 * media: an edge is a reorder target, while the body of a Gallery Group is a
 * drop target for its members. This leaves no ambiguous "loading" drop state.
 */
export function FolderGallery({ onOpen, unlockedFolderIds }: Props) {
  const t = useT();
  const {
    state, createGalleryGroup, addGalleryToGroup, removeGalleryFromGroup,
    updateFolder, updateGalleryGroup, moveGalleryEntry, moveGalleryInGroup,
  } = useAllsight();
  const [selected, setSelected] = useState<string[]>([]);
  const [openedGroupId, setOpenedGroupId] = useState<string | null>(null);
  const [dragged, setDragged] = useState<DragEntry | null>(null);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<LibraryDrop>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const [libraryRail, setLibraryRail] = useState<{ x: number; y: number; height: number } | null>(null);
  const [memberRail, setMemberRail] = useState<{ index: number; side: "left" | "right" } | null>(null);
  const [renamingGalleryGroup, setRenamingGalleryGroup] = useState<GalleryGroup | null>(null);
  const selectedRef = useRef<string[]>([]);
  const dropRef = useRef<LibraryDrop>(null);
  const hold = useRef<{ key: string; startedAt: number } | null>(null);
  const pendingPointer = useRef<{ entry: DragEntry; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const openedGroup = state.galleryGroups.find((group) => group.id === openedGroupId) ?? null;
  const entries = useMemo(() => {
    const groupedIds = new Set(state.galleryGroups.flatMap((group) => group.folderIds));
    const ordered: DragEntry[] = state.galleryOrder.filter((entry) =>
      entry.kind === "group"
        ? state.galleryGroups.some((group) => group.id === entry.id)
        : state.folders.some((folder) => folder.id === entry.id) && !groupedIds.has(entry.id),
    );
    // Older snapshots (and an immediately dissolved group) can lack a card
    // order entry. Keep every valid card visible and repair persistence on the
    // next ordinary state write rather than ever hiding a Gallery.
    const orderedKeys = new Set(ordered.map((entry) => `${entry.kind}:${entry.id}`));
    state.galleryGroups.forEach((group) => {
      if (!orderedKeys.has(`group:${group.id}`)) ordered.push({ kind: "group", id: group.id });
    });
    state.folders.filter((folder) => !groupedIds.has(folder.id)).forEach((folder) => {
      if (!orderedKeys.has(`folder:${folder.id}`)) ordered.push({ kind: "folder", id: folder.id });
    });
    return ordered;
  }, [state.folders, state.galleryGroups, state.galleryOrder]);

  const selectFolder = (event: React.MouseEvent, id: string) => {
    if (event.ctrlKey || event.metaKey) setSelected((ids) => {
      const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
      selectedRef.current = next;
      return next;
    });
    else { selectedRef.current = [id]; setSelected([id]); }
  };
  const finishDrag = useCallback(() => {
    pendingPointer.current = null;
    dropRef.current = null;
    hold.current = null;
    setDragged(null);
    setDragPoint(null);
    setDrop(null);
    setHoldProgress(0);
    setLibraryRail(null);
    setMemberRail(null);
  }, []);
  const syncLibraryRail = (rect: DOMRect, before: boolean) => {
    const root = boardRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const seamX = before ? rect.left - 8 : rect.right + 8;
    const next = {
      x: seamX - rootRect.left + root.scrollLeft - 2,
      y: rect.top - rootRect.top + root.scrollTop,
      height: rect.height,
    };
    setLibraryRail((current) => current && Math.abs(current.x - next.x) < 1 && Math.abs(current.y - next.y) < 1 && Math.abs(current.height - next.height) < 1 ? current : next);
  };
  const consumeDragClick = () => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  };
  const folderById = (id: string) => state.folders.find((folder) => folder.id === id);

  const startPointer = (event: React.PointerEvent, entry: DragEntry) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    pendingPointer.current = { entry, x: event.clientX, y: event.clientY };
    const armDrag = (move: PointerEvent) => {
      const pending = pendingPointer.current;
      if (!pending || Math.hypot(move.clientX - pending.x, move.clientY - pending.y) <= DRAG_THRESHOLD) return;
      suppressClick.current = true;
      setDragged(pending.entry);
      setDragPoint({ x: move.clientX, y: move.clientY });
      pendingPointer.current = null;
      window.removeEventListener("pointermove", armDrag);
      window.removeEventListener("pointerup", cancelArm);
      window.removeEventListener("pointercancel", cancelArm);
    };
    const cancelArm = () => {
      pendingPointer.current = null;
      window.removeEventListener("pointermove", armDrag);
      window.removeEventListener("pointerup", cancelArm);
      window.removeEventListener("pointercancel", cancelArm);
    };
    window.addEventListener("pointermove", armDrag);
    window.addEventListener("pointerup", cancelArm);
    window.addEventListener("pointercancel", cancelArm);
  };

  // Match the media board: a visible, frame-by-frame hold ring makes the
  // 1.5-second grouping gesture discoverable and reversible.
  useEffect(() => {
    if (!dragged) return;
    let frame = 0;
    const tick = () => {
      const activeHold = hold.current;
      setHoldProgress(activeHold ? Math.min(1, (performance.now() - activeHold.startedAt) / HOLD_MS) : 0);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [dragged]);

  useEffect(() => {
    if (!dragged) return;
    const onMove = (event: PointerEvent) => {
      setDragPoint({ x: event.clientX, y: event.clientY });
      const nodes = document.elementsFromPoint(event.clientX, event.clientY) as HTMLElement[];
      const member = nodes.find((node) => node.dataset.galleryMemberId && node.dataset.galleryMemberGroup);
      const entry = nodes.find((node) => node.dataset.galleryEntryId && node.dataset.galleryEntryKind);
      let next: LibraryDrop = null;

      if (member && dragged.kind === "folder") {
        const groupId = member.dataset.galleryMemberGroup!;
        const folderId = member.dataset.galleryMemberId!;
        const group = state.galleryGroups.find((item) => item.id === groupId);
        if (group && group.folderIds.includes(dragged.id)) {
          const rect = member.getBoundingClientRect();
          const before = event.clientX < rect.left + rect.width / 2;
          const index = group.folderIds.indexOf(folderId) + (before ? 0 : 1);
          if (folderId !== dragged.id) {
            next = { type: "member-reorder", groupId, folderId, index };
            setMemberRail((current) => current?.index === group.folderIds.indexOf(folderId) && current.side === (before ? "left" : "right") ? current : { index: group.folderIds.indexOf(folderId), side: before ? "left" : "right" });
          }
        }
      } else if (entry) {
        const id = entry.dataset.galleryEntryId!;
        const kind = entry.dataset.galleryEntryKind as DragEntry["kind"];
        const index = entries.findIndex((item) => item.kind === kind && item.id === id);
        const rect = entry.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        const atEdge = event.clientX < rect.left + EDGE || event.clientX > rect.right - EDGE;
        if (index >= 0 && !(kind === dragged.kind && id === dragged.id)) {
          if (kind === "group" && dragged.kind === "folder" && !atEdge) {
            next = { type: "add-to-group", groupId: id };
          } else if (kind === "folder" && dragged.kind === "folder" && !atEdge) {
            next = { type: "create-group", folderId: id };
          } else {
            next = { type: "reorder", index: index + (before ? 0 : 1) };
            syncLibraryRail(rect, before);
          }
        }
      }

      if (next?.type !== "reorder") setLibraryRail(null);
      if (next?.type !== "member-reorder") setMemberRail(null);
      const holdKey = next?.type === "create-group" ? next.folderId : null;
      if (holdKey && hold.current?.key !== holdKey) hold.current = { key: holdKey, startedAt: performance.now() };
      if (!holdKey) hold.current = null;
      dropRef.current = next;
      setDrop(next);
    };
    const onEnd = () => {
      const next = dropRef.current;
      if (next?.type === "reorder") moveGalleryEntry(dragged, next.index);
      if (next?.type === "add-to-group" && dragged.kind === "folder") addGalleryToGroup(next.groupId, dragged.id);
      if (next?.type === "create-group" && dragged.kind === "folder" && hold.current && performance.now() - hold.current.startedAt >= HOLD_MS) {
        createGalleryGroup([dragged.id, next.folderId]);
      }
      if (next?.type === "member-reorder" && dragged.kind === "folder") moveGalleryInGroup(next.groupId, dragged.id, next.index);
      finishDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", onEnd);
    };
  }, [addGalleryToGroup, createGalleryGroup, dragged, entries, finishDrag, moveGalleryEntry, moveGalleryInGroup, state.galleryGroups]);

  const folderMenu = (folder: PersonalFolder) => {
    const group = state.galleryGroups.find((item) => item.folderIds.includes(folder.id));
    const menuSelection = selectedRef.current.includes(folder.id) ? selectedRef.current : selected;
    const selectedGroup = menuSelection.length > 1 && state.galleryGroups.find((item) => menuSelection.every((id) => item.folderIds.includes(id)));
    if (menuSelection.length > 1 && menuSelection.includes(folder.id)) {
      return <ContextMenuContent className="glass-float w-56 rounded-xl">
        <ContextMenuItem onSelect={() => { menuSelection.forEach(removeGalleryFromGroup); selectedRef.current = []; setSelected([]); }}>
          <Ungroup className="size-4" /> Remove {menuSelection.length} Galleries from group
        </ContextMenuItem>
        {!selectedGroup && <ContextMenuItem onSelect={() => { createGalleryGroup([...menuSelection]); selectedRef.current = []; setSelected([]); }}>
          <Layers className="size-4" /> Create group from {menuSelection.length} Galleries
        </ContextMenuItem>}
      </ContextMenuContent>;
    }
    return <ContextMenuContent className="glass-float w-56 rounded-xl">
      <ContextMenuItem onSelect={() => updateFolder(folder.id, { locked: !folder.locked })}>
        {folder.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}{folder.locked ? "Unlock" : "Lock"}
      </ContextMenuItem>
      {group && <ContextMenuItem onSelect={() => removeGalleryFromGroup(folder.id)}><Ungroup className="size-4" /> Remove from group</ContextMenuItem>}
    </ContextMenuContent>;
  };

  const galleryGroupMenu = (groupId: string) => {
    const group = state.galleryGroups.find((item) => item.id === groupId);
    if (!group) return null;
    return <ContextMenuContent className="glass-float w-56 rounded-xl">
      <ContextMenuItem onSelect={() => setOpenedGroupId(groupId)}><Layers className="size-4" /> Open group</ContextMenuItem>
      <ContextMenuItem onSelect={() => setRenamingGalleryGroup(group)}><Pencil className="size-4" /> Rename</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem className="text-destructive" onSelect={() => group.folderIds.forEach(removeGalleryFromGroup)}><Ungroup className="size-4" /> Delete group</ContextMenuItem>
    </ContextMenuContent>;
  };

  const Tile = ({ folder, mini = false }: { folder: PersonalFolder; mini?: boolean }) => {
    const cover = state.media.find((media) => media.id === (folder.coverId ?? folder.mediaIds[0]));
    const locked = folder.locked && !unlockedFolderIds.includes(folder.id);
    return <div className={cn("relative overflow-hidden bg-muted", mini ? "size-full rounded-md" : "aspect-square rounded-xl")}>
      {cover ? <img src={cover.url || cover.originalUrl || cover.contentUrl || ""} alt="" draggable={false} className={cn("size-full object-cover", locked && "scale-105 blur-md")} /> : <span className="grid size-full place-items-center text-muted-foreground"><Folder className={mini ? "size-4" : "size-8"} /></span>}
      {locked && <LockOverlay size={mini ? "sm" : "md"} />}
    </div>;
  };

  const FolderCard = ({ folder }: { folder: PersonalFolder }) => {
    const locked = folder.locked && !unlockedFolderIds.includes(folder.id);
    const creatingGroup = drop?.type === "create-group" && drop.folderId === folder.id;
    return <ContextMenu key={folder.id}><ContextMenuTrigger asChild>
      <button
        data-gallery-entry-id={folder.id}
        data-gallery-entry-kind="folder"
        onPointerDown={(event) => startPointer(event, { kind: "folder", id: folder.id })}
        onClick={(event) => { if (!consumeDragClick()) selectFolder(event, folder.id); }}
        onDoubleClick={() => onOpen({ kind: "folder", id: folder.id })}
        className={cn("relative group text-left", selected.includes(folder.id) && "rounded-xl ring-2 ring-primary", dragged?.kind === "folder" && dragged.id === folder.id && "opacity-45", creatingGroup && "rounded-xl ring-2 ring-primary/60")}
      >
        <Tile folder={folder} />
        {creatingGroup && <HoldRing progress={holdProgress} />}
        <div className="px-2.5 pt-3 pb-1"><p className="truncate text-sm font-medium">{folder.name}</p><p className="text-xs text-muted-foreground">{locked ? t("locked") : t("count", { count: folder.mediaIds.length })}</p></div>
      </button>
    </ContextMenuTrigger>{folderMenu(folder)}</ContextMenu>;
  };

  const GroupCard = ({ group }: { group: GalleryGroup }) => {
    const members = group.folderIds.map(folderById).filter((folder): folder is PersonalFolder => !!folder);
    return <ContextMenu key={group.id}><ContextMenuTrigger asChild>
      <button
        data-gallery-entry-id={group.id}
        data-gallery-entry-kind="group"
        onPointerDown={(event) => startPointer(event, { kind: "group", id: group.id })}
        onClick={() => { if (!consumeDragClick()) setOpenedGroupId(group.id); }}
        className={cn("relative group text-left", dragged?.kind === "group" && dragged.id === group.id && "opacity-45")}
      >
        <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-1 overflow-hidden rounded-xl border border-border/65 bg-secondary/30 p-1 transition-transform group-hover:-translate-y-0.5">
          {members.slice(0, 4).map((folder) => <Tile key={folder.id} folder={folder} mini />)}
          {Array.from({ length: Math.max(0, 4 - members.length) }).map((_, memberIndex) => <span key={memberIndex} className="rounded-md bg-muted/50" />)}
        </div>
        <div className="px-2.5 pt-3 pb-1"><p className="truncate text-sm font-medium">{group.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{members.length} Galleries</p></div>
      </button>
    </ContextMenuTrigger>{galleryGroupMenu(group.id)}</ContextMenu>;
  };

  return <div ref={boardRef} className="app-scroll relative flex-1 overflow-y-auto p-5">
    <div className="grid grid-cols-5 gap-x-4 gap-y-5">
      {entries.map((entry) => entry.kind === "folder"
        ? <FolderCard key={entry.id} folder={folderById(entry.id)!} />
        : <GroupCard key={entry.id} group={state.galleryGroups.find((group) => group.id === entry.id)!} />,
      )}
    </div>
    {libraryRail && <span aria-hidden className="pointer-events-none absolute z-30 block w-1 rounded-full border border-white/35 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_12px_hsl(var(--primary))]" style={{ left: libraryRail.x, top: libraryRail.y, height: libraryRail.height }} />}
    {dragged && dragPoint && (() => { const folder = dragged.kind === "folder" ? folderById(dragged.id) : folderById(state.galleryGroups.find((group) => group.id === dragged.id)?.folderIds[0] ?? ""); const cover = folder && state.media.find((media) => media.id === (folder.coverId ?? folder.mediaIds[0])); return <div aria-hidden className="pointer-events-none fixed z-[80] w-28 overflow-hidden rounded-xl border border-white/35 bg-background/35 opacity-60 shadow-2xl backdrop-blur-sm" style={{ left: dragPoint.x + 14, top: dragPoint.y + 14 }}><div className="aspect-square bg-muted">{cover ? <img src={cover.url || cover.originalUrl || ""} alt="" className="size-full object-cover" /> : <Folder className="m-auto mt-8 size-6 text-muted-foreground" />}</div><p className="truncate px-2 py-1 text-xs font-medium">{folder?.name ?? "Gallery group"}</p></div>; })()}
    {!state.folders.length && <p className="text-sm text-muted-foreground">{t("noMediaHint")}</p>}

    <Dialog open={!!openedGroup} onOpenChange={(open) => !open && setOpenedGroupId(null)}>
      <DialogContent className="max-w-3xl rounded-2xl" style={{ background: "rgb(24 34 35 / .26)", backdropFilter: "blur(26px) saturate(135%)", borderColor: "rgb(255 255 255 / .18)", boxShadow: "0 20px 58px rgb(0 0 0 / .22), inset 0 1px rgb(255 255 255 / .14)" }}>
        <DialogHeader><div className="flex items-center gap-2"><DialogTitle className="font-display">{openedGroup?.name}</DialogTitle>{openedGroup && <button onClick={() => setRenamingGalleryGroup(openedGroup)} title="Rename group" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="size-3.5" /></button>}</div></DialogHeader>
        <div className="grid grid-cols-4 gap-4">
          {openedGroup?.folderIds.map(folderById).filter((folder): folder is PersonalFolder => !!folder).map((folder, index) => <ContextMenu key={folder.id}><ContextMenuTrigger asChild>
            <button
              data-gallery-member-id={folder.id}
              data-gallery-member-group={openedGroup.id}
              onPointerDown={(event) => startPointer(event, { kind: "folder", id: folder.id })}
              onClick={(event) => { if (!consumeDragClick()) selectFolder(event, folder.id); }}
              onDoubleClick={() => { setOpenedGroupId(null); onOpen({ kind: "folder", id: folder.id }); }}
              className={cn("relative rounded-xl text-left", selected.includes(folder.id) && "ring-2 ring-primary", dragged?.kind === "folder" && dragged.id === folder.id && "opacity-45")}
            >
              {memberRail?.index === index && <span className={cn("pointer-events-none absolute inset-y-2 z-20 w-1 rounded-full border border-white/35 bg-primary shadow-[0_0_10px_hsl(var(--primary))]", memberRail.side === "left" ? "-left-2" : "-right-2")} />}<Tile folder={folder} /><p className="mt-1.5 truncate text-sm font-medium">{folder.name}</p>
            </button>
          </ContextMenuTrigger>{folderMenu(folder)}</ContextMenu>)}
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={!!renamingGalleryGroup} onOpenChange={(open) => !open && setRenamingGalleryGroup(null)}>
      <DialogContent className="glass-float rounded-2xl"><DialogHeader><DialogTitle className="font-display">Rename group</DialogTitle></DialogHeader><input autoFocus value={renamingGalleryGroup?.name ?? ""} onChange={(event) => setRenamingGalleryGroup((group) => group ? { ...group, name: event.target.value } : group)} className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" /><button onClick={() => { if (renamingGalleryGroup?.name.trim()) updateGalleryGroup(renamingGalleryGroup.id, { name: renamingGalleryGroup.name.trim() }); setRenamingGalleryGroup(null); }} className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary">Save</button></DialogContent>
    </Dialog>
  </div>;
}

function HoldRing({ progress }: { progress: number }) {
  return (
    <span className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl bg-background/20 backdrop-blur-[1px]">
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
    </span>
  );
}
