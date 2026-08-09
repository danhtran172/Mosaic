import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/lib/allsight/i18n";

export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Require the user to type this name before a destructive Property removal. */
  confirmText?: string;
  onConfirm: () => void;
}

export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");
  useEffect(() => { if (!request) setTyped(""); }, [request]);
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
  const requiresText = Boolean(request?.confirmText);
  const matches = !requiresText || normalize(typed) === normalize(request?.confirmText ?? "");
  return (
    <AlertDialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="glass-float rounded-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display">{request?.title ?? t("areYouSure")}</AlertDialogTitle>
          <AlertDialogDescription>{request?.description ?? t("destructiveHint")}</AlertDialogDescription>
          {requiresText && <input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={request?.confirmText} className="mt-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-lg">{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!matches}
            onClick={() => {
              request?.onConfirm();
              onClose();
            }}
          >
            {request?.confirmLabel ?? t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
import { useEffect, useState } from "react";
