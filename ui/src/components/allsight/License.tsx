import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Copy, CreditCard, KeyRound, Laptop, Loader2, QrCode, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { getInDeckBridge, type BankTransferDetails, type LicenseDevice, type LicenseResult, type LicenseStatus } from "@/lib/indeck/bridge";
import { copyText } from "@/lib/allsight/designer-tools";
import { useAllsight } from "@/lib/allsight/store";
import { cn } from "@/lib/utils";

/**
 * Mosaic is bought once and unlocked for good. Main.js owns the trial clock
 * and the license; this file only shows it: the paywall when the trial is
 * over, the trial reminder in the Sidebar and the license panel in Settings.
 */

export function useLicense() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  useEffect(() => {
    const bridge = getInDeckBridge();
    if (!bridge?.licenseStatus) return;
    let live = true;
    // Without a status the app is shown, so a failed request must not be the
    // last word: ask again until main answers.
    let retry = 0;
    const load = (attempt: number) => {
      void bridge.licenseStatus!().then(
        (value) => { if (live) setStatus(value); },
        () => { if (live) retry = window.setTimeout(() => load(attempt + 1), Math.min(5000, 250 * 2 ** attempt)); },
      );
    };
    load(0);
    const off = bridge.onLicenseChanged?.((value) => setStatus(value));
    return () => { live = false; window.clearTimeout(retry); off?.(); };
  }, []);
  return [status, setStatus] as const;
}

function useCopy() {
  const { state } = useAllsight();
  return (vi: string, en: string) => (state.language === "en" ? en : vi);
}

// Each currency in the way its own buyers write it: 687.000 ₫, ¥171.75, NT$788.
const PRICE_LOCALES: Record<string, string> = { VND: "vi-VN", CNY: "zh-CN", TWD: "zh-TW", JPY: "ja-JP" };

export function formatMoney(amount: number, currency: string) {
  if (!amount) return "";
  // "$" alone is ambiguous outside the US; the app sells worldwide.
  if (currency === "USD") return `US$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
  try {
    return new Intl.NumberFormat(PRICE_LOCALES[currency] ?? "en", { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatPrice(status: LicenseStatus | null) {
  return status?.price ? formatMoney(status.price.amount, status.price.currency) : "";
}

function errorText(result: Extract<LicenseResult, { ok: false }>, c: (vi: string, en: string) => string) {
  switch (result.error) {
    case "empty": return c("Hãy dán mã bản quyền.", "Paste your license key.");
    case "email": return c("Nhập email bạn đã dùng khi mua.", "Enter the email you bought Mosaic with.");
    case "other-machine": return c("Mã này được cấp cho máy khác. Gửi Mã máy bên dưới cho người bán để nhận mã cho máy này.", "This key was issued for another computer. Send the machine code below to the seller to get a key for this one.");
    case "offline": return c("Không kết nối được máy chủ bản quyền. Kiểm tra mạng rồi thử lại.", "The license server could not be reached. Check your connection and try again.");
    case "device-limit": return result.devices?.length
      ? c("Mã này đã dùng trên đủ số máy. Gỡ một máy bên dưới để dùng trên máy này.", "This key is active on its maximum number of computers. Remove one below to use it here.")
      : c("Mã này đã dùng trên đủ số máy. Hãy gỡ kích hoạt ở máy cũ trước.", "This key is already active on its maximum number of devices. Deactivate it on another computer first.");
    case "wrong-product": return c("Mã này không phải của Mosaic.", "This key is not for Mosaic.");
    case "card-keys-unavailable": return c("Bản này chưa nhận mã từ cổng thanh toán thẻ.", "This build does not accept card-checkout keys yet.");
    // A wrong key and a wrong email read the same, as in Eagle.
    default: return c("Mã bản quyền hoặc email không đúng. Hãy dùng đúng email lúc mua.", "The license key or the email is incorrect. Use the email you bought with.");
  }
}

/** Price, what it buys, the checkout button and the key field. */
export function LicensePanel({ status, onStatus, compact = false }: {
  status: LicenseStatus | null;
  onStatus: (status: LicenseStatus) => void;
  compact?: boolean;
}) {
  const c = useCopy();
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"activate" | "deactivate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The computers holding the key's slots, shown when activation hits the limit.
  const [limit, setLimit] = useState<{ devices: LicenseDevice[]; deviceLimit: number | null } | null>(null);
  const bridge = getInDeckBridge();

  const activate = useCallback(async () => {
    if (!bridge?.activateLicense) return;
    setBusy("activate");
    setError(null);
    setLimit(null);
    try {
      const result = await bridge.activateLicense(key, email);
      if (result.ok) {
        onStatus(result.status);
        setKey("");
        toast.success(c("Đã kích hoạt Mosaic. Cảm ơn bạn đã ủng hộ!", "Mosaic is activated. Thank you for your support!"));
      } else {
        setError(errorText(result, c));
        if (result.error === "device-limit" && result.devices) setLimit({ devices: result.devices, deviceLimit: result.deviceLimit ?? null });
      }
    } catch {
      setError(c("Không thể kích hoạt lúc này.", "Unable to activate right now."));
    } finally { setBusy(null); }
  }, [bridge, c, email, key, onStatus]);

  const deactivate = async () => {
    if (!bridge?.deactivateLicense) return;
    setBusy("deactivate");
    setError(null);
    try {
      const result = await bridge.deactivateLicense();
      if (result.ok) onStatus(result.status);
      else setError(errorText(result, c));
    } finally { setBusy(null); }
  };

  const buy = async () => {
    const opened = await bridge?.buyLicense?.().catch(() => false);
    if (!opened) toast.error(c("Trang thanh toán chưa sẵn sàng.", "The checkout page is not available yet."));
  };

  if (!status) return null;

  if (status.license) {
    return (
      <div className="space-y-2 rounded-xl border border-border/70 bg-secondary/40 p-3" data-license-state="licensed">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BadgeCheck className="size-4 text-primary" />
          {c("Đã mua Mosaic — dùng trọn đời", "Mosaic is yours — for life")}
        </div>
        <p className="text-xs text-muted-foreground">
          {status.license.email ? `${status.license.email} · ` : ""}{c("Mã", "Key")} {status.license.keyHint}
        </p>
        <button
          type="button"
          onClick={() => { void deactivate(); }}
          disabled={busy !== null}
          className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-60"
        >
          {busy === "deactivate" ? c("Đang gỡ…", "Deactivating…") : c("Gỡ kích hoạt trên máy này (để chuyển sang máy khác)", "Deactivate on this computer (to move it to another)")}
        </button>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {status.license.source === "server" && <DeviceManager onStatus={onStatus} />}
      </div>
    );
  }

  const perks = [
    c("Thanh toán một lần, không thuê bao", "Pay once, no subscription"),
    c("Mở khoá toàn bộ app, dùng trọn đời", "Unlocks the whole app, for life"),
    status.deviceLimit ? c(`Dùng trên ${status.deviceLimit} máy`, `Use on ${status.deviceLimit} computers`) : null,
    c("Cập nhật miễn phí", "Free updates"),
  ].filter(Boolean) as string[];

  return (
    <div className={cn("space-y-3", !compact && "rounded-2xl border border-border/70 bg-secondary/40 p-4")} data-license-state={status.state}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">{c("Mosaic — bản quyền trọn đời", "Mosaic — lifetime license")}</p>
          <p className="font-display text-2xl font-semibold tabular-nums" data-license-price>{formatPrice(status)}</p>
        </div>
        {status.state === "trial" && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-foreground">
            {c(`Dùng thử còn ${status.trialDaysLeft} ngày`, `${status.trialDaysLeft} trial days left`)}
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {perks.map((perk) => (
          <li key={perk} className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0 text-primary" /> {perk}
          </li>
        ))}
      </ul>
      {/* With a bank transfer on offer, an unconfigured card checkout is not shown at all. */}
      {(status.checkoutAvailable || !status.bankTransferAvailable) && (
        <button
          type="button"
          onClick={() => { void buy(); }}
          disabled={!status.checkoutAvailable}
          title={status.checkoutAvailable ? undefined : c("Chưa cấu hình trang thanh toán", "No checkout page is configured")}
          data-license-buy
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CreditCard className="size-4" />
          {status.bankTransferAvailable
            ? c(`Thanh toán bằng thẻ · ${formatPrice(status)}`, `Pay by card · ${formatPrice(status)}`)
            : c(`Mua ngay · ${formatPrice(status)}`, `Buy now · ${formatPrice(status)}`)}
        </button>
      )}
      {status.bankTransferAvailable && <BankTransfer primary={!status.checkoutAvailable} automatic={status.serverEnabled} email={email} onEmail={setEmail} />}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" htmlFor="mosaic-license-key">
          <KeyRound className="size-3.5" /> {c("Đã có mã bản quyền?", "Already have a license key?")}
        </label>
        <input
          type="email"
          value={email}
          onChange={(event) => { setEmail(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") void activate(); }}
          placeholder={c("Email lúc mua", "Email you bought with")}
          spellCheck={false}
          autoComplete="email"
          data-license-email
          className="w-full rounded-lg border border-border bg-background/60 px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex gap-2">
          <input
            id="mosaic-license-key"
            value={key}
            onChange={(event) => { setKey(event.target.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") void activate(); }}
            placeholder={c("Dán mã vào đây", "Paste the key here")}
            spellCheck={false}
            autoComplete="off"
            data-license-key
            className="min-w-0 flex-1 rounded-lg border border-border bg-background/60 px-3 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => { void activate(); }}
            disabled={busy !== null || !key.trim() || !email.trim()}
            data-license-activate
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/60 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {busy === "activate" && <Loader2 className="size-3.5 animate-spin" />}
            {c("Kích hoạt", "Activate")}
          </button>
        </div>
        {error && <p className="text-xs text-destructive" data-license-error>{error}</p>}
        {limit && (
          <DeviceManager
            initial={limit}
            credentials={{ key, email }}
            onRemoved={() => { setLimit(null); void activate(); }}
          />
        )}
        <LicenseHelp status={status} />
      </div>
    </div>
  );
}

/**
 * The computers a license runs on, with a way to free any of them — what
 * Eagle calls Activated Device Management. Without credentials it manages
 * the license active here.
 */
function DeviceManager({ initial, credentials, onRemoved, onStatus }: {
  initial?: { devices: LicenseDevice[]; deviceLimit: number | null };
  credentials?: { key: string; email: string };
  onRemoved?: () => void;
  onStatus?: (status: LicenseStatus) => void;
}) {
  const c = useCopy();
  const { state } = useAllsight();
  const [devices, setDevices] = useState<LicenseDevice[] | null>(initial?.devices ?? null);
  const [deviceLimit, setDeviceLimit] = useState<number | null>(initial?.deviceLimit ?? null);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (initial) return;
    let live = true;
    void getInDeckBridge()?.licenseDevices?.(credentials).then((answer) => {
      if (!live) return;
      if (answer.ok) { setDevices(answer.devices); setDeviceLimit(answer.deviceLimit); setCurrent(answer.current); } else setFailed(true);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const remove = async (machine: string) => {
    setBusy(machine);
    try {
      const answer = await getInDeckBridge()?.removeLicenseDevice?.(machine, credentials);
      if (!answer?.ok) { toast.error(c("Không gỡ được máy này.", "Unable to remove that computer.")); return; }
      setDevices(answer.devices);
      if ("status" in answer && answer.status) onStatus?.(answer.status);
      onRemoved?.();
    } finally { setBusy(null); }
  };
  const date = (time: number) => new Date(time).toLocaleDateString(state.language === "en" ? "en-GB" : "vi-VN");
  if (failed) return <p className="text-[11px] text-muted-foreground">{c("Không tải được danh sách máy.", "Could not load the computers.")}</p>;
  if (!devices) return <p className="text-[11px] text-muted-foreground">{c("Đang tải danh sách máy…", "Loading computers…")}</p>;
  return (
    <div className="space-y-1.5 pt-1" data-license-devices>
      <p className="text-[11px] font-medium text-muted-foreground">
        {c("Máy đang dùng mã này", "Computers using this key")}{deviceLimit ? ` (${devices.length}/${deviceLimit})` : ""}
      </p>
      {devices.map((device) => (
        <div key={device.machine} className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs" data-license-device={device.machine}>
          <Laptop className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{device.name}{device.machine === current ? ` · ${c("máy này", "this computer")}` : ""}</span>
            <span className="block text-[10px] text-muted-foreground">{device.machine} · {c("dùng lần cuối", "last used")} {date(device.lastSeenAt)}</span>
          </span>
          {device.machine !== current && (
            <button
              type="button"
              onClick={() => { void remove(device.machine); }}
              disabled={busy !== null}
              data-license-remove-device={device.machine}
              className="shrink-0 rounded-md border border-border/70 px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50"
            >
              {busy === device.machine ? c("Đang gỡ…", "Removing…") : c("Gỡ", "Remove")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** The machine code (for bank-transfer keys) and where to find a lost key. */
function LicenseHelp({ status }: { status: LicenseStatus }) {
  const c = useCopy();
  const { state } = useAllsight();
  const recover = async () => {
    const opened = await getInDeckBridge()?.recoverLicense?.().catch(() => false);
    if (!opened) toast.error(c("Trang tra cứu đơn hàng chưa sẵn sàng.", "The order lookup page is not available."));
  };
  return (
    <div className="space-y-1 pt-1 text-[11px] text-muted-foreground">
      {status.machineCode && (
        <p className="flex items-center gap-1.5">
          {c("Mã máy", "Machine code")}:
          <button
            type="button"
            onClick={() => { void copyText(status.machineCode!, state.language, c("mã máy", "the machine code")); }}
            title={c("Sao chép mã máy", "Copy the machine code")}
            data-license-machine-code
            className="inline-flex items-center gap-1 font-mono font-medium text-foreground hover:text-primary"
          >
            {status.machineCode} <Copy className="size-3 opacity-60" />
          </button>
        </p>
      )}
      {status.recoverAvailable && (
        <button type="button" onClick={() => { void recover(); }} data-license-recover className="underline-offset-2 hover:text-foreground hover:underline">
          {c("Quên mã? Xem lại đơn hàng đã mua bằng thẻ", "Lost your key? Look up your card order")}
        </button>
      )}
      {status.supportContact && (
        <p>{c(`Mua bằng chuyển khoản hoặc cần đổi máy? Liên hệ ${status.supportContact}.`, `Paid by bank transfer, or moving to another computer? Contact ${status.supportContact}.`)}</p>
      )}
    </div>
  );
}

/**
 * Pay by bank transfer with any Vietnamese banking app: scan the VietQR code
 * (amount and description filled in) or type the details. The seller matches
 * the transfer by its description and sends back a MOSAIC- key.
 */
function BankTransfer({ primary, automatic, email, onEmail }: { primary: boolean; automatic: boolean; email: string; onEmail: (email: string) => void }) {
  const c = useCopy();
  const { state } = useAllsight();
  const [details, setDetails] = useState<BankTransferDetails | null>(null);
  const [open, setOpen] = useState(false);
  const [needEmail, setNeedEmail] = useState(false);
  const show = async () => {
    // With a license server the order is opened for an email, which is
    // where the purchase belongs and what the key will be bound to.
    if (automatic && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setNeedEmail(true); return; }
    setNeedEmail(false);
    setOpen(true);
    if (details) return;
    const next = await getInDeckBridge()?.bankTransfer?.(email.trim()).catch(() => null);
    if (next && !("error" in next)) setDetails(next);
    else {
      setOpen(false);
      toast.error(next && "error" in next && next.error === "offline"
        ? c("Không kết nối được máy chủ bản quyền.", "The license server could not be reached.")
        : c("Không tạo được mã chuyển khoản.", "Unable to prepare the bank transfer."));
    }
  };
  // The server matches the payment; ask every few seconds while this is
  // open. Main activates the key itself and broadcasts the new status.
  useEffect(() => {
    if (!details?.automatic) return;
    let live = true;
    const timer = window.setInterval(() => {
      void getInDeckBridge()?.licenseOrderStatus?.(details.order, email.trim()).then((answer) => {
        if (!live || !answer.ok || answer.status !== "paid") return;
        window.clearInterval(timer);
        toast.success(c("Đã nhận thanh toán — Mosaic đã được mở khoá. Cảm ơn bạn!", "Payment received — Mosaic is unlocked. Thank you!"));
      }).catch(() => {});
    }, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [c, details, email]);
  if (needEmail && !open) {
    return (
      <div className="space-y-2 rounded-xl border border-border/70 bg-background/50 p-3">
        <p className="text-xs text-muted-foreground">{c("Nhập email để nhận bản quyền (dùng khi kích hoạt lại):", "Enter the email the license will belong to (used to activate again):")}</p>
        <input
          type="email"
          value={email}
          onChange={(event) => onEmail(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void show(); }}
          placeholder="email@example.com"
          data-license-bank-email
          className="w-full rounded-lg border border-border bg-background/60 px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="button" onClick={() => { void show(); }} data-license-bank-continue className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary">
          <QrCode className="size-4" /> {c("Tạo mã chuyển khoản", "Create the transfer")}
        </button>
      </div>
    );
  }
  const copy = (text: string, what: string) => { void copyText(text, state.language, what); };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { void show(); }}
        data-license-bank
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
          primary ? "bg-primary/90 text-primary-foreground hover:bg-primary" : "border border-border/70 bg-background/60 hover:bg-accent",
        )}
      >
        <QrCode className="size-4" /> {c("Chuyển khoản ngân hàng (VietQR)", "Bank transfer (VietQR)")}
      </button>
    );
  }
  if (!details) return <p className="text-center text-xs text-muted-foreground">{c("Đang tạo mã…", "Preparing…")}</p>;
  const row = (label: string, value: string, what: string) => (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <button type="button" onClick={() => copy(value, what)} title={c("Sao chép", "Copy")} className="inline-flex min-w-0 items-center gap-1 font-medium tabular-nums hover:text-primary">
        <span className="truncate">{value}</span> <Copy className="size-3 shrink-0 opacity-60" />
      </button>
    </div>
  );
  return (
    <div className="space-y-2.5 rounded-xl border border-border/70 bg-background/50 p-3" data-license-bank-details>
      <img src={details.qr} alt="VietQR" className="mx-auto size-44 rounded-lg bg-white p-1.5" data-license-qr />
      <div className="space-y-1">
        {details.bankName && row(c("Ngân hàng", "Bank"), details.bankName, c("tên ngân hàng", "the bank name"))}
        {row(c("Số tài khoản", "Account"), details.accountNumber, c("số tài khoản", "the account number"))}
        {details.accountName && row(c("Chủ tài khoản", "Holder"), details.accountName, c("tên chủ tài khoản", "the holder"))}
        {row(c("Số tiền", "Amount"), formatMoney(details.amount, details.currency), c("số tiền", "the amount"))}
        {row(c("Nội dung", "Description"), details.content, c("nội dung chuyển khoản", "the description"))}
      </div>
      {details.automatic ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground" data-license-bank-waiting>
          <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" />
          {c(
            `Quét mã bằng app ngân hàng, giữ nguyên nội dung "${details.content}". Mosaic tự mở khoá khi nhận được tiền (thường trong 1–2 phút) — cứ để cửa sổ này mở. Bản quyền thuộc về ${email.trim()}.`,
            `Scan with your banking app and keep the description "${details.content}". Mosaic unlocks by itself once the payment arrives (usually within a minute or two) — keep this window open. The license belongs to ${email.trim()}.`,
          )}
        </p>
      ) : (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {c(
          `Quét mã bằng app ngân hàng, giữ nguyên nội dung "${details.content}". Sau khi chuyển, gửi nội dung này cùng email của bạn và Mã máy (bên dưới)${details.contact ? ` tới ${details.contact}` : ""} để nhận mã bản quyền cho máy này, rồi nhập email và mã vào ô bên dưới.`,
          `Scan with your banking app and keep the description "${details.content}". Once paid, send that description with your email and the machine code (below)${details.contact ? ` to ${details.contact}` : ""} to receive a key for this computer, then enter the email and key below.`,
        )}
      </p>
      )}
    </div>
  );
}

/** Shown instead of the app once the trial is over. The Library is untouched. */
export function LicensePaywall({ status, onStatus }: { status: LicenseStatus; onStatus: (status: LicenseStatus) => void }) {
  const c = useCopy();
  return (
    <div className="flex flex-1 items-center justify-center overflow-auto bg-background px-4 py-8" data-license-paywall>
      <div className="glass-panel w-full max-w-md space-y-5 rounded-2xl p-8">
        <div className="space-y-2 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-xl bg-primary/85 text-primary-foreground">
            <Sparkles className="size-5" />
          </span>
          <h1 className="font-display text-xl font-semibold">{c("Hết thời gian dùng thử", "Your trial has ended")}</h1>
          <p className="text-sm text-muted-foreground">
            {c(
              `Cảm ơn bạn đã dùng thử Mosaic ${status.trialDays} ngày. Mua một lần để tiếp tục — thư viện, Gallery và thẻ của bạn vẫn còn nguyên.`,
              `Thanks for trying Mosaic for ${status.trialDays} days. Buy it once to keep going — your Library, Galleries and tags are all still here.`,
            )}
          </p>
        </div>
        <LicensePanel status={status} onStatus={onStatus} compact />
      </div>
    </div>
  );
}
