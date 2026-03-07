import { useState, useCallback, useEffect } from "react";
import type { ParkingFilters, DifficultyFilter } from "@/types/parking";
import { DEFAULT_FILTERS, DEFAULT_DIFFICULTY } from "@/types/parking";

const COOKIE_KEY = "parking_filters";

function readCookie(): ParkingFilters {
  if (typeof document === "undefined") return DEFAULT_FILTERS;
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE_KEY}=`));
  if (!match) return DEFAULT_FILTERS;
  try {
    const parsed = JSON.parse(decodeURIComponent(match.split("=")[1]));
    return {
      ...DEFAULT_FILTERS,
      ...parsed,
      difficulty: { ...DEFAULT_DIFFICULTY, ...parsed.difficulty },
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function writeCookie(filters: ParkingFilters) {
  const val = encodeURIComponent(JSON.stringify(filters));
  document.cookie = `${COOKIE_KEY}=${val};path=/;max-age=${365 * 86400};SameSite=Lax`;
}

export function useParkingFilters() {
  const [filters, setFiltersState] = useState<ParkingFilters>(DEFAULT_FILTERS);

  useEffect(() => {
    setFiltersState(readCookie());
  }, []);

  const setFilters = useCallback((next: ParkingFilters) => {
    setFiltersState(next);
    writeCookie(next);
  }, []);

  const toggle = useCallback(
    (key: "freeOnly" | "publicOnly" | "excludeNoSang") => {
      const next = { ...filters, [key]: !filters[key] };
      setFilters(next);
    },
    [filters, setFilters]
  );

  const toggleDifficulty = useCallback(
    (key: keyof DifficultyFilter) => {
      const next = {
        ...filters,
        difficulty: { ...filters.difficulty, [key]: !filters.difficulty[key] },
      };
      setFilters(next);
    },
    [filters, setFilters]
  );

  const booleanCount = [filters.freeOnly, filters.publicOnly, filters.excludeNoSang].filter(Boolean).length;
  const diffOff = Object.values(filters.difficulty).filter((v) => !v).length;
  const activeCount = booleanCount + diffOff;

  return { filters, setFilters, toggle, toggleDifficulty, activeCount };
}
