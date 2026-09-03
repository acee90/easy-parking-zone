import { useState } from 'react'
import { isUnsetTimeRange } from '@/lib/parking-display'
import { canEstimateFee, estimateFee } from '@/lib/parking-fee'
import type { ParkingLot } from '@/types/parking'

const DURATIONS = [
  { minutes: 30, label: '30분' },
  { minutes: 60, label: '1시간' },
  { minutes: 120, label: '2시간' },
  { minutes: 240, label: '4시간' },
  { minutes: 480, label: '8시간' },
  { minutes: 1440, label: '종일' },
]

/**
 * 주차 요금 계산기.
 *
 * 요금 정보가 모자란 주차장에서는 아예 렌더하지 않는다(`canEstimateFee`).
 * 빈 값을 0원으로 채워 내보내면 "1시간 예상 요금은 0원입니다" 같은 거짓 안내가 된다.
 */
/**
 * 평일 운영시간에서 실제로 댈 수 있는 최대 분.
 *
 * 09:00~18:00 인 곳에 '종일'(1440분) 버튼을 두면 4만 원대 금액이 나오는데 실현 불가능한 값이다
 * (해당 lot 5,141곳). 운영시간을 모르거나 24시간이면 제한하지 않는다.
 */
function maxParkableMinutes(hours: ParkingLot['operatingHours']): number | null {
  if (isUnsetTimeRange(hours.weekday)) return null
  const toMin = (v: string) => {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    return Number(m[1]) * 60 + Number(m[2])
  }
  const start = toMin(hours.weekday.start)
  const end = toMin(hours.weekday.end)
  if (start === null || end === null) return null
  // 자정을 넘겨 운영하는 곳(22:00~02:00)은 제한을 걸지 않는다 — 계산이 더 틀릴 수 있다
  const span = end - start
  if (span <= 0) return null
  return span
}

export function FeeCalculatorSection({ lot }: { lot: ParkingLot }) {
  const [minutes, setMinutes] = useState(60)

  if (!canEstimateFee(lot.pricing)) return null

  // 운영시간을 넘는 선택지는 아예 보여주지 않는다. 못 대는 시간의 요금은 안내가 아니라 오해다.
  const cap = maxParkableMinutes(lot.operatingHours)
  const options = cap === null ? DURATIONS : DURATIONS.filter((d) => d.minutes <= cap)
  const durations = options.length > 0 ? options : DURATIONS.slice(0, 1)

  const fee = estimateFee(lot.pricing, minutes)
  const { baseTime, baseFee, extraTime, dailyMax } = lot.pricing

  let detail: string
  if (lot.pricing.isFree) {
    detail = '무료 주차장입니다'
  } else if (fee === null) {
    detail = '추가 요금 정보가 없어 계산할 수 없습니다'
    // 기본 구간 판정이 상한 판정보다 먼저다.
    // base_fee == daily_max 인 lot(553곳)은 30분에도 "1일 최대 요금 적용"이라 나왔다.
  } else if (minutes <= baseTime) {
    detail =
      baseFee > 0 ? `기본 ${baseTime}분 ${baseFee.toLocaleString()}원` : `최초 ${baseTime}분 무료`
  } else if (dailyMax && fee === dailyMax) {
    detail = `1일 최대 요금 ${dailyMax.toLocaleString()}원 적용`
  } else {
    const units = Math.ceil((minutes - baseTime) / extraTime)
    const head =
      baseFee > 0 ? `기본 ${baseTime}분 ${baseFee.toLocaleString()}원` : `최초 ${baseTime}분 무료`
    detail = `${head} + 추가 ${extraTime}분 × ${units}회`
  }

  return (
    <section className="flex flex-col">
      <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">
          주차 요금 계산
        </h2>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">공시 요금 기준</span>
      </div>
      <p className="mb-[11px] text-[11.5px] text-faint">실제 요금은 현장 안내를 확인해 주세요</p>

      <div className="flex flex-wrap gap-2">
        {durations.map(({ minutes: m, label }) => (
          <button
            key={m}
            type="button"
            onClick={() => setMinutes(m)}
            aria-pressed={minutes === m}
            className={`cursor-pointer rounded-lg px-3.5 py-1.5 text-sm font-semibold tabular-nums transition-colors ${
              minutes === m
                ? 'bg-primary text-primary-foreground'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-black tabular-nums tracking-tight">
          {fee === null ? '계산 불가' : `${fee.toLocaleString()}원`}
        </span>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">{detail}</span>
      </div>
    </section>
  )
}
