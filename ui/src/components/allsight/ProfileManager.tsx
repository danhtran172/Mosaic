import { useCallback, useEffect, useState } from "react";
import { FolderCog, FolderOpen, Keyboard, LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, Star, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getInDeckBridge, type InDeckProfile } from "@/lib/indeck/bridge";
import { cn } from "@/lib/utils";

const inputClass = "w-full rounded-xl border border-border/70 bg-background/55 px-3 py-2 text-sm outline-none transition focus:border-primary/55 focus:ring-2 focus:ring-ring";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function LibraryLocationSetup({ profile, onConfigured }: { profile: InDeckProfile; onConfigured: () => void }) {
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
      toast.error(errorMessage(error, "Không thể kiểm tra vị trí Library."));
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
      toast.success("Default Library Location đã sẵn sàng.");
      onConfigured();
    } catch (error) {
      toast.error(errorMessage(error, "Không thể thiết lập Library."));
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
              <DialogTitle className="font-display text-xl">Thiết lập Default Library Location</DialogTitle>
              <DialogDescription className="mt-1.5 leading-relaxed">Chọn nơi đặt Library cho profile <b className="text-foreground">{profile.name}</b>. App sẽ tạo folder <b className="text-foreground">InDeckMedia_{profile.name}</b> bên trong vị trí bạn chọn; Extension chỉ thấy profile này sau khi hoàn tất.</DialogDescription>
            </div>
          </div>
        </div>
        <div className="space-y-4 px-6 pb-2">
          <button onClick={() => void chooseFolder()} disabled={checking || saving} className="glass-btn flex w-full items-center gap-3 rounded-2xl p-3 text-left disabled:cursor-not-allowed disabled:opacity-55">
            <span className="grid size-9 place-items-center rounded-xl bg-secondary/80 text-muted-foreground"><FolderOpen className="size-4" /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">Chọn nơi tạo InDeckMedia</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{folder || `Ví dụ: D:\\Media → D:\\Media\\InDeckMedia_${profile.name}`}</span></span>
            {checking && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          </button>
          {status && (
            <div className="rounded-2xl border border-border/60 bg-secondary/35 p-3 text-sm">
              <p className="font-medium">{status.exists ? "Đã tìm thấy InDeckMedia" : "Sẽ tạo InDeckMedia mới"}</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">{status.mediaPath}</p>
              {status.sharedWith.length > 0 && <p className="mt-2 text-xs text-primary">Dùng chung toàn bộ media với: {status.sharedWith.map((item) => item.name).join(", ")}.</p>}
              {status.exists && status.sharedWith.length === 0 && <p className="mt-2 text-xs text-amber-600 dark:text-amber-300">Xác nhận bên dưới để dùng Library InDeckMedia đã có sẵn.</p>}
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-border/60 px-6 py-4">
          <button disabled={!folder || checking || saving} onClick={() => void configure()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary/90 px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary disabled:cursor-not-allowed disabled:opacity-45">
            {saving && <LoaderCircle className="size-4 animate-spin" />}{status?.exists ? "Dùng InDeckMedia này" : "Tạo InDeckMedia"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProfileManager({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [profiles, setProfiles] = useState<InDeckProfile[]>([]);
  const [discarded, setDiscarded] = useState<InDeckProfile[]>([]);
  const [newName, setNewName] = useState("");
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
      toast.error(errorMessage(error, "Không thể tải danh sách profile."));
    }
  }, []);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const create = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !newName.trim()) return;
    setWorking("create");
    try {
      const profile = await bridge.createProfile(newName);
      setNewName("");
      await bridge.openProfile(profile.id);
      toast.success("Đã mở profile mới. Hãy chọn Default Library Location trong cửa sổ đó.");
      await refresh();
    } catch (error) { toast.error(errorMessage(error, "Không thể tạo profile.")); }
    finally { setWorking(null); }
  };

  const updateName = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !rename?.name.trim()) return;
    setWorking(`rename:${rename.id}`);
    try { await bridge.renameProfile(rename.id, rename.name); setRename(null); await refresh(); toast.success("Đã đổi tên profile."); }
    catch (error) { toast.error(errorMessage(error, "Không thể đổi tên profile.")); }
    finally { setWorking(null); }
  };

  const deleteProfile = async () => {
    const bridge = getInDeckBridge();
    if (!bridge || !deleteTarget) return;
    setWorking(`delete:${deleteTarget.id}`);
    try {
      await bridge.deleteProfile(deleteTarget.id, typedName, deleteTarget.isDefault ? replacementId : null);
      setDeleteTarget(null); setTypedName(""); setReplacementId(""); await refresh();
      toast.success("Profile đã được chuyển vào Profile Discard Pile. File Library vẫn được giữ nguyên.");
    } catch (error) { toast.error(errorMessage(error, "Không thể xóa profile.")); }
    finally { setWorking(null); }
  };

  const action = async (key: string, operation: () => Promise<unknown>, success: string) => {
    setWorking(key);
    try { await operation(); toast.success(success); await refresh(); }
    catch (error) { toast.error(errorMessage(error, "Thao tác không thành công.")); }
    finally { setWorking(null); }
  };

  const discardedIds = new Set(discarded.map((profile) => profile.id));
  const activeProfiles = profiles.filter((profile) => !discardedIds.has(profile.id));

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-float max-h-[86vh] max-w-3xl overflow-y-auto rounded-3xl p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/60 bg-secondary/20 px-6 py-5 pr-14">
          <DialogTitle className="flex items-center gap-3 font-display text-xl"><span className="grid size-10 place-items-center rounded-2xl bg-primary/14 text-primary"><UserRound className="size-5" /></span>Quản lý Profile</DialogTitle>
          <DialogDescription>Profile có Library và dữ liệu ứng dụng riêng. Các profile dùng cùng một InDeckMedia sẽ dùng chung toàn bộ media.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 px-6 py-5">
          <section className="rounded-2xl border border-border/65 bg-secondary/25 p-3">
            <p className="mb-2 text-sm font-medium">Tạo profile mới</p>
            <div className="flex gap-2"><input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="Tên profile" className={inputClass} /><button onClick={() => void create()} disabled={!newName.trim() || working === "create"} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary/90 px-3.5 text-sm font-medium text-primary-foreground disabled:opacity-45"><Plus className="size-4" />Tạo</button></div>
          </section>
          <section className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Profile khả dụng</p>
            {activeProfiles.map((profile) => <div key={profile.id} className="glass-panel rounded-2xl p-3.5">
              <div className="flex flex-wrap items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary"><UserRound className="size-4" /></span>
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold">{profile.name}</p>{profile.isDefault && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">DEFAULT</span>}</div><p className="mt-1 break-all text-xs text-muted-foreground">{profile.initialized ? profile.mediaPath : "Chưa chọn Default Library Location"}</p></div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {!profile.isDefault && <button onClick={() => void action(`default:${profile.id}`, () => getInDeckBridge()!.setDefaultProfile(profile.id), `“${profile.name}” đã là Default profile.`)} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><Star className="size-3.5" />Đặt làm Default</button>}
                  <button onClick={() => void action(`open:${profile.id}`, () => getInDeckBridge()!.openProfile(profile.id), "Đã mở profile.")} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><FolderOpen className="size-3.5" />Mở</button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border/50 pt-3">
                <button onClick={() => setRename({ ...profile })} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><Pencil className="size-3.5" />Đổi tên</button>
                <button onClick={() => void action(`shortcut:${profile.id}`, () => getInDeckBridge()!.createProfileShortcut(profile.id), "Đã tạo lại shortcut profile.")} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><Keyboard className="size-3.5" />Tạo lại shortcut</button>
                {profile.initialized && <button onClick={() => void action(`recover:${profile.id}`, () => getInDeckBridge()!.recoverProfileLibrary(profile.id), "Đã kiểm tra và bù phần Library bị thiếu.")} className="glass-btn inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs"><RefreshCw className={cn("size-3.5", working === `recover:${profile.id}` && "animate-spin")} />Recover Library</button>}
                <button disabled={activeProfiles.length < 2} onClick={() => { setDeleteTarget(profile); setTypedName(""); setReplacementId(""); }} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/25 px-2.5 text-xs text-destructive transition hover:bg-destructive hover:text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" />Xóa</button>
              </div>
            </div>)}
          </section>
          <section className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Profile Discard Pile</p>
            {discarded.length === 0 ? <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">Chưa có profile đã xóa.</p> : discarded.map((profile) => <div key={profile.id} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-secondary/25 p-3"><RotateCcw className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{profile.name}</p><p className="truncate text-xs text-muted-foreground">{profile.mediaPath || "Chưa thiết lập Library"}</p></div><button onClick={() => void action(`restore:${profile.id}`, () => getInDeckBridge()!.recoverProfile(profile.id), "Đã khôi phục profile.")} className="glass-btn h-8 rounded-lg px-2.5 text-xs">Khôi phục</button></div>)}
          </section>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(rename)} onOpenChange={(isOpen) => { if (!isOpen) setRename(null); }}><DialogContent className="glass-float rounded-2xl"><DialogHeader><DialogTitle className="font-display">Đổi tên profile</DialogTitle></DialogHeader><input autoFocus value={rename?.name ?? ""} onChange={(event) => setRename((value) => value ? { ...value, name: event.target.value } : value)} className={inputClass} /><DialogFooter><button onClick={() => void updateName()} disabled={!rename?.name.trim() || working?.startsWith("rename:")} className="rounded-xl bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground">Lưu tên mới</button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(deleteTarget)} onOpenChange={(isOpen) => { if (!isOpen) setDeleteTarget(null); }}><DialogContent className="glass-float rounded-2xl"><DialogHeader><DialogTitle className="font-display text-destructive">Xóa profile</DialogTitle><DialogDescription>File dữ liệu và InDeckMedia không bị xóa; profile sẽ vào Profile Discard Pile để có thể khôi phục.</DialogDescription></DialogHeader>{deleteTarget?.isDefault && <label className="space-y-1.5 text-sm"><span>Default thay thế</span><select value={replacementId} onChange={(event) => setReplacementId(event.target.value)} className={inputClass}><option value="">Chọn profile</option>{activeProfiles.filter((profile) => profile.id !== deleteTarget.id).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>}<label className="space-y-1.5 text-sm"><span>Nhập <b>{deleteTarget?.name}</b> để xác nhận</span><input autoFocus value={typedName} onChange={(event) => setTypedName((event.target as HTMLInputElement).value)} className={inputClass} /></label><DialogFooter className="gap-2"><button onClick={() => setDeleteTarget(null)} className="glass-btn rounded-xl px-4 py-2 text-sm">Hủy</button><button onClick={() => void deleteProfile()} disabled={!typedName.trim() || Boolean(deleteTarget?.isDefault && !replacementId) || working?.startsWith("delete:")} className="rounded-xl bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-45">Chuyển vào Discard Pile</button></DialogFooter></DialogContent></Dialog>
  </>;
}
