import { useState, useCallback, useEffect } from "react";
import type { ParkingFilters } from "@/types/parking";
import { DEFAULT_FILTERS } from "@/types/parking";

const COOKIE_KEY = "parking_filters";

function readCookie(): ParkingFilters {
  if (typeof document === "undefined") return DEFAULT_FILTERS;
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE_KEY}=`));
  if (!match) return DEFAULT_FILTERS;
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(decodeURIComponent(match.split("=")[1])) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function writeCookie(filters: ParkingFilters) {
  const val = encodeURIComponent(JSON.stringify(filters));
  // 1년 유지
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
    (key: keyof ParkingFilters) => {
      const next = { ...filters, [key]: !filters[key] };
      setFilters(next);
    },
    [filters, setFilters]
  );

  const activeCount = Object.values(filters).filter(Boolean).length;

  return { filters, setFilters, toggle, activeCount };
}
