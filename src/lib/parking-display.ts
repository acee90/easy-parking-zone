import type { ParkingLot } from '@/types/parking'

const NO_INFO = '정보 없음'

const isUnsetTimeRange = (range: { start: string; end: string }): boolean => {
  if (!range.start || !range.end) return true
  const normalized = `${range.start.trim()}-${range.end.trim()}`
  return normalized === '0:00-24:00' || normalized === '00:00-24:00'
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

  return {
    primary: `평일 ${hours.weekday.start}-${hours.weekday.end}`,
    secondary: `토 ${hours.saturday.start}-${hours.saturday.end} · 공휴일 ${hours.holiday.start}-${hours.holiday.end}`,
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

  const primary = `기본 ${pricing.baseTime}분 ${pricing.baseFee.toLocaleString()}원`
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
