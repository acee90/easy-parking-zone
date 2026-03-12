import { useState, useMemo, useCallback, useRef } from "react";
import type { ParkingLot } from "@/types/parking";
import {
  getDifficultyColor,
  getDifficultyIcon,
  getDifficultyLabel,
  getDistance,
} from "@/lib/geo-utils";
import { ChevronUp } from "lucide-react";

interface MobileBottomPanelProps {
  parkingLots: ParkingLot[];
  selectedLotId: string | null;
  onSelect: (lot: ParkingLot) => void;
  userLat?: number;
  userLng?: number;
  userLocated?: boolean;
}

export function MobileBottomPanel({
  parkingLots,
  selectedLotId,
  onSelect,
  userLat,
  userLng,
  userLocated,
}: MobileBottomPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // 터치 스와이프 핸들링
  const touchStartY = useRef(0);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const dy = touchStartY.current - e.changedTouches[0].clientY;
    if (dy > 40) setExpanded(true);
    if (dy < -40) setExpanded(false);
  }, []);

  const sortedLots = useMemo(() => {
    return parkingLots
      .map((lot) => ({
        lot,
        distance:
          userLocated && userLat && userLng
            ? getDistance(userLat, userLng, lot.lat, lot.lng)
            : null,
      }))
      .sort((a, b) => {
        if (a.distance !== null && b.distance !== null)
          return a.distance - b.distance;
        return (b.lot.difficulty.score ?? -1) - (a.lot.difficulty.score ?? -1);
      });
  }, [parkingLots, userLat, userLng, userLocated]);

  // 선택된 주차장이 있거나, 데스크톱이면 숨김
  // (md: breakpoint는 CSS로 처리)
  if (selectedLotId || parkingLots.length === 0) return null;

  return (
    <div
      className="md:hidden fixed bottom-0 inset-x-0 z-30 transition-transform duration-200 ease-out"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* 접힌 상태: 피크 바 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white border-t border-border shadow-[0_-2px_10px_rgba(0,0,0,0.08)] cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {/* 미니 난이도 도트들 */}
          <div className="flex -space-x-0.5">
            {sortedLots.slice(0, 5).map(({ lot }) => (
              <div
                key={lot.id}
                className={`size-2 rounded-full ${getDifficultyColor(lot.difficulty.score)} ring-1 ring-white`}
              />
            ))}
          </div>
          <span className="text-sm font-medium">
            주차장 {parkingLots.length}개
          </span>
          {sortedLots[0]?.distance !== null && userLocated && (
            <span className="text-xs text-muted-foreground">
              · 가장 가까운{" "}
              {sortedLots[0].distance! < 1
                ? `${Math.round(sortedLots[0].distance! * 1000)}m`
                : `${sortedLots[0].distance!.toFixed(1)}km`}
            </span>
          )}
        </div>
        <ChevronUp
          className={`size-4 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {/* 펼친 상태: 목록 */}
      {expanded && (
        <div
          className="bg-white max-h-[45vh] overflow-y-auto overscroll-contain border-t border-border"
        >
          {sortedLots.slice(0, 30).map(({ lot, distance }) => (
            <button
              key={lot.id}
              onClick={() => {
                onSelect(lot);
                setExpanded(false);
              }}
              className="w-full flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 active:bg-blue-50 transition-colors cursor-pointer"
            >
              <span className="text-lg leading-none shrink-0">
                {getDifficultyIcon(lot.difficulty.score)}
              </span>
              <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium truncate">
                    {lot.name}
                  </span>
                  {lot.curationTag === "hell" && (
                    <span className="text-[10px] text-red-500 font-medium shrink-0">
                      주의
                    </span>
                  )}
                  {lot.curationTag === "easy" && (
                    <span className="text-[10px] text-green-600 font-medium shrink-0">
                      추천
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{getDifficultyLabel(lot.difficulty.score)}</span>
                  <span>·</span>
                  <span>{lot.pricing.isFree ? "무료" : "유료"}</span>
                  {lot.totalSpaces > 0 && (
                    <>
                      <span>·</span>
                      <span>{lot.totalSpaces}면</span>
                    </>
                  )}
                </div>
              </div>
              {distance !== null && (
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                  {distance < 1
                    ? `${Math.round(distance * 1000)}m`
                    : `${distance.toFixed(1)}km`}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
