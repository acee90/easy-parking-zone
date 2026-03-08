import { useState, useRef, useEffect, useCallback } from "react";
import { Search, X, MapPin, Navigation } from "lucide-react";
import { Input } from "@/components/ui/input";
import { searchParkingLots, searchPlaces } from "@/server/parking";
import type { ParkingLot } from "@/types/parking";
import type { Place } from "@/types/parking";
import { getDifficultyIcon } from "@/lib/geo-utils";

interface SearchBarProps {
  onSelect: (lot: ParkingLot) => void;
  onPlaceSelect?: (coords: { lat: number; lng: number }) => void;
}

export function SearchBar({ onSelect, onPlaceSelect }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [lotResults, setLotResults] = useState<ParkingLot[]>([]);
  const [placeResults, setPlaceResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 1) {
      setLotResults([]);
      setPlaceResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const [lots, places] = await Promise.all([
        searchParkingLots({ data: { query: trimmed } }),
        trimmed.length >= 2
          ? searchPlaces({ data: { query: trimmed } })
          : Promise.resolve([]),
      ]);
      setLotResults(lots);
      setPlaceResults(places);
      setOpen(lots.length > 0 || places.length > 0);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (value: string) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleSelectLot = (lot: ParkingLot) => {
    setQuery(lot.name);
    setOpen(false);
    onSelect(lot);
  };

  const handleSelectPlace = (place: Place) => {
    setQuery(place.name);
    setOpen(false);
    onPlaceSelect?.({ lat: place.lat, lng: place.lng });
  };

  const handleClear = () => {
    setQuery("");
    setLotResults([]);
    setPlaceResults([]);
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
          onFocus={() =>
            (lotResults.length > 0 || placeResults.length > 0) && setOpen(true)
          }
          placeholder="장소 또는 주차장 검색..."
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
        <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border bg-white shadow-lg max-h-72 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              검색 중...
            </div>
          ) : (
            <>
              {placeResults.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground bg-gray-50 sticky top-0">
                    주변 주차장 찾기
                  </div>
                  {placeResults.map((place, i) => (
                    <button
                      key={`place-${i}`}
                      onClick={() => handleSelectPlace(place)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-b-0 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Navigation className="size-3.5 text-orange-500 shrink-0" />
                        <span className="text-sm font-medium truncate">
                          {place.name}
                        </span>
                        {place.category && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {place.category}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate pl-5.5">
                        {place.address}
                      </p>
                    </button>
                  ))}
                </>
              )}
              {lotResults.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground bg-gray-50 sticky top-0">
                    주차장 바로가기
                  </div>
                  {lotResults.slice(0, 3).map((lot) => (
                    <button
                      key={lot.id}
                      onClick={() => handleSelectLot(lot)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-b-0 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <MapPin className="size-3.5 text-blue-500 shrink-0" />
                        <span className="text-sm font-medium truncate">
                          {lot.name}
                        </span>
                        <span className="shrink-0 text-xs">
                          {getDifficultyIcon(lot.difficulty.score)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate pl-5.5">
                        {lot.address}
                      </p>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
