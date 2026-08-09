import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Locked-collection treatment: dark rounded frame, the cover blurred underneath
 * and a frosted glass padlock floating in the middle.
 */
export function LockOverlay({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const icon = size === "sm" ? "size-3" : size === "lg" ? "size-10" : "size-7";
  // The lock is deliberately only the glyph.  A locked Gallery still shows
  // its dimmed cover; this overlay must never introduce a pad, fill or border.
  return <Lock className={cn("pointer-events-none absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-white/95 drop-shadow-[0_2px_4px_rgb(0_0_0_/_0.85)]", icon, className)} />;
}
