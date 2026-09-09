import type { ParkingLot } from '@/types/parking'

const NO_INFO = '정보 없음'

type TimeRange = { start: string; end: string }

/**
 * 값이 시각으로 쓸 만한가.
 *
 * 빈 값 말고 **문자열 `'null'`** 도 걸러야 한다. 크롤러가 `null` 을 문자열로 써 넣은 행이
 * 1,071곳 있고(2026-09-09 리모트 실측), 그대로 두면 화면에 `평일 null-null` 이 나온다.
 */
const hasTime = (value: string | undefined | null): boolean => {
  const v = value?.trim()
  return Boolean(v) && v !== 'null'
}

const normalizeRange = (range: TimeRange) => `${range.start.trim()}-${range.end.trim()}`

/**
 * 24시간 운영 인코딩. 출처마다 끝 시각을 다르게 준다 (2026-09-09 리모트 실측):
 * 공공데이터·카카오는 `00:00-23:59`(20,327곳), MODU·하이파킹은 `00:00-24:00`(11,498곳).
 */
const HOURS_24 = new Set(['0:00-23:59', '00:00-23:59', '0:00-24:00', '00:00-24:00'])

/** 시작과 끝이 같은 자정 = 값이 안 채워진 것. 공공데이터 sync 가 빈 칸을 `00:00` 으로 메운다 */
const UNSET_RANGES = new Set(['0:00-0:00', '00:00-00:00', '0:00-00:00', '00:00-0:00'])

export const is24HourRange = (range: TimeRange): boolean =>
  hasTime(range.start) && hasTime(range.end) && HOURS_24.has(normalizeRange(range))

/**
 * 운영시간이 "모름"인가.
 *
 * 값이 비었거나(문자열 `'null'` 포함) 시작·끝이 둘 다 자정이면 미상이다. 구조화 데이터도
 * 같은 판정을 써야 화면에 안 보이는 시간을 검색엔진에만 내보내는 일이 생기지 않는다.
 *
 * ⚠️ `00:00-24:00` 은 **미상이 아니다**. 예전 주석은 "공공데이터에서 채워지지 않은 행이
 * 그렇게 들어온다" 고 했지만 사실이 아니었다 — 공공데이터 sync 는 빈 칸을 `00:00` 으로
 * 메우고(`sync-public-data.ts:190`), `00:00-24:00` 은 전부 MODU·하이파킹 행이다.
 * MODU 는 상세페이지의 `HH:MM ~ HH:MM` 을 그대로 긁으므로(`backfill-modu-hours.ts:56`)
 * 그 값은 원본이 24시간 운영이라고 말한 것이다. 미상으로 보는 동안 9,835곳이
 * 「정보 없음」으로 잘못 나왔다.
 */
export const isUnsetTimeRange = (range: TimeRange): boolean => {
  if (!hasTime(range.start) || !hasTime(range.end)) return true
  return UNSET_RANGES.has(normalizeRange(range))
}

/** 시간대 한 칸을 사람이 읽는 문장으로. 미상이면 null — 지어내지 않는다 */
export function formatTimeRange(range: TimeRange): string | null {
  if (isUnsetTimeRange(range)) return null
  if (is24HourRange(range)) return '24시간'
  return `${range.start.trim()}-${range.end.trim()}`
}

interface OperatingHoursDisplay {
  primary: string
  secondary?: string
  isUnknown: boolean
}

export function formatOperatingHours(hours: ParkingLot['operatingHours']): OperatingHoursDisplay {
  const allUnset =
    isUnsetTimeRange(hours.weekday) &&
    isUnsetTimeRange(hours.saturday) &&
    isUnsetTimeRange(hours.holiday)

  if (allUnset) {
    return { primary: `운영시간 ${NO_INFO}`, isUnknown: true }
  }

  const sat = formatTimeRange(hours.saturday)
  const hol = formatTimeRange(hours.holiday)
  const satPart = sat ? `토 ${sat}` : null
  const holPart = hol ? `공휴일 ${hol}` : null
  const secondary = [satPart, holPart].filter(Boolean).join(' · ') || undefined

  const weekday = formatTimeRange(hours.weekday)

  return {
    primary: weekday ? `평일 ${weekday}` : (secondary ?? `운영시간 ${NO_INFO}`),
    secondary: weekday ? secondary : undefined,
    isUnknown: false,
  }
}

interface PricingDisplay {
  primary: string
  secondary?: string
  isUnknown: boolean
}

export function formatPricing(pricing: ParkingLot['pricing']): PricingDisplay {
  if (pricing.isFree) {
    return { primary: '무료', isUnknown: false }
  }

  if (pricing.baseFee <= 0 && pricing.baseTime <= 0) {
    return { primary: `요금 ${NO_INFO}`, isUnknown: true }
  }

  // 기본요금 0원 = "최초 N분 무료" 정책(백화점·마트 등). "기본 30분 0원"은 사용자가 읽기 어렵다.
  const primary =
    pricing.baseFee <= 0
      ? `최초 ${pricing.baseTime}분 무료`
      : `기본 ${pricing.baseTime}분 ${pricing.baseFee.toLocaleString()}원`
  const extras: string[] = []

  if (pricing.extraTime > 0 && pricing.extraFee > 0) {
    extras.push(`추가 ${pricing.extraTime}분당 ${pricing.extraFee.toLocaleString()}원`)
  }
  if (pricing.dailyMax) {
    extras.push(`1일 최대 ${pricing.dailyMax.toLocaleString()}원`)
  }

  return {
    primary,
    secondary: extras.length > 0 ? extras.join(' · ') : undefined,
    isUnknown: false,
  }
}

export function formatTotalSpaces(totalSpaces: number): string | null {
  if (!totalSpaces || totalSpaces <= 0) return null
  return `총 ${totalSpaces}면`
}

export function formatPhone(phone: string | undefined): string | null {
  if (!phone || !phone.trim()) return null
  return phone.trim()
}

export function formatDistanceLabel(distanceKm: number): string {
  if (distanceKm < 1) return `${Math.round(distanceKm * 1000)}m`
  return `${distanceKm.toFixed(1)}km`
}
