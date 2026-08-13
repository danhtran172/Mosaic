/**
 * HTML5 DataTransfer is the interoperable representation of a media drag,
 * but Electron can occasionally clear custom MIME payloads while crossing
 * nested React portals. Keep the current in-app drag as a short-lived,
 * renderer-local backup.
 */
export type MosaicMediaDrag = { mediaIds: string[]; sourceFolderId: string | null };

let activeMediaDrag: MosaicMediaDrag | null = null;

export function beginMediaDrag(payload: MosaicMediaDrag) {
  activeMediaDrag = payload;
}

export function currentMediaDrag() {
  return activeMediaDrag;
}

export function finishMediaDrag() {
  activeMediaDrag = null;
}
