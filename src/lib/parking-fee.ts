import type { ParkingLot } from '@/types/parking'

type Pricing = ParkingLot['pricing']

/** 도보 속도(m/분). 경쟁사 관측치(약 75)보다 보수적으로 잡아 과소 안내를 피한다. */
const WALK_METERS_PER_MINUTE = 67

/**
 * 이용시간(분)에 대한 예상 요금.
 *
 * 계산 불가일 때 숫자를 지어내지 않고 null 을 반환하는 것이 이 함수의 핵심이다.
 * 과거 초안은 `base_fee * 60 / base_time` 근사식을 쓰자고 했는데, 그 식은
 * 추가 단위요금·올림·1일 최대요금을 반영하지 못해 유료 주차장의 33%에서 틀린 값을 냈다
 * (2026-09-02 remote 실측: 9,266건 중 3,057건). 게다가 extra_* 가 비어 있는
 * 3,846건에서는 아예 없는 요금을 만들어낸다.
 */
export function estimateFee(pricing: Pricing, minutes: number): number | null {
  if (minutes <= 0) return null

  // `is_free=1` 인데 요금표도 함께 들어 있는 lot 이 643곳 있다(2026-09-02 remote 실측).
  // 대개 "일부 시간 무료 + 이후 유료" 이거나 데이터가 어긋난 경우다.
  // 이때 0원이라고 단언하면 사람이 돈을 준비하지 않고 갔다가 낭패를 본다.
  // 무료 플래그만 있고 요금표가 없을 때만 0원으로 답하고, 둘 다 있으면 "모름"으로 남긴다.
  if (pricing.isFree) {
    const hasFeeTable = pricing.baseFee > 0 || pricing.extraFee > 0
    return hasFeeTable ? null : 0
  }

  const { baseTime, baseFee, extraTime, extraFee, dailyMax } = pricing
  // 경계(transforms.ts)에서 걸러지지만, 다른 경로로 들어온 값도 여기서 막는다.
  // 숫자가 아닌 값이 새면 `baseFee + units * extraFee` 가 문자열 연결이 된다.
  if (!Number.isFinite(baseTime) || !Number.isFinite(baseFee)) return null

  // 기본 구간 자체가 없으면 판단 불가
  if (baseTime <= 0) return null

  if (minutes <= baseTime) return capDaily(baseFee, dailyMax)

  // 기본 시간을 넘겼는데 추가 요금 정보가 없다 → 계산 불가 (0원으로 처리하면 거짓말이 된다)
  if (!Number.isFinite(extraTime) || !Number.isFinite(extraFee)) return null
  if (extraTime <= 0 || extraFee <= 0) return null

  const units = Math.ceil((minutes - baseTime) / extraTime)
  return capDaily(baseFee + units * extraFee, dailyMax)
}

function capDaily(fee: number, dailyMax: number | undefined): number {
  if (dailyMax && dailyMax > 0) return Math.min(fee, dailyMax)
  return fee
}

/** 이 주차장에서 요금 계산기를 켤 수 있는가 */
export function canEstimateFee(pricing: Pricing): boolean {
  // 무료 플래그와 요금표가 동시에 있으면 어느 쪽이 맞는지 알 수 없다 → 계산기를 아예 숨긴다
  if (pricing.isFree) return !(pricing.baseFee > 0 || pricing.extraFee > 0)
  return pricing.baseTime > 0 && pricing.extraTime > 0 && pricing.extraFee > 0
}

/** 직선거리(km) → 도보 예상 시간(분). 실제 보행로가 아니므로 "직선거리 기준"임을 화면에 밝힌다. */
export function walkMinutes(distanceKm: number): number {
  return Math.max(1, Math.round((distanceKm * 1000) / WALK_METERS_PER_MINUTE))
}
