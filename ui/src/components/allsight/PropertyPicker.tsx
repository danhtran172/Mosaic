import { useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/lib/allsight/i18n";
import { cn } from "@/lib/utils";

export function PropertyPicker({
  options,
  onSelect,
  onCreate,
  allowCreate = true,
  label,
  align = "start",
  trigger,
}: {
  options: { id: string; label: string }[];
  onSelect: (id: string) => void;
  onCreate?: (value: string) => void;
  allowCreate?: boolean;
  label?: string;
  align?: "start" | "end" | "center";
  trigger?: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const exact = options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase());
  const showCreate = allowCreate && !!onCreate && query.trim().length > 0 && !exact;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-6 items-center justify-center rounded-md border border-border/70 bg-secondary/60 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="glass-float w-64 rounded-xl p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchValues")}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === "Enter" && showCreate) {
                onCreate?.(query.trim());
                setQuery("");
              }
            }}
          />
        </div>
        <div className="app-scroll max-h-56 overflow-y-auto p-1">
          {matches.map((o) => (
            <button
              key={o.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(o.id);
                setQuery("");
                inputRef.current?.focus();
              }}
              className="block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {o.label}
            </button>
          ))}
          {matches.length === 0 && !showCreate && (
            <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{t("noResults")}</p>
          )}
          {showCreate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onCreate?.(query.trim());
                setQuery("");
                inputRef.current?.focus();
              }}
              className={cn(
                "mt-1 block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm font-medium text-primary transition-colors hover:bg-primary/10",
                matches.length > 0 && "border-t border-border/60 pt-2",
              )}
            >
              {t("createValue", { value: query.trim() })}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function Chip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-secondary/70 px-2 py-0.5 text-xs text-secondary-foreground">
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`Remove ${label}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
