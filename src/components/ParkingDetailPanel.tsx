import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import type { ParkingLot, CrawledReview } from "@/types/parking";
import { fetchCrawledReviews, reportReview } from "@/server/parking";
import {
  getDifficultyIcon,
  getDifficultyLabel,
  getDistance,
} from "@/lib/geo-utils";
import { MapPin, Clock, CreditCard, Phone, ParkingSquare, X, MessageSquare, ThumbsUp, ThumbsDown, Flag, Check } from "lucide-react";

interface ParkingDetailPanelProps {
  lot: ParkingLot;
  onClose: () => void;
  userLat?: number;
  userLng?: number;
  userLocated?: boolean;
}

const REPORT_REASONS = [
  { key: "wrong_sentiment", label: "긍정/부정 반대" },
  { key: "irrelevant", label: "주차와 무관" },
  { key: "other", label: "기타 오류" },
] as const;

function ReviewCard({
  review,
  parkingLotId,
}: {
  review: CrawledReview;
  parkingLotId: string;
}) {
  const [open, setOpen] = useState(false);
  const [reported, setReported] = useState(false);

  const handleReport = (reason: string) => {
    reportReview({
      data: { sourceUrl: review.sourceUrl, parkingLotId, reason },
    }).catch(() => {});
    setReported(true);
    setOpen(false);
  };

  return (
    <div className="rounded-lg border overflow-hidden">
      <a
        href={review.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors"
      >
        <div className="shrink-0 mt-0.5">
          {review.isPositive ? (
            <ThumbsUp className="size-4 text-green-500" />
          ) : (
            <ThumbsDown className="size-4 text-red-400" />
          )}
        </div>
        <p className="text-xs text-gray-700 line-clamp-5 leading-relaxed">
          {review.summary}
        </p>
      </a>
      <div className="flex items-center border-t px-3 py-1.5 bg-gray-50/50">
        {reported ? (
          <span className="flex items-center gap-1 text-[11px] text-green-600">
            <Check className="size-3" />
            신고 접수됨
          </span>
        ) : open ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            {REPORT_REASONS.map((r) => (
              <button
                key={r.key}
                onClick={() => handleReport(r.key)}
                className="text-[11px] px-2 py-0.5 rounded-full border border-red-200 text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={() => setOpen(false)}
              className="text-[11px] text-muted-foreground ml-1 cursor-pointer"
            >
              취소
            </button>
          </div>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-red-400 transition-colors cursor-pointer"
          >
            <Flag className="size-3" />
            요약이 잘못됐나요?
          </button>
        )}
      </div>
    </div>
  );
}

function difficultyColor(score: number | null) {
  if (score === null) return "bg-gray-400";
  if (score >= 4.0) return "bg-green-500";
  if (score >= 2.5) return "bg-yellow-500";
  if (score >= 1.5) return "bg-orange-500";
  return "bg-red-500";
}

export function ParkingDetailPanel({
  lot,
  onClose,
  userLat,
  userLng,
  userLocated,
}: ParkingDetailPanelProps) {
  const [reviews, setReviews] = useState<CrawledReview[]>([]);

  useEffect(() => {
    fetchCrawledReviews({ data: { parkingLotId: lot.id } })
      .then(setReviews)
      .catch(() => setReviews([]));
  }, [lot.id]);

  const icon = getDifficultyIcon(lot.difficulty.score);
  const label = getDifficultyLabel(lot.difficulty.score);
  const distance =
    userLocated && userLat && userLng
      ? getDistance(userLat, userLng, lot.lat, lot.lng)
      : null;

  return (
    <div className="hidden md:flex w-[360px] shrink-0 flex-col border-r bg-white animate-in slide-in-from-left-full duration-200">
      {/* 헤더 */}
      <div className="shrink-0 border-b px-4 py-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`size-3 rounded-full shrink-0 ${difficultyColor(lot.difficulty.score)}`}
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

        {/* 특기사항 */}
        {lot.notes && (
          <p className="text-xs text-muted-foreground bg-gray-50 rounded-lg px-3 py-2">
            {lot.notes}
          </p>
        )}

        {/* 블로그/카페 후기 */}
        {reviews.length > 0 && (
          <div className="pt-2 border-t">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">주차 후기</span>
              <span className="text-xs text-muted-foreground">
                {reviews.length}건
              </span>
            </div>
            <div className="space-y-2.5">
              {reviews.map((review) => (
                <ReviewCard
                  key={review.sourceUrl}
                  review={review}
                  parkingLotId={lot.id}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
