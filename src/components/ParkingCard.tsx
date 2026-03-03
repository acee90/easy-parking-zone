import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import type { ParkingLot } from "@/types/parking";
import {
  getDifficultyIcon,
  getDifficultyLabel,
  getDistance,
} from "@/lib/geo-utils";
import { MapPin, Clock, CreditCard, Phone } from "lucide-react";

interface ParkingCardProps {
  lot: ParkingLot | null;
  onClose: () => void;
  userLat?: number;
  userLng?: number;
  userLocated?: boolean;
}

function difficultyColor(score: number | null) {
  if (score === null) return "bg-gray-400";
  if (score >= 4.0) return "bg-green-500";
  if (score >= 2.5) return "bg-yellow-500";
  if (score >= 1.5) return "bg-orange-500";
  return "bg-red-500";
}

export function ParkingCard({
  lot,
  onClose,
  userLat,
  userLng,
  userLocated,
}: ParkingCardProps) {
  // 데스크톱(md+)에서는 Sheet를 렌더링하지 않음 — 상세 패널이 대신 표시됨
  const [isMobile, setIsMobile] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    setIsMobile(!mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(!e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  if (!lot || !isMobile) return null;

  const icon = getDifficultyIcon(lot.difficulty.score);
  const label = getDifficultyLabel(lot.difficulty.score);
  const distance =
    userLocated && userLat && userLng
      ? getDistance(userLat, userLng, lot.lat, lot.lng)
      : null;

  return (
    <Sheet open={!!lot} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="rounded-t-xl max-h-[50vh]">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <div
              className={`size-3 rounded-full ${difficultyColor(lot.difficulty.score)}`}
            />
            <SheetTitle className="text-base">{lot.name}</SheetTitle>
          </div>
          <SheetDescription className="sr-only">
            주차장 상세 정보
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-4 space-y-3">
          {/* 난이도 + 거리 */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className="text-sm">
              {icon} {label}
            </Badge>
            <Badge variant={lot.pricing.isFree ? "default" : "outline"}>
              {lot.pricing.isFree ? "무료" : "유료"}
            </Badge>
            {distance !== null && (
              <span className="text-xs text-muted-foreground">
                {distance < 1
                  ? `${Math.round(distance * 1000)}m`
                  : `${distance.toFixed(1)}km`}
              </span>
            )}
            {lot.difficulty.reviewCount > 0 && (
              <span className="text-xs text-muted-foreground">
                리뷰 {lot.difficulty.reviewCount}개
              </span>
            )}
          </div>

          {/* 주소 */}
          <div className="flex items-start gap-2 text-sm">
            <MapPin className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
            <span>{lot.address}</span>
          </div>

          {/* 운영시간 */}
          <div className="flex items-start gap-2 text-sm">
            <Clock className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
            <div>
              <div>
                평일 {lot.operatingHours.weekday.start}-
                {lot.operatingHours.weekday.end}
              </div>
              <div className="text-xs text-muted-foreground">
                토 {lot.operatingHours.saturday.start}-
                {lot.operatingHours.saturday.end} · 공휴일{" "}
                {lot.operatingHours.holiday.start}-
                {lot.operatingHours.holiday.end}
              </div>
            </div>
          </div>

          {/* 요금 */}
          {!lot.pricing.isFree && (
            <div className="flex items-start gap-2 text-sm">
              <CreditCard className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div>
                <div>
                  기본 {lot.pricing.baseTime}분 {lot.pricing.baseFee.toLocaleString()}원
                </div>
                <div className="text-xs text-muted-foreground">
                  추가 {lot.pricing.extraTime}분당{" "}
                  {lot.pricing.extraFee.toLocaleString()}원
                  {lot.pricing.dailyMax &&
                    ` · 1일 최대 ${lot.pricing.dailyMax.toLocaleString()}원`}
                </div>
              </div>
            </div>
          )}

          {/* 전화번호 */}
          {lot.phone && (
            <div className="flex items-center gap-2 text-sm">
              <Phone className="size-4 shrink-0 text-muted-foreground" />
              <a href={`tel:${lot.phone}`} className="text-blue-500 underline">
                {lot.phone}
              </a>
            </div>
          )}

          {/* 특기사항 */}
          {lot.notes && (
            <p className="text-xs text-muted-foreground bg-gray-50 rounded px-2 py-1">
              {lot.notes}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
