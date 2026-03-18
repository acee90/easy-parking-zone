import { Badge } from "@/components/ui/badge";
import type { ParkingLot } from "@/types/parking";
import { VoteBookmarkBar } from "@/components/VoteBookmarkBar";
import { ParkingTabs } from "@/components/ParkingTabs";
import {
  getDifficultyIcon,
  getDifficultyLabel,
  getDifficultyColor,
  getDistance,
  getReliabilityBadge,
} from "@/lib/geo-utils";
import { MapPin, Clock, CreditCard, Phone, ParkingSquare, X, Flame, ThumbsUp, Navigation } from "lucide-react";

interface ParkingDetailPanelProps {
  lot: ParkingLot;
  onClose: () => void;
  userLat?: number;
  userLng?: number;
  userLocated?: boolean;
}


export function ParkingDetailPanel({
  lot,
  onClose,
  userLat,
  userLng,
  userLocated,
}: ParkingDetailPanelProps) {
  const icon = getDifficultyIcon(lot.difficulty.score);
  const label = getDifficultyLabel(lot.difficulty.score);
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability);
  const distance =
    userLocated && userLat && userLng
      ? getDistance(userLat, userLng, lot.lat, lot.lng)
      : null;

  return (
    <div className="hidden md:flex w-[360px] shrink-0 flex-col border-r bg-white animate-in slide-in-from-left-full duration-150">
      {/* 헤더 */}
      <div className="shrink-0 border-b px-4 py-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`size-3 rounded-full shrink-0 ${getDifficultyColor(lot.difficulty.score)}`}
            />
            <h2 className="font-semibold text-base truncate">{lot.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {lot.curationTag === 'hell' && (
            <Badge variant="destructive" className="text-xs gap-1">
              <Flame className="size-3" />
              초보 주의
            </Badge>
          )}
          {lot.curationTag === 'easy' && (
            <Badge className="text-xs gap-1 bg-green-500 hover:bg-green-600">
              <ThumbsUp className="size-3" />
              초보 추천
            </Badge>
          )}
          <Badge variant="secondary" className="text-sm">
            {icon} {label}
          </Badge>
          {reliabilityBadge && (
            <Badge variant="outline" className={`text-xs ${reliabilityBadge.className}`}>
              {reliabilityBadge.label}
            </Badge>
          )}
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
        <div className="mt-2.5">
          <VoteBookmarkBar lotId={lot.id} />
        </div>
      </div>

      {/* 상세 정보 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* 주소 */}
        <div className="flex items-start gap-2.5 text-sm">
          <MapPin className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
          <span>{lot.address}</span>
        </div>

        {/* 운영시간 */}
        <div className="flex items-start gap-2.5 text-sm">
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
          <div className="flex items-start gap-2.5 text-sm">
            <CreditCard className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
            <div>
              <div>
                기본 {lot.pricing.baseTime}분{" "}
                {lot.pricing.baseFee.toLocaleString()}원
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

        {/* 주차면수 */}
        {lot.totalSpaces > 0 && (
          <div className="flex items-center gap-2.5 text-sm">
            <ParkingSquare className="size-4 shrink-0 text-muted-foreground" />
            <span>총 {lot.totalSpaces}면</span>
          </div>
        )}

        {/* 전화번호 */}
        {lot.phone && (
          <div className="flex items-center gap-2.5 text-sm">
            <Phone className="size-4 shrink-0 text-muted-foreground" />
            <a href={`tel:${lot.phone}`} className="text-blue-500 underline">
              {lot.phone}
            </a>
          </div>
        )}

        {/* POI 태그 */}
        {lot.poiTags && lot.poiTags.length > 0 && (
          <div className="flex items-start gap-2.5 text-sm">
            <Navigation className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
            <div className="flex flex-wrap gap-1.5">
              {lot.poiTags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* 특기사항 */}
        {lot.notes && (
          <p className="text-xs text-muted-foreground bg-gray-50 rounded-lg px-3 py-2">
            {lot.notes}
          </p>
        )}

        {/* 큐레이션 사유 */}
        {lot.curationReason && (
          <div className={`text-xs rounded-lg px-3 py-2 ${
            lot.curationTag === 'hell'
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}>
            {lot.curationTag === 'hell' ? '⚠️' : '✅'}{' '}
            {lot.curationReason}
            {lot.featuredSource === '1010' && (
              <span className="block mt-1 text-muted-foreground">
                📺 10시10분 유튜브에 소개된 주차장
              </span>
            )}
          </div>
        )}

        {/* 탭 영역 */}
        <ParkingTabs lotId={lot.id} />
      </div>
    </div>
  );
}
