import { Link } from '@tanstack/react-router'
import { SectionShell } from '@/components/wiki/SectionShell'
import { getDifficultyIcon, getDifficultyLabel } from '@/lib/geo-utils'
import { makeParkingSlug } from '@/lib/slug'
import type { DestinationLot } from '@/types/parking'

/** 난이도 점수를 믿을 수 있는 주차장만. reliability='none' 은 점수가 있어도 추천하지 않는다 */
export function pickEasiest(lots: DestinationLot[], limit = 3): DestinationLot[] {
  return lots
    .filter(
      (dl) =>
        dl.lot.difficulty.score !== null &&
        dl.lot.difficulty.reliability !== undefined &&
        dl.lot.difficulty.reliability !== 'none',
    )
    .sort((a, b) => (b.lot.difficulty.score ?? 0) - (a.lot.difficulty.score ?? 0))
    .slice(0, limit)
}

/**
 * 초보 추천 (#166, 기획 12-5절)
 *
 * 검색 결과의 경쟁 페이지 열 곳 중 어디에도 없는 요소라 첫 화면에 둔다.
 * 추천할 근거(신뢰할 수 있는 난이도 점수)가 없으면 섹션 자체를 그리지 않는다.
 */
export function EasiestPicks({ picks }: { picks: DestinationLot[] }) {
  if (picks.length === 0) return null

  return (
    <SectionShell
      title="초보 운전자에게 쉬운 곳"
      sub={`${picks.length}곳`}
      note="후기와 웹 글에서 계산한 주차 난이도 점수 순입니다. 점수를 믿기 어려운 곳은 제외했습니다."
    >
      <ol className="m-0 flex list-none flex-col divide-y divide-zinc-100 p-0">
        {picks.map((dl, i) => {
          const { lot } = dl
          const score = lot.difficulty.score
          return (
            <li key={lot.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span className="w-5 shrink-0 text-[13px] font-extrabold tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link
                  to="/wiki/$slug"
                  params={{ slug: makeParkingSlug(lot.name, lot.id) }}
                  className="truncate text-[15px] font-bold text-ink hover:underline"
                >
                  {lot.name}
                </Link>
                <p className="m-0 text-[12.5px] text-muted-foreground">
                  직선 {dl.distanceM}m · 도보 약 {dl.walkMinutes}분
                  {lot.difficulty.reviewCount > 0 && ` · 후기 ${lot.difficulty.reviewCount}건`}
                </p>
              </div>
              <span className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">
                {getDifficultyIcon(score)} {getDifficultyLabel(score)}
                {score !== null && (
                  <span className="ml-1 text-muted-foreground">{score.toFixed(1)}</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </SectionShell>
  )
}
