/**
 * 지역 허브 집계 — 색인 실험 처치 그룹용 (docs/exec-plans/region-hub-indexing-2026-09-14.md).
 *
 * 상세 페이지와 숫자가 어긋나지 않도록 화면과 같은 판정을 쓴다:
 * 1시간 요금은 `estimateFee`(계산 불가면 뺀다), 24시간은 `is24HourRange`(운영시간 미상은 모수에서 뺀다).
 */
import { is24HourRange, isUnsetTimeRange } from '@/lib/parking-display'
import { estimateFee } from '@/lib/parking-fee'
import type { ParkingLot } from '@/types/parking'

/** 처치 그룹 — `PARKING_REGIONS` 순서에서 짝수 번째. 결과를 보고 바꾸지 않는다 */
export const ENRICHED_REGIONS: ReadonlySet<string> = new Set([
  '서울',
  '인천',
  '대구',
  '광주',
  '세종',
  '충북',
  '전북',
  '경북',
  '제주',
])

export interface RegionStatsRow {
  type: string | null
  is_free: number | null
  total_spaces: number | null
  weekday_start: string | null
  weekday_end: string | null
  base_time: number | null
  base_fee: number | null
  extra_time: number | null
  extra_fee: number | null
  daily_max: number | null
  address: string | null
}

export interface DistrictStats {
  name: string
  count: number
  free: number
  feeMedian: number | null
  feeCount: number
}

export interface RegionStats {
  total: number
  outdoor: number
  attached: number
  onStreet: number
  free: number
  large: number
  feeMedian: number | null
  feeCount: number
  hours24: number
  hoursKnown: number
  districts: DistrictStats[]
}

const LARGE_SPACES = 200

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** 유료 lot 의 1시간 요금. 무료이거나 요금표로 계산할 수 없으면 null */
function paidHourFee(row: RegionStatsRow): number | null {
  if (num(row.is_free) === 1) return null
  const pricing = {
    isFree: false,
    baseTime: num(row.base_time),
    baseFee: num(row.base_fee),
    extraTime: num(row.extra_time),
    extraFee: num(row.extra_fee),
    dailyMax: num(row.daily_max),
  } as ParkingLot['pricing']
  const fee = estimateFee(pricing, 60)
  return fee !== null && fee > 0 ? fee : null
}

/** '서울특별시 강남구 …' → 강남구. 허브의 구·시·군 분류 SQL 과 같은 규칙(주소 두 번째 토큰) */
export function districtOf(address: string | null, prefixes: readonly string[]): string | null {
  const token = address?.trim().split(/\s+/)[1]
  if (!token || !/[시군구]$/.test(token)) return null
  if (prefixes.some((prefix) => token.startsWith(prefix))) return null
  return token
}

export function computeRegionStats(
  rows: readonly RegionStatsRow[],
  prefixes: readonly string[],
): RegionStats {
  let outdoor = 0
  let attached = 0
  let onStreet = 0
  let free = 0
  let large = 0
  let hours24 = 0
  let hoursKnown = 0
  const fees: number[] = []
  const byDistrict = new Map<string, { count: number; free: number; fees: number[] }>()

  for (const row of rows) {
    if (row.type === '노외') outdoor++
    else if (row.type === '부설') attached++
    else if (row.type === '노상') onStreet++

    const isFree = num(row.is_free) === 1
    if (isFree) free++
    if (num(row.total_spaces) >= LARGE_SPACES) large++

    const range = { start: row.weekday_start ?? '', end: row.weekday_end ?? '' }
    if (!isUnsetTimeRange(range)) {
      hoursKnown++
      if (is24HourRange(range)) hours24++
    }

    const fee = paidHourFee(row)
    if (fee !== null) fees.push(fee)

    const district = districtOf(row.address, prefixes)
    if (district) {
      const group = byDistrict.get(district) ?? { count: 0, free: 0, fees: [] }
      group.count++
      if (isFree) group.free++
      if (fee !== null) group.fees.push(fee)
      byDistrict.set(district, group)
    }
  }

  const districts = [...byDistrict.entries()]
    .map(([name, g]) => ({
      name,
      count: g.count,
      free: g.free,
      feeMedian: median(g.fees),
      feeCount: g.fees.length,
    }))
    .sort((a, b) => b.count - a.count)

  return {
    total: rows.length,
    outdoor,
    attached,
    onStreet,
    free,
    large,
    feeMedian: median(fees),
    feeCount: fees.length,
    hours24,
    hoursKnown,
    districts,
  }
}
