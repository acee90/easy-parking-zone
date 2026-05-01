import { createFileRoute } from '@tanstack/react-router'
import { Car } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavermapsProvider } from 'react-naver-maps'
import { toast } from 'sonner'
import { FloatingFilters } from '@/components/FloatingFilters'
import { Header } from '@/components/Header'
import { MapErrorBoundary } from '@/components/MapErrorBoundary'
import { MapView } from '@/components/MapView'
import { MobileBottomPanel } from '@/components/MobileBottomPanel'
import { MobileFilterSheet } from '@/components/MobileFilterSheet'
import { ParkingCard } from '@/components/ParkingCard'
import { ParkingDetailPanel } from '@/components/ParkingDetailPanel'
import { ParkingSidebar } from '@/components/ParkingSidebar'
import { useGeolocation } from '@/hooks/useGeolocation'
import { useParkingFilters } from '@/hooks/useParkingFilters'
import { type MapFeature, useSuperCluster } from '@/hooks/useSuperCluster'
import { Route as RootRoute } from '@/routes/__root'
import type { ParkingPoint } from '@/server/parking'
import { fetchAllParkingPoints, fetchParkingDetail, fetchParkingLots } from '@/server/parking'
import type { MapBounds, ParkingLot } from '@/types/parking'

const DETAIL_PANEL_WIDTH = 400
const FILTER_LEFT_CLOSED = 296
const FILTER_LEFT_OPENED = 12 + 280 + 8 + DETAIL_PANEL_WIDTH

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    lotId: typeof search.lotId === 'string' ? search.lotId : undefined,
  }),
  head: () => ({
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz' }],
  }),
  component: App,
})

function App() {
  const siteStats = RootRoute.useLoaderData()
  const { lotId } = Route.useSearch()
  const {
    lat: userLat,
    lng: userLng,
    loading: locationLoading,
    located: userLocated,
    initializing,
    requestLocation,
    error: locationError,
  } = useGeolocation()

  const { filters, toggle, toggleDifficulty, setFeeRange, toggleMinSpaces, activeCount } =
    useParkingFilters()

  const [isClient, setIsClient] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [allPoints, setAllPoints] = useState<ParkingPoint[] | null>(null)
  const [parkingLots, setParkingLots] = useState<ParkingLot[]>([])
  const [features, setFeatures] = useState<MapFeature[]>([])
  const [selectedLot, setSelectedLot] = useState<ParkingLot | null>(null)
  const [hoveredLotId, setHoveredLotId] = useState<string | null>(null)
  const [moveTo, setMoveTo] = useState<{ lat: number; lng: number } | null>(null)
  const lastViewRef = useRef<{ bounds: MapBounds; zoom: number } | null>(null)
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number } | null>({
    lat: 37.5666,
    lng: 126.9784,
  })

  useEffect(() => {
    setIsClient(true)
  }, [])

  useEffect(() => {
    if (locationError) toast.error(locationError)
  }, [locationError])

  // 전체 경량 데이터 1회 로드
  useEffect(() => {
    fetchAllParkingPoints()
      .then(setAllPoints)
      .catch((err) => {
        console.error('[fetchAllParkingPoints] error:', err)
      })
  }, [])

  // 난이도 필터를 경량 포인트에 적용 (클러스터링에 반영)
  const filteredPoints = useMemo(() => {
    if (!allPoints) return null
    const d = filters.difficulty
    const allOn = Object.values(d).every(Boolean)
    if (allOn) return allPoints

    return allPoints.filter((p) => {
      const s = p.score
      if (s === null) return true
      if (s >= 4.0) return d.easy
      if (s >= 3.3) return d.decent
      if (s >= 2.7) return d.normal
      if (s >= 2.0) return d.bad
      if (s >= 1.5) return d.hard
      return d.hell
    })
  }, [allPoints, filters.difficulty])

  const { getClusters, getExpansionZoom, loaded: clusterReady } = useSuperCluster(filteredPoints)

  const handleBoundsChanged = useCallback(
    async (bounds: MapBounds, zoom: number) => {
      lastViewRef.current = { bounds, zoom }
      setMapCenter({
        lat: (bounds.south + bounds.north) / 2,
        lng: (bounds.west + bounds.east) / 2,
      })

      // SuperCluster로 클러스터/개별 포인트 계산 (서버 호출 없음)
      if (clusterReady) {
        setFeatures(getClusters(bounds, zoom))
      }

      // 개별 마커 상세 데이터 (사이드바/상세패널용)
      try {
        const lots = await fetchParkingLots({ data: { ...bounds, filters } })
        setParkingLots(lots)
      } catch (err) {
        console.error('[fetchParkingLots] error:', err)
      }
    },
    [filters, clusterReady, getClusters],
  )

  // SuperCluster 준비 후 현재 뷰 재계산
  useEffect(() => {
    if (clusterReady && lastViewRef.current) {
      const { bounds, zoom } = lastViewRef.current
      setFeatures(getClusters(bounds, zoom))
    }
  }, [clusterReady, getClusters])

  // 검색으로 선택된 주차장이 필터에 의해 빠져있으면 렌더 시점에 삽입
  const displayedLots = useMemo(() => {
    if (!selectedLot) return parkingLots
    if (parkingLots.some((l) => l.id === selectedLot.id)) return parkingLots
    return [selectedLot, ...parkingLots]
  }, [parkingLots, selectedLot])

  // Re-fetch when filters change
  useEffect(() => {
    if (lastViewRef.current) {
      const { bounds, zoom } = lastViewRef.current
      handleBoundsChanged(bounds, zoom)
    }
  }, [handleBoundsChanged])

  const handleMarkerClick = useCallback((lot: ParkingLot) => {
    setSelectedLot(lot)
  }, [])

  const handleSearchSelect = useCallback((lot: ParkingLot) => {
    setMoveTo({ lat: lot.lat, lng: lot.lng })
    setSelectedLot(lot)
  }, [])

  const handlePlaceSelect = useCallback((coords: { lat: number; lng: number }) => {
    setSelectedLot(null)
    setMoveTo(coords)
  }, [])

  const handleSidebarSelect = useCallback((lot: ParkingLot) => {
    setMoveTo({ lat: lot.lat, lng: lot.lng })
    setSelectedLot(lot)
  }, [])

  // URL ?lotId= 파라미터로 진입 시 지도 이동 + 상세패널 오픈
  useEffect(() => {
    if (!mapReady || !lotId) return
    fetchParkingDetail({ data: { id: lotId } })
      .then((lot) => {
        if (!lot) return
        setSelectedLot(lot)
        setMoveTo({ lat: lot.lat, lng: lot.lng })
      })
      .catch((err) => {
        console.error('[lotId navigation] error:', err)
      })
  }, [mapReady, lotId])

  const mapLoading = !isClient || initializing || !mapReady

  return (
    <div className="flex h-dvh flex-col">
      <Header
        onSearchSelect={handleSearchSelect}
        onPlaceSelect={handlePlaceSelect}
        siteStats={siteStats}
      />

      <div className="relative flex-1 overflow-hidden">
        {/* 지도 — full width */}
        <div className="absolute inset-0">
          {mapLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
              <div className="flex flex-col items-center gap-3">
                <Car className="size-8 text-blue-500 animate-pulse" />
                <p className="text-sm text-muted-foreground">지도를 불러오는 중...</p>
              </div>
            </div>
          )}
          {isClient && !initializing && (
            <MapErrorBoundary>
              <NavermapsProvider ncpKeyId={import.meta.env.VITE_NAVER_MAP_CLIENT_ID}>
                <MapView
                  userLat={userLat}
                  userLng={userLng}
                  userLocated={userLocated}
                  locationLoading={locationLoading}
                  onRequestLocation={requestLocation}
                  onMapReady={() => setMapReady(true)}
                  parkingLots={displayedLots}
                  features={features}
                  getExpansionZoom={getExpansionZoom}
                  onBoundsChanged={handleBoundsChanged}
                  onMarkerClick={handleMarkerClick}
                  onMarkerHover={setHoveredLotId}
                  selectedLotId={selectedLot?.id}
                  hoveredLotId={hoveredLotId}
                  moveTo={moveTo}
                />
              </NavermapsProvider>
            </MapErrorBoundary>
          )}
        </div>

        {/* 아일랜드 패널 — 지도 위에 float */}
        <div className="hidden md:flex absolute top-3 left-3 bottom-3 z-10 gap-2 pointer-events-none">
          <ParkingSidebar
            parkingLots={displayedLots}
            selectedLotId={selectedLot?.id ?? null}
            hoveredLotId={hoveredLotId}
            onSelect={handleSidebarSelect}
            onHover={setHoveredLotId}
            userLat={userLat}
            userLng={userLng}
            userLocated={userLocated}
            mapCenter={mapCenter}
          />
          {selectedLot && (
            <ParkingDetailPanel
              lot={selectedLot}
              onClose={() => setSelectedLot(null)}
              userLat={userLat}
              userLng={userLng}
              userLocated={userLocated}
            />
          )}
        </div>

        {/* 필터 — 사이드바 오른쪽, 상세패널 열리면 더 오른쪽 */}
        <div
          className="hidden md:block absolute top-3 z-20 pointer-events-auto transition-[left] duration-200"
          style={{ left: selectedLot ? `${FILTER_LEFT_OPENED}px` : `${FILTER_LEFT_CLOSED}px` }}
        >
          <FloatingFilters
            filters={filters}
            onToggle={toggle}
            onToggleDifficulty={toggleDifficulty}
            onSetFeeRange={setFeeRange}
            onToggleMinSpaces={toggleMinSpaces}
            activeCount={activeCount}
          />
        </div>

        {/* 필터 — 모바일 (버튼 → 시트) */}
        <div className="md:hidden absolute top-3 left-3 z-20 pointer-events-auto">
          <MobileFilterSheet
            filters={filters}
            onToggle={toggle}
            onToggleDifficulty={toggleDifficulty}
            onSetFeeRange={setFeeRange}
            onToggleMinSpaces={toggleMinSpaces}
            activeCount={activeCount}
          />
        </div>
      </div>

      {/* 하단 목록 패널 — 모바일 전용 */}
      <MobileBottomPanel
        parkingLots={displayedLots}
        selectedLotId={selectedLot?.id ?? null}
        onSelect={handleSidebarSelect}
        userLat={userLat}
        userLng={userLng}
        userLocated={userLocated}
        mapCenter={mapCenter}
      />

      {/* 하단 시트 — 모바일 전용 */}
      <ParkingCard
        lot={selectedLot}
        onClose={() => setSelectedLot(null)}
        userLat={userLat}
        userLng={userLng}
        userLocated={userLocated}
      />
    </div>
  )
}
