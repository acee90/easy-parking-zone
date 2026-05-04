import type { ParkingLot } from '@/types/parking'

export interface ParkingTabCounts {
  reviews: number
  blog: number
  media: number
}

function hasText(value: string | undefined | null) {
  return Boolean(value?.trim())
}

function hasMeaningfulText(value: string | undefined | null, minLength = 10) {
  return (value?.trim().length ?? 0) >= minLength
}

function hasKnownTime(value: string | undefined | null) {
  if (!hasText(value)) return false
  return !['00:00', '0:00', '정보없음', '-'].includes(value.trim())
}

function hasKnownOperatingHours(lot: ParkingLot) {
  const { weekday, saturday, holiday } = lot.operatingHours
  return [
    weekday.start,
    weekday.end,
    saturday.start,
    saturday.end,
    holiday.start,
    holiday.end,
  ].some(hasKnownTime)
}

function hasKnownPricing(lot: ParkingLot) {
  const { pricing } = lot
  return (
    pricing.isFree ||
    pricing.baseTime > 0 ||
    pricing.baseFee > 0 ||
    pricing.extraTime > 0 ||
    pricing.extraFee > 0 ||
    pricing.dailyMax !== undefined ||
    pricing.monthlyPass !== undefined
  )
}

function hasKnownDifficulty(lot: ParkingLot) {
  return (
    lot.difficulty.reviewCount > 0 ||
    (lot.difficulty.score !== null &&
      lot.difficulty.reliability !== undefined &&
      lot.difficulty.reliability !== 'none')
  )
}

export function getParkingDetailSeoSignalCount(lot: ParkingLot) {
  const signals = [
    lot.totalSpaces > 0,
    hasKnownOperatingHours(lot),
    hasKnownPricing(lot),
    hasText(lot.phone),
    hasText(lot.paymentMethods),
    hasMeaningfulText(lot.notes),
    hasKnownDifficulty(lot),
    hasText(lot.verifiedSource),
    (lot.poiTags?.length ?? 0) > 0,
  ]

  return signals.filter(Boolean).length
}

export function hasParkingDetailEditorialContent(lot: ParkingLot) {
  return Boolean(
    hasMeaningfulText(lot.curationReason) ||
      hasMeaningfulText(lot.aiSummary) ||
      hasMeaningfulText(lot.aiTipPricing) ||
      hasMeaningfulText(lot.aiTipVisit) ||
      hasMeaningfulText(lot.aiTipAlternative),
  )
}

export function shouldIndexParkingDetail(lot: ParkingLot, tabCounts: ParkingTabCounts | undefined) {
  const externalContentCount = tabCounts ? tabCounts.blog + tabCounts.reviews + tabCounts.media : 0

  if (externalContentCount > 0) return true
  if (hasParkingDetailEditorialContent(lot)) return true

  return getParkingDetailSeoSignalCount(lot) >= 3
}
