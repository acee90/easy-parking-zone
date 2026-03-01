import { useState, useRef, useEffect, useCallback } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { searchParkingLots } from "@/server/parking";
import type { ParkingLot } from "@/types/parking";
import { getDifficultyIcon } from "@/lib/geo-utils";

interface SearchBarProps {
  onSelect: (lot: ParkingLot) => void;
}

export function SearchBar({ onSelect }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ParkingLot[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const data = await searchParkingLots({ data: { query: q.trim() } });
      setResults(data);
      setOpen(data.length > 0);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (value: string) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleSelect = (lot: ParkingLot) => {
    setQuery(lot.name);
    setOpen(false);
    onSelect(lot);
  };

  const handleClear = () => {
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={containerRef} className="relative flex-1 max-w-sm">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="주차장 검색..."
          className="pl-8 pr-8 h-8 text-sm"
        />
        {query && (
          <button
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2"
          >
            <X className="size-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border bg-white shadow-lg max-h-64 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              검색 중...
            </div>
          ) : (
            results.map((lot) => (
              <button
                key={lot.id}
                onClick={() => handleSelect(lot)}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-b-0 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {lot.name}
                  </span>
                  <span className="shrink-0 text-xs">
                    {getDifficultyIcon(lot.difficulty.score)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {lot.address}
                </p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
