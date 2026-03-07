import { SlidersHorizontal } from "lucide-react";
import type { ParkingFilters } from "@/types/parking";

interface FloatingFiltersProps {
  filters: ParkingFilters;
  onToggle: (key: keyof ParkingFilters) => void;
  activeCount: number;
}

const FILTER_OPTIONS: { key: keyof ParkingFilters; label: string }[] = [
  { key: "freeOnly", label: "무료만" },
  { key: "publicOnly", label: "공영만" },
  { key: "excludeNoSang", label: "노상 제외" },
];

export function FloatingFilters({ filters, onToggle, activeCount }: FloatingFiltersProps) {
  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5">
      <div className="flex size-8 items-center justify-center rounded-full bg-white shadow-md border border-border relative">
        <SlidersHorizontal className="size-4 text-zinc-600" />
        {activeCount > 0 && (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">
            {activeCount}
          </span>
        )}
      </div>
      {FILTER_OPTIONS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onToggle(key)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium shadow-md border transition-colors ${
            filters[key]
              ? "bg-blue-500 text-white border-blue-500"
              : "bg-white text-zinc-700 border-border hover:bg-zinc-50"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
