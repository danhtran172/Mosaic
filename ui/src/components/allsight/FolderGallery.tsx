import { useRef, useState } from "react";
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
  const [libraryRail, setLibraryRail] = useState<{ x: number; y: number; height: number } | null>(null);
  const [memberRail, setMemberRail] = useState<{ index: number; side: "left" | "right" } | null>(null);
  const [renamingGalleryGroup, setRenamingGalleryGroup] = useState<GalleryGroup | null>(null);
  const selectedRef = useRef<string[]>([]);
  const hold = useRef<{ targetId: string; timer: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragFrame = useRef(0);
  const pendingDragPoint = useRef<{ x: number; y: number } | null>(null);
  const railFrame = useRef(0);
  const pendingRail = useRef<{ x: number; y: number; height: number } | null>(null);
  const lastRail = useRef<{ x: number; y: number; height: number } | null>(null);
  const groupedIds = new Set(state.galleryGroups.flatMap((group) => group.folderIds));
  const openedGroup = state.galleryGroups.find((group) => group.id === openedGroupId) ?? null;

  const entries: DragEntry[] = state.galleryOrder.filter((entry) =>
    entry.kind === "group"
      ? state.galleryGroups.some((group) => group.id === entry.id)
      : state.folders.some((folder) => folder.id === entry.id) && !groupedIds.has(entry.id),
  );
  // Older snapshots (and an immediately dissolved group) can lack a card
  // order entry. Keep every valid card visible and repair persistence on the
  // next ordinary state write rather than ever hiding a Gallery.
  const orderedKeys = new Set(entries.map((entry) => `${entry.kind}:${entry.id}`));
  state.galleryGroups.forEach((group) => {
    if (!orderedKeys.has(`group:${group.id}`)) entries.push({ kind: "group", id: group.id });
  });
  state.folders.filter((folder) => !groupedIds.has(folder.id)).forEach((folder) => {
    if (!orderedKeys.has(`folder:${folder.id}`)) entries.push({ kind: "folder", id: folder.id });
  });

  const selectFolder = (event: React.MouseEvent, id: string) => {
    if (event.ctrlKey || event.metaKey) setSelected((ids) => {
      const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
      selectedRef.current = next;
      return next;
    });
    else { selectedRef.current = [id]; setSelected([id]); }
  };
  const clearHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const beginDrag = (event: React.DragEvent, entry: DragEntry) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-indeck-gallery", JSON.stringify(entry));
    setDragged(entry);
    setDragPoint({ x: event.clientX, y: event.clientY });
  };
  const trackDrag = (event: React.DragEvent) => {
    if (!event.clientX && !event.clientY) return;
    pendingDragPoint.current = { x: event.clientX, y: event.clientY };
    if (dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      if (pendingDragPoint.current) setDragPoint(pendingDragPoint.current);
    });
  };
  const finishDrag = () => {
    clearHold();
    if (dragFrame.current) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
    if (railFrame.current) cancelAnimationFrame(railFrame.current);
    railFrame.current = 0;
    pendingDragPoint.current = null;
    pendingRail.current = null;
    lastRail.current = null;
    setDragged(null);
    setDragPoint(null);
    setLibraryRail(null);
    setMemberRail(null);
  };
  const edge = (event: React.DragEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + 50 || event.clientX > rect.right - 50;
  };
  const targetInsertIndex = (event: React.DragEvent, index: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? index : index + 1;
  };
  const setLibraryDrop = (event: React.DragEvent, index: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    const root = boardRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const seamX = before ? rect.left - 8 : rect.right + 8;
    const next = {
      x: seamX - rootRect.left + root.scrollLeft - 2,
      y: rect.top - rootRect.top + root.scrollTop,
      height: rect.height,
    };
    const current = lastRail.current;
    if (current && Math.abs(current.x - next.x) < 1 && Math.abs(current.y - next.y) < 1 && Math.abs(current.height - next.height) < 1) return;
    pendingRail.current = next;
    if (railFrame.current) return;
    railFrame.current = requestAnimationFrame(() => {
      railFrame.current = 0;
      if (!pendingRail.current) return;
      lastRail.current = pendingRail.current;
      setLibraryRail(pendingRail.current);
    });
  };
  const setMemberDrop = (index: number, side: "left" | "right") => {
    setMemberRail((current) => current?.index === index && current.side === side ? current : { index, side });
  };
  const startGroupHold = (targetId: string, isEdge: boolean) => {
    if (isEdge || !dragged || dragged.kind !== "folder" || dragged.id === targetId || hold.current?.targetId === targetId) return;
    clearHold();
    hold.current = { targetId, timer: window.setTimeout(() => {
      if (dragged?.kind === "folder") createGalleryGroup([dragged.id, targetId]);
      hold.current = null;
      setDragged(null);
      setLibraryRail(null);
      lastRail.current = null;
    }, 1500) };
  };
  const leaveCard = (event: React.DragEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) clearHold();
  };
  const folderById = (id: string) => state.folders.find((folder) => folder.id === id);

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

  const FolderCard = ({ folder, index }: { folder: PersonalFolder; index: number }) => {
    const locked = folder.locked && !unlockedFolderIds.includes(folder.id);
    return <ContextMenu key={folder.id}><ContextMenuTrigger asChild>
      <button
        draggable
        onDragStart={(event) => beginDrag(event, { kind: "folder", id: folder.id })}
        onDragEnd={finishDrag}
        onDrag={trackDrag}
        onDragOver={(event) => {
          event.preventDefault();
          const isEdge = edge(event);
          startGroupHold(folder.id, isEdge);
          setLibraryDrop(event, index);
        }}
        onDragLeave={leaveCard}
        onDrop={(event) => {
          event.preventDefault();
          clearHold();
          if (dragged && !(dragged.kind === "folder" && dragged.id === folder.id)) moveGalleryEntry(dragged, targetInsertIndex(event, index));
          finishDrag();
        }}
        onClick={(event) => selectFolder(event, folder.id)}
        onDoubleClick={() => onOpen({ kind: "folder", id: folder.id })}
        className={cn("relative group text-left", selected.includes(folder.id) && "rounded-xl ring-2 ring-primary", dragged?.kind === "folder" && dragged.id === folder.id && "opacity-45")}
      >
        <Tile folder={folder} />
        <div className="px-2.5 pt-3 pb-1"><p className="truncate text-sm font-medium">{folder.name}</p><p className="text-xs text-muted-foreground">{locked ? t("locked") : t("count", { count: folder.mediaIds.length })}</p></div>
      </button>
    </ContextMenuTrigger>{folderMenu(folder)}</ContextMenu>;
  };

  const GroupCard = ({ group, index }: { group: GalleryGroup; index: number }) => {
    const members = group.folderIds.map(folderById).filter((folder): folder is PersonalFolder => !!folder);
    return <ContextMenu key={group.id}><ContextMenuTrigger asChild>
      <button
        draggable
        onDragStart={(event) => beginDrag(event, { kind: "group", id: group.id })}
        onDragEnd={finishDrag}
        onDrag={trackDrag}
        onDragOver={(event) => {
          event.preventDefault();
          if (dragged?.kind === "folder" && !edge(event)) {
            setLibraryRail(null);
            lastRail.current = null;
          } else setLibraryDrop(event, index);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (!dragged || (dragged.kind === "group" && dragged.id === group.id)) return finishDrag();
          if (dragged.kind === "folder" && !edge(event)) addGalleryToGroup(group.id, dragged.id);
          else moveGalleryEntry(dragged, targetInsertIndex(event, index));
          finishDrag();
        }}
        onClick={() => setOpenedGroupId(group.id)}
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

  return <div ref={boardRef} className="app-scroll relative flex-1 overflow-y-auto p-5" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
    if (event.target === event.currentTarget && dragged?.kind === "folder") removeGalleryFromGroup(dragged.id);
    finishDrag();
  }}>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-4 gap-y-5">
      {entries.map((entry, index) => entry.kind === "folder"
        ? <FolderCard key={entry.id} folder={folderById(entry.id)!} index={index} />
        : <GroupCard key={entry.id} group={state.galleryGroups.find((group) => group.id === entry.id)!} index={index} />,
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
              draggable
              onDragStart={(event) => beginDrag(event, { kind: "folder", id: folder.id })}
              onDragEnd={finishDrag}
              onDrag={trackDrag}
              onDragOver={(event) => {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMemberDrop(index, event.clientX < rect.left + rect.width / 2 ? "left" : "right");
              }}
              onDrop={(event) => { event.preventDefault(); if (dragged?.kind === "folder" && dragged.id !== folder.id && openedGroup) moveGalleryInGroup(openedGroup.id, dragged.id, event.clientX < event.currentTarget.getBoundingClientRect().left + event.currentTarget.getBoundingClientRect().width / 2 ? index : index + 1); finishDrag(); }}
              onClick={(event) => selectFolder(event, folder.id)}
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
