import { Link } from '@tanstack/react-router'
import { SectionShell } from '@/components/wiki/SectionShell'
import type { DestinationLink } from '@/types/parking'

/**
 * 이 주차장으로 갈 수 있는 곳 (#166, 기획 6-4절)
 *
 * destination_lots 를 주차장 기준으로 뒤집어 읽은 것. 목적지 페이지 ↔ 주차장 페이지의
 * 양방향 링크 중 올라가는 쪽이다. 기존 "여기 주차하고 가볼 곳"(카페·맛집)과는 다른 데이터라 섞지 않는다.
 * 목적지가 없으면 그리지 않는다.
 */
export function DestinationsForLotSection({ items }: { items: DestinationLink[] }) {
  if (items.length === 0) return null

  return (
    <SectionShell
      title="이 주차장으로 갈 수 있는 곳"
      sub={`${items.length}곳`}
      note="목적지별로 주변 주차장을 비교한 페이지입니다."
    >
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {items.map((d) => (
          <li key={d.id}>
            <Link
              to="/near/$slug"
              params={{ slug: d.slug }}
              className="inline-flex items-baseline gap-1.5 rounded-full bg-zinc-100 px-3 py-1 text-[13px] font-semibold text-ink hover:underline"
            >
              {d.name} 근처 주차장
              <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
                {d.distanceM}m
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionShell>
  )
}
