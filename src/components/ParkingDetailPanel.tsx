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
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { ParkingActionGroup } from '@/components/ParkingActionGroup'
import { ParkingReputationSections } from '@/components/ParkingReputationSections'
import { Badge } from '@/components/ui/badge'
import { getReliabilityBadge } from '@/lib/geo-utils'
import { FIELD_GROUPS, type FieldSources } from '@/lib/lot-field-groups'
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
  userLat?: number
  userLng?: number
  userLocated?: boolean
}

export function ParkingDetailPanel({ lot }: ParkingDetailPanelProps) {
  const score = lot.difficulty.score
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const summary = lot.aiSummary
  const operatingHours = formatOperatingHours(lot.operatingHours)
  const pricing = formatPricing(lot.pricing)
  const totalSpacesLabel = formatTotalSpaces(lot.totalSpaces)
  // `fetchParkingDetail` 이 얹어 주는 값 — 타입에는 없어서 방어적으로 읽는다
  const fieldSources = (lot as ParkingLot & { fieldSources?: FieldSources }).fieldSources
  const hasUserContributedField = fieldSources
    ? FIELD_GROUPS.some((g) => fieldSources[g] === 'user')
    : false
  const phoneLabel = formatPhone(lot.phone)
  const slug = makeParkingSlug(lot.name, lot.id)
  const hasAiTips = Boolean(lot.aiTipPricing || lot.aiTipVisit || lot.aiTipAlternative)
  const hasContentAbove = Boolean(summary) || hasAiTips

  const [tabCounts, setTabCounts] = useState<{ reviews: number; blog: number; media: number }>({
    reviews: 0,
    blog: 0,
    media: 0,
  })

  // 개수를 받기 전엔 아래 리뷰·영상·글 블록을 그리지 않는다 — 빈 lot 은 받은 뒤 접힌다 (D-3)
  const [tabCountsReady, setTabCountsReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setTabCountsReady(false)
    fetchTabCounts({ data: { parkingLotId: lot.id } })
      .then((counts) => {
        if (!cancelled) setTabCounts(counts)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTabCountsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [lot.id])

  return (
    <div className="w-full h-full flex-col bg-white/95 backdrop-blur-sm flex overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {/* 헤더 */}
        <section className="border-b bg-white px-5 pt-4 pb-4">
          <div className="space-y-4">
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
              <h2 className="text-2xl font-bold leading-tight tracking-tight">{lot.name}</h2>
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <MapPin className="mt-0.5 size-4 shrink-0" />
                <span>{lot.address}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-zinc-50 p-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">쉬움 점수</span>
                  {reliabilityBadge && (
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${reliabilityBadge.className}`}
                    >
                      {reliabilityBadge.label}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 flex items-end gap-2">
                  <span className="text-3xl font-black leading-none">
                    {score === null ? '-' : score.toFixed(1)}
                  </span>
                  <span className="pb-1 text-sm font-semibold text-muted-foreground">/ 5</span>
                </div>
              </div>

              <div className="rounded-xl bg-zinc-50 p-3 flex items-center">
                <div className="flex w-full justify-around text-center">
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">리뷰</div>
                    <div className="mt-2 text-2xl font-black leading-none tabular-nums">
                      {tabCounts.reviews}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">영상</div>
                    <div className="mt-2 text-2xl font-black leading-none tabular-nums">
                      {tabCounts.media}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">블로그</div>
                    <div className="mt-2 text-2xl font-black leading-none tabular-nums">
                      {tabCounts.blog}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <ParkingActionGroup lat={lot.lat} lng={lot.lng} name={lot.name} lotId={lot.id} />
              <Link
                to="/wiki/$slug"
                params={{ slug }}
                className="inline-flex items-center gap-1 px-2.5 py-2 text-sm font-medium rounded-lg bg-zinc-100 hover:bg-zinc-200 active:bg-zinc-300 transition-colors"
              >
                자세히
                <ChevronRight className="size-3" />
              </Link>
            </div>
          </div>
        </section>

        {/* 컨텐츠 */}
        <div className="px-5 py-5 space-y-4">
          {summary && (
            <section className="border-t border-zinc-100 pt-4">
              <div className="mb-2 text-xs font-semibold text-primary">AI 요약</div>
              <p className="whitespace-pre-line text-sm font-medium leading-relaxed text-zinc-900">
                {summary}
              </p>
              {lot.featuredSource === '1010' && (
                <p className="mt-3 pt-2 border-t border-zinc-100 text-xs text-muted-foreground">
                  📺 10시10분 유튜브 채널에 소개된 주차장
                </p>
              )}
            </section>
          )}

          {hasAiTips && (
            <section className="grid grid-cols-1 gap-3 border-t border-zinc-100 pt-4">
              {lot.aiTipPricing && (
                <div className="text-sm leading-relaxed text-zinc-700">
                  <span className="mb-1 block text-sm font-semibold text-zinc-900">요금</span>
                  {lot.aiTipPricing}
                </div>
              )}
              {lot.aiTipVisit && (
                <div className="text-sm leading-relaxed text-zinc-700">
                  <span className="mb-1 block text-sm font-semibold text-zinc-900">방문 팁</span>
                  {lot.aiTipVisit}
                </div>
              )}
              {lot.aiTipAlternative && (
                <div className="text-sm leading-relaxed text-zinc-700">
                  <span className="mb-1 block text-sm font-semibold text-zinc-900">대안</span>
                  {lot.aiTipAlternative}
                </div>
              )}
            </section>
          )}

          {/* 기본 정보 */}
          <section className={hasContentAbove ? 'border-t border-zinc-100 pt-5 pb-2' : 'pt-1 pb-2'}>
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

              {/* 이 패널은 상세페이지와 같은 병합 결과(fetchParkingDetail)를 쓴다.
                  칸마다 배지를 달 자리는 없지만, 유저가 채운 값을 공식 정보처럼
                  보여줄 수는 없어 한 줄로 밝힌다. 고치는 건 상세페이지에서. */}
              {hasUserContributedField && (
                <p className="text-xs text-muted-foreground">
                  일부 정보는 유저 제보입니다 · 상세페이지에서 수정할 수 있어요
                </p>
              )}

              {phoneLabel && (
                <div className="flex items-center gap-2.5">
                  <Phone className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">{phoneLabel}</span>
                  <a
                    href={`tel:${phoneLabel}`}
                    className="inline-flex h-8 shrink-0 items-center rounded-full bg-zinc-100 px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-200 active:bg-zinc-300"
                  >
                    전화
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
              bordered
              viewAllSlug={slug}
              initialTabCounts={tabCounts}
              countsReady={tabCountsReady}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
