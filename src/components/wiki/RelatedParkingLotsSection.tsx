import { Link } from '@tanstack/react-router'
import { getDistance } from '@/lib/geo-utils'
import { formatDistanceLabel } from '@/lib/parking-display'
import { estimateFee, walkMinutes } from '@/lib/parking-fee'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

/** 1시간 예상요금 셀 — 계산 불가면 숫자를 지어내지 않는다. 목적지 페이지(#166)도 같은 셀을 쓴다 */
export function HourFee({ lot }: { lot: ParkingLot }) {
  const fee = estimateFee(lot.pricing, 60)
  if (fee === null) return <span className="text-muted-foreground">확인 필요</span>
  if (fee === 0) return <span className="font-semibold text-green-700">0원</span>
  return <span className="font-semibold">{fee.toLocaleString()}원</span>
}

export function PricingCell({ lot }: { lot: ParkingLot }) {
  const { isFree, baseTime, baseFee, extraTime, extraFee } = lot.pricing
  if (isFree) return <span className="font-medium text-green-700">무료</span>
  // 기본 시간이 없으면 요금 체계를 모른다
  if (baseTime <= 0) return <span className="text-muted-foreground">정보 없음</span>

  const extra =
    extraTime > 0 && extraFee > 0 ? ` / +${extraTime}분 ${extraFee.toLocaleString()}원` : ''

  // 기본요금 0원은 "정보 없음"이 아니라 **최초 N분 무료** 정책이다 (백화점·마트 등 711곳).
  // '정보 없음'으로 뭉개면 오히려 유리한 조건인 주차장이 정보가 빠진 곳처럼 보인다.
  // parking-display.ts 의 formatPricing 은 이미 이렇게 표기하고 있어 화면 안에서도 어긋났다.
  if (baseFee <= 0) {
    return (
      <span>
        <span className="font-medium text-green-700">최초 {baseTime}분 무료</span>
        {extra}
      </span>
    )
  }

  return (
    <span>
      {baseTime}분 {baseFee.toLocaleString()}원{extra}
    </span>
  )
}

/**
 * 주변 주차장 비교표.
 *
 * 첫 행은 지금 보는 주차장이다. "주변에 뭐가 있나" 목록이 아니라 "지금 여기 대비 주변이
 * 어떤가"를 비교하는 표라서, 기준값이 같은 줄에 없으면 아래 주차장이 싼 건지 비싼 건지
 * 판단할 수 없다.
 */
export function RelatedParkingLotsSection({ lot, lots }: { lot: ParkingLot; lots: ParkingLot[] }) {
  if (lots.length === 0) return null

  return (
    <section className="flex flex-col">
      <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">
          주변 주차장 비교
        </h2>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">{lots.length}곳</span>
      </div>
      <p className="mb-[11px] text-[11.5px] text-faint">
        첫 줄이 지금 보는 주차장입니다 · 거리는 직선거리 기준
      </p>

      <div className="-mx-5 overflow-x-auto px-5 md:-mx-6 md:px-6">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="bg-zinc-50 text-[11px] tracking-wide text-muted-foreground">
              <th className="whitespace-nowrap rounded-l-lg px-3 py-2 text-left font-semibold">
                주차장
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">거리</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">도보</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">면수</th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-semibold">요금</th>
              <th className="whitespace-nowrap rounded-r-lg px-3 py-2 text-right font-semibold">
                1시간
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            <tr className="bg-primary/5">
              <td className="rounded-l-lg px-3 py-3 font-bold text-primary">
                {lot.name}
                <span className="ml-1.5 rounded bg-white px-1.5 py-0.5 align-middle text-[10px] font-bold text-primary">
                  지금 보는 곳
                </span>
              </td>
              <td className="px-3 py-3 text-right text-muted-foreground">—</td>
              <td className="px-3 py-3 text-right text-muted-foreground">—</td>
              <td className="px-3 py-3 text-right">
                {lot.totalSpaces > 0 ? lot.totalSpaces : '—'}
              </td>
              <td className="px-3 py-3">
                <PricingCell lot={lot} />
              </td>
              <td className="rounded-r-lg px-3 py-3 text-right">
                <HourFee lot={lot} />
              </td>
            </tr>
            {lots.map((related) => {
              const km = getDistance(lot.lat, lot.lng, related.lat, related.lng)
              return (
                <tr key={related.id} className="border-t border-zinc-100">
                  <td className="px-3 py-3 font-medium">
                    <Link
                      to="/wiki/$slug"
                      params={{ slug: makeParkingSlug(related.name, related.id) }}
                      className="transition-colors hover:text-primary hover:underline"
                    >
                      {related.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-right">{formatDistanceLabel(km)}</td>
                  <td className="px-3 py-3 text-right">{walkMinutes(km)}분</td>
                  <td className="px-3 py-3 text-right">
                    {related.totalSpaces > 0 ? related.totalSpaces : '—'}
                  </td>
                  <td className="px-3 py-3">
                    <PricingCell lot={related} />
                  </td>
                  <td className="px-3 py-3 text-right">
                    <HourFee lot={related} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
