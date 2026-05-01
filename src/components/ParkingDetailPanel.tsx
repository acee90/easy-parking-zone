import { Link } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  CreditCard,
  Flame,
  MapPin,
  ParkingSquare,
  Phone,
  Tag,
  ThumbsUp,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavigationButton } from '@/components/NavigationButton'
import { ParkingReputationSections } from '@/components/ParkingReputationSections'
import { Badge } from '@/components/ui/badge'
import { VoteBookmarkBar } from '@/components/VoteBookmarkBar'
import { getReliabilityBadge } from '@/lib/geo-utils'
import {
  formatOperatingHours,
  formatPhone,
  formatPricing,
  formatTotalSpaces,
} from '@/lib/parking-display'
import { makeParkingSlug } from '@/lib/slug'
import { fetchTabCounts } from '@/server/parking'
import type { ParkingLot } from '@/types/parking'

interface ParkingDetailPanelProps {
  lot: ParkingLot
  onClose: () => void
  userLat?: number
  userLng?: number
  userLocated?: boolean
}

export function ParkingDetailPanel({ lot, onClose }: ParkingDetailPanelProps) {
  const score = lot.difficulty.score
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const summary = lot.curationReason ?? lot.aiSummary
  const operatingHours = formatOperatingHours(lot.operatingHours)
  const pricing = formatPricing(lot.pricing)
  const totalSpacesLabel = formatTotalSpaces(lot.totalSpaces)
  const phoneLabel = formatPhone(lot.phone)
  const slug = makeParkingSlug(lot.name, lot.id)
  const hasAiTips = Boolean(lot.aiTipPricing || lot.aiTipVisit || lot.aiTipAlternative)
  const hasContentAbove = Boolean(summary) || hasAiTips

  const [tabCounts, setTabCounts] = useState<{ reviews: number; blog: number; media: number }>({
    reviews: 0,
    blog: 0,
    media: 0,
  })

  useEffect(() => {
    let cancelled = false
    fetchTabCounts({ data: { parkingLotId: lot.id } })
      .then((counts) => {
        if (!cancelled) setTabCounts(counts)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [lot.id])

  const sourceCount = tabCounts.reviews + tabCounts.blog + tabCounts.media

  return (
    <div className="w-[400px] shrink-0 flex-col bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border pointer-events-auto flex overflow-hidden animate-in slide-in-from-left-4 duration-150">
      <div className="flex-1 overflow-y-auto">
        {/* 헤더 */}
        <section className="relative border-b bg-white px-5 pt-5 pb-4">
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 p-1.5 rounded-md bg-white/90 hover:bg-gray-100 transition-colors cursor-pointer"
            aria-label="닫기"
          >
            <X className="size-4 text-muted-foreground" />
          </button>

          <div className="space-y-4 pr-8">
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
              <h2 className="text-2xl font-bold leading-tight tracking-normal">{lot.name}</h2>
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0" />
                <span>{lot.address}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-white p-3">
                <div className="text-xs font-medium text-muted-foreground">쉬움 점수</div>
                <div className="mt-2 flex items-end gap-2">
                  <span className="text-3xl font-black leading-none">
                    {score === null ? '-' : score.toFixed(1)}
                  </span>
                  <span className="pb-1 text-sm font-semibold text-muted-foreground">/ 5</span>
                </div>
              </div>

              <div className="rounded-lg border bg-white p-3">
                <div className="text-xs font-medium text-muted-foreground">리뷰/영상/블로그</div>
                <div className="mt-2 text-3xl font-black leading-none">{sourceCount}</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <NavigationButton
                lat={lot.lat}
                lng={lot.lng}
                name={lot.name}
                buttonClassName="px-3 py-2 text-sm"
              />
              <VoteBookmarkBar lotId={lot.id} />
              <Link
                to="/wiki/$slug"
                params={{ slug }}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-2 text-sm font-medium rounded-lg border hover:bg-gray-50 transition-colors"
              >
                자세히
                <ChevronRight className="size-3" />
              </Link>
            </div>
            {reliabilityBadge && (
              <Badge variant="outline" className={reliabilityBadge.className}>
                {reliabilityBadge.label}
              </Badge>
            )}
          </div>
        </section>

        {/* 컨텐츠 */}
        <div className="px-5 py-5 space-y-4">
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
                    <div className="text-xs text-muted-foreground">{operatingHours.secondary}</div>
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
    </div>
  )
}
