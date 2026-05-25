import { formatOperatingHours, formatPricing } from '@/lib/parking-display'
import type { ParkingLot } from '@/types/parking'

export interface FaqItem {
  question: string
  answer: string
}

export function generateFaqItems(lot: ParkingLot, relatedLots: ParkingLot[]): FaqItem[] {
  const items: FaqItem[] = []

  // Q1: 주차요금
  const pricingAnswer = buildPricingAnswer(lot)
  if (pricingAnswer) {
    items.push({ question: `${lot.name} 주차요금이 얼마인가요?`, answer: pricingAnswer })
  }

  // Q2: 초보운전자 난이도
  const difficultyAnswer = buildDifficultyAnswer(lot)
  if (difficultyAnswer) {
    items.push({
      question: `${lot.name}은 초보운전자도 이용할 수 있나요?`,
      answer: difficultyAnswer,
    })
  }

  // Q3: 운영시간
  const hoursAnswer = buildHoursAnswer(lot)
  if (hoursAnswer) {
    items.push({ question: `${lot.name} 운영시간이 어떻게 되나요?`, answer: hoursAnswer })
  }

  // Q4: 주차면수
  if (lot.totalSpaces > 0) {
    items.push({
      question: `${lot.name} 주차면수는 몇 개인가요?`,
      answer: `총 ${lot.totalSpaces}면 규모입니다.`,
    })
  }

  // Q5: 근처 주차장
  const nearbyAnswer = buildNearbyAnswer(lot, relatedLots)
  if (nearbyAnswer) {
    items.push({ question: `${lot.name} 근처에 다른 주차장도 있나요?`, answer: nearbyAnswer })
  }

  return items
}

function buildPricingAnswer(lot: ParkingLot): string | null {
  if (lot.aiTipPricing) return lot.aiTipPricing

  const display = formatPricing(lot.pricing)
  if (display.isUnknown) return null

  if (lot.pricing.isFree) return '무료 주차장입니다.'

  const parts = [display.primary]
  if (display.secondary) parts.push(display.secondary)
  return `${parts.join('. ')}.`
}

function buildDifficultyAnswer(lot: ParkingLot): string | null {
  const score = lot.difficulty.score
  if (score === null) return '난이도 정보가 충분하지 않습니다.'
  const s = score.toFixed(1)
  if (score >= 4.0) return `쉬움 점수 ${s}점으로 초보운전자도 편하게 이용할 수 있습니다.`
  if (score >= 3.3)
    return `쉬움 점수 ${s}점으로 무난한 편이라 초보운전자도 큰 어려움 없이 이용할 수 있습니다.`
  if (score >= 2.7) return `쉬움 점수 ${s}점으로 보통 수준의 주차장입니다.`
  if (score >= 2.0) return `쉬움 점수 ${s}점으로 다소 어려운 편이라 초보운전자는 주의가 필요합니다.`
  if (score >= 1.5) return `쉬움 점수 ${s}점으로 어려운 주차장이라 초보운전자에게는 비추천합니다.`
  return `쉬움 점수 ${s}점으로 매우 어려운 주차장입니다. 사전에 경로를 확인하고 신중히 진입하세요.`
}

function buildHoursAnswer(lot: ParkingLot): string | null {
  const display = formatOperatingHours(lot.operatingHours)
  if (display.isUnknown) return '정확한 운영시간은 방문 전 확인하세요.'
  const parts = [display.primary]
  if (display.secondary) parts.push(display.secondary)
  return `${parts.join(', ')}.`
}

function buildNearbyAnswer(lot: ParkingLot, relatedLots: ParkingLot[]): string | null {
  if (lot.aiTipAlternative) return lot.aiTipAlternative

  const nearby = relatedLots.slice(0, 3)
  if (nearby.length === 0) return null

  const names = nearby.map((l) => l.name).join(', ')
  return `인근 주차장으로 ${names} 등이 있습니다.`
}
