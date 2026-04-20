import { Clock, CreditCard, Flame, MapPin, Phone, Star, Tag, ThumbsUp, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NavigationButton } from '@/components/NavigationButton'
import { ParkingTabs } from '@/components/ParkingTabs'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { VoteBookmarkBar } from '@/components/VoteBookmarkBar'
import {
  getDifficultyColor,
  getDifficultyIcon,
  getDifficultyLabel,
  getDistance,
  getReliabilityBadge,
} from '@/lib/geo-utils'
import type { ParkingLot } from '@/types/parking'

interface ParkingCardProps {
  lot: ParkingLot | null
  onClose: () => void
  userLat?: number
  userLng?: number
  userLocated?: boolean
}

export function ParkingCard({ lot, onClose, userLat, userLng, userLocated }: ParkingCardProps) {
  const [isMobile, setIsMobile] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const prevLotId = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    setIsMobile(!mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(!e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  // 새 주차장 선택 시 접힌 상태로 리셋 + 스크롤 맨 위로
  useEffect(() => {
    if (lot && lot.id !== prevLotId.current) {
      setExpanded(false)
      prevLotId.current = lot.id
      scrollRef.current?.scrollTo(0, 0)
    }
    if (!lot) {
      prevLotId.current = null
    }
  }, [lot])

  // 아래로 스크롤 → 확장 (CSS transition 없으므로 즉시 리사이즈, 충돌 없음)
  const lastScrollTop = useRef(0)
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const st = el.scrollTop
    if (!expanded && st > lastScrollTop.current) {
      setExpanded(true)
    }
    lastScrollTop.current = st
  }, [expanded])

  const handleClose = useCallback(() => {
    setExpanded(false)
    onClose()
  }, [onClose])

  // 시트 전체 터치: 위로 스와이프 → 확장, 아래로 스와이프 → 닫기
  const sheetTouchY = useRef(0)
  const handleSheetTouchStart = useCallback((e: React.TouchEvent) => {
    sheetTouchY.current = e.touches[0].clientY
  }, [])
  const handleSheetTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const dy = e.changedTouches[0].clientY - sheetTouchY.current
      if (dy > 30) {
        if (expanded) {
          setExpanded(false)
          scrollRef.current?.scrollTo(0, 0)
        } else {
          handleClose()
        }
      }
      if (dy < -30 && !expanded) {
        setExpanded(true)
      }
    },
    [expanded, handleClose],
  )

  if (!lot || !isMobile) return null

  const icon = getDifficultyIcon(lot.difficulty.score)
  const label = getDifficultyLabel(lot.difficulty.score)
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const distance =
    userLocated && userLat && userLng ? getDistance(userLat, userLng, lot.lat, lot.lng) : null

  return (
    <Sheet open={!!lot} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        side="bottom"
        className={`rounded-t-xl overflow-hidden flex flex-col ${
          expanded ? 'max-h-[85vh]' : 'max-h-[320px]'
        }`}
        showCloseButton={false}
        onTouchStart={handleSheetTouchStart}
        onTouchEnd={handleSheetTouchEnd}
      >
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto overscroll-contain"
        >
          {/* 드래그 핸들 + 타이틀 — sticky 고정 */}
          <div className="sticky top-0 z-10 bg-background">
            <div className="flex items-center justify-between px-4 pt-1.5">
              <div className="w-8" />
              <div className="w-10 h-1 rounded-full bg-gray-300" />
              <button
                onClick={handleClose}
                className="flex size-7 items-center justify-center rounded-full hover:bg-gray-100 active:bg-gray-200 transition-colors cursor-pointer"
                aria-label="닫기"
              >
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>

            <SheetHeader className="[&]:p-0 [&]:px-4 [&]:pb-2">
              <SheetTitle className="text-lg font-bold mb-1">{lot.name}</SheetTitle>
              <div className="flex items-center gap-2 flex-wrap">
                {/* 별점 */}
                <div className="flex items-center gap-1">
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => {
                      const rating = lot.difficulty.score ?? 0
                      return (
                        <Star
                          key={i}
                          className={`size-3 ${
                            i <= Math.round(rating)
                              ? 'fill-yellow-400 text-yellow-400'
                              : 'text-gray-300'
                          }`}
                        />
                      )
                    })}
                  </div>
                  <span className="text-xs font-semibold">
                    {(lot.difficulty.score ?? 0).toFixed(1)}
                  </span>
                </div>
                <Badge className="bg-green-500 hover:bg-green-600 text-white text-xs">
                  주차 가능
                </Badge>
              </div>
              <SheetDescription className="sr-only">주차장 상세 정보</SheetDescription>
            </SheetHeader>
          </div>

          <div className="px-4 pb-4 space-y-3">
            {/* AI Summary */}
            {lot.curationReason && (
              <div
                className={`rounded-lg px-3 py-2.5 text-xs space-y-1 ${
                  lot.difficulty.score !== null && lot.difficulty.score < 2.0
                    ? 'bg-red-50 border border-red-200'
                    : 'bg-blue-50 border border-blue-200'
                }`}
              >
                <div className="font-semibold flex items-center gap-1">
                  {lot.difficulty.score !== null && lot.difficulty.score < 2.0 ? '⚠️' : '✨'} 요약
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
              </div>
            )}

            {/* 난이도 배지 */}
            <div className="flex items-center gap-2 flex-wrap">
              {lot.difficulty.score !== null && lot.difficulty.score < 2.0 && (
                <Badge variant="destructive" className="text-xs gap-1">
                  <Flame className="size-3" />
                  초보 주의
                </Badge>
              )}
              {lot.difficulty.score !== null && lot.difficulty.score >= 4.0 && (
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
              <Badge variant={lot.pricing.isFree ? 'default' : 'outline'}>
                {lot.pricing.isFree ? '무료' : '유료'}
              </Badge>
              {distance !== null && (
                <span className="text-xs text-muted-foreground">
                  {distance < 1 ? `${Math.round(distance * 1000)}m` : `${distance.toFixed(1)}km`}
                </span>
              )}
              {lot.difficulty.reviewCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  리뷰 {lot.difficulty.reviewCount}개
                </span>
              )}
            </div>

            {/* 길찾기 + 투표 */}
            <div className="flex items-center gap-2">
              <NavigationButton lat={lot.lat} lng={lot.lng} name={lot.name} />
              <VoteBookmarkBar lotId={lot.id} />
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
              <div className="flex items-start gap-2 text-sm">
                <CreditCard className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div>
                  <div>
                    기본 {lot.pricing.baseTime}분 {lot.pricing.baseFee.toLocaleString()}원
                  </div>
                  <div className="text-xs text-muted-foreground">
                    추가 {lot.pricing.extraTime}분당 {lot.pricing.extraFee.toLocaleString()}원
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

            {/* POI 태그 */}
            {lot.poiTags && lot.poiTags.length > 0 && (
              <div className="flex items-start gap-2 text-sm">
                <Tag className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
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
              <p className="text-xs text-muted-foreground bg-gray-50 rounded px-2 py-1">
                {lot.notes}
              </p>
            )}

            {/* 리뷰/영상/블로그 탭 */}
            <ParkingTabs lotId={lot.id} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
