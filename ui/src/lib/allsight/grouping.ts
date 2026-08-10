/** A display-only hierarchy for the media canvas. Ordering follows the order
 * in which the user enables these fields in Group by. */
export type MediaGroupBy =
  | { kind: "property"; propertyId: string }
  | { kind: "media-source" }
  | { kind: "gallery-source" };

export function mediaGroupById(groupBy: MediaGroupBy) {
  return groupBy.kind === "property" ? `property:${groupBy.propertyId}` : groupBy.kind;
}
