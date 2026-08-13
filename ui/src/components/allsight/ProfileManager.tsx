import { useCallback, useEffect, useState } from "react";
import { FolderCog, FolderOpen, Keyboard, LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, Star, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getInDeckBridge, type InDeckProfile } from "@/lib/indeck/bridge";
import { useAllsight } from "@/lib/allsight/store";
import { cn } from "@/lib/utils";

const inputClass = "w-full rounded-xl border border-border/70 bg-background/55 px-3 py-2 text-sm outline-none transition focus:border-primary/55 focus:ring-2 focus:ring-ring";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizedProfileName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function LibraryLocationSetup({ profile, onConfigured }: { profile: InDeckProfile; onConfigured: () => void }) {
  const { state } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  const [folder, setFolder] = useState("");
  const [status, setStatus] = useState<{ mediaPath: string; exists: boolean; sharedWith: Array<{ id: string; name: string }> } | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  const chooseFolder = async () => {
    const bridge = getInDeckBridge();
    if (!bridge) return;
    const selected = await bridge.pickFolder();
    if (!selected) return;
    setFolder(selected);
    setStatus(null);
    setChecking(true);
    try {
      setStatus(await bridge.libraryLocationStatus(profile.id, selected));
    } catch (error) {
      toast.error(errorMessage(error, c("Không thể kiểm tra vị trí Library.", "Could not check the Library location.")));
    } finally {
      setChecking(false);
    }
  };

  const configure = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !folder) return;
    setSaving(true);
    try {
      await bridge.configureProfileLibrary(profile.id, folder, Boolean(status?.exists));
      toast.success(c("Default Library Location đã sẵn sàng.", "Default Library Location is ready."));
      onConfigured();
    } catch (error) {
      toast.error(errorMessage(error, c("Không thể thiết lập Library.", "Could not configure the Library.")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="glass-float max-w-xl rounded-3xl p-0 [&>button]:hidden sm:max-w-xl" onEscapeKeyDown={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
        <div className="border-b border-border/60 bg-primary/[0.07] px-6 py-5">
          <div className="flex items-start gap-3 pr-7">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-primary/25 bg-primary/15 text-primary"><FolderCog className="size-5" /></span>
            <div>
              <DialogTitle className="font-display text-xl">{c("Thiết lập Default Library Location", "Set up Default Library Location")}</DialogTitle>
              <DialogDescription className="mt-1.5 leading-relaxed">{c("Chọn nơi đặt Library cho profile ", "Choose the Library location for profile ")}<b className="text-foreground">{profile.name}</b>. {c("App sẽ tạo folder ", "Mosaic will create ")}<b className="text-foreground">MosaicMedia_{profile.name}</b>{c(" bên trong vị trí bạn chọn; Extension chỉ thấy profile này sau khi hoàn tất.", " inside that location; the Extension can use this profile once setup is complete.")}</DialogDescription>
            </div>
          </div>
        </div>
        <div className="space-y-4 px-6 pb-2">
          <button onClick={() => void chooseFolder()} disabled={checking || saving} className="glass-btn flex w-full items-center gap-3 rounded-2xl p-3 text-left disabled:cursor-not-allowed disabled:opacity-55">
            <span className="grid size-9 place-items-center rounded-xl bg-secondary/80 text-muted-foreground"><FolderOpen className="size-4" /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{c("Chọn nơi tạo MosaicMedia", "Choose where to create MosaicMedia")}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{folder || (state.language === "en" ? `Example: D:\\Media → D:\\Media\\MosaicMedia_${profile.name}` : `Ví dụ: D:\\Media → D:\\Media\\MosaicMedia_${profile.name}`)}</span></span>
            {checking && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          </button>
          {status && (
            <div className="rounded-2xl border border-border/60 bg-secondary/35 p-3 text-sm">
              <p className="font-medium">{status.exists ? c("Đã tìm thấy MosaicMedia", "Found MosaicMedia") : c("Sẽ tạo MosaicMedia mới", "A new MosaicMedia will be created")}</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">{status.mediaPath}</p>
              {status.sharedWith.length > 0 && <p className="mt-2 text-xs text-primary">{c("Dùng chung toàn bộ media với: ", "Shares all media with: ")}{status.sharedWith.map((item) => item.name).join(", ")}.</p>}
              {status.exists && status.sharedWith.length === 0 && <p className="mt-2 text-xs text-amber-600 dark:text-amber-300">{c("Xác nhận bên dưới để dùng Library MosaicMedia đã có sẵn.", "Confirm below to use this existing MosaicMedia Library.")}</p>}
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-border/60 px-6 py-4">
          <button disabled={!folder || checking || saving} onClick={() => void configure()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary/90 px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary disabled:cursor-not-allowed disabled:opacity-45">
            {saving && <LoaderCircle className="size-4 animate-spin" />}{status?.exists ? c("Dùng MosaicMedia này", "Use this MosaicMedia") : c("Tạo MosaicMedia", "Create MosaicMedia")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProfileManager({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  const [profiles, setProfiles] = useState<InDeckProfile[]>([]);
  const [discarded, setDiscarded] = useState<InDeckProfile[]>([]);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState<string | null>(null);
  const [rename, setRename] = useState<InDeckProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InDeckProfile | null>(null);
  const [typedName, setTypedName] = useState("");
  const [replacementId, setReplacementId] = useState("");
  const [working, setWorking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const bridge = getInDeckBridge();
    if (!bridge) return;
    try {
      const [nextProfiles, nextDiscarded] = await Promise.all([bridge.listProfiles(), bridge.listDiscardedProfiles()]);
      setProfiles(nextProfiles);
      setDiscarded(nextDiscarded);
    } catch (error) {
      toast.error(errorMessage(error, c("Không thể tải danh sách profile.", "Could not load profiles.")));
    }
  }, []);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const profileNameExists = (value: string) => {
    const normalized = normalizedProfileName(value);
    return Boolean(normalized) && profiles.some((profile) => normalizedProfileName(profile.name) === normalized);
  };

  const updateNewName = (value: string) => {
    setNewName(value);
    setNewNameError(profileNameExists(value)
      ? c("Tên profile này đã tồn tại.", "A profile with this name already exists.")
      : null);
  };

  const create = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !newName.trim()) return;
    if (profileNameExists(newName)) {
      setNewNameError(c("Tên profile này đã tồn tại.", "A profile with this name already exists."));
      return;
    }
    setWorking("create");
    try {
      const profile = await bridge.createProfile(newName);
      setNewName("");
      setNewNameError(null);
      await bridge.openProfile(profile.id);
      toast.success(c("Đã mở profile mới. Hãy chọn Default Library Location trong cửa sổ đó.", "The new profile is open. Choose its Default Library Location in that window."));
      await refresh();
    } catch (error) {
      if (/profile with this name already exists/i.test(errorMessage(error, ""))) {
        setNewNameError(c("Tên profile này đã tồn tại.", "A profile with this name already exists."));
      } else {
        toast.error(errorMessage(error, c("Không thể tạo profile.", "Could not create profile.")));
      }
    }
    finally { setWorking(null); }
  };

  const updateName = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !rename?.name.trim()) return;
    setWorking(`rename:${rename.id}`);
    try { await bridge.renameProfile(rename.id, rename.name); setRename(null); await refresh(); toast.success(c("Đã đổi tên profile.", "Profile renamed.")); }
    catch (error) { toast.error(errorMessage(error, c("Không thể đổi tên profile.", "Could not rename profile."))); }
    finally { setWorking(null); }
  };

  const deleteProfile = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !deleteTarget) return;
    setWorking(`delete:${deleteTarget.id}`);
    try {
      await bridge.deleteProfile(deleteTarget.id, typedName, deleteTarget.isDefault ? replacementId : null);
      setDeleteTarget(null); setTypedName(""); setReplacementId(""); await refresh();
      toast.success(c("Profile đã được chuyển vào Profile Discard Pile. File Library vẫn được giữ nguyên.", "Profile moved to the Profile Discard Pile. Library files are kept."));
    } catch (error) { toast.error(errorMessage(error, c("Không thể xóa profile.", "Could not delete profile."))); }
    finally { setWorking(null); }
  };

  const action = async (key: string, operation: () => Promise<unknown>, success: string) => {
    setWorking(key);
    try { await operation(); toast.success(success); await refresh(); }
    catch (error) { toast.error(errorMessage(error, c("Thao tác không thành công.", "The action could not be completed."))); }
    finally { setWorking(null); }
  };

  const discardedIds = new Set(discarded.map((profile) => profile.id));
  const activeProfiles = profiles
    .filter((profile) => !discardedIds.has(profile.id))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-float max-h-[86vh] max-w-3xl overflow-y-auto rounded-3xl p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/60 bg-secondary/20 px-6 py-5 pr-14">
          <DialogTitle className="flex items-center gap-3 font-display text-xl"><span className="grid size-10 place-items-center rounded-2xl bg-primary/14 text-primary"><UserRound className="size-5" /></span>{c("Quản lý Profile", "Manage Profiles")}</DialogTitle>
          <DialogDescription>{c("Mỗi Profile có Library và dữ liệu ứng dụng riêng. Các Profile dùng chung MosaicMedia sẽ dùng chung toàn bộ media.", "Each Profile has its own Library and app data. Profiles that use the same MosaicMedia share all media.")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 px-6 py-5">
          <section className="rounded-2xl border border-border/65 bg-secondary/25 p-3">
            <p className="mb-2 text-sm font-medium">{c("Tạo Profile mới", "Create Profile")}</p>
            <div className="space-y-1.5"><div className="flex gap-2"><input value={newName} onChange={(event) => updateNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder={c("Tên Profile", "Profile name")} aria-invalid={Boolean(newNameError)} className={`${inputClass} ${newNameError ? "border-destructive/70 focus:border-destructive focus:ring-destructive/25" : ""}`} /><button onClick={() => void create()} disabled={!newName.trim() || working === "create"} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary/90 px-3.5 text-sm font-medium text-primary-foreground disabled:opacity-45"><Plus className="size-4" />{c("Tạo", "Create")}</button></div>{newNameError && <p role="alert" className="px-1 text-xs text-destructive">{newNameError}</p>}</div>
          </section>
          <section className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{c("Profile khả dụng", "Available Profiles")}</p>
            {activeProfiles.map((profile) => <div key={profile.id} className="glass-panel rounded-2xl p-3.5">
              <div className="flex flex-wrap items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary"><UserRound className="size-4" /></span>
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold">{profile.name}</p>{profile.isDefault && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">{c("MẶC ĐỊNH", "DEFAULT")}</span>}</div><p className="mt-1 break-all text-xs text-muted-foreground">{profile.initialized ? profile.mediaPath : c("Chưa chọn Default Library Location", "Default Library Location is not selected")}</p></div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {!profile.isDefault && <button onClick={() => void action(`default:${profile.id}`, () => getInDeckBridge()!.setDefaultProfile(profile.id), c(`“${profile.name}” đã là Profile mặc định.`, `“${profile.name}” is now the default Profile.`))} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><Star className="size-3.5" />{c("Đặt làm mặc định", "Set as default")}</button>}
                  <button onClick={() => void action(`open:${profile.id}`, () => getInDeckBridge()!.openProfile(profile.id), c("Đã mở Profile.", "Profile opened."))} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><FolderOpen className="size-3.5" />{c("Mở", "Open")}</button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border/50 pt-3">
                <button onClick={() => setRename({ ...profile })} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><Pencil className="size-3.5" />{c("Đổi tên", "Rename")}</button>
                <button onClick={() => void action(`shortcut:${profile.id}`, () => getInDeckBridge()!.createProfileShortcut(profile.id), c("Đã tạo lại lối tắt Profile.", "Profile shortcut recreated."))} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><Keyboard className="size-3.5" />{c("Tạo lại lối tắt", "Recreate shortcut")}</button>
                {profile.initialized && <button onClick={() => void action(`recover:${profile.id}`, () => getInDeckBridge()!.recoverProfileLibrary(profile.id), c("Đã kiểm tra và khôi phục phần Library bị thiếu.", "The Library was checked and repaired."))} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><RefreshCw className={cn("size-3.5", working === `recover:${profile.id}` && "animate-spin")} />{c("Khôi phục Library", "Recover Library")}</button>}
                <button disabled={activeProfiles.length < 2} onClick={() => { setDeleteTarget(profile); setTypedName(""); setReplacementId(""); }} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/25 px-2.5 text-xs text-destructive transition hover:bg-destructive hover:text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" />{c("Xóa", "Delete")}</button>
              </div>
            </div>)}
          </section>
          <section className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{c("Thùng rác Profile", "Profile Discard Pile")}</p>
            {discarded.length === 0 ? <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">{c("Chưa có Profile đã xóa.", "No deleted Profiles.")}</p> : discarded.map((profile) => <div key={profile.id} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-secondary/25 p-3"><RotateCcw className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{profile.name}</p><p className="truncate text-xs text-muted-foreground">{profile.mediaPath || c("Chưa thiết lập Library", "Library is not configured")}</p></div><button onClick={() => void action(`restore:${profile.id}`, () => getInDeckBridge()!.recoverProfile(profile.id), c("Đã khôi phục Profile.", "Profile restored."))} className="glass-btn h-8 rounded-lg px-2.5 text-xs">{c("Khôi phục", "Restore")}</button></div>)}
          </section>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(rename)} onOpenChange={(isOpen) => { if (!isOpen) setRename(null); }}><DialogContent className="glass-float rounded-2xl"><DialogHeader><DialogTitle className="font-display">{c("Đổi tên Profile", "Rename Profile")}</DialogTitle></DialogHeader><input autoFocus value={rename?.name ?? ""} onChange={(event) => setRename((value) => value ? { ...value, name: event.target.value } : value)} className={inputClass} /><DialogFooter><button onClick={() => void updateName()} disabled={!rename?.name.trim() || working?.startsWith("rename:")} className="rounded-xl bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground">{c("Lưu tên mới", "Save new name")}</button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(deleteTarget)} onOpenChange={(isOpen) => { if (!isOpen) setDeleteTarget(null); }}><DialogContent className="glass-float rounded-2xl"><DialogHeader><DialogTitle className="font-display text-destructive">{c("Xóa Profile", "Delete Profile")}</DialogTitle><DialogDescription>{c("File dữ liệu và MosaicMedia không bị xóa; Profile sẽ vào Thùng rác Profile để có thể khôi phục.", "Data files and MosaicMedia are kept; the Profile moves to the Profile Discard Pile and can be restored.")}</DialogDescription></DialogHeader>{deleteTarget?.isDefault && <label className="space-y-1.5 text-sm"><span>{c("Mặc định thay thế", "Replacement default")}</span><select value={replacementId} onChange={(event) => setReplacementId(event.target.value)} className={inputClass}><option value="">{c("Chọn Profile", "Select a Profile")}</option>{activeProfiles.filter((profile) => profile.id !== deleteTarget.id).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}<label className="space-y-1.5 text-sm"><span>{c("Nhập", "Type")} <b>{deleteTarget?.name}</b> {c("để xác nhận", "to confirm")}</span><input autoFocus value={typedName} onChange={(event) => setTypedName((event.target as HTMLInputElement).value)} className={inputClass} /></label><DialogFooter className="gap-2"><button onClick={() => setDeleteTarget(null)} className="glass-btn rounded-xl px-4 py-2 text-sm">{c("Hủy", "Cancel")}</button><button onClick={() => void deleteProfile()} disabled={!typedName.trim() || Boolean(deleteTarget?.isDefault && !replacementId) || working?.startsWith("delete:")} className="rounded-xl bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-45">{c("Chuyển vào Thùng rác Profile", "Move to Profile Discard Pile")}</button></DialogFooter></DialogContent></Dialog>
  </>;
}
