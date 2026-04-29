import { MapPin, Navigation, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getDifficultyIcon } from '@/lib/geo-utils'
import { searchParkingLots, searchPlaces } from '@/server/parking'
import type { ParkingLot, Place } from '@/types/parking'

interface SearchBarProps {
  onSelect: (lot: ParkingLot) => void
  onPlaceSelect?: (coords: { lat: number; lng: number }) => void
}

function useSearch(
  onSelect: (lot: ParkingLot) => void,
  onPlaceSelect?: (coords: { lat: number; lng: number }) => void,
) {
  const [query, setQuery] = useState('')
  const [lotResults, setLotResults] = useState<ParkingLot[]>([])
  const [placeResults, setPlaceResults] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const queryRef = useRef('')

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 1) {
      setLotResults([])
      setPlaceResults([])
      setOpen(false)
      return
    }
    setLoading(true)
    try {
      const [lots, places] = await Promise.all([
        searchParkingLots({ data: { query: trimmed } }),
        trimmed.length >= 2 ? searchPlaces({ data: { query: trimmed } }) : Promise.resolve([]),
      ])
      setLotResults(lots)
      setPlaceResults(places)
      // 비동기 완료 시점에 입력이 이미 지워졌으면 열지 않음
      if (queryRef.current.trim().length > 0) {
        setOpen(true)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const handleChange = useCallback(
    (value: string) => {
      setQuery(value)
      queryRef.current = value
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => doSearch(value), 300)
    },
    [doSearch],
  )

  const handleSelectLot = useCallback(
    (lot: ParkingLot) => {
      setQuery(lot.name)
      setOpen(false)
      onSelect(lot)
    },
    [onSelect],
  )

  const handleSelectPlace = useCallback(
    (place: Place) => {
      setQuery(place.name)
      setOpen(false)
      onPlaceSelect?.({ lat: place.lat, lng: place.lng })
    },
    [onPlaceSelect],
  )

  const handleClear = useCallback(() => {
    setQuery('')
    queryRef.current = ''
    setLotResults([])
    setPlaceResults([])
    setOpen(false)
  }, [])

  return {
    query,
    lotResults,
    placeResults,
    open,
    loading,
    setOpen,
    handleChange,
    handleSelectLot,
    handleSelectPlace,
    handleClear,
  }
}

/** 검색 결과 리스트 (inline dropdown / dialog 공용) */
function SearchResults({
  loading,
  lotResults,
  placeResults,
  onSelectLot,
  onSelectPlace,
  maxHeight,
}: {
  loading: boolean
  lotResults: ParkingLot[]
  placeResults: Place[]
  onSelectLot: (lot: ParkingLot) => void
  onSelectPlace: (place: Place) => void
  maxHeight?: string
}) {
  if (loading) {
    return <div className="px-3 py-4 text-sm text-muted-foreground text-center">검색 중...</div>
  }

  if (lotResults.length === 0 && placeResults.length === 0) {
    return (
      <div className="px-3 py-4 text-sm text-muted-foreground text-center">
        검색 결과가 없습니다
      </div>
    )
  }

  return (
    <>
      <div
        className="search-dropdown-scroll overscroll-contain flex-1"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {placeResults.length > 0 && (
          <>
            <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground bg-gray-50 sticky top-0">
              주변 주차장 찾기
            </div>
            {placeResults.map((place, i) => (
              <button
                type="button"
                key={`place-${i}`}
                onClick={() => onSelectPlace(place)}
                className="w-full text-left px-3 py-2.5 hover:bg-gray-50 border-b last:border-b-0 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Navigation className="size-3.5 text-orange-500 shrink-0" />
                  <span className="text-sm font-medium truncate">{place.name}</span>
                  {place.category && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {place.category}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate pl-5.5">{place.address}</p>
              </button>
            ))}
          </>
        )}
        {lotResults.length > 0 && (
          <>
            <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground bg-gray-50 sticky top-0">
              주차장 바로가기
            </div>
            {lotResults.map((lot) => (
              <button
                type="button"
                key={lot.id}
                onClick={() => onSelectLot(lot)}
                className="w-full text-left px-3 py-2.5 hover:bg-gray-50 border-b last:border-b-0 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <MapPin className="size-3.5 text-blue-500 shrink-0" />
                  <span className="text-sm font-medium truncate">{lot.name}</span>
                  <span className="shrink-0 text-xs">
                    {getDifficultyIcon(lot.difficulty.score)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate pl-5.5">{lot.address}</p>
              </button>
            ))}
          </>
        )}
      </div>
      {(placeResults.length > 0 || lotResults.length > 0) && (
        <div className="shrink-0 border-t bg-gray-50 px-3 py-1 text-[11px] text-muted-foreground text-right">
          {placeResults.length > 0 && lotResults.length > 0
            ? `장소 ${placeResults.length}건 · 주차장 ${lotResults.length}건`
            : placeResults.length > 0
              ? `장소 ${placeResults.length}건`
              : `주차장 ${lotResults.length}건`}
        </div>
      )}
    </>
  )
}

export function SearchBar({ onSelect, onPlaceSelect }: SearchBarProps) {
  const search = useSearch(onSelect, onPlaceSelect)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const dialogInputRef = useRef<HTMLInputElement>(null)

  // Close inline dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        search.setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [search])

  // Dialog 열릴 때 input에 포커스
  useEffect(() => {
    if (dialogOpen) {
      setTimeout(() => dialogInputRef.current?.focus(), 100)
    } else {
      search.handleClear()
    }
  }, [dialogOpen, search.handleClear])

  const handleDialogSelectLot = (lot: ParkingLot) => {
    search.handleSelectLot(lot)
    setDialogOpen(false)
  }

  const handleDialogSelectPlace = (place: Place) => {
    search.handleSelectPlace(place)
    setDialogOpen(false)
  }

  return (
    <>
      {/* 모바일: 검색 아이콘 버튼 */}
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="sm:hidden flex size-8 items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
      >
        <Search className="size-4 text-muted-foreground" />
      </button>

      {/* 데스크탑: 인라인 검색바 */}
      <div ref={containerRef} className="relative flex-1 max-w-sm hidden sm:block">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search.query}
            onChange={(e) => search.handleChange(e.target.value)}
            onFocus={() =>
              (search.lotResults.length > 0 || search.placeResults.length > 0) &&
              search.setOpen(true)
            }
            placeholder="장소 또는 주차장 검색..."
            className="pl-8 pr-8 h-8 text-sm"
          />
          {search.query && (
            <button
              type="button"
              onClick={search.handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2"
            >
              <X className="size-3.5 text-muted-foreground" />
            </button>
          )}
        </div>

        {search.open && (
          <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border bg-white shadow-lg flex flex-col max-h-72">
            <SearchResults
              loading={search.loading}
              lotResults={search.lotResults}
              placeResults={search.placeResults}
              onSelectLot={search.handleSelectLot}
              onSelectPlace={search.handleSelectPlace}
            />
          </div>
        )}
      </div>

      {/* 모바일: 검색 다이얼로그 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          showCloseButton={false}
          className="top-[12%] translate-y-0 p-0 gap-0 w-[calc(100%-2rem)] max-w-md rounded-xl"
        >
          <DialogTitle className="sr-only">주차장 검색</DialogTitle>
          <div className="relative p-3 border-b">
            <Search className="absolute left-5.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              ref={dialogInputRef}
              value={search.query}
              onChange={(e) => search.handleChange(e.target.value)}
              placeholder="장소 또는 주차장 검색..."
              className="pl-8 pr-8 h-10 text-base"
            />
            {search.query && (
              <button
                type="button"
                onClick={search.handleClear}
                className="absolute right-5.5 top-1/2 -translate-y-1/2"
              >
                <X className="size-4 text-muted-foreground" />
              </button>
            )}
          </div>
          <div className="flex flex-col max-h-[60vh]">
            {search.query.trim().length > 0 ? (
              <SearchResults
                loading={search.loading}
                lotResults={search.lotResults}
                placeResults={search.placeResults}
                onSelectLot={handleDialogSelectLot}
                onSelectPlace={handleDialogSelectPlace}
                maxHeight="55vh"
              />
            ) : (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                장소명, 주차장명, 주소를 검색하세요
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
