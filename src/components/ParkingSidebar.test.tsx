import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ParkingLot } from '@/types/parking'

// 행 아래 QuickRating 이 서버 함수를 import 한다 — 테스트에서는 불러오지 않는다
vi.mock('@/server/reviews', () => ({ createReview: vi.fn() }))

import { ParkingSidebar } from './ParkingSidebar'

function makeLots(n: number, prefix: string): ParkingLot[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `${prefix} 주차장 ${i}`,
    type: '노외',
    address: '서울시 어딘가',
    lat: 37.5 + i * 0.0001,
    lng: 127,
    totalSpaces: 10,
    phone: null,
    pricing: {
      isFree: false,
      baseTime: 30,
      baseFee: 1000,
      extraTime: 10,
      extraFee: 500,
      dailyMax: null,
    },
    difficulty: { score: 3.0, reviewCount: 0, reliability: 'none' },
    operatingHours: {
      weekday: { start: '09:00', end: '21:00' },
      saturday: { start: '09:00', end: '21:00' },
      holiday: { start: '09:00', end: '21:00' },
    },
  })) as unknown as ParkingLot[]
}

const rowCount = () => screen.queryAllByRole('button', { name: / 상세보기$/ }).length

describe('ParkingSidebar 표시 개수 (D-6)', () => {
  const props = {
    selectedLotId: null,
    onSelect: () => {},
    onHover: () => {},
    mapCenter: { lat: 37.5, lng: 127 },
  }

  it('「더 보기」로 늘린 개수는 목록이 바뀌면(지도 이동) 20으로 되돌아간다', () => {
    const { rerender } = render(<ParkingSidebar {...props} parkingLots={makeLots(45, 'a')} />)
    expect(rowCount()).toBe(20)

    fireEvent.click(screen.getByRole('button', { name: /더 보기/ }))
    expect(rowCount()).toBe(40)

    rerender(<ParkingSidebar {...props} parkingLots={makeLots(45, 'b')} />)
    expect(rowCount()).toBe(20)
  })

  it('목록 행은 클릭하면 바로 상세로 가는 버튼이다 (C-1)', () => {
    const onSelect = vi.fn()
    render(<ParkingSidebar {...props} onSelect={onSelect} parkingLots={makeLots(3, 'c')} />)
    fireEvent.click(screen.getByRole('button', { name: 'c 주차장 1 상세보기' }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1' }))
  })
})
