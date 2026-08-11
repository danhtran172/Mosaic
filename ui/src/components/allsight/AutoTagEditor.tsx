import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import { Chip, PropertyPicker } from "./PropertyPicker";

/** Edit the auto-tags of a personal folder across every property group. */
export function AutoTagEditor({ folderId }: { folderId: string }) {
  const t = useT();
  const { state, updateFolder, createPropertyValue } = useAllsight();
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return null;

  const setValues = (gid: string, values: string[]) =>
    updateFolder(folder.id, { autoTags: { ...folder.autoTags, [gid]: values } });
  const inherited = state.galleryGroups
    .filter((galleryGroup) => galleryGroup.folderIds.includes(folder.id))
    .flatMap((galleryGroup) => galleryGroup.propertyGroupIds ?? []);
  const available = state.propertyGroups.filter((group) => {
    if (group.id.startsWith(`exclusive:${folder.id}:`)) return true;
    if (group.id.startsWith("exclusive:")) return false;
    if (group.id.startsWith("gallery-group:")) return inherited.includes(group.id) && !(folder.disabledGalleryGroupIds ?? []).includes(group.id);
    return !(folder.disabledGeneralGroupIds ?? []).includes(group.id);
  });

  return (
    <div className="space-y-3">
      {available.map((g) => {
        const current = folder.autoTags[g.id] ?? [];
        return (
          <section key={g.id} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h4 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                {g.name}
              </h4>
              <PropertyPicker
                label={`${t("addValue")} ${g.name}`}
                align="end"
                options={g.values.filter((v) => !current.includes(v)).map((v) => ({ id: v, label: v }))}
                onSelect={(v) => setValues(g.id, Array.from(new Set([...current, v])))}
                onCreate={(v) => { createPropertyValue(g.id, v); setValues(g.id, Array.from(new Set([...current, v]))); }}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {current.map((v) => (
                <Chip key={v} label={v} onRemove={() => setValues(g.id, current.filter((x) => x !== v))} />
              ))}
              {current.length === 0 && <span className="text-xs text-muted-foreground">{t("none")}</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
