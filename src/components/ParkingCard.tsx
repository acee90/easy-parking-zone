import { Link } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  CreditCard,
  Flame,
  MapPin,
  MessageSquare,
  ParkingSquare,
  Phone,
  Star,
  Tag,
  ThumbsUp,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NavigationButton } from '@/components/NavigationButton'
import { ParkingReputationSections } from '@/components/ParkingReputationSections'
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
  getDifficultyLabel,
  getDistance,
  getReliabilityBadge,
} from '@/lib/geo-utils'
import {
  formatOperatingHours,
  formatPhone,
  formatPricing,
  formatTotalSpaces,
} from '@/lib/parking-display'
import { nearestSnap, type SnapPoints } from '@/lib/sheet-snap'
import { makeParkingSlug } from '@/lib/slug'
import { fetchTabCounts } from '@/server/parking'
import type { ParkingLot } from '@/types/parking'

const MID_HEIGHT = 320
const FULL_HEIGHT_RATIO = 0.85
const CLOSE_DRAG_THRESHOLD = 120

interface ParkingCardProps {
  lot: ParkingLot | null
  onClose: () => void
  userLat?: number
  userLng?: number
  userLocated?: boolean
}

export function ParkingCard({ lot, onClose, userLat, userLng, userLocated }: ParkingCardProps) {
  const [isMobile, setIsMobile] = useState(true)
  const [sheetHeight, setSheetHeight] = useState(MID_HEIGHT)
  const [isDragging, setIsDragging] = useState(false)
  const prevLotId = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(MID_HEIGHT)
  const lastDragDelta = useRef(0)

  const [tabCounts, setTabCounts] = useState<{ reviews: number; blog: number; media: number }>({
    reviews: 0,
    blog: 0,
    media: 0,
  })

  const getFullHeight = useCallback(
    () => Math.max(MID_HEIGHT, Math.round(window.innerHeight * FULL_HEIGHT_RATIO)),
    [],
  )

  const getSnapPoints = useCallback(
    (): SnapPoints => ({ mid: MID_HEIGHT, full: getFullHeight() }),
    [getFullHeight],
  )

  // 드래그 중에는 0까지 따라가도록 허용 (mid → close 드래그 시 시각 피드백)
  const clampHeight = useCallback(
    (height: number) => Math.min(getFullHeight(), Math.max(0, height)),
    [getFullHeight],
  )

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    setIsMobile(!mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(!e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  // 새 주차장 선택 시 mid 위치로 리셋 + 스크롤 맨 위로
  useEffect(() => {
    if (lot && lot.id !== prevLotId.current) {
      setIsDragging(false)
      setSheetHeight(MID_HEIGHT)
      prevLotId.current = lot.id
      scrollRef.current?.scrollTo(0, 0)
    }
    if (!lot) {
      prevLotId.current = null
    }
  }, [lot])

  // 평판 카운트 fetch
  useEffect(() => {
    if (!lot) return
    let cancelled = false
    setTabCounts({ reviews: 0, blog: 0, media: 0 })
    fetchTabCounts({ data: { parkingLotId: lot.id } })
      .then((counts) => {
        if (!cancelled) setTabCounts(counts)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [lot])

  const handleClose = useCallback(() => {
    setIsDragging(false)
    setSheetHeight(0)
    setTimeout(() => {
      onClose()
    }, 300)
  }, [onClose])

  useEffect(() => {
    if (!isMobile) return

    const handleResize = () => {
      setSheetHeight((prev) => {
        if (prev <= MID_HEIGHT) return MID_HEIGHT
        return getFullHeight()
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [getFullHeight, isMobile])

  const handleDragStart = useCallback(
    (e: React.TouchEvent<HTMLElement>) => {
      dragStartY.current = e.touches[0].clientY
      dragStartHeight.current = sheetHeight
      lastDragDelta.current = 0
      setIsDragging(true)
    },
    [sheetHeight],
  )

  const handleDragMove = useCallback(
    (e: React.TouchEvent<HTMLElement>) => {
      if (!isDragging) return

      const deltaY = e.touches[0].clientY - dragStartY.current
      lastDragDelta.current = deltaY
      setSheetHeight(clampHeight(dragStartHeight.current - deltaY))
    },
    [clampHeight, isDragging],
  )

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return

    const dragDistance = lastDragDelta.current
    setIsDragging(false)

    // mid에서 아래로 충분히 드래그하면 닫기 (transition 그대로 적용 → 부드러운 close)
    if (dragStartHeight.current <= MID_HEIGHT + 8 && dragDistance > CLOSE_DRAG_THRESHOLD) {
      setSheetHeight(0)
      setTimeout(() => {
        onClose()
      }, 300)
      return
    }

    // 가장 가까운 스냅 포인트로 이동 (mid / full)
    const target = nearestSnap(sheetHeight, getSnapPoints())
    setSheetHeight(target)

    // mid로 돌아가는 경우 스크롤도 맨 위로
    if (target === MID_HEIGHT) {
      scrollRef.current?.scrollTo({ top: 0 })
    }
  }, [getSnapPoints, isDragging, onClose, sheetHeight])

  if (!lot || !isMobile) return null

  const score = lot.difficulty.score
  const scoreLabel = getDifficultyLabel(score)
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const summary = lot.curationReason ?? lot.aiSummary
  const operatingHours = formatOperatingHours(lot.operatingHours)
  const pricing = formatPricing(lot.pricing)
  const totalSpacesLabel = formatTotalSpaces(lot.totalSpaces)
  const phoneLabel = formatPhone(lot.phone)
  const slug = makeParkingSlug(lot.name, lot.id)
  const hasAiTips = Boolean(lot.aiTipPricing || lot.aiTipVisit || lot.aiTipAlternative)
  const hasContentAbove = Boolean(summary) || hasAiTips
  const sourceCount = tabCounts.reviews + tabCounts.blog + tabCounts.media
  const distance =
    userLocated && userLat && userLng ? getDistance(userLat, userLng, lot.lat, lot.lng) : null

  return (
    <Sheet open={!!lot} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        side="bottom"
        className={`rounded-t-xl overflow-hidden flex flex-col will-change-[height] ${
          isDragging ? 'duration-0' : 'transition-[height] duration-300 ease-out'
        }`}
        style={{ height: `${sheetHeight}px` }}
        showCloseButton={false}
      >
        <div
          ref={scrollRef}
          className={`flex-1 overflow-y-auto overscroll-contain ${
            isDragging ? 'overflow-hidden' : ''
          }`}
        >
          {/* 드래그 핸들 + 닫기 — sticky 고정. touch-none으로 native scroll 차단 */}
          <div
            className="sticky top-0 z-10 bg-background touch-none"
            onTouchStart={handleDragStart}
            onTouchMove={handleDragMove}
            onTouchEnd={handleDragEnd}
          >
            <div className="flex items-center justify-between px-4 pt-1.5">
              <div className="w-8" />
              <div
                aria-hidden="true"
                className="w-10 h-1 rounded-full bg-gray-300 cursor-grab active:cursor-grabbing"
              />
              <button
                type="button"
                onClick={handleClose}
                className="flex size-7 items-center justify-center rounded-full hover:bg-gray-100 active:bg-gray-200 transition-colors cursor-pointer outline-none focus:outline-none"
                aria-label="닫기"
              >
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>

            <SheetHeader className="[&]:p-0 [&]:px-4 [&]:pb-2 [&]:pt-1">
              <SheetTitle className="sr-only">{lot.name}</SheetTitle>
              <SheetDescription className="sr-only">주차장 상세 정보</SheetDescription>
            </SheetHeader>
          </div>

          <div className="px-4 pb-safe space-y-4">
            {/* 헤더: 뱃지 + 제목 + 주소 */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={lot.pricing.isFree ? 'default' : 'outline'}>
                  {lot.pricing.isFree ? '무료' : '유료'}
                </Badge>
                <Badge variant="outline">{lot.type}</Badge>
                {score !== null && score >= 4.0 && (
                  <Badge className="gap-1 bg-green-100 text-green-700 hover:bg-green-100">
                    <ThumbsUp className="size-3" />
                    초보 추천
                  </Badge>
                )}
                {score !== null && score < 2.0 && (
                  <Badge variant="destructive" className="gap-1">
                    <Flame className="size-3" />
                    초보 주의
                  </Badge>
                )}
              </div>
              <h2 className="text-xl font-bold leading-tight tracking-normal flex items-center gap-2">
                <span
                  className={`size-2.5 rounded-full shrink-0 ${getDifficultyColor(score)}`}
                  aria-hidden="true"
                />
                {lot.name}
              </h2>
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0" />
                <span>{lot.address}</span>
                {distance !== null && (
                  <span className="ml-auto shrink-0 tabular-nums">
                    {distance < 1 ? `${Math.round(distance * 1000)}m` : `${distance.toFixed(1)}km`}
                  </span>
                )}
              </div>
            </div>

            {/* 점수 + 평판 근거 2-카드 그리드 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-white p-3">
                <div className="text-xs font-medium text-muted-foreground">쉬움 점수</div>
                <div className="mt-2 flex items-end gap-2">
                  <span className="text-3xl font-black leading-none">
                    {score === null ? '-' : score.toFixed(1)}
                  </span>
                  <span className="pb-1 text-sm font-semibold text-muted-foreground">/ 5</span>
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-sm font-medium">
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <Star
                        key={i}
                        className={`size-3 ${
                          i <= Math.round(score ?? 0)
                            ? 'fill-yellow-400 text-yellow-400'
                            : 'text-gray-300'
                        }`}
                      />
                    ))}
                  </div>
                  <span>{scoreLabel}</span>
                </div>
              </div>

              <div className="rounded-lg border bg-white p-3">
                <div className="text-xs font-medium text-muted-foreground">평판 근거</div>
                <div className="mt-2 text-3xl font-black leading-none">{sourceCount}</div>
                <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <MessageSquare className="size-3.5" />
                  리뷰/영상/웹 글
                </div>
              </div>
            </div>

            {/* 액션 행 */}
            <div className="flex flex-wrap items-center gap-2">
              <NavigationButton
                lat={lot.lat}
                lng={lot.lng}
                name={lot.name}
                buttonClassName="px-3 py-2 text-sm"
              />
              <VoteBookmarkBar lotId={lot.id} />
              {lot.phone && (
                <a
                  href={`tel:${lot.phone}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm font-medium transition-colors hover:bg-zinc-50"
                >
                  <Phone className="size-3.5" />
                  전화
                </a>
              )}
              <Link
                to="/wiki/$slug"
                params={{ slug }}
                onClick={handleClose}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-2 text-sm font-medium rounded-lg border hover:bg-gray-50 transition-colors"
              >
                자세히보기
                <ChevronRight className="size-3" />
              </Link>
            </div>

            {reliabilityBadge && (
              <Badge variant="outline" className={reliabilityBadge.className}>
                {reliabilityBadge.label}
              </Badge>
            )}

            {/* AI 요약 — 위키 톤 (분기 제거, 항상 파란 카드) */}
            {summary && (
              <section className="rounded-xl border border-blue-100 bg-blue-50 p-4">
                <div className="mb-2 text-xs font-semibold text-blue-700">AI 요약</div>
                <p className="whitespace-pre-line text-sm font-medium leading-relaxed text-zinc-900">
                  {summary}
                </p>
                {lot.featuredSource === '1010' && (
                  <p className="mt-3 pt-2 border-t border-blue-200 text-xs text-blue-700/80">
                    📺 10시10분 유튜브 채널에 소개된 주차장
                  </p>
                )}
              </section>
            )}

            {/* AI 팁 3-카드 그리드 (모바일은 1열로 떨어짐) */}
            {hasAiTips && (
              <section className="grid grid-cols-1 gap-2">
                {lot.aiTipPricing && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-sm font-semibold text-gray-900">요금</span>
                    {lot.aiTipPricing}
                  </div>
                )}
                {lot.aiTipVisit && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-sm font-semibold text-gray-900">방문 팁</span>
                    {lot.aiTipVisit}
                  </div>
                )}
                {lot.aiTipAlternative && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-sm font-semibold text-gray-900">대안</span>
                    {lot.aiTipAlternative}
                  </div>
                )}
              </section>
            )}

            {/* 기본 정보 */}
            <section
              className={hasContentAbove ? 'border-t-2 border-zinc-300 pt-6 pb-2' : 'pt-1 pb-2'}
            >
              <h3 className="mb-3 text-base font-bold">주차장 정보</h3>
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-2.5">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{lot.address}</span>
                </div>

                <div className="flex items-start gap-2.5">
                  <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className={operatingHours.isUnknown ? 'text-muted-foreground' : ''}>
                      {operatingHours.primary}
                    </div>
                    {operatingHours.secondary && (
                      <div className="text-xs text-muted-foreground">
                        {operatingHours.secondary}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <CreditCard className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className={pricing.isUnknown ? 'text-muted-foreground' : ''}>
                      {pricing.primary}
                    </div>
                    {pricing.secondary && (
                      <div className="text-xs text-muted-foreground">{pricing.secondary}</div>
                    )}
                  </div>
                </div>

                {totalSpacesLabel && (
                  <div className="flex items-center gap-2.5">
                    <ParkingSquare className="size-4 shrink-0 text-muted-foreground" />
                    <span>{totalSpacesLabel}</span>
                  </div>
                )}

                {phoneLabel && (
                  <div className="flex items-center gap-2.5">
                    <Phone className="size-4 shrink-0 text-muted-foreground" />
                    <a href={`tel:${phoneLabel}`} className="text-blue-500 underline">
                      {phoneLabel}
                    </a>
                  </div>
                )}

                {lot.poiTags && lot.poiTags.length > 0 && (
                  <div className="flex items-start gap-2.5">
                    <Tag className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="flex flex-wrap gap-1.5">
                      {lot.poiTags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {lot.notes && (
                  <p className="text-sm text-muted-foreground bg-gray-50 rounded-lg px-3 py-2">
                    {lot.notes}
                  </p>
                )}
              </div>
            </section>

            {/* 리뷰/영상/블로그 — 위키 톤 캐로셀 */}
            <section className="pt-2">
              <ParkingReputationSections
                lotId={lot.id}
                expanded
                viewAllSlug={slug}
                initialTabCounts={tabCounts}
              />
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
