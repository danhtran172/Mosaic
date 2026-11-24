import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "@/lib/allsight/types";
import { cn } from "@/lib/utils";

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// Long enough that sweeping the pointer across a Gallery does not start a
// decoder in every card it passes over.
const HOVER_DELAY_MS = 350;

/**
 * Hover a video card to play it muted in place; moving the pointer across the
 * card scrubs through it. Only the hovered card holds a <video>, and it is
 * unmounted on leave, so a Gallery never keeps more than one decoder open.
 * Clicks, double clicks and drags bubble to the card underneath unchanged.
 */
export function VideoHoverPreview({ media, compact }: { media: MediaItem; compact: boolean }) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: media.duration || 0 });
  const video = useRef<HTMLVideoElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const scrubFrame = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (scrubFrame.current) cancelAnimationFrame(scrubFrame.current);
  }, []);

  const stop = () => {
    window.clearTimeout(timer.current);
    setActive(false);
    setPlaying(false);
    setProgress({ current: 0, duration: media.duration || 0 });
  };

  const scrub = (clientX: number, element: HTMLElement) => {
    const player = video.current;
    if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return;
    const box = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width)));
    if (scrubFrame.current) cancelAnimationFrame(scrubFrame.current);
    scrubFrame.current = requestAnimationFrame(() => {
      if (video.current) video.current.currentTime = ratio * video.current.duration;
    });
  };

  const duration = progress.duration || media.duration || 0;
  const showTime = !compact && duration > 0;

  return (
    <div
      className="absolute inset-0"
      onPointerEnter={(event) => {
        // A drag passing over a card is not a request to preview it.
        if (event.buttons !== 0 || !media.originalUrl) return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setActive(true), HOVER_DELAY_MS);
      }}
      onPointerLeave={stop}
      onPointerDown={stop}
      onPointerMove={(event) => { if (active && event.buttons === 0) scrub(event.clientX, event.currentTarget); }}
    >
      {active && (
        <video
          ref={video}
          src={media.originalUrl}
          muted
          loop
          autoPlay
          playsInline
          preload="auto"
          disablePictureInPicture
          onPlaying={() => setPlaying(true)}
          onLoadedMetadata={(event) => {
            // Read it now: React clears currentTarget before a state updater runs.
            const loaded = event.currentTarget.duration;
            setProgress((value) => ({ ...value, duration: loaded || value.duration }));
          }}
          onTimeUpdate={(event) => setProgress({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration || duration })}
          onError={stop}
          className={cn("pointer-events-none absolute inset-0 size-full object-cover transition-opacity duration-150", playing ? "opacity-100" : "opacity-0")}
        />
      )}
      {active && playing && duration > 0 && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
          <span className="block h-full bg-primary" style={{ width: `${Math.min(100, (progress.current / duration) * 100)}%` }} />
        </span>
      )}
      {showTime && (
        <span className="glass-panel pointer-events-none absolute bottom-1.5 left-1.5 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium tabular-nums">
          {active && playing ? `${formatDuration(progress.current)} / ${formatDuration(duration)}` : formatDuration(duration)}
        </span>
      )}
    </div>
  );
}
