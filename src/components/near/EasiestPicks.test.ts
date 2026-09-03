import { describe, expect, it } from 'vitest'
import type { DestinationLot, ParkingLot } from '@/types/parking'
import { pickEasiest } from './EasiestPicks'

function dl(
  id: string,
  score: number | null,
  reliability: ParkingLot['difficulty']['reliability'],
): DestinationLot {
  return {
    lot: {
      id,
      name: id,
      difficulty: { score, reviewCount: 0, reliability },
    } as unknown as ParkingLot,
    distanceM: 100,
    walkMinutes: 2,
    rank: 1,
    evidenceSourceId: null,
  }
}

describe('pickEasiest', () => {
  it('structural·reference·none 점수는 추천 근거로 쓰지 않는다', () => {
    const picks = pickEasiest([
      dl('a', 4.5, 'structural'),
      dl('b', 4.4, 'reference'),
      dl('c', 4.0, 'none'),
      dl('d', 3.8, 'estimated'),
      dl('e', 3.6, 'confirmed'),
    ])
    expect(picks.map((p) => p.lot.id)).toEqual(['d', 'e'])
  })
  it('실제 신호가 하나도 없으면 빈 배열 → 섹션 미렌더', () => {
    expect(pickEasiest([dl('a', 4.5, 'structural')])).toEqual([])
  })
})
