import { ArrowUpDown, ChevronRight, MapPin, ParkingSquare } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getDifficultyIcon, getDifficultyLabel, getDistance } from '@/lib/geo-utils'
import type { ParkingLot, SortMode } from '@/types/parking'

const PAGE_SIZE = 20

interface ParkingSidebarProps {
  parkingLots: ParkingLot[]
  selectedLotId: string | null
  hoveredLotId?: string | null
  onSelect: (lot: ParkingLot) => void
  onHover: (lotId: string | null) => void
  userLat?: number
  userLng?: number
  userLocated?: boolean
  mapCenter?: { lat: number; lng: number } | null
}

function difficultyColor(score: number | null) {
  if (score === null) return 'bg-gray-400'
  if (score >= 4.0) return 'bg-green-500'
  if (score >= 2.5) return 'bg-yellow-500'
  if (score >= 1.5) return 'bg-orange-500'
  return 'bg-red-500'
}

export function ParkingSidebar({
  parkingLots,
  selectedLotId,
  onSelect,
  hoveredLotId,
  onHover,
  userLat,
  userLng,
  userLocated,
  mapCenter,
}: ParkingSidebarProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [sortMode, setSortMode] = useState<SortMode>('distance')

  // parkingLots 변경 시 표시 개수 초기화
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [])

  // 거리 기준점: 유저 위치 > 지도 중심
  const refLat = userLocated && userLat != null ? userLat : mapCenter?.lat
  const refLng = userLocated && userLng != null ? userLng : mapCenter?.lng

  const sortedLots = useMemo(() => {
    const withDistance = parkingLots.map((lot) => ({
      lot,
      distance:
        refLat != null && refLng != null ? getDistance(refLat, refLng, lot.lat, lot.lng) : null,
    }))

    if (sortMode === 'distance') {
      withDistance.sort((a, b) => {
        if (a.distance !== null && b.distance !== null) {
          return a.distance - b.distance
        }
        return (b.lot.difficulty.score ?? -1) - (a.lot.difficulty.score ?? -1)
      })
    } else {
      withDistance.sort((a, b) => (b.lot.difficulty.score ?? -1) - (a.lot.difficulty.score ?? -1))
    }

    return withDistance
  }, [parkingLots, refLat, refLng, sortMode])

  // 선택된 주차장이 visibleCount 밖이면 확장
  const selectedIdx = selectedLotId ? sortedLots.findIndex((s) => s.lot.id === selectedLotId) : -1
  const effectiveCount = selectedIdx >= visibleCount ? selectedIdx + 1 : visibleCount

  const visibleLots = sortedLots.slice(0, effectiveCount)
  const hasMore = effectiveCount < sortedLots.length

  // 마커 클릭 시 리스트 자동 스크롤
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  useEffect(() => {
    if (!selectedLotId) return
    const el = itemRefs.current.get(selectedLotId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selectedLotId])

  return (
    <aside className="w-full h-full flex-col bg-white/95 backdrop-blur-sm flex overflow-hidden">
      <div className="shrink-0 px-4 py-2 border-b flex items-center gap-1">
        <ArrowUpDown className="size-3 text-muted-foreground" />
        <button
          type="button"
          onClick={() => setSortMode('distance')}
          className={`px-2 py-0.5 rounded text-sm cursor-pointer transition-colors ${
            sortMode === 'distance'
              ? 'bg-blue-100 text-blue-700 font-medium'
              : 'text-muted-foreground hover:bg-gray-100'
          }`}
        >
          {userLocated ? '가까운 순' : '지도 중심 순'}
        </button>
        <button
          type="button"
          onClick={() => setSortMode('difficulty')}
          className={`px-2 py-0.5 rounded text-xs cursor-pointer transition-colors ${
            sortMode === 'difficulty'
              ? 'bg-blue-100 text-blue-700 font-medium'
              : 'text-muted-foreground hover:bg-gray-100'
          }`}
        >
          쉬운 순
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sortedLots.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm px-4 text-center">
            <ParkingSquare className="size-8 mb-2 opacity-30" />
            <p>현재 지도 영역에</p>
            <p>주차장이 없습니다</p>
          </div>
        ) : (
          <>
            {visibleLots.map(({ lot, distance }) => {
              const selected = lot.id === selectedLotId
              const hovered = lot.id === hoveredLotId
              const icon = getDifficultyIcon(lot.difficulty.score)
              const label = getDifficultyLabel(lot.difficulty.score)

              return (
                <button
                  type="button"
                  key={lot.id}
                  ref={(el) => {
                    if (el) itemRefs.current.set(lot.id, el)
                    else itemRefs.current.delete(lot.id)
                  }}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-blue-50 transition-colors cursor-pointer flex items-center gap-2 ${
                    selected
                      ? 'bg-blue-50 border-l-2 border-l-blue-500'
                      : hovered
                        ? 'bg-blue-50'
                        : ''
                  }`}
                  onClick={() => onSelect(lot)}
                  onMouseEnter={() => onHover(lot.id)}
                  onMouseLeave={() => onHover(null)}
                  aria-label={selected ? `${lot.name} 자세히 보기` : `${lot.name} 선택`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div
                        className={`size-2.5 rounded-full shrink-0 ${difficultyColor(lot.difficulty.score)}`}
                      />
                      <span className="font-medium text-base truncate flex-1">{lot.name}</span>
                      <span className="text-sm shrink-0">{icon}</span>
                    </div>

                    <div className="flex items-center gap-1.5 mb-1.5">
                      <MapPin className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-sm text-muted-foreground truncate">{lot.address}</span>
                    </div>

                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={`px-1.5 py-0.5 rounded ${
                          lot.difficulty.score !== null
                            ? 'bg-gray-100 text-gray-700'
                            : 'bg-gray-50 text-gray-400'
                        }`}
                      >
                        {label}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded ${
                          lot.pricing.isFree
                            ? 'bg-green-50 text-green-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {lot.pricing.isFree ? '무료' : '유료'}
                      </span>
                      {lot.totalSpaces > 0 && (
                        <span className="text-muted-foreground">{lot.totalSpaces}면</span>
                      )}
                      {distance !== null && (
                        <span className="text-muted-foreground ml-auto">
                          {distance < 1
                            ? `${Math.round(distance * 1000)}m`
                            : `${distance.toFixed(1)}km`}
                        </span>
                      )}
                    </div>
                  </div>
                  {selected && (
                    <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-blue-500" />
                  )}
                </button>
              )
            })}
            {hasMore && (
              <button
                className="w-full py-3 text-sm text-blue-500 hover:bg-blue-50 transition-colors cursor-pointer font-medium"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              >
                더 보기 ({sortedLots.length - effectiveCount}개 남음)
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
