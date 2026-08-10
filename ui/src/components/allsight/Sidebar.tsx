import { useEffect, useRef, useState } from "react";
import {
  Layers,
  Ungroup,
  Lock,
  LockOpen,
  Plus,
  Shield,
  Tags,
  Languages,
  Folder,
  FolderCog,
  FolderInput,
  FolderPlus,
  HardDriveDownload,
  Pencil,
  Settings,
  Palette,
  Sun,
  Moon,
  Tag,
  Trash2,
  EyeOff,
  Eye,
  RefreshCw,
  RotateCcw,
  X,

  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import type { GalleryOrderEntry, MediaItem, PersonalFolder } from "@/lib/allsight/types";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { ProfileManager } from "./ProfileManager";
import { cn } from "@/lib/utils";
import type { ConfirmRequest } from "./ConfirmDialog";
import appIcon from "@/assets/app-icon.png";
import indeckIcon from "@/assets/indeck.png";
import { LockOverlay } from "./LockOverlay";

import { AutoTagEditor } from "./AutoTagEditor";

export type View = { kind: "all" } | { kind: "folders" } | { kind: "folder"; id: string };
type NewGalleryDraft = {
  name: string;
  // A name suggested from one folder must never silently name a Gallery that
  // contains multiple folders.
  nameMode: "auto" | "manual" | "required";
  sourcePaths: string[];
  notes: string;
  autoTags: Record<string, string[]>;
};

const itemBase =
  "group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
const menuItem = "gap-2";

async function passwordHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Trash cards can be the first place a media item is rendered, so request
 * its cached preview here instead of relying on a previously populated URL. */
function TrashMediaPreview({ media }: { media: MediaItem }) {
  const { setMediaPreview } = useAllsight();
  useEffect(() => {
    if (media.url) return;
    const bridge = getInDeckBridge();
    if (!bridge) return;
    let active = true;
    void bridge.ensureThumbnails([{
      id: media.id,
      path: media.path,
      type: media.type,
      modified: media.modified,
      vault: media.vault,
      contentUrl: media.contentUrl,
    }]).then((urls) => {
      if (active && urls[media.id]) setMediaPreview(media.id, urls[media.id]!);
    });
    return () => { active = false; };
  }, [media, setMediaPreview]);

  if (media.url) return <img src={media.url} alt="" className="size-full object-cover opacity-70 grayscale-[.15]" />;
  return <span className="grid size-full place-items-center bg-muted/55 text-xs text-muted-foreground">Đang tải preview…</span>;
}

export function Sidebar({
  view,
  unlockedFolderIds,
  onView,
  onConfirm,
  onLock,
  onRelockGallery,
  onManageTags,
  onOpenExtensionManage,
  onOpenTrash,
}: {
  view: View;
  unlockedFolderIds: string[];
  onView: (v: View) => void;
  onConfirm: (r: ConfirmRequest) => void;
  onLock: () => void;
  onRelockGallery: (id: string) => void;
  onManageTags: () => void;
  onOpenExtensionManage: () => void;
  onOpenTrash: () => void;
}) {
  const t = useT();
  const {
    state,
    createFolder,
    updateFolder,
    renameFolder,
    ensureFolderDefaultSource,
    deleteFolder,
    addToFolder,
    setLanguage,
    setPassword,
    setRequirePasswordToUnlockGallery,
    setAppearance,
    toggleExcludedFolder,
    syncMediaLocation,
    restoreMedia,
    restoreFromFolderTrash,
    purgeMedia,
    restoreFolder,
    purgeFolder,
    updateGalleryGroup,
    createGalleryGroup,
    addGalleryToGroup,
    moveGalleryEntry,
    moveGalleryInGroup,
    removeGalleryFromGroup,
    attachSourceFolder,
  } = useAllsight();
  const [collapsed, setCollapsed] = useState(false);
  const [newFolder, setNewFolder] = useState<NewGalleryDraft | null>(null);
  const [newFolderNameError, setNewFolderNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<PersonalFolder | null>(null);
  const [renamingGalleryGroup, setRenamingGalleryGroup] = useState<{ id: string; name: string } | null>(null);
  const [navSelectedFolders, setNavSelectedFolders] = useState<string[]>([]);
  const [navDrag, setNavDrag] = useState<GalleryOrderEntry | null>(null);
  const [navDragPoint, setNavDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [navRail, setNavRail] = useState<{ y: number; left: number; width: number } | null>(null);
  const navListRef = useRef<HTMLDivElement>(null);
  const navDragFrame = useRef(0);
  const pendingNavPoint = useRef<{ x: number; y: number } | null>(null);
  const lastNavRail = useRef<{ y: number; left: number; width: number } | null>(null);
  const [autoTagFolder, setAutoTagFolder] = useState<PersonalFolder | null>(null);
  const [importFromGallery, setImportFromGallery] = useState<PersonalFolder | null>(null);
  const [addSourcesToGallery, setAddSourcesToGallery] = useState<{ galleryId: string; sourceIds: string[] } | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [trashSelection, setTrashSelection] = useState<string[]>([]);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [syncResult, setSyncResult] = useState<number | null>(null);
  const [pwd, setPwd] = useState("");
  const [pwdCurrent, setPwdCurrent] = useState("");
  const [pwdConfirm, setPwdConfirm] = useState("");
  const [pwdError, setPwdError] = useState("");

  const toggleTrashSelection = (event: React.MouseEvent, key: string) => {
    if (event.ctrlKey || event.metaKey) {
      setTrashSelection((selected) => selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]);
      return;
    }
    setTrashSelection([key]);
  };


  const coverFor = (f: PersonalFolder) => {
    const id = f.coverId ?? f.mediaIds[0];
    const media = state.media.find((m) => m.id === id);
    return media?.url || media?.originalUrl || media?.contentUrl || null;
  };

  const folderMenu = (f: PersonalFolder) => {
    const selection = navSelectedFolders.includes(f.id) ? navSelectedFolders : [f.id];
    const containingGroup = state.galleryGroups.find((group) => group.folderIds.includes(f.id));
    const selectedGroup = selection.length >= 2
      ? state.galleryGroups.find((group) => selection.every((id) => group.folderIds.includes(id)))
      : undefined;
    if (selection.length >= 2) {
      return (
        <ContextMenuContent className="glass-float w-60 rounded-xl">
          {selectedGroup ? (
            <ContextMenuItem className={menuItem} onSelect={() => { selection.forEach(removeGalleryFromGroup); setNavSelectedFolders([]); }}>
              <Ungroup className="size-4" /> Loại {selection.length} Gallery khỏi group
            </ContextMenuItem>
          ) : (
            <ContextMenuItem className={menuItem} onSelect={() => { createGalleryGroup(selection); setNavSelectedFolders([]); }}>
              <Layers className="size-4" /> Tạo group từ {selection.length} Gallery
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      );
    }
    return (
    <ContextMenuContent className="glass-float w-60 rounded-xl">
      <ContextMenuItem className={menuItem} onSelect={() => setRenaming(f)}>
        <Pencil className="size-4" /> {t("rename")}
      </ContextMenuItem>
      <ContextMenuItem className={menuItem} onSelect={() => setAutoTagFolder(f)}>
        <Tag className="size-4" /> {t("autoTagsConfig")}
      </ContextMenuItem>
      <ContextMenuItem className={menuItem} onSelect={() => updateFolder(f.id, { locked: !f.locked })}>
        {f.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}
        {f.locked ? t("unlockFolder") : t("lockFolder")}
      </ContextMenuItem>
      {f.locked && unlockedFolderIds.includes(f.id) && (
        <ContextMenuItem className={menuItem} onSelect={() => onRelockGallery(f.id)}>
          <Lock className="size-4" /> Lock Now
        </ContextMenuItem>
      )}
      <ContextMenuItem
        className={menuItem}
        onSelect={() => setAddSourcesToGallery({ galleryId: f.id, sourceIds: [] })}
      >
        <HardDriveDownload className="size-4" /> {t("importLocal")}
      </ContextMenuItem>
      <ContextMenuItem className={menuItem} onSelect={() => setImportFromGallery(f)}>
        <FolderInput className="size-4" /> {t("importFolder")}
      </ContextMenuItem>
      {containingGroup && (
        <ContextMenuItem className={menuItem} onSelect={() => removeGalleryFromGroup(f.id)}>
          <Ungroup className="size-4" /> Loại khỏi group
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        className={cn(menuItem, "text-destructive")}
        onSelect={() =>
          onConfirm({
            title: `${t("deleteFolder")} — ${f.name}`,
            onConfirm: () => {
              void deleteFolder(f.id);
              if (view.kind === "folder" && view.id === f.id) onView({ kind: "all" });
            },
          })
        }
      >
        <Trash2 className="size-4" /> {t("deleteFolder")}
      </ContextMenuItem>
    </ContextMenuContent>
    );
  };

  const galleryGroupMenu = (groupId: string) => {
    const group = state.galleryGroups.find((item) => item.id === groupId);
    if (!group) return null;
    return (
      <ContextMenuContent className="glass-float w-56 rounded-xl">
        <ContextMenuItem className={menuItem} onSelect={() => setRenamingGalleryGroup({ id: group.id, name: group.name })}>
          <Pencil className="size-4" /> {t("rename")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className={cn(menuItem, "text-destructive")} onSelect={() => group.folderIds.forEach(removeGalleryFromGroup)}>
          <Trash2 className="size-4" /> Xóa group
        </ContextMenuItem>
      </ContextMenuContent>
    );
  };

  const beginNavDrag = (event: React.DragEvent, entry: GalleryOrderEntry) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-indeck-gallery-entry", JSON.stringify(entry));
    setNavDrag(entry);
    setNavDragPoint({ x: event.clientX, y: event.clientY });
  };
  const finishNavDrag = () => {
    if (navDragFrame.current) cancelAnimationFrame(navDragFrame.current);
    navDragFrame.current = 0;
    pendingNavPoint.current = null;
    lastNavRail.current = null;
    setNavDrag(null);
    setNavDragPoint(null);
    setNavRail(null);
  };
  const placeNavRail = (event: React.DragEvent, before: boolean) => {
    const root = navListRef.current;
    if (!root) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const next = {
      y: (before ? rect.top : rect.bottom) - rootRect.top + root.scrollTop - 2,
      left: 4,
      width: Math.max(0, root.clientWidth - 8),
    };
    const previous = lastNavRail.current;
    if (previous && Math.abs(previous.y - next.y) < 1 && previous.width === next.width) return;
    lastNavRail.current = next;
    setNavRail(next);
  };
  const trackNavDrag = (event: React.DragEvent) => {
    if (!event.clientX && !event.clientY) return;
    pendingNavPoint.current = { x: event.clientX, y: event.clientY };
    if (navDragFrame.current) return;
    navDragFrame.current = requestAnimationFrame(() => {
      navDragFrame.current = 0;
      if (pendingNavPoint.current) setNavDragPoint(pendingNavPoint.current);
    });
  };
  const moveToTopLevel = (entry: GalleryOrderEntry, index: number) => {
    if (entry.kind === "folder" && state.galleryGroups.some((group) => group.folderIds.includes(entry.id))) removeGalleryFromGroup(entry.id);
    moveGalleryEntry(entry, index);
  };

  const galleryRow = (f: PersonalFolder, nested = false, groupId?: string, entryIndex = 0, memberIndex = 0) => (
    <ContextMenu key={f.id}>
      <ContextMenuTrigger asChild>
        <button
          draggable
          onDragStart={(event) => beginNavDrag(event, { kind: "folder", id: f.id })}
          onDrag={trackNavDrag}
          onDragEnd={finishNavDrag}
          onDragOver={(event) => {
            if (!navDrag) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            placeNavRail(event, before);
          }}
          onDrop={(event) => {
            if (!navDrag) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (groupId && navDrag.kind === "folder") addGalleryToGroup(groupId, navDrag.id, before ? memberIndex : memberIndex + 1);
            else moveToTopLevel(navDrag, before ? entryIndex : entryIndex + 1);
            finishNavDrag();
          }}
          onClick={(event) => {
            if (event.ctrlKey || event.metaKey) {
              setNavSelectedFolders((ids) => ids.includes(f.id) ? ids.filter((id) => id !== f.id) : [...ids, f.id]);
              return;
            }
            setNavSelectedFolders([f.id]);
            onView({ kind: "folder", id: f.id });
          }}
          onContextMenu={() => { if (!navSelectedFolders.includes(f.id)) setNavSelectedFolders([f.id]); }}
          title={f.name}
          className={cn(
            itemBase,
            nested && !collapsed && "ml-3 w-[calc(100%-0.75rem)]",
            collapsed && "justify-center px-0",
            view.kind === "folder" && view.id === f.id ? "bg-primary/15 text-foreground" : navSelectedFolders.includes(f.id) ? "bg-primary/10 text-foreground" : "hover:bg-accent/60",
          )}
        >
          {coverFor(f) ? (
            <span className="relative size-5 shrink-0 overflow-hidden rounded-[5px]">
              <img src={coverFor(f)!} alt="" className={cn("size-full object-cover", f.locked && !unlockedFolderIds.includes(f.id) && "scale-105 opacity-70 blur-[1px]")} />
              {f.locked && !unlockedFolderIds.includes(f.id) && <LockOverlay size="sm" />}
            </span>
          ) : <span className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-muted"><Folder className="size-3 text-muted-foreground" /></span>}
          {!collapsed && <>
            <span className="flex-1 truncate text-left">{f.name}</span>
            {f.locked && !unlockedFolderIds.includes(f.id) ? <Lock className="size-3 text-muted-foreground" /> : <span className="text-xs text-muted-foreground tabular-nums">{f.mediaIds.length}</span>}
          </>}
        </button>
      </ContextMenuTrigger>
      {folderMenu(f)}
    </ContextMenu>
  );

  const groupedGalleryIds = new Set(state.galleryGroups.flatMap((group) => group.folderIds));
  const navEntries: GalleryOrderEntry[] = state.galleryOrder.filter((entry) =>
    entry.kind === "group"
      ? state.galleryGroups.some((group) => group.id === entry.id)
      : state.folders.some((folder) => folder.id === entry.id) && !groupedGalleryIds.has(entry.id),
  );
  const knownNavEntries = new Set(navEntries.map((entry) => `${entry.kind}:${entry.id}`));
  state.galleryGroups.forEach((group) => { if (!knownNavEntries.has(`group:${group.id}`)) navEntries.push({ kind: "group", id: group.id }); });
  state.folders.filter((folder) => !groupedGalleryIds.has(folder.id)).forEach((folder) => { if (!knownNavEntries.has(`folder:${folder.id}`)) navEntries.push({ kind: "folder", id: folder.id }); });
  const galleryGroupRow = (group: typeof state.galleryGroups[number], entryIndex: number) => {
    const members = group.folderIds.map((id) => state.folders.find((folder) => folder.id === id)).filter((folder): folder is PersonalFolder => !!folder);
    return (
      <ContextMenu key={group.id}>
        <ContextMenuTrigger asChild>
          <section
            onDragOver={(event) => { if (navDrag) event.preventDefault(); }}
            onDrop={(event) => {
              if (!navDrag) return;
              event.preventDefault();
              if (navDrag.kind === "folder") addGalleryToGroup(group.id, navDrag.id);
              else moveToTopLevel(navDrag, entryIndex);
              finishNavDrag();
            }}
            className={cn("rounded-lg bg-secondary/20 py-1", collapsed && "bg-transparent", navDrag?.kind === "group" && navDrag.id === group.id && "opacity-45")}
          >
            <button
              draggable
              onDragStart={(event) => beginNavDrag(event, { kind: "group", id: group.id })}
              onDrag={trackNavDrag}
              onDragEnd={finishNavDrag}
              onDragOver={(event) => {
                if (!navDrag) return;
                event.preventDefault();
                if (navDrag.kind === "folder") { setNavRail(null); return; }
                const rect = event.currentTarget.getBoundingClientRect();
                placeNavRail(event, event.clientY < rect.top + rect.height / 2);
              }}
              onDrop={(event) => {
                if (!navDrag) return;
                event.preventDefault();
                event.stopPropagation();
                if (navDrag.kind === "folder") addGalleryToGroup(group.id, navDrag.id);
                else {
                  const rect = event.currentTarget.getBoundingClientRect();
                  moveToTopLevel(navDrag, event.clientY < rect.top + rect.height / 2 ? entryIndex : entryIndex + 1);
                }
                finishNavDrag();
              }}
              onClick={() => updateGalleryGroup(group.id, { collapsed: !group.collapsed })}
              className={cn(itemBase, "py-1 text-xs font-medium text-muted-foreground", collapsed && "justify-center px-0")}
              title={group.name}
            >
              {!collapsed && <><span className="flex-1 truncate text-left">{group.name}</span><span className="text-[10px]">{members.length}</span></>}
            </button>
            {!group.collapsed && members.map((folder, memberIndex) => galleryRow(folder, true, group.id, entryIndex, memberIndex))}
          </section>
        </ContextMenuTrigger>
        {galleryGroupMenu(group.id)}
      </ContextMenu>
    );
  };

  return (
    <aside
      className={cn(
        "glass-panel flex h-full min-h-0 shrink-0 flex-col rounded-none border-y-0 border-l-0 bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-64",
      )}
    >
      <div className={cn("flex items-center gap-2 pt-5 pb-3", collapsed ? "flex-col px-2" : "px-4")}>
        <button
          onClick={() => onView({ kind: "all" })}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
        >
          <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-lg bg-primary/85 text-primary-foreground">
            <img src={appIcon} alt="Mosaic" className="size-full object-cover" />
          </span>
          {!collapsed && (
            <span className="truncate font-display text-lg font-semibold tracking-tight">{t("brand")}</span>
          )}
        </button>
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <div ref={navListRef} className={cn("app-scroll relative min-h-0 flex-1 overflow-y-auto", collapsed ? "px-2" : "px-3")}>
        {!collapsed && (
          <div className="mt-2 mb-1 flex items-center justify-between px-1.5">
            <button
              onClick={() => onView({ kind: "folders" })}
              className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              {t("library")}
            </button>
            <button
              aria-label={t("newFolder")}
              onClick={() => { setNewFolderNameError(null); setNewFolder({ name: "", nameMode: "required", sourcePaths: [], notes: "", autoTags: {} }); }}
              className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        )}

        <button
          onClick={() => onView({ kind: "all" })}
          title={t("allMedia")}
          className={cn(
            itemBase,
            collapsed && "justify-center px-0",
            view.kind === "all" ? "bg-primary/15 text-foreground" : "hover:bg-accent/60",
          )}
        >
          <img src={indeckIcon} alt="" className="size-4 shrink-0 rounded-[3px] object-cover" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">{t("allMedia")}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {state.media.filter((m) => !m.hidden).length}
              </span>
            </>
          )}
        </button>

        {collapsed && (
          <button
            onClick={() => { setNewFolderNameError(null); setNewFolder({ name: "", nameMode: "required", sourcePaths: [], notes: "", autoTags: {} }); }}
            aria-label={t("newFolder")}
            title={t("newFolder")}
            className={cn(itemBase, "justify-center px-0 hover:bg-accent/60")}
          >
            <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}

        {navEntries.map((entry, index) => entry.kind === "group"
          ? galleryGroupRow(state.galleryGroups.find((group) => group.id === entry.id)!, index)
          : galleryRow(state.folders.find((folder) => folder.id === entry.id)!, false, undefined, index),
        )}
        {navRail && <span aria-hidden className="pointer-events-none absolute z-40 h-1 rounded-full border border-white/35 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_12px_hsl(var(--primary))]" style={{ top: navRail.y, left: navRail.left, width: navRail.width }} />}

      </div>

      {navDrag && navDragPoint && (() => {
        const folder = navDrag.kind === "folder"
          ? state.folders.find((item) => item.id === navDrag.id)
          : state.folders.find((item) => item.id === state.galleryGroups.find((group) => group.id === navDrag.id)?.folderIds[0]);
        const cover = folder && coverFor(folder);
        return <div aria-hidden className="pointer-events-none fixed z-[90] flex w-44 items-center gap-2 rounded-xl border border-white/30 bg-background/55 px-2 py-1.5 opacity-65 shadow-2xl backdrop-blur-md" style={{ left: navDragPoint.x + 14, top: navDragPoint.y + 14 }}><span className="size-8 shrink-0 overflow-hidden rounded-lg bg-muted">{cover ? <img src={cover} alt="" className="size-full object-cover" /> : <Folder className="m-2 size-4 text-muted-foreground" />}</span><span className="truncate text-xs font-medium">{folder?.name ?? "Gallery group"}</span></div>;
      })()}

      {/* Bottom: tags + settings */}
      <div className={cn("shrink-0 space-y-1 border-t border-border/60 p-3", collapsed && "px-2")}>
        <button
          onClick={() => setSettingsOpen(true)}
          title={t("settings")}
          className={cn(itemBase, collapsed && "justify-center px-0", "hover:bg-accent/60")}
        >
          <Settings className="size-4 shrink-0 text-muted-foreground" />
          {!collapsed && t("settings")}
        </button>
        <button
          type="button"
          onClick={onManageTags}
          title={t("manageTags")}
          className={cn(itemBase, collapsed && "justify-center px-0", "hover:bg-accent/60")}
        >
          <Tags className="size-4 shrink-0 text-muted-foreground" />
          {!collapsed && t("manageTags")}
        </button>
        <button
          type="button"
          onClick={onOpenExtensionManage}
          title={t("extensionManager")}
          className={cn(itemBase, collapsed && "justify-center px-0", "hover:bg-accent/60")}
        >
          <HardDriveDownload className="size-4 shrink-0 text-muted-foreground" />
          {!collapsed && t("extensionManager")}
        </button>
        <button
          type="button"
          onClick={onOpenTrash}
          title={t("discardPile")}
          className={cn(itemBase, collapsed && "justify-center px-0", "hover:bg-accent/60")}
        >
          <Trash2 className="size-4 shrink-0 text-muted-foreground" />
          {!collapsed && t("discardPile")}
        </button>
      </div>

      {/* Settings dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{t("settings")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Languages className="size-4 text-muted-foreground" />
              <span className="flex-1">{t("language")}</span>
              <div className="flex overflow-hidden rounded-md border border-border/70">
                {(["en", "vi"] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLanguage(l)}
                    className={cn(
                      "px-2.5 py-1 text-[11px] font-medium uppercase transition-colors",
                      state.language === l ? "bg-primary/85 text-primary-foreground" : "hover:bg-accent",
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <Palette className="size-4 text-muted-foreground" />
              <span className="flex-1">{t("appearance")}</span>
              <div className="flex overflow-hidden rounded-md border border-border/70">
                {([
                  { key: "light", icon: Sun },
                  { key: "dark", icon: Moon },
                ] as const).map(({ key, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setAppearance(key)}
                    aria-label={t(key)}
                    className={cn(
                      "grid size-7 place-items-center transition-colors",
                      state.appearance === key
                        ? "bg-primary/85 text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <Icon className="size-3.5" />
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => {
                setSettingsOpen(false);
                setProfilesOpen(true);
              }}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              <FolderCog className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">Quản lý Profile</span>
              <span className="text-xs text-muted-foreground">Library & shortcut</span>
            </button>
            <button
              onClick={() => {
                setSettingsOpen(false);
                setSecurityOpen(true);
              }}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              <Shield className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{t("password")}</span>
              <span className="text-xs text-muted-foreground">{state.password ? t("changePassword") : t("setPassword")}</span>
            </button>
            <div className={cn("flex w-full items-center gap-3 rounded-lg border border-border/70 bg-secondary/40 px-3 py-2", state.password ? "hover:bg-accent/60" : "opacity-50")}>
              <Lock className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-sm">Yêu cầu mật khẩu để mở Gallery</span>
                <span className="block text-xs text-muted-foreground">Khi tắt, vẫn phải bấm Unlock nhưng không cần nhập mật khẩu.</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={state.requirePasswordToUnlockGallery}
                aria-label="Yêu cầu mật khẩu để mở Gallery"
                disabled={!state.password}
                onClick={() => {
                  if (state.requirePasswordToUnlockGallery) setRequirePasswordToUnlockGallery(false);
                  else setRequirePasswordToUnlockGallery(true);
                }}
                className={cn(
                  "relative h-6 w-11 min-w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                  state.requirePasswordToUnlockGallery ? "bg-primary" : "bg-muted-foreground/35",
                )}
              >
                <span className={cn("absolute top-0.5 left-0 size-5 rounded-full bg-white shadow-sm transition-transform", state.requirePasswordToUnlockGallery ? "translate-x-5" : "translate-x-0.5")} />
              </button>
            </div>
            <button
              onClick={() => {
                setSettingsOpen(false);
                onLock();
              }}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              <Lock className="size-4 text-muted-foreground" />
              {t("lockApp")}
            </button>
            <button
              onClick={() => setSyncResult(syncMediaLocation())}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              <RefreshCw className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{t("syncMediaLocation")}</span>
              {syncResult !== null && (
                <span className="text-xs text-muted-foreground">{t("syncDone", { count: syncResult })}</span>
              )}
            </button>
            <p className="text-xs text-muted-foreground">{t("syncMediaHint")}</p>

          </div>
        </DialogContent>
      </Dialog>

      <ProfileManager open={profilesOpen} onOpenChange={setProfilesOpen} />

      {/* Discard pile */}
      <Dialog open={discardOpen} onOpenChange={(open) => { setDiscardOpen(open); if (!open) setTrashSelection([]); }}>
        <DialogContent className="glass-float max-h-[82vh] max-w-4xl overflow-hidden rounded-2xl p-0 sm:max-w-4xl">
          {(() => {
            const trashedMedia = state.media.filter((m) => m.hidden);
            const galleryTrash = state.folders.flatMap((gallery) =>
              (gallery.discardedMediaIds ?? []).map((mediaId) => ({
                gallery,
                media: state.media.find((media) => media.id === mediaId),
              })).filter((entry): entry is { gallery: PersonalFolder; media: typeof state.media[number] } => !!entry.media),
            );
            const total = trashedMedia.length + galleryTrash.length + state.trashFolders.length;
            const selected = new Set(trashSelection);
            const restoreSelected = () => {
              trashSelection.forEach((key) => {
                if (key.startsWith("folder:")) restoreFolder(key.slice("folder:".length));
                else if (key.startsWith("media:")) restoreMedia(key.slice("media:".length));
                else if (key.startsWith("gallery-media:")) {
                  const [galleryId, mediaId] = key.slice("gallery-media:".length).split(":");
                  if (galleryId && mediaId) restoreFromFolderTrash(galleryId, mediaId);
                }
              });
              setTrashSelection([]);
            };
            const purgeSelected = () => {
              trashSelection.forEach((key) => {
                if (key.startsWith("folder:")) purgeFolder(key.slice("folder:".length));
                else if (key.startsWith("media:")) purgeMedia(key.slice("media:".length));
                else if (key.startsWith("gallery-media:")) {
                  const [, mediaId] = key.slice("gallery-media:".length).split(":");
                  if (mediaId) purgeMedia(mediaId);
                }
              });
              setTrashSelection([]);
            };
            return (
              <div className="flex max-h-[82vh] flex-col">
                <DialogHeader className="border-b border-border/60 bg-secondary/25 px-6 py-5 text-left">
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-xl border border-border/70 bg-background/35 text-muted-foreground shadow-sm">
                      <Trash2 className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <DialogTitle className="font-display text-lg">{t("discardPile")}</DialogTitle>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {total ? `${total} mục có thể khôi phục` : t("discardEmpty")}
                      </p>
                    </div>
                    {trashSelection.length > 0 && (
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        <span className="hidden text-xs text-muted-foreground sm:inline">{trashSelection.length} đã chọn</span>
                        <button onClick={restoreSelected} className="glass-btn flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"><RotateCcw className="size-3.5" /> {t("restore")}</button>
                        <button onClick={purgeSelected} className="flex h-8 items-center gap-1.5 rounded-lg border border-destructive/30 px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"><Trash2 className="size-3.5" /> {t("deleteForever")}</button>
                      </div>
                    )}
                  </div>
                </DialogHeader>
                {!total ? (
                  <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 text-center">
                    <span className="grid size-12 place-items-center rounded-2xl bg-secondary/50 text-muted-foreground">
                      <Trash2 className="size-5" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">{t("discardEmpty")}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Ảnh ẩn khỏi Gallery và Gallery đã xóa sẽ xuất hiện ở đây.</p>
                    </div>
                  </div>
                ) : (
                <div className="app-scroll space-y-7 overflow-y-auto px-6 py-5">
                {state.trashFolders.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                      {t("discardedGalleries")}
                    </h3>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
                      {state.trashFolders.map((f) => (
                        <div
                          key={f.id}
                          onClick={(event) => toggleTrashSelection(event, `folder:${f.id}`)}
                          className={cn("group cursor-pointer overflow-hidden rounded-xl border border-border/65 bg-secondary/20 transition-colors", selected.has(`folder:${f.id}`) && "border-primary bg-primary/10 ring-1 ring-primary")}
                        >
                          <div className="flex aspect-[16/7] items-center justify-center bg-muted/55">
                            <Folder className="size-8 text-muted-foreground/70" />
                          </div>
                          <div className="space-y-3 p-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{f.name}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">Gallery đã xóa</p>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={(event) => { event.stopPropagation(); restoreFolder(f.id); }} className="glass-btn flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-medium">
                                <RotateCcw className="size-3.5" /> {t("restore")}
                              </button>
                              <button onClick={(event) => { event.stopPropagation(); purgeFolder(f.id); }} title={t("deleteForever")} className="grid size-8 place-items-center rounded-lg border border-destructive/25 text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground">
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {trashedMedia.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                      {t("discardedMedia")}
                    </h3>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                      {trashedMedia.map((m) => (
                        <div
                          key={m.id}
                          onClick={(event) => toggleTrashSelection(event, `media:${m.id}`)}
                          className={cn("group cursor-pointer overflow-hidden rounded-xl border border-border/65 bg-secondary/20 transition-colors", selected.has(`media:${m.id}`) && "border-primary bg-primary/10 ring-1 ring-primary")}
                        >
                          <div className="aspect-[4/3] bg-muted/55"><TrashMediaPreview media={m} /></div>
                          <div className="space-y-2 p-3">
                            <p className="truncate text-sm font-medium">{m.name}</p>
                            <div className="flex gap-2">
                              <button onClick={(event) => { event.stopPropagation(); restoreMedia(m.id); }} className="glass-btn flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-medium"><RotateCcw className="size-3.5" /> {t("restore")}</button>
                              <button onClick={(event) => { event.stopPropagation(); purgeMedia(m.id); }} title={t("deleteForever")} className="grid size-8 place-items-center rounded-lg border border-destructive/25 text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"><Trash2 className="size-3.5" /></button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {galleryTrash.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Ảnh ẩn khỏi Gallery</h3>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                      {galleryTrash.map(({ gallery, media }) => (
                        <div
                          key={`${gallery.id}:${media.id}`}
                          onClick={(event) => toggleTrashSelection(event, `gallery-media:${gallery.id}:${media.id}`)}
                          className={cn("group cursor-pointer overflow-hidden rounded-xl border border-border/65 bg-secondary/20 transition-colors", selected.has(`gallery-media:${gallery.id}:${media.id}`) && "border-primary bg-primary/10 ring-1 ring-primary")}
                        >
                          <div className="relative aspect-[4/3] bg-muted/55">
                            <TrashMediaPreview media={media} />
                            <span className="absolute left-2 top-2 rounded-md border border-white/15 bg-black/35 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-md">{gallery.name}</span>
                          </div>
                          <div className="space-y-2 p-3">
                            <p className="truncate text-sm font-medium">{media.name}</p>
                            <div className="flex gap-2">
                              <button onClick={(event) => { event.stopPropagation(); restoreFromFolderTrash(gallery.id, media.id); }} className="glass-btn flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-medium"><RotateCcw className="size-3.5" /> {t("restore")}</button>
                              <button onClick={(event) => { event.stopPropagation(); purgeMedia(media.id); }} title="Bỏ ảnh khỏi Mosaic (không xóa file nguồn)" className="grid size-8 place-items-center rounded-lg border border-destructive/25 text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"><Trash2 className="size-3.5" /></button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                </div>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Excluded collections */}
      <Dialog open={excludeOpen} onOpenChange={setExcludeOpen}>
        <DialogContent className="glass-float max-h-[80vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{t("excludeLibrary")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t("excludeHint")}</p>
          <div className="space-y-1.5">
            {state.folders
              .filter((f) => state.excludedFolderIds.includes(f.id))
              .map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5">
                  <EyeOff className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-sm">{f.name}</span>
                  <button
                    onClick={() => toggleExcludedFolder(f.id)}
                    title={t("deleteForever")}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
          </div>
          {(() => {
            const available = state.folders.filter((f) => !state.excludedFolderIds.includes(f.id));
            return (
              <div className="space-y-1.5">
                <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  {t("addExcluded")}
                </h3>
                {available.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("allExcluded")}</p>
                ) : (
                  available.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => toggleExcludedFolder(f.id)}
                      className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
                    >
                      <Eye className="size-4 text-muted-foreground" />
                      <span className="flex-1 truncate text-left">{f.name}</span>
                      <Plus className="size-3.5 text-muted-foreground" />
                    </button>
                  ))
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>



      {/* New folder dialog */}
      <Dialog open={!!newFolder} onOpenChange={(o) => { if (!o) { setNewFolder(null); setNewFolderNameError(null); } }}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">Gallery mới</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <input
              autoFocus
              value={newFolder?.name ?? ""}
              onChange={(e) => { setNewFolderNameError(null); setNewFolder((s) => s ? { ...s, name: e.target.value, nameMode: "manual" } : s); }}
              placeholder={(newFolder?.sourcePaths.length ?? 0) > 1 ? "Nhập tên Gallery (bắt buộc)" : "Tên Gallery"}
              aria-invalid={Boolean(newFolderNameError)}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {newFolderNameError && <p role="alert" className="-mt-2 text-xs text-destructive">{newFolderNameError}</p>}
            <section className="space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Media Sources</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Chọn folder trên máy để làm nguồn media cho Gallery này.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void (async () => {
                    const path = await getInDeckBridge()?.pickFolder();
                    if (!path) return;
                    const normalized = path.replace(/[\\/]+$/, "").toLowerCase();
                    setNewFolderNameError(null);
                    setNewFolder((draft) => {
                      if (!draft || draft.sourcePaths.some((item) => item.replace(/[\\/]+$/, "").toLowerCase() === normalized)) return draft;
                      const sourcePaths = [...draft.sourcePaths, path];
                      const folderName = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Untitled Gallery";
                      if (sourcePaths.length === 1 && draft.nameMode !== "manual") return { ...draft, sourcePaths, name: folderName, nameMode: "auto" };
                      if (sourcePaths.length > 1 && draft.nameMode === "auto") return { ...draft, sourcePaths, name: "", nameMode: "required" };
                      return { ...draft, sourcePaths };
                    });
                  })()}
                  className="glass-btn inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                >
                  <FolderPlus className="size-3.5" /> Thêm folder
                </button>
              </div>
              <div className="max-h-52 overflow-y-auto rounded-xl border border-border/65 bg-background/25">
                {(newFolder?.sourcePaths ?? []).map((path) => {
                  const source = state.sources.find((item) => item.path.replace(/[\\/]+$/, "").toLowerCase() === path.replace(/[\\/]+$/, "").toLowerCase());
                  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Untitled source";
                  const count = source ? state.media.filter((media) => media.sourceId === source.id).length : null;
                  return <div key={path} className="flex min-w-0 items-center gap-2.5 border-b border-border/55 px-2.5 py-2.5 last:border-b-0">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/70 text-muted-foreground"><HardDriveDownload className="size-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{source?.name ?? name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground" title={path}>{path}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{count == null ? "Sẽ scan khi tạo Gallery" : `${count} media`}</span>
                    </span>
                    <button type="button" aria-label={`Bỏ ${name}`} title="Bỏ folder" onClick={() => {
                      setNewFolderNameError(null);
                      setNewFolder((draft) => {
                        if (!draft) return draft;
                        const sourcePaths = draft.sourcePaths.filter((item) => item !== path);
                        if (sourcePaths.length === 1 && draft.nameMode !== "manual") {
                          const folderName = sourcePaths[0]!.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Untitled Gallery";
                          return { ...draft, sourcePaths, name: folderName, nameMode: "auto" };
                        }
                        if (sourcePaths.length === 0 && draft.nameMode === "auto") return { ...draft, sourcePaths, name: "", nameMode: "required" };
                        return { ...draft, sourcePaths };
                      });
                    }} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"><X className="size-3.5" /></button>
                  </div>;
                })}
                {(newFolder?.sourcePaths.length ?? 0) === 0 && <p className="px-3 py-4 text-center text-xs text-muted-foreground">Chưa có Media Source. Thêm một hoặc nhiều folder.</p>}
              </div>
              {(newFolder?.sourcePaths.length ?? 0) > 1 && !newFolder?.name.trim() && <p className="text-xs text-amber-500">Đã chọn nhiều folder. Hãy nhập tên Gallery trước khi tạo.</p>}
            </section>
            <textarea
              value={newFolder?.notes ?? ""}
              onChange={(e) => setNewFolder((draft) => draft ? { ...draft, notes: e.target.value } : draft)}
              placeholder={t("descriptionPlaceholder")}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <section className="space-y-2">
              <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Auto Tag</p>
              {state.propertyGroups.map((group) => {
                const values = newFolder?.autoTags[group.id] ?? [];
                return <div key={group.id} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{group.name}</span>
                  <select value="" onChange={(e) => { const value = e.target.value; if (!value) return; setNewFolder((draft) => draft ? { ...draft, autoTags: { ...draft.autoTags, [group.id]: [...new Set([...(draft.autoTags[group.id] ?? []), value])] } } : draft); }} className="min-w-0 flex-1 rounded-md border border-border bg-background/60 px-2 py-1 text-xs">
                    <option value="">Thêm tag…</option>
                    {group.values.filter((value) => !values.includes(value)).map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  {values.length > 0 && <span className="max-w-24 truncate text-xs text-primary" title={values.join(", ")}>{values.join(", ")}</span>}
                </div>;
              })}
            </section>
          </div>
          <DialogFooter>
            <button
              onClick={() => {
                const name = newFolder?.name?.trim();
                const sourcePaths = newFolder?.sourcePaths ?? [];
                if (!name) {
                  setNewFolderNameError(sourcePaths.length > 1 ? "Đã chọn nhiều folder, hãy nhập tên Gallery trước khi tạo." : "Hãy nhập tên Gallery trước khi tạo.");
                  return;
                }
                const id = createFolder(name, {
                  sourceIds: [],
                  notes: newFolder?.notes ?? "",
                  autoTags: newFolder?.autoTags ?? {},
                });
                setNewFolder(null);
                setNewFolderNameError(null);
                onView({ kind: "folder", id });
                // Every Gallery owns an InDeck-managed Default Source. Extra
                // Media Sources are scanned independently and never replaced.
                void ensureFolderDefaultSource(id, name);
                void Promise.all(sourcePaths.map((path) => attachSourceFolder(id, path)));
              }}
              className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary"
            >
              Tạo Gallery
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{t("rename")}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={renaming?.name ?? ""}
            onChange={(e) => setRenaming((f) => (f ? { ...f, name: e.target.value } : f))}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <DialogFooter>
            <button
              onClick={() => {
                if (renaming) void renameFolder(renaming.id, renaming.name);
                setRenaming(null);
              }}
              className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary"
            >
              {t("save")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renamingGalleryGroup} onOpenChange={(o) => !o && setRenamingGalleryGroup(null)}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">{t("rename")}</DialogTitle></DialogHeader>
          <input autoFocus value={renamingGalleryGroup?.name ?? ""} onChange={(e) => setRenamingGalleryGroup((group) => group ? { ...group, name: e.target.value } : group)} className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <DialogFooter><button onClick={() => { if (renamingGalleryGroup?.name.trim()) updateGalleryGroup(renamingGalleryGroup.id, { name: renamingGalleryGroup.name.trim() }); setRenamingGalleryGroup(null); }} className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary">{t("save")}</button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Auto tags dialog */}
      <Dialog open={!!autoTagFolder} onOpenChange={(o) => !o && setAutoTagFolder(null)}>
        <DialogContent className="glass-float max-h-[80vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{t("autoTagsConfig")}</DialogTitle>
          </DialogHeader>
          {autoTagFolder && <AutoTagEditor folderId={autoTagFolder.id} />}
        </DialogContent>
      </Dialog>

      {/* Import from another Gallery */}
      <Dialog open={!!importFromGallery} onOpenChange={(open) => !open && setImportFromGallery(null)}>
        <DialogContent className="glass-float max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{t("importFolder")}</DialogTitle>
          </DialogHeader>
          {importFromGallery && (
            <>
              <p className="text-sm text-muted-foreground">
                Chọn Gallery nguồn để thêm media vào <span className="font-medium text-foreground">{importFromGallery.name}</span>.
              </p>
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {state.folders.filter((folder) => folder.id !== importFromGallery.id).map((source) => (
                  <button
                    key={source.id}
                    onClick={() => {
                      addToFolder(importFromGallery.id, source.mediaIds);
                      setImportFromGallery(null);
                    }}
                    className="glass-btn flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left"
                  >
                    <span className="grid size-8 place-items-center rounded-lg bg-secondary/70 text-muted-foreground"><Folder className="size-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{source.name}</span>
                      <span className="block text-xs text-muted-foreground">{source.mediaIds.length} media</span>
                    </span>
                    <Plus className="size-4 text-muted-foreground" />
                  </button>
                ))}
                {state.folders.length <= 1 && <p className="py-8 text-center text-sm text-muted-foreground">Chưa có Gallery khác để nhập.</p>}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Attach existing Media Sources to a Gallery */}
      <Dialog open={!!addSourcesToGallery} onOpenChange={(open) => !open && setAddSourcesToGallery(null)}>
        <DialogContent className="glass-float max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">Thêm nguồn media</DialogTitle>
          </DialogHeader>
          {addSourcesToGallery && (() => {
            const gallery = state.folders.find((folder) => folder.id === addSourcesToGallery.galleryId);
            const availableSources = state.sources.filter((source) => !gallery?.sourceIds?.includes(source.id));
            return (
              <>
                <p className="text-sm text-muted-foreground">
                  Chọn một hoặc nhiều Media Source để thêm vào <span className="font-medium text-foreground">{gallery?.name ?? "Gallery"}</span>.
                </p>
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-border/65 p-1.5">
                  {availableSources.map((source) => {
                    const selected = addSourcesToGallery.sourceIds.includes(source.id);
                    const count = state.media.filter((media) => media.sourceId === source.id).length;
                    return (
                      <button
                        key={source.id}
                        type="button"
                        onClick={() => setAddSourcesToGallery((draft) => draft ? {
                          ...draft,
                          sourceIds: selected ? draft.sourceIds.filter((id) => id !== source.id) : [...draft.sourceIds, source.id],
                        } : draft)}
                        className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent", selected && "bg-primary/15 text-foreground")}
                      >
                        <span className={cn("grid size-4 shrink-0 place-items-center rounded border text-[10px]", selected ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{selected && "✓"}</span>
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{source.name}</span>
                        <span className="text-xs text-muted-foreground">{count}</span>
                      </button>
                    );
                  })}
                  {availableSources.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">Không còn Media Source nào để thêm.</p>}
                </div>
                <DialogFooter>
                  <button onClick={() => setAddSourcesToGallery(null)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t("cancel")}</button>
                  <button
                    disabled={addSourcesToGallery.sourceIds.length === 0 || !gallery}
                    onClick={() => {
                      if (!gallery) return;
                      const sourceIds = addSourcesToGallery.sourceIds;
                      updateFolder(gallery.id, { sourceIds: [...new Set([...(gallery.sourceIds ?? []), ...sourceIds])] });
                      addToFolder(gallery.id, state.media.filter((media) => sourceIds.includes(media.sourceId)).map((media) => media.id));
                      setAddSourcesToGallery(null);
                    }}
                    className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Thêm nguồn đã chọn
                  </button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Security dialog */}
      <Dialog open={securityOpen} onOpenChange={setSecurityOpen}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{t("password")}</DialogTitle>
          </DialogHeader>
          {state.password && (
            <input
              autoFocus
              type="password"
              value={pwdCurrent}
              onChange={(e) => { setPwdCurrent(e.target.value); setPwdError(""); }}
              placeholder="Mật khẩu hiện tại"
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          )}
          <input
            type="password"
            value={pwd}
            onChange={(e) => { setPwd(e.target.value); setPwdError(""); }}
            placeholder={state.password ? "Mật khẩu mới" : t("password")}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="password"
            value={pwdConfirm}
            onChange={(e) => { setPwdConfirm(e.target.value); setPwdError(""); }}
            placeholder="Xác nhận mật khẩu mới"
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {pwdError && <p className="text-xs text-destructive">{pwdError}</p>}
          <DialogFooter className="gap-2">
            {state.password && (
              <button
                onClick={() => { void (async () => {
                  if (await passwordHash(pwdCurrent) !== state.password) { setPwdError("Mật khẩu hiện tại không đúng."); return; }
                  onConfirm({
                    title: t("removePassword"),
                    onConfirm: () => {
                      setPassword(null); setRequirePasswordToUnlockGallery(false);
                      setPwd(""); setPwdCurrent(""); setPwdConfirm(""); setPwdError(""); setSecurityOpen(false);
                    },
                  });
                })(); }}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent"
              >
                {t("removePassword")}
              </button>
            )}
            <button
              onClick={() => { void (async () => {
                if (!pwd.trim()) { setPwdError("Nhập mật khẩu mới."); return; }
                if (pwd !== pwdConfirm) { setPwdError("Xác nhận mật khẩu chưa khớp."); return; }
                if (state.password && await passwordHash(pwdCurrent) !== state.password) { setPwdError("Mật khẩu hiện tại không đúng."); return; }
                setPassword(await passwordHash(pwd));
                setPwd(""); setPwdCurrent(""); setPwdConfirm(""); setPwdError(""); setSecurityOpen(false);
              })(); }}
              className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary"
            >
              {state.password ? t("changePassword") : t("setPassword")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
