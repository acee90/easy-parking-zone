import { Link } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  CreditCard,
  Flame,
  MapPin,
  Navigation,
  ParkingSquare,
  Phone,
  Star,
  ThumbsUp,
  X,
} from 'lucide-react'
import { NavigationButton } from '@/components/NavigationButton'
import { ParkingTabs } from '@/components/ParkingTabs'
import { Badge } from '@/components/ui/badge'
import { VoteBookmarkBar } from '@/components/VoteBookmarkBar'
import {
  getDifficultyColor,
  getDifficultyIcon,
  getDifficultyLabel,
  getDistance,
  getReliabilityBadge,
} from '@/lib/geo-utils'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

interface ParkingDetailPanelProps {
  lot: ParkingLot
  onClose: () => void
  userLat?: number
  userLng?: number
  userLocated?: boolean
}

export function ParkingDetailPanel({
  lot,
  onClose,
  userLat,
  userLng,
  userLocated,
}: ParkingDetailPanelProps) {
  const icon = getDifficultyIcon(lot.difficulty.score)
  const label = getDifficultyLabel(lot.difficulty.score)
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const distance =
    userLocated && userLat && userLng ? getDistance(userLat, userLng, lot.lat, lot.lng) : null

  const rating = lot.difficulty.score ?? 0
  const hasImage = true // TODO: 실제 이미지 URL이 있으면 표시

  return (
    <div className="w-[360px] shrink-0 flex-col bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border pointer-events-auto flex overflow-hidden animate-in slide-in-from-left-4 duration-150">
      {/* 히어로 이미지 */}
      <div className="relative shrink-0 h-40 bg-gradient-to-br from-blue-100 to-blue-50 flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <ParkingSquare className="size-32 text-blue-500" />
        </div>
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-white/90 hover:bg-white shadow-sm transition-colors cursor-pointer z-10"
        >
          <X className="size-4 text-muted-foreground" />
        </button>
      </div>

      {/* 헤더 */}
      <div className="shrink-0 border-b px-4 py-4">
        {/* 제목 + 평점 + 상태 */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-lg mb-1.5">{lot.name}</h2>
            {/* 평점 표시 */}
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Star
                    key={i}
                    className={`size-3.5 ${
                      i <= Math.round(rating) ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'
                    }`}
                  />
                ))}
              </div>
              <span className="text-sm font-semibold">{rating.toFixed(1)}</span>
              {lot.difficulty.reviewCount > 0 && (
                <span className="text-xs text-muted-foreground ml-0.5">
                  리뷰 {lot.difficulty.reviewCount}개
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 상태 배지 */}
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Badge className="bg-green-500 hover:bg-green-600 text-white text-xs">주차 가능</Badge>
          <Badge variant={lot.pricing.isFree ? 'default' : 'outline'} className="text-xs">
            {lot.pricing.isFree ? '무료' : '유료'}
          </Badge>
          {lot.difficulty.score !== null && lot.difficulty.score >= 4.0 && (
            <Badge className="text-xs gap-1 bg-green-100 text-green-700 hover:bg-green-100">
              <ThumbsUp className="size-3" />
              초보 추천
            </Badge>
          )}
          {lot.difficulty.score !== null && lot.difficulty.score < 2.0 && (
            <Badge variant="destructive" className="text-xs gap-1">
              <Flame className="size-3" />
              초보 주의
            </Badge>
          )}
        </div>

        {/* 액션 버튼 */}
        <div className="flex items-center gap-2">
          <NavigationButton lat={lot.lat} lng={lot.lng} name={lot.name} />
          <VoteBookmarkBar lotId={lot.id} />
          <Link
            to="/wiki/$slug"
            params={{ slug: makeParkingSlug(lot.name, lot.id) }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border hover:bg-gray-50 transition-colors"
          >
            자세히
            <ChevronRight className="size-3" />
          </Link>
        </div>
      </div>

      {/* 상세 정보 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* AI Summary */}
        {lot.curationReason && (
          <div
            className={`rounded-lg px-3.5 py-3 text-sm space-y-1.5 ${
              lot.difficulty.score !== null && lot.difficulty.score < 2.0
                ? 'bg-red-50 border border-red-200'
                : 'bg-blue-50 border border-blue-200'
            }`}
          >
            <div className="font-semibold flex items-center gap-2">
              {lot.difficulty.score !== null && lot.difficulty.score < 2.0 ? '⚠️' : '✨'} AI 요약
            </div>
            <p
              className={
                lot.difficulty.score !== null && lot.difficulty.score < 2.0
                  ? 'text-red-700'
                  : 'text-blue-700'
              }
            >
              {lot.curationReason}
            </p>
            {lot.featuredSource === '1010' && (
              <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-current border-opacity-20">
                📺 10시10분 유튜브 채널에 소개된 주차장
              </p>
            )}
          </div>
        )}

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
              평일 {lot.operatingHours.weekday.start}-{lot.operatingHours.weekday.end}
            </div>
            <div className="text-xs text-muted-foreground">
              토 {lot.operatingHours.saturday.start}-{lot.operatingHours.saturday.end} · 공휴일{' '}
              {lot.operatingHours.holiday.start}-{lot.operatingHours.holiday.end}
            </div>
          </div>
        </div>

        {/* 요금 */}
        {!lot.pricing.isFree && (
          <div className="flex items-start gap-2.5 text-sm">
            <CreditCard className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
            <div>
              <div>
                기본 {lot.pricing.baseTime}분 {lot.pricing.baseFee.toLocaleString()}원
              </div>
              <div className="text-xs text-muted-foreground">
                추가 {lot.pricing.extraTime}분당 {lot.pricing.extraFee.toLocaleString()}원
                {lot.pricing.dailyMax && ` · 1일 최대 ${lot.pricing.dailyMax.toLocaleString()}원`}
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

        {/* 탭 영역 */}
        <ParkingTabs lotId={lot.id} />
      </div>
    </div>
  )
}
