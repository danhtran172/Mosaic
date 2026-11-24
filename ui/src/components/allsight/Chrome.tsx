import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpToLine,
  CheckSquare,
  Grid2X2,
  Heart,
  Image as ImageIcon,
  PanelRight,
  Search,
  Filter,
  Video,
  ZoomIn,
  ZoomOut,
  Rows3,
  X,
  FolderPlus,
  Boxes,
  Tag,
  Copy,
  Ungroup,
  Check,
  Maximize2,
  Minimize2,
  Minus,
  Group,
  EyeOff,
  Shapes,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAllsight } from "@/lib/allsight/store";
import { useT } from "@/lib/allsight/i18n";
import type { FilterKind, GalleryLayout, MediaItem, PersonalFolder } from "@/lib/allsight/types";
import { designFilterCount, formatGroup, mediaExtension, type DesignFilter, type MediaShape } from "@/lib/allsight/designer-tools";

/** A colour filter: the colour, and how far (CIE76 ΔE) a palette colour may be from it. */
export type ColorFilter = { hex: string; tolerance: number };
export const DEFAULT_COLOR_TOLERANCE = 22;
// Hue presets in colour-wheel order, then the neutrals.
const COLOR_PRESETS = ["#e53935", "#fb8c00", "#fdd835", "#7cb342", "#43a047", "#00897b", "#00acc1", "#1e88e5", "#3949ab", "#8e24aa", "#d81b60", "#6d4c41", "#212121", "#9e9e9e", "#fafafa"];
import { mediaGroupById, type MediaGroupBy } from "@/lib/allsight/grouping";

const OTHER_MEDIA_SOURCE_ID = "__indeck-other-media__";
import { cn } from "@/lib/utils";
import { PropertyPicker } from "./PropertyPicker";
import type { ConfirmRequest } from "./ConfirmDialog";
import { getInDeckBridge } from "@/lib/indeck/bridge";

const iconBtn =
  "glass-btn grid size-8 shrink-0 place-items-center rounded-xl text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";


const BASE_THUMB = 200;

const filterDefs: { key: FilterKind; labelKey: "all" | "favorites" | "images" | "videos"; icon: typeof Grid2X2 }[] = [
  { key: "all", labelKey: "all", icon: Grid2X2 },
  { key: "favorites", labelKey: "favorites", icon: Heart },
  { key: "images", labelKey: "images", icon: ImageIcon },
  { key: "videos", labelKey: "videos", icon: Video },
];


export function Header({
  title,
  subtitle,
  query,
  onQuery,
  filter,
  onFilter,
  showFilters,
  inspectorOpen,
  onToggleInspector,
  allSelected,
  onSelectAll,
  propFilters,
  onTogglePropFilter,
  onClearPropFilters,
  viewKind,
  folder,
  galleryFilterIds,
  onToggleGalleryFilter,
  sourceFilterIds,
  onToggleSourceFilter,
  invertAdvancedFilters,
  onToggleInvertAdvancedFilters,
  onClearAdvancedFilters,
  colorFilter,
  onColorFilter,
  colorAnalysis,
  designFilter,
  onDesignFilter,
  groupBy,
  onToggleGroupBy,
}: {
  title: string;
  subtitle?: string | undefined;
  query: string;
  onQuery: (v: string) => void;
  filter: FilterKind;
  onFilter: (f: FilterKind) => void;
  showFilters: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  allSelected: boolean;
  onSelectAll: () => void;
  propFilters: Record<string, string[]>;
  onTogglePropFilter: (groupId: string, value: string) => void;
  onClearPropFilters: () => void;
  viewKind: "all" | "folders" | "folder";
  folder: PersonalFolder | null;
  galleryFilterIds: string[];
  onToggleGalleryFilter: (id: string) => void;
  sourceFilterIds: string[];
  onToggleSourceFilter: (id: string) => void;
  invertAdvancedFilters: boolean;
  onToggleInvertAdvancedFilters: () => void;
  onClearAdvancedFilters: () => void;
  colorFilter: ColorFilter | null;
  onColorFilter: (filter: ColorFilter | null) => void;
  colorAnalysis: { done: number; total: number } | null;
  designFilter: DesignFilter;
  onDesignFilter: (filter: DesignFilter) => void;
  groupBy: MediaGroupBy[];
  onToggleGroupBy: (groupBy: MediaGroupBy) => void;
}) {
  const t = useT();
  const { state, setThumbHeight, setGalleryLayout, pushUngroupedToFront } = useAllsight();
  const zoomPct = Math.round((state.thumbHeight / BASE_THUMB) * 100);
  const activeCount = Object.values(propFilters).reduce((n, v) => n + v.length, 0) + galleryFilterIds.length + sourceFilterIds.length + (colorFilter ? 1 : 0) + designFilterCount(designFilter);

  return (
    <header className="library-header glass-panel flex items-center gap-x-3 rounded-none border-x-0 border-t-0 px-5 py-2">
      <div className="flex min-w-0 flex-1 basis-32 items-center gap-2">
        <div className="min-w-0">
          <h1 className="truncate font-display text-base font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {showFilters && (
          <Select value={filter} onValueChange={(v) => onFilter(v as FilterKind)}>
            <SelectTrigger className="glass-btn h-8 w-auto shrink-0 gap-1.5 rounded-xl px-3 py-1 text-xs font-medium shadow-none focus:ring-0 focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="glass-float rounded-xl border-0 p-1">
              {filterDefs.map(({ key, labelKey, icon: Icon }) => (
                <SelectItem key={key} value={key} className="rounded-lg px-2.5 py-1.5 text-xs focus:bg-primary/15 focus:text-foreground">
                  <span className="flex items-center gap-1.5"><Icon className="size-3.5" />{t(labelKey)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {showFilters && (
          <button
            onClick={onSelectAll}
            aria-label={allSelected ? t("deselectAll") : t("selectAll")}
            title={allSelected ? t("deselectAll") : t("selectAll")}
            className={cn(iconBtn, "size-7 shrink-0", allSelected && "bg-primary/20 text-foreground")}
          >
            <CheckSquare className="size-3.5" />
          </button>
        )}
      </div>

      <div className="ml-auto flex min-w-0 shrink items-center gap-2">
        <div className="glass-btn flex w-[18vw] max-w-[18rem] min-w-24 shrink items-center gap-2 rounded-xl px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            data-library-search
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { onQuery(""); e.currentTarget.blur(); } }}
            placeholder={`${t("search")}  (Ctrl+F)`}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery("")}
              aria-label={t("clearFilters")}
              className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {showFilters && (
          <FilterPopover
            propFilters={propFilters}
            onToggle={onTogglePropFilter}
            activeCount={activeCount}
            viewKind={viewKind}
            folder={folder}
            galleryFilterIds={galleryFilterIds}
            onToggleGallery={onToggleGalleryFilter}
            sourceFilterIds={sourceFilterIds}
            onToggleSource={onToggleSourceFilter}
            inverted={invertAdvancedFilters}
            onToggleInvert={onToggleInvertAdvancedFilters}
            onClearAll={onClearAdvancedFilters}
            colorFilter={colorFilter}
            onColorFilter={onColorFilter}
            colorAnalysis={colorAnalysis}
            designFilter={designFilter}
            onDesignFilter={onDesignFilter}
          />
        )}

        {showFilters && (
          <GroupByPopover
            groupBy={groupBy}
            onToggle={onToggleGroupBy}
            viewKind={viewKind}
            folder={folder}
          />
        )}

        {showFilters && <LayoutPopover layout={folder?.layout ?? state.mainGalleryLayout} onChange={(layout) => setGalleryLayout(folder?.id ?? null, layout)} onPushUngrouped={pushUngroupedToFront} pushLabel={state.language === "en" ? "Ungrouped media to top" : "Đẩy ảnh chưa có group lên trên"} />}

        {showFilters && (
          <TooltipProvider delayDuration={200}>
            <div className="glass-btn flex shrink-0 items-center gap-0.5 rounded-xl p-1">
              <button
                onClick={() => setThumbHeight(Math.max(100, state.thumbHeight - 50))}
                aria-label={t("zoomOut")}
                className="grid size-6 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground active:scale-95"
              >
                <ZoomOut className="size-3.5" />
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setThumbHeight(BASE_THUMB)}
                    aria-label={t("resetZoom")}
                    className="w-11 rounded-lg py-0.5 text-center text-xs tabular-nums text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground active:scale-95"
                  >
                    {zoomPct}%
                  </button>
                </TooltipTrigger>
                <TooltipContent className="glass-float text-foreground">{t("resetZoom")}</TooltipContent>
              </Tooltip>
              <button
                onClick={() => setThumbHeight(Math.min(400, state.thumbHeight + 50))}
                aria-label={t("zoomIn")}
                className="grid size-6 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground active:scale-95"
              >
                <ZoomIn className="size-3.5" />
              </button>
            </div>
          </TooltipProvider>
        )}

        <button
          onClick={onToggleInspector}
          aria-label={t("inspector")}
          className={cn(iconBtn, inspectorOpen && "bg-primary/20 text-foreground")}
        >
          <PanelRight className="size-4" />
        </button>
      </div>
    </header>

  );
}

function LayoutPopover({ layout, onChange, onPushUngrouped, pushLabel }: { layout: GalleryLayout; onChange: (layout: GalleryLayout) => void; onPushUngrouped: () => void; pushLabel: string }) {
  const t = useT();
  const item = (value: GalleryLayout, label: string, Icon: typeof Grid2X2) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent", layout === value && "bg-primary/15 text-foreground")}
    >
      <Icon className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Check className={cn("size-3.5", layout === value ? "text-primary" : "invisible")} />
    </button>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={t("galleryLayout")}
          title={t("galleryLayout")}
          className={cn(iconBtn, "flex h-8 w-auto items-center justify-center gap-1.5 px-2.5 text-xs font-medium", layout === "justified" && "bg-primary/20 text-foreground")}
        >
          {layout === "justified" ? <Rows3 className="size-4" /> : <Grid2X2 className="size-4" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="glass-float w-44 rounded-2xl p-2">
        <p className="px-2.5 py-1.5 text-xs font-semibold">{t("galleryLayout")}</p>
        {item("justified", t("justifiedLayout"), Rows3)}
        {item("square", t("squareLayout"), Grid2X2)}
        <div className="my-1 h-px bg-border/60" />
        <button
          type="button"
          onClick={onPushUngrouped}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
        >
          <ArrowUpToLine className="size-3.5" />
          <span className="min-w-0 flex-1">{pushLabel}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function WindowControls() {
  const t = useT();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const sync = () => { void getInDeckBridge()?.isWindowMaximized().then(setIsMaximized).catch(() => {}); };
    sync();
    // Maximising by double-clicking the title bar or snapping the window does
    // not go through these buttons; a resize is the one signal all of them give.
    let timer = 0;
    const onResize = () => { window.clearTimeout(timer); timer = window.setTimeout(sync, 120); };
    window.addEventListener("resize", onResize);
    return () => { window.clearTimeout(timer); window.removeEventListener("resize", onResize); };
  }, []);

  return (
    <div className="flex h-full shrink-0 overflow-hidden border-l border-border/55">
      <button
        onClick={() => { void getInDeckBridge()?.minimizeWindow(); }}
        title={t("minimizeWindow")}
        aria-label={t("minimizeWindow")}
        className="grid h-full w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minus className="size-4" />
      </button>
      <button
        onClick={() => { void getInDeckBridge()?.toggleMaximizeWindow().then(setIsMaximized); }}
        title={isMaximized ? t("restoreWindow") : t("maximizeWindow")}
        aria-label={isMaximized ? t("restoreWindow") : t("maximizeWindow")}
        className="grid h-full w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {isMaximized ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
      </button>
      <button
        onClick={() => { void getInDeckBridge()?.closeWindow(); }}
        title={t("closeWindow")}
        aria-label={t("closeWindow")}
        className="grid h-full w-11 place-items-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function GroupByPopover({
  groupBy,
  onToggle,
  viewKind,
  folder,
}: {
  groupBy: MediaGroupBy[];
  onToggle: (groupBy: MediaGroupBy) => void;
  viewKind: "all" | "folders" | "folder";
  folder: PersonalFolder | null;
}) {
  const t = useT();
  const { state } = useAllsight();
  const properties = state.propertyGroups.filter((property) => {
    if (!folder) return !property.id.startsWith("exclusive:") && !property.id.startsWith("gallery-group:");
    if (property.id.startsWith(`exclusive:${folder.id}:`)) return true;
    if (property.id.startsWith("exclusive:")) return false;
    if (property.id.startsWith("gallery-group:")) return (folder.managedGroupIds ?? []).includes(property.id) && !(folder.disabledGalleryGroupIds ?? []).includes(property.id);
    return !(folder.disabledGeneralGroupIds ?? []).includes(property.id);
  });
  const selectedIndex = (value: MediaGroupBy) => groupBy.findIndex((item) => mediaGroupById(item) === mediaGroupById(value));
  const item = (label: string, value: MediaGroupBy) => {
    const index = selectedIndex(value);
    const enabled = index >= 0;
    return (
      <button
        key={mediaGroupById(value)}
        type="button"
        onClick={() => onToggle(value)}
        className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent", enabled && "bg-primary/15 text-foreground")}
      >
        <span className={cn("grid size-4 place-items-center rounded border", enabled ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{enabled ? <span className="text-[10px] font-semibold">{index + 1}</span> : null}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={t("groupBy")}
          title={t("groupBy")}
          className={cn(iconBtn, "flex h-8 w-auto items-center justify-center gap-1.5 px-2.5 text-xs font-medium", groupBy.length > 0 && "bg-primary/20 text-foreground")}
        >
          <Group className="size-4" />
          {groupBy.length > 0 && <span className="tabular-nums">{groupBy.length}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="glass-float w-64 rounded-2xl p-2">
        <p className="px-2.5 py-1.5 text-xs font-semibold">{t("groupBy")}</p>
        <p className="px-2.5 pb-2 text-[11px] text-muted-foreground">{t("groupByHint")}</p>
        <div className="app-scroll max-h-72 space-y-1 overflow-auto pr-1">
          {item(t("mediaSource"), { kind: "media-source" })}
          {viewKind === "all" && item(t("gallerySource"), { kind: "gallery-source" })}
          {properties.length > 0 && <div className="mt-2 border-t border-border/60 pt-2"><p className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">{t("property")}</p>{properties.map((property) => item(property.name, { kind: "property", propertyId: property.id }))}</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterPopover({
  propFilters,
  onToggle,
  activeCount,
  viewKind,
  folder,
  galleryFilterIds,
  onToggleGallery,
  sourceFilterIds,
  onToggleSource,
  inverted,
  onToggleInvert,
  onClearAll,
  colorFilter,
  onColorFilter,
  colorAnalysis,
  designFilter,
  onDesignFilter,
}: {
  propFilters: Record<string, string[]>;
  onToggle: (groupId: string, value: string) => void;
  activeCount: number;
  viewKind: "all" | "folders" | "folder";
  folder: PersonalFolder | null;
  galleryFilterIds: string[];
  onToggleGallery: (id: string) => void;
  sourceFilterIds: string[];
  onToggleSource: (id: string) => void;
  inverted: boolean;
  onToggleInvert: () => void;
  onClearAll: () => void;
  colorFilter: ColorFilter | null;
  onColorFilter: (filter: ColorFilter | null) => void;
  colorAnalysis: { done: number; total: number } | null;
  designFilter: DesignFilter;
  onDesignFilter: (filter: DesignFilter) => void;
}) {
  const t = useT();
  const { state } = useAllsight();
  const [tagQuery, setTagQuery] = useState("");
  // Formats offered are the ones this view actually holds.
  const scopeMedia = useMemo(() => {
    if (!folder) return state.media;
    const members = new Set(folder.mediaIds);
    return state.media.filter((media) => members.has(media.id));
  }, [folder, state.media]);
  const q = tagQuery.trim().toLowerCase();

  const groups = state.propertyGroups
    .filter((g) => !folder?.managedGroupIds?.length || folder.managedGroupIds.includes(g.id))
    .filter((g) => !folder?.disabledGeneralGroupIds?.includes(g.id) && !folder?.disabledGalleryGroupIds?.includes(g.id))
    .map((g) => ({ ...g, values: g.values.filter((v) => !q || v.toLowerCase().includes(q)) }))
    .filter((g) => g.values.length > 0);
  const managedSources = state.sources.filter((source) =>
    !folder || (folder.sourceIds ?? []).includes(source.id),
  );
  const otherInFolder = useMemo(() => {
    if (!folder) return false;
    const managed = new Set(folder.sourceIds ?? []);
    const members = new Set(folder.mediaIds);
    return state.media.some((media) => members.has(media.id) && !managed.has(media.sourceId));
  }, [folder, state.media]);
  const availableSources = otherInFolder
    ? [...managedSources, { id: OTHER_MEDIA_SOURCE_ID, name: t("other"), path: "" }]
    : managedSources;
  // A source filter is only useful once there is a meaningful choice. Keep
  // the popover focused when a Gallery has one or two source folders.
  const showSourceFilter = availableSources.length > 2;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={t("filters")}
          title={t("filters")}
          className={cn(
            iconBtn,
            "flex h-8 w-auto items-center justify-center gap-1.5 px-2.5 text-xs font-medium",
            activeCount > 0 && "bg-primary/20 text-foreground",
          )}
        >
          <Filter className="size-4" />
          {colorFilter && <span className="size-3 rounded-full border border-white/40" style={{ backgroundColor: colorFilter.hex }} />}
          {activeCount > 0 && <span className="tabular-nums">{activeCount}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="glass-float w-72 rounded-2xl p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold">{t("filters")}</span>
          {activeCount > 0 && <div className="flex items-center gap-3"><button onClick={onToggleInvert} className={cn("text-xs transition-colors hover:text-foreground", inverted ? "text-primary" : "text-muted-foreground")}>{t("invertFilters")}</button><button onClick={onClearAll} className="text-xs text-muted-foreground transition-colors hover:text-foreground">{t("clearFilters")}</button></div>}
        </div>

        <div className="glass-btn mb-3 flex items-center gap-2 rounded-xl px-2.5 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            placeholder={t("searchTags")}
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {tagQuery && (
            <button onClick={() => setTagQuery("")} className="text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <ColorFilterSection value={colorFilter} onChange={onColorFilter} analysis={colorAnalysis} language={state.language} />
        <DesignFilterSection value={designFilter} onChange={onDesignFilter} media={scopeMedia} language={state.language} />

        <div className="app-scroll max-h-72 space-y-3 overflow-auto pr-1">
          {groups.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">{t("noTagsFound")}</p>}
          {groups.map((g) => (
            <div key={g.id}>
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{g.name}</p>
              <div className="flex flex-wrap gap-1.5">
                {g.values.map((v) => {
                  const on = propFilters[g.id]?.includes(v) ?? false;
                  return (
                    <button
                      key={v}
                      onClick={() => onToggle(g.id, v)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs transition-all duration-200 active:scale-95",
                        on
                          ? "bg-primary/85 text-primary-foreground"
                          : "glass-btn text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {on && <Check className="size-3" />}
                      {v}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {viewKind === "all" && (
            <div className="space-y-1.5 border-t border-border/60 pt-3">
              <p className="text-[11px] font-medium text-muted-foreground">Gallery</p>
              {state.folders.map((f) => <button key={f.id} onClick={() => onToggleGallery(f.id)} className={cn("glass-btn flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs", galleryFilterIds.includes(f.id) && "bg-primary/20 text-foreground")}><span className="truncate">{f.name}</span><Check className={cn("size-3", !galleryFilterIds.includes(f.id) && "invisible")} /></button>)}
            </div>
          )}
          {showSourceFilter && (
            <div className="space-y-1.5 border-t border-border/60 pt-3">
              <p className="text-[11px] font-medium text-muted-foreground">Media Source</p>
              {availableSources.map((source) => <button key={source.id} onClick={() => onToggleSource(source.id)} className={cn("glass-btn flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs", sourceFilterIds.includes(source.id) && "bg-primary/20 text-foreground")}><span className="truncate">{source.name}</span><Check className={cn("size-3", !sourceFilterIds.includes(source.id) && "invisible")} /></button>)}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}


/**
 * Pick a colour to keep only media whose palette contains it. Palettes come
 * from thumbnails; media not measured yet are analysed in the background
 * while the filter is on, and join the results as they are measured.
 */
function ColorFilterSection({ value, onChange, analysis, language }: {
  value: ColorFilter | null;
  onChange: (filter: ColorFilter | null) => void;
  analysis: { done: number; total: number } | null;
  language: string;
}) {
  const c = (vi: string, en: string) => language === "en" ? en : vi;
  const tolerance = value?.tolerance ?? DEFAULT_COLOR_TOLERANCE;
  const pick = (hex: string) => onChange(value?.hex === hex ? null : { hex, tolerance });
  const ring = "ring-2 ring-primary ring-offset-1 ring-offset-background";
  return (
    <div className="mb-3 space-y-2 border-b border-border/60 pb-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-muted-foreground">{c("Màu", "Colour")}</p>
        {value && <button onClick={() => onChange(null)} className="text-[11px] text-muted-foreground transition-colors hover:text-foreground">{c("Bỏ màu", "Clear colour")}</button>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {COLOR_PRESETS.map((hex) => (
          <button
            key={hex}
            type="button"
            data-color-preset={hex}
            onClick={() => pick(hex)}
            aria-label={hex}
            aria-pressed={value?.hex === hex}
            className={cn("size-5 rounded-full border border-white/25 shadow-soft transition-transform hover:scale-110", value?.hex === hex && ring)}
            style={{ backgroundColor: hex }}
          />
        ))}
        <label
          title={c("Chọn màu khác", "Pick another colour")}
          className={cn("relative grid size-5 cursor-pointer place-items-center overflow-hidden rounded-full border border-white/25 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]", value && !COLOR_PRESETS.includes(value.hex) && ring)}
        >
          <input
            type="color"
            value={value?.hex ?? "#808080"}
            onChange={(event) => onChange({ hex: event.target.value, tolerance })}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
      {value && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{c("Chính xác", "Exact")}</span>
            <input
              type="range"
              min={8}
              max={45}
              step={1}
              value={tolerance}
              onChange={(event) => onChange({ hex: value.hex, tolerance: Number(event.target.value) })}
              aria-label={c("Độ gần của màu", "Colour tolerance")}
              className="h-1 flex-1 accent-primary"
            />
            <span className="text-[11px] text-muted-foreground">{c("Rộng", "Broad")}</span>
          </div>
          {analysis && analysis.total > 0 && analysis.done < analysis.total && (
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {c("Đang phân tích màu", "Analysing colours")} {analysis.done}/{analysis.total}…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Orientation, a minimum long edge and the file format. */
function DesignFilterSection({ value, onChange, media, language }: {
  value: DesignFilter;
  onChange: (filter: DesignFilter) => void;
  media: MediaItem[];
  language: string;
}) {
  const c = (vi: string, en: string) => language === "en" ? en : vi;
  const formats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of media) {
      const format = formatGroup(mediaExtension(item));
      if (format) counts.set(format, (counts.get(format) ?? 0) + 1);
    }
    return [...counts].sort((left, right) => right[1] - left[1]);
  }, [media]);
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]);
  const shapes: Array<[MediaShape, string]> = [
    ["landscape", c("Ngang", "Landscape")],
    ["portrait", c("Dọc", "Portrait")],
    ["square", c("Vuông", "Square")],
    ["panorama", c("Toàn cảnh", "Panorama")],
  ];
  const sizes: Array<[number, string]> = [[0, c("Mọi cỡ", "Any size")], [1080, "≥ 1080"], [1920, "≥ 1920"], [3840, "≥ 4K"]];
  const chip = (active: boolean) => cn(
    "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
    active ? "border-primary/60 bg-primary/20 text-foreground" : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground",
  );
  return (
    <div className="mb-3 space-y-2 border-b border-border/60 pb-3" data-design-filter>
      <p className="text-[11px] font-medium text-muted-foreground">{c("Hình dạng & kích thước", "Shape & size")}</p>
      <div className="flex flex-wrap gap-1.5">
        {shapes.map(([shape, label]) => (
          <button key={shape} type="button" data-shape={shape} aria-pressed={value.shapes.includes(shape)} className={chip(value.shapes.includes(shape))} onClick={() => onChange({ ...value, shapes: toggle(value.shapes, shape) })}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" title={c("Cạnh dài tối thiểu, tính bằng pixel", "Minimum long edge, in pixels")}>
        {sizes.map(([side, label]) => (
          <button key={side} type="button" data-min-side={side} aria-pressed={value.minSide === side} className={chip(value.minSide === side)} onClick={() => onChange({ ...value, minSide: side })}>
            {label}
          </button>
        ))}
      </div>
      {(formats.length > 1 || value.formats.length > 0) && (
        <>
          <p className="pt-1 text-[11px] font-medium text-muted-foreground">{c("Định dạng", "Format")}</p>
          <div className="flex flex-wrap gap-1.5">
            {formats.map(([format, count]) => (
              <button key={format} type="button" data-format={format} aria-pressed={value.formats.includes(format)} className={chip(value.formats.includes(format))} onClick={() => onChange({ ...value, formats: toggle(value.formats, format) })}>
                {format.toUpperCase()} <span className="tabular-nums opacity-60">{count}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function BulkBar({
  selected,
  folder,
  onClear,
  onHide,
  onFavorite,
  onGroup,
}: {
  selected: string[];
  folder: PersonalFolder | null;
  onClear: () => void;
  onHide: () => void;
  onFavorite: (favorite: boolean) => void;
  onGroup: () => void;
}) {
  const t = useT();
  const { state, addPropValue } = useAllsight();
  const c = (vi: string, en: string) => state.language === "en" ? en : vi;
  const chosen = new Set(selected);
  const allFavorite = selected.length > 0 && state.media.every((media) => !chosen.has(media.id) || media.favorite);
  const inherited = state.galleryGroups
    .filter((galleryGroup) => !!folder && galleryGroup.folderIds.includes(folder.id))
    .flatMap((galleryGroup) => galleryGroup.propertyGroupIds ?? []);
  const availableProperties = state.propertyGroups.filter((group) => {
    if (!folder) return !group.id.startsWith("exclusive:") && !group.id.startsWith("gallery-group:");
    if (group.id.startsWith(`exclusive:${folder.id}:`)) return true;
    if (group.id.startsWith("exclusive:")) return false;
    if (group.id.startsWith("gallery-group:")) return inherited.includes(group.id) && !(folder.disabledGalleryGroupIds ?? []).includes(group.id);
    return !(folder.disabledGeneralGroupIds ?? []).includes(group.id);
  });
  if (selected.length < 2) return null;

  return (
    <div className="glass-float pointer-events-auto absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl px-2.5 py-2">
      <span className="px-2 text-xs font-medium tabular-nums">{t("itemsSelected", { count: selected.length })}</span>
      <span className="h-5 w-px bg-border" />
      <button
        type="button"
        onClick={() => onFavorite(!allFavorite)}
        title={allFavorite ? c("Bỏ yêu thích", "Unfavorite") : t("favorite")}
        aria-label={allFavorite ? c("Bỏ yêu thích", "Unfavorite") : t("favorite")}
        className={cn(iconBtn, allFavorite && "text-favorite")}
      >
        <Heart className={cn("size-4", allFavorite && "fill-favorite")} />
      </button>
      <button type="button" onClick={onGroup} title={`${t("createGroupSelected")} (Ctrl+G)`} aria-label={t("createGroupSelected")} className={iconBtn}>
        <Shapes className="size-4" />
      </button>
      {availableProperties.map((group) => (
        <PropertyPicker
          key={group.id}
        label={`${t("add")} ${group.name}`}
          align="center"
          options={group.values.map((value) => ({ id: value, label: value }))}
          onSelect={(value) => addPropValue(selected, group.id, value)}
          onCreate={(value) => addPropValue(selected, group.id, value)}
          trigger={<button type="button" className="glass-btn inline-flex h-8 max-w-32 items-center gap-1.5 rounded-xl px-2 text-xs font-medium"><Tag className="size-3.5 shrink-0" /><span className="truncate">{group.name}</span></button>}
        />
      ))}
      <span className="h-5 w-px bg-border" />
      <button
        type="button"
        onClick={onHide}
        title={`${folder ? c("Ẩn khỏi Gallery", "Hide from Gallery") : c("Ẩn khỏi Main Gallery", "Hide from Main Gallery")} (Delete)`}
        aria-label={folder ? c("Ẩn khỏi Gallery", "Hide from Gallery") : c("Ẩn khỏi Main Gallery", "Hide from Main Gallery")}
        className={cn(iconBtn, "hover:text-destructive")}
      >
        <EyeOff className="size-4" />
      </button>
      <button onClick={onClear} title={`${t("clearSelection")} (Esc)`} aria-label={t("clearSelection")} className={iconBtn}>
        <X className="size-4" />
      </button>
    </div>
  );
}
