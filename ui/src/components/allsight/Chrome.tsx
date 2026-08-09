import { useEffect, useState } from "react";
import {
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
import type { FilterKind, PersonalFolder } from "@/lib/allsight/types";

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
  onClearAdvancedFilters,
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
  onClearAdvancedFilters: () => void;
}) {
  const t = useT();
  const { state, setThumbHeight } = useAllsight();
  const zoomPct = Math.round((state.thumbHeight / BASE_THUMB) * 100);
  const activeCount = Object.values(propFilters).reduce((n, v) => n + v.length, 0) + galleryFilterIds.length + sourceFilterIds.length;

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
        <div className="glass-btn flex w-[25vw] max-w-md min-w-24 shrink items-center gap-2 rounded-xl px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t("search")}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
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
            onClearAll={onClearAdvancedFilters}
          />
        )}

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

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void getInDeckBridge()?.isWindowMaximized().then(setIsMaximized);
  }, []);

  return (
    <div className="flex h-full shrink-0 overflow-hidden border-l border-border/55">
      <button
        onClick={() => { void getInDeckBridge()?.minimizeWindow(); }}
        title="Thu nhỏ cửa sổ"
        aria-label="Thu nhỏ cửa sổ"
        className="grid h-full w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minus className="size-4" />
      </button>
      <button
        onClick={() => { void getInDeckBridge()?.toggleMaximizeWindow().then(setIsMaximized); }}
        title={isMaximized ? "Khôi phục kích thước cửa sổ" : "Phóng to cửa sổ"}
        aria-label={isMaximized ? "Khôi phục kích thước cửa sổ" : "Phóng to cửa sổ"}
        className="grid h-full w-11 place-items-center border-l border-border/55 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {isMaximized ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
      </button>
      <button
        onClick={() => { void getInDeckBridge()?.closeWindow(); }}
        title="Đóng cửa sổ"
        aria-label="Đóng cửa sổ"
        className="grid h-full w-11 place-items-center border-l border-border/55 text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
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
  onClearAll,
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
  onClearAll: () => void;
}) {
  const t = useT();
  const { state } = useAllsight();
  const [tagQuery, setTagQuery] = useState("");
  const q = tagQuery.trim().toLowerCase();

  const groups = state.propertyGroups
    .filter((g) => !folder?.managedGroupIds?.length || folder.managedGroupIds.includes(g.id))
    .map((g) => ({ ...g, values: g.values.filter((v) => !q || v.toLowerCase().includes(q)) }))
    .filter((g) => g.values.length > 0);
  const managedSources = state.sources.filter((source) =>
    !folder || (folder.sourceIds ?? []).includes(source.id),
  );
  const otherInFolder = !!folder && folder.mediaIds.some((mediaId) => {
    const media = state.media.find((item) => item.id === mediaId);
    return media && !(folder.sourceIds ?? []).includes(media.sourceId);
  });
  const availableSources = otherInFolder
    ? [...managedSources, { id: OTHER_MEDIA_SOURCE_ID, name: "Khác", path: "" }]
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
          {activeCount > 0 && <span className="tabular-nums">{activeCount}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="glass-float w-72 rounded-2xl p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold">{t("filters")}</span>
          {activeCount > 0 && (
            <button onClick={onClearAll} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
              {t("clearFilters")}
            </button>
          )}
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


export function BulkBar({
  selected,
  onClear,
}: {
  selected: string[];
  onClear: () => void;
}) {
  const t = useT();
  if (selected.length < 2) return null;

  return (
    <div className="glass-float pointer-events-auto absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl px-2.5 py-2">
      <span className="px-2 text-xs font-medium">{t("itemsSelected", { count: selected.length })}</span>
      <span className="h-5 w-px bg-border" />
      <button onClick={onClear} aria-label={t("clearSelection")} className={iconBtn}>
        <X className="size-4" />
      </button>
    </div>
  );
}
