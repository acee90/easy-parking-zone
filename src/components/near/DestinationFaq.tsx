import { SectionShell } from '@/components/wiki/SectionShell'
import type { Destination, DestinationLot } from '@/types/parking'

export interface DestinationFaqItem {
  q: string
  a: string
}

/**
 * 답이 데이터에서 계산되는 문항만 만든다 (#166, 기획 12-6절 [5]).
 * 주차장 상세페이지 FAQ 와 문장이 겹치지 않도록 목적지 기준으로만 쓴다.
 * 만들 수 있는 문항이 없으면 빈 배열.
 */
export function buildDestinationFaq(
  dest: Destination,
  lots: DestinationLot[],
  easiest: DestinationLot | undefined,
): DestinationFaqItem[] {
  const items: DestinationFaqItem[] = []
  const nearest = lots[0]

  if (dest.freeCount > 0) {
    const names = lots
      .filter((dl) => dl.lot.pricing.isFree)
      .slice(0, 3)
      .map((dl) => dl.lot.name)
    items.push({
      q: `${dest.name} 근처에 무료 주차장이 있나요?`,
      a: `반경 1km 안에 ${dest.freeCount}곳 있습니다. ${names.join(', ')}${dest.freeCount > 3 ? ' 등' : ''}입니다.`,
    })
  } else if (lots.length > 0) {
    items.push({
      q: `${dest.name} 근처에 무료 주차장이 있나요?`,
      a: `저희가 확인한 반경 1km 안의 ${lots.length}곳 중에는 무료로 표기된 곳이 없습니다.`,
    })
  }

  if (nearest) {
    items.push({
      q: `${dest.name}에서 가장 가까운 주차장은 어디인가요?`,
      a: `${nearest.lot.name}입니다. 직선거리 ${nearest.distanceM}m, 도보 약 ${nearest.walkMinutes}분입니다.`,
    })
  }

  if (easiest) {
    items.push({
      q: `${dest.name} 근처에서 초보 운전자가 대기 쉬운 곳은 어디인가요?`,
      a: `후기와 웹 글로 계산한 난이도 점수가 가장 높은 곳은 ${easiest.lot.name}(${easiest.lot.difficulty.score?.toFixed(1)}점)입니다.`,
    })
  }

  return items
}

export function DestinationFaq({ items }: { items: DestinationFaqItem[] }) {
  if (items.length === 0) return null
  return (
    <SectionShell title="자주 묻는 질문" sub={`${items.length}문항`}>
      <dl className="m-0 flex flex-col divide-y divide-zinc-100">
        {items.map((it) => (
          <div key={it.q} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <dt className="text-[14.5px] font-bold text-ink">{it.q}</dt>
            <dd className="m-0 text-[14px] leading-[1.65] text-ink">{it.a}</dd>
          </div>
        ))}
      </dl>
    </SectionShell>
  )
}
