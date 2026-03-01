import { Car } from "lucide-react";
import { SearchBar } from "@/components/SearchBar";
import type { ParkingLot } from "@/types/parking";

interface HeaderProps {
  onSearchSelect: (lot: ParkingLot) => void;
}

export function Header({ onSearchSelect }: HeaderProps) {
  return (
    <header className="shrink-0 flex items-center gap-3 border-b bg-white px-4 py-2.5 z-20">
      <div className="flex items-center gap-2 shrink-0">
        <Car className="size-5 text-blue-500" />
        <h1 className="font-bold text-base">쉬운주차</h1>
      </div>
      <SearchBar onSelect={onSearchSelect} />
      <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground shrink-0">
        <span>😊 추천</span>
        <span>🙂 보통</span>
        <span>💀 주의</span>
        <span>💀💀 비추</span>
      </div>
    </header>
  );
}
