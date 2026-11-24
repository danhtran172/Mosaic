# Eagle vs Mosaic: thumbnail and media pipeline

Static reading of **Eagle 4.0.0** (build 20260401, Electron 22.3.7) as installed at
`D:\Apps\Eagle`, compared with Mosaic's working tree on 2026-10-19. Eagle's main and
core process code ships as V8 bytecode (`run.jsc`, `main.jsc`, `app/js/core.jsc`) and was
not read; everything below comes from the plain JavaScript in `resources/app.asar`.

To read the sources again, extract the files you need from the ASAR (its header is JSON).
They are Eagle's copyrighted code, so do not commit them here. The files that matter:

| Eagle file | What it does |
|---|---|
| `app/js/thumbs/thumb.js` | Picks a thumbnailer by extension. Lets plugins replace one. Re-encodes every result to WebP 0.75 at 320 px (480–1080 px for design and document formats). |
| `app/js/thumbs/*.js` | ~40 thumbnailers, one per format. Each falls back to the next method in its own chain (examples below). |
| `app/js/utils/compress.js` | Canvas downscale that halves the size at each step, with `imageSmoothingQuality: 'high'`. |
| `app/js/utils/nativeThumb.js` | IPC to the main process for the OS thumbnail (Windows shell, Quick Look on macOS). |
| `app/js/background.js` | Hidden window that imports files and builds thumbnails. Uses `async.queue`: 4 regenerate jobs, 2 high-resolution, 8 metadata. Computes palettes, and has a `regenerate-thumbnail` command. |
| `app/js/services/lazy-load-manager.js` | Grid loading. IntersectionObserver with a 50 px margin, at most 6 loads at once, ordered by how visible a card is. Delays adapt to disk speed. Cancels with AbortController. |
| `app/js/hover-preview/video-hover-preview.js` | Hover a video card to play it muted and looping. Moving the mouse across the card scrubs (`duration * x / width`). Shows a time label and a progress bar. |
| `app/js/workers/bitmapWorker.js` | Full-resolution viewer only. Decodes off the main thread with `createImageBitmap`, splits the image into tiles, and applies EXIF orientation. |

Per-format fallback chains in Eagle:

| Format | Chain |
|---|---|
| Video | `<video>` seek to min(10 s, duration/3), then the bundled mpv |
| RAW | embedded JPEG via `raw-parser`, then UTIF decode, then the shell thumbnail |
| HEIC | Quick Look on macOS, then libheif WASM in a Worker |
| PSD | Magick.NET through electron-edge on Windows, Quick Look on macOS |
| PDF | pdf.js page 1, then Magick |

## Where Mosaic was worse at the same job (now fixed)

| Topic | Eagle | Mosaic before | Mosaic now |
|---|---|---|---|
| Video cover frame | min(10 s, duration/3) | 1 s, then frame 0 (often still the fade-in) | min(10 s, duration/3), then 1 s, then 0. Input seeking, except output seeking for MPEG-TS. Cache version is `jpeg-v4`. |
| Shell thumbnail fails | A fallback chain for each format | Static placeholder | Falls back to ffmpeg. `createThumbnailFromPath` rejects (it does not return empty), and that is now caught. |
| Stale-thumbnail detection | Path stored per item | Key was `id:mtime` | Key is `id:mtime:size` |
| Placeholder | Palette from the thumbnail | Hue hashed from the id | Average colour measured from the thumbnail, stored in `thumbnails/colors.json`. Placeholders repaint when the colours load. |
| Vault (HTTP) stills | Canvas in a background window | `nativeImage.createFromBuffer` on the main process, which is synchronous and froze every window | Bytes are piped to ffmpeg (child process, applies EXIF orientation). `createFromBuffer` is only the last resort. |
| Fixing a bad thumbnail | `regenerate-thumbnail` command | Not possible until the file changed | "Regenerate thumbnail" in the card's right-click menu, for one item or a selection |

## What Mosaic lacked and now has

- **RAW, HEIC/HEIF, TIFF and PSD**: `.dng .cr2 .cr3 .nef .nrw .arw .raf .orf .rw2 .pef .srw .heic .heif .tif .tiff .psd`.
  - **Grid order:** shell thumbnail, then the largest embedded preview (`JpgFromRaw`, `PreviewImage`, `OtherImage`, `ThumbnailImage` or `PhotoshopThumbnail`, read with exiftool and oriented from the file's EXIF), then ffmpeg.
  - **Lightbox:** Chromium cannot show these originals, so the Lightbox shows a 2048 px derived JPEG (`displayUrl`). For that size the embedded preview is tried first, and one under 1024 px is turned down.
  - **Safety:** these formats are never stamped with the XMP Media ID, so originals are only read.
- **Video duration**: read in the existing batched exiftool pass (`-Duration`), stored on the asset, and shown as a badge on video cards.
- **Colour filter**, as in Eagle's palette search. Each thumbnail yields up to six dominant colours with their share of the image (48×48 downscale, 4-bit bins merged below ΔE 14), stored next to the average colour in `thumbnails/colors.json`.
  - **Using it:** the Filters popover has 15 presets, a custom colour picker and an Exact ↔ Broad tolerance slider. A media matches when a palette colour covering at least 8% of the image is within the tolerance, measured as CIE76 ΔE in Lab (default 22).
  - **Unanalysed media:** while the filter is on, media without a palette go through the thumbnail queue's buffer lane (`thumbnails:analyze-colors`, 40 per call), reusing any cached size. Results are kept, so this runs once.
  - **Inspector:** shows the selected media's palette as a strip; clicking a colour filters by it.
- **Hover preview with scrubbing**: modelled on Eagle (`VideoHoverPreview.tsx`). Starts after 350 ms. Only the hovered card holds a `<video>`. A drag passing over a card does not trigger it.

## Designer tools

Helpers live in `ui/src/lib/allsight/designer-tools.ts`; the IPC is in `main.js`.

- **SVG**: `.svg` is now a media type.
  - **Thumbnails:** Chromium draws the file in a hidden offscreen window (`rasterizeSvgFile`), as an `<img>` with JavaScript off and only `file:`/`data:` requests allowed, so an SVG's scripts never run and its links are never fetched. The capture is a JPEG, so the colour palette and colour filter work as for any image.
  - **Size:** read from the markup (`width`/`height` with units, else `viewBox`), because ExifTool reports `"210mm"` or `"100%"` as written.
  - **Lightbox:** shows the vector original.
  - **Menu:** "Copy SVG code" puts the markup on the clipboard, ready to paste into Figma.
- **Drag out to other apps**: Figma, Photoshop, Explorer, browser uploads.
  - **Where:** carry a card (or a selection) past the window edge; or drag the Inspector preview; or drag the Lightbox photo at fit zoom.
  - **How:** `media:start-drag` calls `webContents.startDrag` with the local files. The card's cached thumbnail is the drag image. Vault media has no file to give.
- **Colour codes**:
  - **Inspector:** lists the palette as hex chips (click to copy), with a button that copies the whole palette.
  - **Lightbox:** has an eyedropper (Chromium `EyeDropper`) that copies the picked colour and keeps it on screen.
- **Lightbox scale**: the percentage is measured against the original's pixels (device pixels, so it holds on a scaled display), not against the fit. "1:1" jumps to actual pixels; past 2:1 the image renders `pixelated`. The zoom ceiling grows with the image, so a 4K photo can pass 1:1.
- **Shape, size and format filters** in the Filters popover:
  - **Shape:** landscape, portrait, square, panorama (≥ 2:1).
  - **Minimum long edge:** 1080, 1920 or 4K. SVG passes any size.
  - **Format:** chips with counts for the formats in the current view.
  - **Behaviour:** these count towards the filter badge and follow invert and clear.
- **File facts**: the Inspector also shows the aspect ratio (snapped to common ratios such as 16:9) and the file size.
- **Copy image** now works for RAW/HEIC/TIFF/PSD and SVG too, through the 2048 px rendering. Also added:
  - **Copy path:** one media or a whole selection.
  - **Open with…:** Windows' own app chooser, `OpenAs_RunDLL`.

Known limits:
- **SVG linking to a remote image:** that image is blocked, as intended, but Chromium draws its broken-image icon in the thumbnail.
- **Clipboard not checked in the test run:** the test shell cannot reach the clipboard. The handlers report success, but what lands on the clipboard has not been read back.

## Not adopted, and why

- **Eagle builds every thumbnail eagerly at import, in a hidden renderer window.** Mosaic builds them on demand in the main process, with two priority lanes, de-duplication and cancellation. That suits a library that lives on the user's disk better.
- **Eagle skips thumbnails for small images (≤ 960 px and ≤ 15 MB) and shows the original instead.** Mosaic's renderer decodes everything to an ImageBitmap, so a small JPEG thumbnail is still the cheaper choice.
- **Animated GIFs in the grid.** Mosaic deliberately shows a still, to avoid several megabytes of animation per card.

## Open follow-ups

- **PDF thumbnails:** Eagle renders page 1 with pdf.js.
- **Tiled full-resolution viewer** for very large stills, like Eagle's `bitmapWorker`.
- **HEIC without the Windows HEIF codec:** this gets only the small embedded thumbnail. The bundled ffmpeg 6.1 has no HEIF demuxer (ffmpeg 7+ does).
- **Not tested:** real camera RAW files and Vault-backed media in a running app. The pipeline was exercised with synthetic files and a local HTTP server.
