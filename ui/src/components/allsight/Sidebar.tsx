import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
  RefreshCw,
  X,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  BadgeCheck,
  Sparkles,
} from "lucide-react";
import { LicensePanel, formatPrice, useLicense } from "./License";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAllsight } from "@/lib/allsight/store";
import { currentMediaDrag, finishMediaDrag } from "@/lib/allsight/media-drag-transfer";
import { useT } from "@/lib/allsight/i18n";
import type { GalleryOrderEntry, PersonalFolder } from "@/lib/allsight/types";
import { getInDeckBridge } from "@/lib/indeck/bridge";
import { LazyThumbnail } from "./Thumbnail";
import { ProfileManager } from "./ProfileManager";
import { cn } from "@/lib/utils";
import type { ConfirmRequest } from "./ConfirmDialog";
import appIcon from "@/assets/app-icon.png";
import indeckIcon from "@/assets/indeck.png";
import { LockOverlay } from "./LockOverlay";

import { AutoTagEditor } from "./AutoTagEditor";
import { Chip, PropertyPicker } from "./PropertyPicker";

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
  onMediaMovedFromSelection,
  mainGalleryCount,
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
  /** A card drag dropped here finished moving Gallery media out of the
   * Library's current selection; that selection is now stale and must clear
   * the same way the equivalent in-Gallery "Add to Gallery" actions do. */
  onMediaMovedFromSelection: () => void;
  /** How many media Main Gallery actually shows under the current rules. */
  mainGalleryCount: number;
}) {
  const t = useT();
  const [appDisplayName, setAppDisplayName] = useState("Mosaic");
  useEffect(() => {
    let active = true;
    void getInDeckBridge()?.getAppDisplayName().then((name) => {
      if (active && name) setAppDisplayName(name);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const {
    state,
    createFolder,
    updateFolder,
    renameFolder,
    ensureFolderDefaultSource,
    deleteFolder,
    addToFolder,
    moveToFolder,
    setLanguage,
    setPassword,
    setAppLockEnabled,
    setRequirePasswordToUnlockGallery,
    setAppearance,
    setThemeColor,
    syncMediaLocation,
    updateGalleryGroup,
    createGalleryGroup,
    addGalleryToGroup,
    moveGalleryEntry,
    removeGalleryFromGroup,
    attachSourceFolder,
    createPropertyValue,
  } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  const [collapsed, setCollapsed] = useState(false);
  const [newFolder, setNewFolder] = useState<NewGalleryDraft | null>(null);
  const [newFolderNameError, setNewFolderNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<PersonalFolder | null>(null);
  const [renamingGalleryGroup, setRenamingGalleryGroup] = useState<{ id: string; name: string } | null>(null);
  const [navSelectedFolders, setNavSelectedFolders] = useState<string[]>([]);
  const [navDrag, setNavDrag] = useState<GalleryOrderEntry | null>(null);
  const [mediaDropTarget, setMediaDropTarget] = useState<string | null>(null);
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
  const [enableAppLockAfterPassword, setEnableAppLockAfterPassword] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [license, setLicense] = useLicense();
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [syncResult, setSyncResult] = useState<{ moved: number; renamed: number; skipped: number; conflicts: number } | null>(null);
  const [pwd, setPwd] = useState("");
  const [pwdCurrent, setPwdCurrent] = useState("");
  const [pwdConfirm, setPwdConfirm] = useState("");
  const [pwdError, setPwdError] = useState("");
  const [noGalleryPasswordConfirmOpen, setNoGalleryPasswordConfirmOpen] = useState(false);
  const [noGalleryPassword, setNoGalleryPassword] = useState("");
  const [noGalleryPasswordError, setNoGalleryPasswordError] = useState("");
  const [navSearchOpen, setNavSearchOpen] = useState(false);
  const [navSearchQuery, setNavSearchQuery] = useState("");
  const [navSearchDropActive, setNavSearchDropActive] = useState(false);
  const [galleryPicker, setGalleryPicker] = useState<{ mediaIds: string[]; sourceFolderId: string | null } | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const navSearchRef = useRef<HTMLButtonElement>(null);
  const navSearchInputRef = useRef<HTMLInputElement>(null);
  // A card dragged with the pointer (not HTML5 drag-and-drop) is captured here
  // while it hovers the search field, so the drop still resolves even though
  // the shared drag payload is cleared by whoever handles pointerup first.
  const navSearchPayload = useRef<{ mediaIds: string[]; sourceFolderId: string | null } | null>(null);

  // Other screens (the Library board, its empty state) open the same
  // "New Gallery" dialog instead of pointing at the + button.
  useEffect(() => {
    const open = () => { setNewFolderNameError(null); setNewFolder({ name: "", nameMode: "required", sourcePaths: [], notes: "", autoTags: {} }); };
    window.addEventListener("mosaic:new-gallery", open);
    return () => window.removeEventListener("mosaic:new-gallery", open);
  }, []);

  const openGalleryPicker = (payload: { mediaIds: string[]; sourceFolderId: string | null }) => {
    if (!payload.mediaIds.length) return;
    setPickerQuery("");
    setNavSearchDropActive(false);
    setGalleryPicker(payload);
  };

  const mediaById = useMemo(() => new Map(state.media.map((media) => [media.id, media])), [state.media]);
  const coverFor = (f: PersonalFolder) => mediaById.get(f.coverId ?? f.mediaIds[0] ?? "") ?? null;
  // What each Gallery actually shows: references to media that no longer
  // exist, or that are hidden, are not counted.
  const galleryCount = (f: PersonalFolder) => {
    let count = 0;
    for (const id of f.mediaIds) {
      const media = mediaById.get(id);
      if (media && !media.hidden) count += 1;
    }
    return count;
  };
  const isSessionLocked = (f: PersonalFolder) => f.locked && !unlockedFolderIds.includes(f.id);
  // Turning a Gallery's lock off is as good as opening it, so while it is
  // still locked and protected by the password, it has to be opened first.
  const toggleGalleryLock = (f: PersonalFolder) => {
    if (f.locked && isSessionLocked(f) && state.password && state.requirePasswordToUnlockGallery) {
      onView({ kind: "folder", id: f.id });
      toast.info(c("Mở khóa Gallery bằng mật khẩu trước khi gỡ khóa.", "Unlock the Gallery with the password before removing its lock."));
      return;
    }
    updateFolder(f.id, { locked: !f.locked });
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
              <Ungroup className="size-4" /> {c(`Loại ${selection.length} Gallery khỏi group`, `Remove ${selection.length} Galleries from group`)}
            </ContextMenuItem>
          ) : (
            <ContextMenuItem className={menuItem} onSelect={() => { createGalleryGroup(selection); setNavSelectedFolders([]); }}>
              <Layers className="size-4" /> {c(`Tạo group từ ${selection.length} Gallery`, `Create group from ${selection.length} Galleries`)}
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
      <ContextMenuItem className={menuItem} onSelect={() => toggleGalleryLock(f)}>
        {f.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}
        {f.locked ? t("unlockFolder") : t("lockFolder")}
      </ContextMenuItem>
      {f.locked && unlockedFolderIds.includes(f.id) && (
        <ContextMenuItem className={menuItem} onSelect={() => onRelockGallery(f.id)}>
          <Lock className="size-4" /> {c("Khóa ngay", "Lock now")}
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
          <Ungroup className="size-4" /> {c("Loại khỏi group", "Remove from group")}
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

  const submitNewFolder = () => {
    const name = newFolder?.name?.trim();
    const sourcePaths = newFolder?.sourcePaths ?? [];
    if (!name) {
      setNewFolderNameError(sourcePaths.length > 1 ? c("Đã chọn nhiều folder, hãy nhập tên Gallery trước khi tạo.", "Several folders are selected; enter a Gallery name first.") : c("Hãy nhập tên Gallery trước khi tạo.", "Enter a Gallery name first."));
      return;
    }
    const usedNames = new Set(state.folders.map((folder) => folder.name.trim().toLocaleLowerCase()));
    let galleryName = name;
    for (let number = 2; usedNames.has(galleryName.toLocaleLowerCase()); number += 1) {
      galleryName = `${name} (${number})`;
    }
    const id = createFolder(galleryName, {
      sourceIds: [],
      notes: newFolder?.notes ?? "",
      autoTags: newFolder?.autoTags ?? {},
    });
    setNewFolder(null);
    setNewFolderNameError(null);
    onView({ kind: "folder", id });
    // Every Gallery owns an InDeck-managed Default Source. Extra
    // Media Sources are scanned independently and never replaced.
    void ensureFolderDefaultSource(id, galleryName);
    void Promise.all(sourcePaths.map((path) => attachSourceFolder(id, path)));
  };

  const confirmNoGalleryPassword = async () => {
    if (!state.password || await passwordHash(noGalleryPassword) !== state.password) {
      setNoGalleryPasswordError(t("wrongPassword"));
      return;
    }
    setRequirePasswordToUnlockGallery(false);
    setNoGalleryPasswordConfirmOpen(false);
  };
  const submitPassword = async () => {
    if (!pwd.trim()) { setPwdError(c("Nhập mật khẩu mới.", "Enter a new password.")); return; }
    if (pwd !== pwdConfirm) { setPwdError(c("Xác nhận mật khẩu chưa khớp.", "The confirmation does not match.")); return; }
    if (state.password && await passwordHash(pwdCurrent) !== state.password) { setPwdError(c("Mật khẩu hiện tại không đúng.", "The current password is incorrect.")); return; }
    const hash = await passwordHash(pwd);
    setPassword(hash);
    // Choosing Lock app before a password exists establishes the
    // shared password and enables lock-on-next-launch, without
    // interrupting the current session.
    if (enableAppLockAfterPassword) setAppLockEnabled(true);
    setPwd(""); setPwdCurrent(""); setPwdConfirm(""); setPwdError("");
    setEnableAppLockAfterPassword(false); setSecurityOpen(false);
  };
  const submitRename = () => {
    const name = renaming?.name.trim();
    if (!renaming || !name) return;
    void renameFolder(renaming.id, name);
    setRenaming(null);
  };
  const submitGalleryGroupRename = () => {
    const name = renamingGalleryGroup?.name.trim();
    if (!renamingGalleryGroup || !name) return;
    updateGalleryGroup(renamingGalleryGroup.id, { name });
    setRenamingGalleryGroup(null);
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
          <Trash2 className="size-4" /> {c("Xóa group", "Delete group")}
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
  const draggedMedia = (event: React.DragEvent) => {
    const plain = event.dataTransfer.getData("text/plain");
    const raw = event.dataTransfer.getData("application/x-mosaic-media")
      || event.dataTransfer.getData("text/x-mosaic-media")
      || (plain.startsWith("mosaic-media:") ? plain.slice("mosaic-media:".length) : "");
    if (!raw) return currentMediaDrag();
    try {
      const value = JSON.parse(raw);
      const mediaIds = Array.isArray(value?.mediaIds) ? value.mediaIds.map(String).filter(Boolean) : [];
      return mediaIds.length ? { mediaIds, sourceFolderId: value.sourceFolderId == null ? null : String(value.sourceFolderId) } : null;
    } catch {
      return currentMediaDrag();
    }
  };
  const canDropMedia = (event: React.DragEvent) => {
    // DataTransfer.types is a DOMStringList in some Electron/Chromium builds
    // and an array in others; Array.from handles both. Two MIME markers make
    // a card-to-nav drag reliable across those versions.
    const types = Array.from(event.dataTransfer.types ?? []);
    // On some Electron builds custom MIME types disappear during dragover
    // (even though they are present again on drop). The renderer-local drag
    // payload is authoritative for Mosaic's own card drag and lets us call
    // preventDefault here, which is required for the browser to dispatch
    // the subsequent drop event at all.
    return Boolean(currentMediaDrag())
      || types.includes("application/x-mosaic-media")
      || types.includes("text/x-mosaic-media");
  };
  useEffect(() => {
    const clearMediaDrop = () => { setMediaDropTarget(null); finishMediaDrag(); };
    window.addEventListener("dragend", clearMediaDrop);
    return () => window.removeEventListener("dragend", clearMediaDrop);
  }, []);

  // Dragging towards either end of the nav scrolls it, so a card can reach a
  // Gallery that is currently off-screen. Both drag flavours are covered: an
  // HTML5 drag only emits `dragover`, while Mosaic's own card drag is pointer
  // driven and emits `pointermove`.
  useEffect(() => {
    const NAV_EDGE = 56;
    const NAV_SPEED = 12;
    let velocity = 0;
    let frame = 0;
    const step = () => {
      frame = 0;
      const root = navListRef.current;
      if (!root || !velocity) return;
      root.scrollTop += velocity;
      frame = requestAnimationFrame(step);
    };
    const track = (clientX: number, clientY: number) => {
      const root = navListRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      // A little slack past each end keeps scrolling alive when the pointer
      // overshoots the list while the user is still holding the card.
      // Horizontally there is no slack: the nav owns its own column only, so
      // dragging near the top of the Gallery does not scroll this list too.
      const withinReach = clientY >= rect.top - 80 && clientY <= rect.bottom + 80
        && clientX >= rect.left && clientX <= rect.right;
      velocity = !withinReach ? 0
        : clientY < rect.top + NAV_EDGE ? -NAV_SPEED
        : clientY > rect.bottom - NAV_EDGE ? NAV_SPEED
        : 0;
      if (velocity && !frame) frame = requestAnimationFrame(step);
    };
    const stop = () => { velocity = 0; setMediaDropTarget(null); };
    // The drop highlight was only ever set from `onDragOver`, an HTML5 event a
    // pointer-driven card drag never fires. Dropping worked, but no row ever
    // lit up, so carrying media — one item or a whole selection — over the nav
    // looked like nothing was droppable there.
    const highlight = (clientX: number, clientY: number) => {
      const row = document.elementsFromPoint(clientX, clientY)
        .map(element => (element as HTMLElement).closest<HTMLElement>('[data-gallery-media-drop-id]'))
        .find((element): element is HTMLElement => !!element);
      const next = row?.dataset['galleryMediaDropId'] ?? null;
      setMediaDropTarget(current => current === next ? current : next);
    };
    const onDragOver = (event: DragEvent) => track(event.clientX, event.clientY);
    const onPointerMove = (event: PointerEvent) => {
      if (!currentMediaDrag()) return;
      track(event.clientX, event.clientY);
      highlight(event.clientX, event.clientY);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("dragend", stop);
    window.addEventListener("drop", stop);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("dragend", stop);
      window.removeEventListener("drop", stop);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Pointer-driven card drags do not deliver an HTML5 `drop`, so the search
  // field resolves its own pointerup while the payload captured on hover is
  // still available.
  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      const payload = navSearchPayload.current;
      navSearchPayload.current = null;
      if (!payload) return;
      const field = navSearchRef.current;
      const over = field?.getBoundingClientRect();
      setNavSearchDropActive(false);
      if (!over) return;
      const inside = event.clientX >= over.left && event.clientX <= over.right
        && event.clientY >= over.top && event.clientY <= over.bottom;
      if (inside) openGalleryPicker(payload);
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, []);

  const galleryRow = (f: PersonalFolder, nested = false, groupId?: string, entryIndex = 0, memberIndex = 0) => (
    <ContextMenu key={f.id}>
      <ContextMenuTrigger asChild>
        <button
          data-gallery-media-drop-id={f.id}
          draggable
          onDragStart={(event) => beginNavDrag(event, { kind: "folder", id: f.id })}
          onDrag={trackNavDrag}
          onDragEnd={finishNavDrag}
          onDragOver={(event) => {
            if (!navDrag && canDropMedia(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setMediaDropTarget(f.id);
              setNavRail(null);
              return;
            }
            if (!navDrag) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            placeNavRail(event, before);
          }}
          onDrop={(event) => {
            const media = draggedMedia(event);
            if (media) {
              event.preventDefault();
              event.stopPropagation();
              moveToFolder(f.id, media.mediaIds, media.sourceFolderId);
              onMediaMovedFromSelection();
              setMediaDropTarget(null);
              finishMediaDrag();
              return;
            }
            if (!navDrag) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (groupId && navDrag.kind === "folder") addGalleryToGroup(groupId, navDrag.id, before ? memberIndex : memberIndex + 1);
            else moveToTopLevel(navDrag, before ? entryIndex : entryIndex + 1);
            finishNavDrag();
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setMediaDropTarget((id) => id === f.id ? null : id);
          }}
          onPointerEnter={() => {
            if (currentMediaDrag()) setMediaDropTarget(f.id);
          }}
          onPointerMove={() => {
            if (currentMediaDrag()) setMediaDropTarget(f.id);
          }}
          onPointerLeave={() => setMediaDropTarget((id) => id === f.id ? null : id)}
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
            mediaDropTarget === f.id && "bg-primary/20 ring-2 ring-primary/70",
          )}
        >
          {coverFor(f) ? (
            <span className="relative size-5 shrink-0 overflow-hidden rounded-[5px]">
              <LazyThumbnail media={coverFor(f)!} priority thumbnailSize={160} className={cn("size-full object-cover", f.locked && !unlockedFolderIds.includes(f.id) && "scale-105 opacity-70 blur-[1px]")} />
              {f.locked && !unlockedFolderIds.includes(f.id) && <LockOverlay size="sm" />}
            </span>
          ) : <span className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-muted"><Folder className="size-3 text-muted-foreground" /></span>}
          {!collapsed && <>
            <span className="flex-1 truncate text-left">{f.name}</span>
            {isSessionLocked(f) ? <Lock className="size-3 text-muted-foreground" /> : <span className="text-xs text-muted-foreground tabular-nums">{galleryCount(f)}</span>}
          </>}
        </button>
      </ContextMenuTrigger>
      {folderMenu(f)}
    </ContextMenu>
  );

  const folderById = new Map(state.folders.map((folder) => [folder.id, folder]));
  const groupedGalleryIds = new Set(state.galleryGroups.flatMap((group) => group.folderIds));
  const navEntries: GalleryOrderEntry[] = state.galleryOrder.filter((entry) =>
    entry.kind === "group"
      ? state.galleryGroups.some((group) => group.id === entry.id)
      : state.folders.some((folder) => folder.id === entry.id) && !groupedGalleryIds.has(entry.id),
  );
  const knownNavEntries = new Set(navEntries.map((entry) => `${entry.kind}:${entry.id}`));
  state.galleryGroups.forEach((group) => { if (!knownNavEntries.has(`group:${group.id}`)) navEntries.push({ kind: "group", id: group.id }); });
  state.folders.filter((folder) => !groupedGalleryIds.has(folder.id)).forEach((folder) => { if (!knownNavEntries.has(`folder:${folder.id}`)) navEntries.push({ kind: "folder", id: folder.id }); });
  const navQuery = navSearchOpen && !collapsed ? navSearchQuery.trim().toLowerCase() : "";
  const matchingGalleries = navQuery
    ? state.folders.filter((folder) => folder.name.toLowerCase().includes(navQuery))
    : [];
  const galleryGroupRow = (group: typeof state.galleryGroups[number], entryIndex: number) => {
    const members = group.folderIds.map((id) => folderById.get(id)).filter((folder): folder is PersonalFolder => !!folder);
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
            <img src={appIcon} alt={appDisplayName} className="size-full object-cover" />
          </span>
          {!collapsed && (
            <span className="truncate font-display text-lg font-semibold tracking-tight">{appDisplayName}</span>
          )}
        </button>
        <button
          ref={navSearchRef}
          onClick={() => {
            setCollapsed(false);
            setNavSearchOpen((open) => {
              if (open) setNavSearchQuery("");
              else window.setTimeout(() => navSearchInputRef.current?.focus(), 0);
              return !open;
            });
          }}
          // Dropping cards straight onto the icon asks which Gallery they
          // belong in, so the nav never has to be scrolled to find it. Both
          // drag flavours land here: HTML5 drops fire onDrop, while Mosaic's
          // pointer drag is resolved by the window pointerup handler using the
          // payload captured here on hover.
          onDragOver={(event) => {
            if (!canDropMedia(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setNavSearchDropActive(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setNavSearchDropActive(false);
          }}
          onDrop={(event) => {
            const media = draggedMedia(event);
            if (!media) return;
            event.preventDefault();
            event.stopPropagation();
            navSearchPayload.current = null;
            openGalleryPicker(media);
            finishMediaDrag();
          }}
          onPointerMove={() => {
            const media = currentMediaDrag();
            if (!media) return;
            navSearchPayload.current = media;
            setNavSearchDropActive(true);
          }}
          onPointerLeave={() => {
            navSearchPayload.current = null;
            setNavSearchDropActive(false);
          }}
          aria-label={c("Tìm gallery", "Search galleries")}
          title={c("Tìm gallery — hoặc thả ảnh vào đây để chọn gallery", "Search galleries — or drop media here to pick one")}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg transition-colors hover:bg-accent hover:text-accent-foreground",
            navSearchDropActive
              ? "scale-110 bg-primary/25 text-foreground ring-2 ring-primary/70"
              : navSearchOpen ? "bg-primary/15 text-foreground" : "text-muted-foreground",
          )}
        >
          <Search className="size-4" />
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

      {navSearchOpen && !collapsed && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={navSearchInputRef}
            value={navSearchQuery}
            onChange={(event) => setNavSearchQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { setNavSearchQuery(""); setNavSearchOpen(false); } }}
            placeholder={c("Tìm gallery…", "Search galleries…")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {navSearchQuery && (
            <button
              onClick={() => { setNavSearchQuery(""); navSearchInputRef.current?.focus(); }}
              aria-label={c("Xoá tìm kiếm", "Clear search")}
              className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      )}

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
          data-gallery-media-drop-id="__mosaic-main-gallery__"
          onPointerEnter={() => { if (currentMediaDrag()) setMediaDropTarget("__mosaic-main-gallery__"); }}
          onPointerMove={() => { if (currentMediaDrag()) setMediaDropTarget("__mosaic-main-gallery__"); }}
          onPointerLeave={() => setMediaDropTarget((id) => id === "__mosaic-main-gallery__" ? null : id)}
          onClick={() => onView({ kind: "all" })}
          title={t("allMedia")}
          className={cn(
            itemBase,
            collapsed && "justify-center px-0",
            view.kind === "all" ? "bg-primary/15 text-foreground" : "hover:bg-accent/60",
            mediaDropTarget === "__mosaic-main-gallery__" && "bg-primary/20 ring-2 ring-primary/70",
          )}
        >
          <img src={indeckIcon} alt="" className="size-4 shrink-0 rounded-[3px] object-cover" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">{t("allMedia")}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {mainGalleryCount}
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

        {/* A search collapses the tree to the galleries that match, groups
            included — nesting is not useful once the list is already a result
            set, and a flat list keeps every match one click away. */}
        {navQuery
          ? (matchingGalleries.length
            ? matchingGalleries.map((folder, index) => galleryRow(folder, false, undefined, index))
            : (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {c("Không có gallery nào khớp", "No galleries match")}
              </p>
            ))
          : navEntries.map((entry, index) => entry.kind === "group"
            ? galleryGroupRow(state.galleryGroups.find((group) => group.id === entry.id)!, index)
            : galleryRow(state.folders.find((folder) => folder.id === entry.id)!, false, undefined, index),
          )}
        {navRail && <span aria-hidden className="pointer-events-none absolute z-40 h-1 rounded-full border border-white/35 bg-primary shadow-[0_0_0_2px_rgb(255_255_255_/_0.16),0_0_12px_hsl(var(--primary))]" style={{ top: navRail.y, left: navRail.left, width: navRail.width }} />}

      </div>

      <Dialog open={!!galleryPicker} onOpenChange={(open) => { if (!open) setGalleryPicker(null); }}>
        <DialogContent className="glass-float rounded-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {c(
                `Chuyển ${galleryPicker?.mediaIds.length ?? 0} ảnh vào gallery`,
                `Move ${galleryPicker?.mediaIds.length ?? 0} item(s) to a gallery`,
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
              placeholder={c("Tìm gallery…", "Search galleries…")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="app-scroll max-h-80 space-y-1 overflow-y-auto pr-1">
            {state.folders
              .filter((folder) => folder.name.toLowerCase().includes(pickerQuery.trim().toLowerCase()))
              .map((folder) => {
                const cover = coverFor(folder);
                return (
                  <button
                    key={folder.id}
                    onClick={() => {
                      if (galleryPicker) {
                        moveToFolder(folder.id, galleryPicker.mediaIds, galleryPicker.sourceFolderId);
                        onMediaMovedFromSelection();
                      }
                      setGalleryPicker(null);
                    }}
                    className="flex w-full items-center gap-3 rounded-xl border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border/60 hover:bg-accent/60"
                  >
                    <span className="size-10 shrink-0 overflow-hidden rounded-lg bg-muted">
                      {cover
                        ? <LazyThumbnail media={cover} priority thumbnailSize={160} className="size-full object-cover" />
                        : <Folder className="m-3 size-4 text-muted-foreground" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{folder.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {isSessionLocked(folder) ? t("locked") : c(`${galleryCount(folder)} ảnh`, `${galleryCount(folder)} items`)}
                      </span>
                    </span>
                  </button>
                );
              })}
            {!state.folders.some((folder) => folder.name.toLowerCase().includes(pickerQuery.trim().toLowerCase())) && (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                {c("Không có gallery nào khớp", "No galleries match")}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {navDrag && navDragPoint && (() => {
        const folder = navDrag.kind === "folder"
          ? state.folders.find((item) => item.id === navDrag.id)
          : state.folders.find((item) => item.id === state.galleryGroups.find((group) => group.id === navDrag.id)?.folderIds[0]);
        const cover = folder && coverFor(folder);
        return <div aria-hidden className="pointer-events-none fixed z-[90] flex w-44 items-center gap-2 rounded-xl border border-white/30 bg-background/55 px-2 py-1.5 opacity-65 shadow-2xl backdrop-blur-md" style={{ left: navDragPoint.x + 14, top: navDragPoint.y + 14 }}><span className="size-8 shrink-0 overflow-hidden rounded-lg bg-muted">{cover ? <LazyThumbnail media={cover} priority thumbnailSize={160} className="size-full object-cover" /> : <Folder className="m-2 size-4 text-muted-foreground" />}</span><span className="truncate text-xs font-medium">{folder?.name ?? "Gallery group"}</span></div>;
      })()}

      {/* Bottom: tags + settings */}
      <div className={cn("shrink-0 space-y-1 border-t border-border/60 p-3", collapsed && "px-2")}>
        {license?.state === "trial" && (
          <button
            type="button"
            onClick={() => setLicenseOpen(true)}
            title={c(`Dùng thử còn ${license.trialDaysLeft} ngày · Mua Mosaic`, `${license.trialDaysLeft} trial days left · Buy Mosaic`)}
            data-license-trial-badge
            className={cn(itemBase, collapsed && "justify-center px-0", "bg-primary/15 hover:bg-primary/25")}
          >
            <Sparkles className="size-4 shrink-0 text-primary" />
            {!collapsed && (
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate">{c(`Dùng thử · còn ${license.trialDaysLeft} ngày`, `Trial · ${license.trialDaysLeft} days left`)}</span>
                <span className="shrink-0 text-xs font-medium text-primary">{c("Mua", "Buy")}</span>
              </span>
            )}
          </button>
        )}
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
              <Palette className="size-4 text-muted-foreground" />
              <span className="flex-1">{t("themeColor")}</span>
              <div className="flex items-center gap-1.5">
                {([
                  { key: "green", color: "#4b8b60", label: "themeGreen" },
                  { key: "blue", color: "#0055DA", label: "themeBlue" },
                  { key: "teal", color: "#76ABAE", label: "themeTeal" },
                  { key: "pink", color: "#F5788B", label: "themePink" },
                  { key: "orange", color: "#F7A00A", label: "themeOrange" },
                ] as const).map(({ key, color, label }) => (
                  <button key={key} onClick={() => setThemeColor(key)} title={t(label)} aria-label={t(label)} style={{ backgroundColor: color }} className={cn("size-6 rounded-md border-2 border-white/45 shadow-sm transition-transform hover:scale-110", state.themeColor === key && "ring-2 ring-ring ring-offset-2 ring-offset-background")} />
                ))}
              </div>
            </div>
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

            {license && license.state !== "development" && (
              <button
                onClick={() => { setSettingsOpen(false); setLicenseOpen(true); }}
                data-license-settings
                className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
              >
                {license.license ? <BadgeCheck className="size-4 text-primary" /> : <Sparkles className="size-4 text-muted-foreground" />}
                <span className="flex-1 text-left">{c("Bản quyền", "License")}</span>
                <span className="text-xs text-muted-foreground">
                  {license.license
                    ? c("Đã mua", "Purchased")
                    : license.state === "trial"
                      ? c(`Dùng thử · còn ${license.trialDaysLeft} ngày`, `Trial · ${license.trialDaysLeft} days left`)
                      : formatPrice(license)}
                </span>
              </button>
            )}
            <button
              onClick={() => {
                setSettingsOpen(false);
                setProfilesOpen(true);
              }}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              <FolderCog className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{c("Quản lý Profile", "Manage profiles")}</span>
              <span className="text-xs text-muted-foreground">{c("Library và lối tắt", "Library and shortcut")}</span>
            </button>
            <button
              onClick={() => {
                setSettingsOpen(false);
                setEnableAppLockAfterPassword(false);
                setSecurityOpen(true);
              }}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              <Shield className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{t("password")}</span>
              <span className="text-xs text-muted-foreground">{state.password ? t("changePassword") : t("setPassword")}</span>
            </button>
            <div className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-secondary/40 px-3 py-2 hover:bg-accent/60">
              <Lock className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-sm">{t("passwordRequiredForGallery")}</span>
                <span className="block text-xs text-muted-foreground">{t("passwordRequiredForGalleryHint")}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={!state.requirePasswordToUnlockGallery}
                aria-label={t("passwordRequiredForGallery")}
                onClick={() => {
                  if (state.requirePasswordToUnlockGallery) {
                    if (state.password) {
                      setNoGalleryPassword("");
                      setNoGalleryPasswordError("");
                      setNoGalleryPasswordConfirmOpen(true);
                      return;
                    }
                    setSettingsOpen(false);
                    setEnableAppLockAfterPassword(false);
                    setSecurityOpen(true);
                    return;
                  }
                  if (!state.password) {
                    setSettingsOpen(false);
                    setEnableAppLockAfterPassword(false);
                    setSecurityOpen(true);
                    return;
                  }
                  setRequirePasswordToUnlockGallery(!state.requirePasswordToUnlockGallery);
                }}
                className={cn(
                  "relative h-6 w-11 min-w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !state.requirePasswordToUnlockGallery ? "bg-primary" : "bg-muted-foreground/35",
                )}
              >
                <span className={cn("absolute top-0.5 left-0 size-5 rounded-full bg-white shadow-sm transition-transform", !state.requirePasswordToUnlockGallery ? "translate-x-5" : "translate-x-0.5")} />
              </button>
            </div>
            <button
              onClick={() => {
                if (state.appLockEnabled) {
                  setAppLockEnabled(false);
                  return;
                }
                if (!state.password) {
                  setSettingsOpen(false);
                  setEnableAppLockAfterPassword(true);
                  setSecurityOpen(true);
                  return;
                }
                setAppLockEnabled(true);
                setSettingsOpen(false);
                onLock();
              }}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              {state.appLockEnabled ? <LockOpen className="size-4 text-muted-foreground" /> : <Lock className="size-4 text-muted-foreground" />}
              {state.appLockEnabled ? t("unlockApp") : t("lockApp")}
            </button>
            <button
              onClick={() => { void syncMediaLocation().then(setSyncResult).catch(() => setSyncResult({ moved: 0, renamed: 0, skipped: 1, conflicts: 0 })); }}
              className={cn(itemBase, "border border-border/70 bg-secondary/40 hover:bg-accent/60")}
            >
              <RefreshCw className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{t("syncMediaLocation")}</span>
              {/* Skipped was counted but never shown, so media a Vault holds —
                  which Sync deliberately never moves — looked as though it had
                  been synced along with everything else. */}
              {syncResult !== null && (
                <span className="text-xs text-muted-foreground">{t("syncDone", { count: syncResult.moved, ordered: syncResult.renamed })}{syncResult.skipped ? ` · ${syncResult.skipped} ${c("bỏ qua", "skipped")}` : ""}{syncResult.conflicts ? ` · ${syncResult.conflicts} conflict` : ""}</span>
              )}
            </button>
            <p className="text-xs text-muted-foreground">{t("syncMediaHint")}</p>

          </div>
        </DialogContent>
      </Dialog>

      <ProfileManager open={profilesOpen} onOpenChange={setProfilesOpen} />

      {/* License: buy, activate a key, or move it to another computer. */}
      <Dialog open={licenseOpen} onOpenChange={setLicenseOpen}>
        <DialogContent className="glass-float max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{c("Bản quyền Mosaic", "Mosaic license")}</DialogTitle>
          </DialogHeader>
          <LicensePanel status={license} onStatus={setLicense} />
        </DialogContent>
      </Dialog>

      {/* New folder dialog */}
      <Dialog open={!!newFolder} onOpenChange={(o) => { if (!o) { setNewFolder(null); setNewFolderNameError(null); } }}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{c("Gallery mới", "New Gallery")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <input
              autoFocus
              value={newFolder?.name ?? ""}
              onChange={(e) => { setNewFolderNameError(null); setNewFolder((s) => s ? { ...s, name: e.target.value, nameMode: "manual" } : s); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitNewFolder(); } }}
              placeholder={(newFolder?.sourcePaths.length ?? 0) > 1 ? c("Nhập tên Gallery (bắt buộc)", "Enter a Gallery name (required)") : c("Tên Gallery", "Gallery name")}
              aria-invalid={Boolean(newFolderNameError)}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {newFolderNameError && <p role="alert" className="-mt-2 text-xs text-destructive">{newFolderNameError}</p>}
            <section className="space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Media Sources</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c("Chọn folder trên máy để làm nguồn media cho Gallery này.", "Choose folders on this computer as Media Sources for this Gallery.")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void (async () => {
                    const path = await getInDeckBridge()?.pickFolder().catch(() => null);
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
                  <FolderPlus className="size-3.5" /> {c("Thêm folder", "Add folder")}
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
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{count == null ? c("Sẽ quét khi tạo Gallery", "Scanned when the Gallery is created") : `${count} media`}</span>
                    </span>
                <button type="button" aria-label={c(`Bỏ ${name}`, `Remove ${name}`)} title={c("Bỏ folder", "Remove folder")} onClick={() => {
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
                {(newFolder?.sourcePaths.length ?? 0) === 0 && <p className="px-3 py-4 text-center text-xs text-muted-foreground">{c("Chưa có Media Source. Thêm một hoặc nhiều folder.", "No Media Sources yet. Add one or more folders.")}</p>}
              </div>
              {(newFolder?.sourcePaths.length ?? 0) > 1 && !newFolder?.name.trim() && <p className="text-xs text-amber-500">{c("Đã chọn nhiều folder. Hãy nhập tên Gallery trước khi tạo.", "Several folders are selected. Enter a Gallery name first.")}</p>}
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
                const addValue = (value: string, create = false) => {
                  if (create) createPropertyValue(group.id, value);
                  setNewFolder((draft) => draft ? { ...draft, autoTags: { ...draft.autoTags, [group.id]: [...new Set([...(draft.autoTags[group.id] ?? []), value])] } } : draft);
                };
                return <div key={group.id} className="flex items-start gap-2">
                  <span className="w-24 shrink-0 pt-1.5 truncate text-xs text-muted-foreground">{group.name}</span>
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><PropertyPicker label={`${t("addValue")} ${group.name}`} options={group.values.filter((value) => !values.includes(value)).map((value) => ({ id: value, label: value }))} onSelect={(value) => addValue(value)} onCreate={(value) => addValue(value, true)} trigger={<button type="button" className="glass-btn rounded-md px-2 py-1 text-xs">{t("addValue")}…</button>} />{values.map((value) => <Chip key={value} label={value} onRemove={() => setNewFolder((draft) => draft ? { ...draft, autoTags: { ...draft.autoTags, [group.id]: (draft.autoTags[group.id] ?? []).filter((item) => item !== value) } } : draft)} />)}</div></div>
                </div>;
              })}
            </section>
          </div>
          <DialogFooter>
            <button
              onClick={submitNewFolder}
              className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary"
            >
              {c("Tạo Gallery", "Create Gallery")}
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
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitRename(); } }}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <DialogFooter>
            <button
              disabled={!renaming?.name.trim()}
              onClick={submitRename}
              className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary disabled:cursor-not-allowed disabled:opacity-45"
            >
              {t("save")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renamingGalleryGroup} onOpenChange={(o) => !o && setRenamingGalleryGroup(null)}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader><DialogTitle className="font-display">{t("rename")}</DialogTitle></DialogHeader>
          <input autoFocus value={renamingGalleryGroup?.name ?? ""} onChange={(e) => setRenamingGalleryGroup((group) => group ? { ...group, name: e.target.value } : group)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitGalleryGroupRename(); } }} className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <DialogFooter><button disabled={!renamingGalleryGroup?.name.trim()} onClick={submitGalleryGroupRename} className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary disabled:cursor-not-allowed disabled:opacity-45">{t("save")}</button></DialogFooter>
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
                {c("Chọn Gallery nguồn để thêm media vào ", "Choose a Gallery to add its media to ")}<span className="font-medium text-foreground">{importFromGallery.name}</span>.
              </p>
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {state.folders.filter((folder) => folder.id !== importFromGallery.id).map((source) => {
                  // A locked Gallery's media must not leak out through an
                  // import before it has been unlocked.
                  const sealed = isSessionLocked(source);
                  return (
                    <button
                      key={source.id}
                      disabled={sealed}
                      onClick={() => {
                        addToFolder(importFromGallery.id, source.mediaIds.filter((id) => mediaById.has(id)));
                        setImportFromGallery(null);
                      }}
                      className="glass-btn flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="grid size-8 place-items-center rounded-lg bg-secondary/70 text-muted-foreground">{sealed ? <Lock className="size-4" /> : <Folder className="size-4" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{source.name}</span>
                        <span className="block text-xs text-muted-foreground">{sealed ? t("locked") : `${galleryCount(source)} media`}</span>
                      </span>
                      {!sealed && <Plus className="size-4 text-muted-foreground" />}
                    </button>
                  );
                })}
                {state.folders.length <= 1 && <p className="py-8 text-center text-sm text-muted-foreground">{c("Chưa có Gallery khác để nhập.", "There is no other Gallery to import from.")}</p>}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Attach existing Media Sources to a Gallery */}
      <Dialog open={!!addSourcesToGallery} onOpenChange={(open) => !open && setAddSourcesToGallery(null)}>
        <DialogContent className="glass-float max-w-lg rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{c("Thêm nguồn media", "Add Media Sources")}</DialogTitle>
          </DialogHeader>
          {addSourcesToGallery && (() => {
            const gallery = state.folders.find((folder) => folder.id === addSourcesToGallery.galleryId);
            const availableSources = state.sources.filter((source) => !gallery?.sourceIds?.includes(source.id));
            return (
              <>
                <p className="text-sm text-muted-foreground">
                  {c("Chọn một hoặc nhiều Media Source để thêm vào ", "Choose one or more Media Sources to add to ")}<span className="font-medium text-foreground">{gallery?.name ?? "Gallery"}</span>.
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
                  {availableSources.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{c("Không còn Media Source nào để thêm.", "There are no more Media Sources to add.")}</p>}
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
                    {c("Thêm nguồn đã chọn", "Add selected sources")}
                  </button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={noGalleryPasswordConfirmOpen} onOpenChange={(open) => {
        setNoGalleryPasswordConfirmOpen(open);
        if (!open) { setNoGalleryPassword(""); setNoGalleryPasswordError(""); }
      }}>
        <DialogContent className="glass-float rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display">{c("Xác nhận bỏ yêu cầu mật khẩu", "Stop requiring the password")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{c("Nhập mật khẩu ứng dụng để cho phép mở Gallery mà không cần mật khẩu.", "Enter the app password to allow opening Galleries without it.")}</p>
          <input
            autoFocus
            type="password"
            value={noGalleryPassword}
            onChange={(event) => { setNoGalleryPassword(event.target.value); setNoGalleryPasswordError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void confirmNoGalleryPassword(); } }}
            placeholder={t("password")}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {noGalleryPasswordError && <p className="text-xs text-destructive">{noGalleryPasswordError}</p>}
          <DialogFooter className="gap-2">
            <button onClick={() => setNoGalleryPasswordConfirmOpen(false)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">{t("cancel")}</button>
            <button onClick={() => { void confirmNoGalleryPassword(); }} className="rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary">{t("confirm")}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Security dialog */}
      <Dialog open={securityOpen} onOpenChange={(open) => {
        setSecurityOpen(open);
        // Typed passwords never survive a closed dialog.
        if (!open) { setEnableAppLockAfterPassword(false); setPwd(""); setPwdCurrent(""); setPwdConfirm(""); setPwdError(""); }
      }}>
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
              placeholder={t("currentPassword")}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          )}
          <input
            type="password"
            value={pwd}
            onChange={(e) => { setPwd(e.target.value); setPwdError(""); }}
            placeholder={state.password ? t("newPassword") : t("password")}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="password"
            value={pwdConfirm}
            onChange={(e) => { setPwdConfirm(e.target.value); setPwdError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitPassword(); } }}
            placeholder={t("confirmNewPassword")}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {pwdError && <p className="text-xs text-destructive">{pwdError}</p>}
          <DialogFooter className="gap-2">
            {state.password && (
              <button
                onClick={() => { void (async () => {
                  if (await passwordHash(pwdCurrent) !== state.password) { setPwdError(c("Mật khẩu hiện tại không đúng.", "The current password is incorrect.")); return; }
                  onConfirm({
                    title: t("removePassword"),
                    onConfirm: () => {
                      setPassword(null); setAppLockEnabled(false); setRequirePasswordToUnlockGallery(false);
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
              onClick={() => { void submitPassword(); }}
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
