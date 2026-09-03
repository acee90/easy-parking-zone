import { Link } from '@tanstack/react-router'
import { SectionShell } from '@/components/wiki/SectionShell'
import { getDifficultyIcon, getDifficultyLabel } from '@/lib/geo-utils'
import { makeParkingSlug } from '@/lib/slug'
import type { DestinationLot } from '@/types/parking'

/**
 * 실제 신호(후기·웹 글)로 계산된 난이도만 추천 근거로 쓴다.
 * reliability 가 structural 인 점수는 주차장 유형·규모로 만든 사전값(prior)이라 "쉬운 곳" 추천의
 * 근거가 못 된다 — 발행 목적지에 걸린 주차장 5,308곳 중 65% 가 structural 이다 (2026-09-03).
 * reference(n_effective < 1)도 신호 한 조각뿐이라 제외한다. 남는 것이 없으면 섹션을 그리지 않는다.
 */
const TRUSTED = new Set(['estimated', 'confirmed'])

export function pickEasiest(lots: DestinationLot[], limit = 3): DestinationLot[] {
  return lots
    .filter(
      (dl) =>
        dl.lot.difficulty.score !== null &&
        dl.lot.difficulty.reliability !== undefined &&
        TRUSTED.has(dl.lot.difficulty.reliability),
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
      note="실제 후기와 웹 글에서 계산한 난이도 점수 순입니다. 주차장 유형만으로 추정한 점수는 근거로 쓰지 않았습니다."
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
