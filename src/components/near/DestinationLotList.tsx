import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { HourFee, PricingCell } from '@/components/wiki/RelatedParkingLotsSection'
import { SectionShell } from '@/components/wiki/SectionShell'
import { getDifficultyIcon } from '@/lib/geo-utils'
import { estimateFee } from '@/lib/parking-fee'
import { makeParkingSlug } from '@/lib/slug'
import type { DestinationLot } from '@/types/parking'

type SortKey = 'near' | 'cheap' | 'easy' | 'free'

const TABS: { key: SortKey; label: string }[] = [
  { key: 'near', label: '가까운 순' },
  { key: 'cheap', label: '싼 순' },
  { key: 'easy', label: '쉬운 순' },
  { key: 'free', label: '무료만' },
]

function hasPricing(dl: DestinationLot): boolean {
  const p = dl.lot.pricing
  return p.isFree || p.baseTime > 0
}

function sortLots(lots: DestinationLot[], key: SortKey): DestinationLot[] {
  const arr = [...lots]
  switch (key) {
    case 'near':
      return arr.sort((a, b) => a.distanceM - b.distanceM)
    case 'cheap':
      return arr.sort((a, b) => {
        const fa = estimateFee(a.lot.pricing, 60)
        const fb = estimateFee(b.lot.pricing, 60)
        if (fa === null && fb === null) return a.distanceM - b.distanceM
        if (fa === null) return 1
        if (fb === null) return -1
        return fa - fb || a.distanceM - b.distanceM
      })
    case 'easy':
      return arr.sort((a, b) => {
        const sa = a.lot.difficulty.score
        const sb = b.lot.difficulty.score
        if (sa === null && sb === null) return a.distanceM - b.distanceM
        if (sa === null) return 1
        if (sb === null) return -1
        return sb - sa || a.distanceM - b.distanceM
      })
    case 'free':
      return arr.filter((dl) => dl.lot.pricing.isFree).sort((a, b) => a.distanceM - b.distanceM)
  }
}

/**
 * 주변 주차장 비교표 (#166, 기획 12-6절 [2])
 *
 * 데스크톱은 테이블, 모바일은 카드다. 유입의 82% 가 모바일 네이버 검색이라
 * 가로 스크롤 테이블을 첫 화면에 둘 수 없다 (검토 4-2절).
 * 열 단위로 값이 전무하면 그 열을 없앤다. "확인 권장" 같은 문장으로 빈칸을 채우지 않는다.
 */
export function DestinationLotList({ lots }: { lots: DestinationLot[] }) {
  const [sort, setSort] = useState<SortKey>('near')
  const sorted = useMemo(() => sortLots(lots, sort), [lots, sort])

  const anyPricing = lots.some(hasPricing)
  const anySpaces = lots.some((dl) => dl.lot.totalSpaces > 0)
  const anyScore = lots.some((dl) => dl.lot.difficulty.score !== null)
  const noPricingCount = lots.filter((dl) => !hasPricing(dl)).length
  const freeCount = lots.filter((dl) => dl.lot.pricing.isFree).length

  return (
    <SectionShell title="주변 주차장 비교" sub={`${lots.length}곳 · 반경 1km`}>
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="정렬">
        {TABS.filter((t) => t.key !== 'free' || freeCount > 0).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={sort === t.key}
            onClick={() => setSort(t.key)}
            className={
              sort === t.key
                ? 'rounded-full bg-zinc-100 px-3 py-1 text-[12px] font-semibold text-ink'
                : 'rounded-full px-3 py-1 text-[12px] text-muted-foreground hover:text-ink'
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 모바일: 카드 목록 */}
      <ul className="m-0 flex list-none flex-col divide-y divide-zinc-100 p-0 md:hidden">
        {sorted.map((dl) => {
          const { lot } = dl
          return (
            <li key={lot.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-2">
                <Link
                  to="/wiki/$slug"
                  params={{ slug: makeParkingSlug(lot.name, lot.id) }}
                  className="min-w-0 truncate text-[15px] font-bold text-ink hover:underline"
                >
                  {lot.name}
                </Link>
                <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
                  {dl.distanceM}m · 도보 {dl.walkMinutes}분
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink">
                {anyPricing && (
                  <span>
                    <PricingCell lot={lot} />
                  </span>
                )}
                {anyPricing && !lot.pricing.isFree && lot.pricing.baseTime > 0 && (
                  <span>
                    1시간 <HourFee lot={lot} />
                  </span>
                )}
                {anySpaces && lot.totalSpaces > 0 && <span>{lot.totalSpaces}면</span>}
                {anyScore && lot.difficulty.score !== null && (
                  <span>
                    {getDifficultyIcon(lot.difficulty.score)} {lot.difficulty.score.toFixed(1)}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {/* 데스크톱: 테이블 */}
      <div className="hidden md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[11.5px] font-semibold text-muted-foreground">
              <th className="py-2 pr-2 font-semibold">주차장</th>
              <th className="py-2 pr-2 font-semibold">도보(직선)</th>
              {anyPricing && <th className="py-2 pr-2 font-semibold">요금</th>}
              {anyPricing && <th className="py-2 pr-2 font-semibold">1시간</th>}
              {anySpaces && <th className="py-2 pr-2 font-semibold">면수</th>}
              {anyScore && <th className="py-2 font-semibold">난이도</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {sorted.map((dl) => {
              const { lot } = dl
              return (
                <tr key={lot.id}>
                  <td className="py-2.5 pr-2">
                    <Link
                      to="/wiki/$slug"
                      params={{ slug: makeParkingSlug(lot.name, lot.id) }}
                      className="font-semibold text-ink hover:underline"
                    >
                      {lot.name}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-2 tabular-nums text-muted-foreground">
                    {dl.distanceM}m · {dl.walkMinutes}분
                  </td>
                  {anyPricing && (
                    <td className="py-2.5 pr-2">
                      <PricingCell lot={lot} />
                    </td>
                  )}
                  {anyPricing && (
                    <td className="py-2.5 pr-2 tabular-nums">
                      {lot.pricing.isFree ? (
                        <span className="text-green-700">0원</span>
                      ) : lot.pricing.baseTime > 0 ? (
                        <HourFee lot={lot} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                  {anySpaces && (
                    <td className="py-2.5 pr-2 tabular-nums">
                      {lot.totalSpaces > 0 ? (
                        `${lot.totalSpaces}면`
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                  {anyScore && (
                    <td className="py-2.5 tabular-nums">
                      {lot.difficulty.score !== null ? (
                        <>
                          {getDifficultyIcon(lot.difficulty.score)}{' '}
                          {lot.difficulty.score.toFixed(1)}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 mb-0 text-[11px] text-faint">
        거리는 직선거리 기준이며 실제 보행 경로와 다를 수 있습니다.
        {noPricingCount > 0 && ` 요금 정보가 없는 ${noPricingCount}곳은 요금 칸을 비워 두었습니다.`}
      </p>
    </SectionShell>
  )
}
