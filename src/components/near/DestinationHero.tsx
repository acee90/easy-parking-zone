import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { Destination, DestinationLot } from '@/types/parking'

const CATEGORY_LABEL: Record<Destination['category'], string> = {
  station: '지하철역',
  market: '전통시장',
  mall: '쇼핑',
  tourist: '관광지',
}

/**
 * 목적지 페이지 머리 (#166, 기획 12-6절)
 *
 * H1 은 검색어 그대로("석촌역 근처 주차장")이고, 그 아래 수치 타일이 답을 먼저 준다.
 * 값이 없는 타일은 그리지 않는다 — 네 개가 다 있을 때만 네 개다. 카드·테두리·그림자는 쓰지 않는다(표면 규칙).
 */
export function DestinationHero({
  dest,
  lots,
  easyCount,
}: {
  dest: Destination
  lots: DestinationLot[]
  easyCount: number
}) {
  const nearest = lots[0]
  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: '반경 1km 주차장', value: `${dest.lotCount}곳` },
  ]
  if (dest.freeCount > 0) tiles.push({ label: '무료', value: `${dest.freeCount}곳` })
  if (nearest) {
    tiles.push({
      label: '가장 가까운 곳',
      value: `${nearest.distanceM}m`,
      sub: `${nearest.lot.name} · 직선거리`,
    })
  }
  if (easyCount > 0) tiles.push({ label: '초보 추천', value: `${easyCount}곳` })

  return (
    <div className="flex flex-col gap-4">
      <nav
        aria-label="breadcrumb"
        className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      >
        <Link to="/wiki" className="transition-colors hover:text-foreground hover:underline">
          둘러보기
        </Link>
        <ChevronRight className="size-3 shrink-0" />
        <span className="font-medium text-foreground">{dest.name} 근처 주차장</span>
      </nav>

      <div className="flex flex-col gap-1">
        <p className="m-0 text-[11.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {CATEGORY_LABEL[dest.category]}
        </p>
        <h1 className="m-0 text-[25px] font-extrabold leading-[1.25] tracking-[-0.02em] text-ink">
          {dest.name} 근처 주차장 {dest.lotCount}곳
        </h1>
        {dest.address && <p className="m-0 text-[13px] text-muted-foreground">{dest.address}</p>}
      </div>

      <dl className="m-0 grid grid-cols-2 gap-y-4 sm:grid-cols-4 sm:divide-x sm:divide-zinc-100">
        {tiles.map((t) => (
          <div key={t.label} className="flex flex-col gap-0.5 sm:px-4 sm:first:pl-0">
            <dt className="text-[10.5px] font-semibold text-muted-foreground">{t.label}</dt>
            <dd className="m-0 text-[20px] font-extrabold tabular-nums text-ink">{t.value}</dd>
            {t.sub && <dd className="m-0 text-[11px] text-faint">{t.sub}</dd>}
          </div>
        ))}
      </dl>
    </div>
  )
}
