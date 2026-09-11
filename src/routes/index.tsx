import { createFileRoute } from '@tanstack/react-router'
import { Car, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavermapsProvider } from 'react-naver-maps'
import { toast } from 'sonner'
import { DesktopMapPanel } from '@/components/DesktopMapPanel'
import { FloatingFilters } from '@/components/FloatingFilters'
import { Header } from '@/components/Header'
import { MapErrorBoundary } from '@/components/MapErrorBoundary'
import { MapView } from '@/components/MapView'
import { MobileBottomPanel } from '@/components/MobileBottomPanel'
import { MobileFilterSheet } from '@/components/MobileFilterSheet'
import { ParkingCard } from '@/components/ParkingCard'
import { useGeolocation } from '@/hooks/useGeolocation'
import { useParkingFilters } from '@/hooks/useParkingFilters'
import { type MapFeature, useSuperCluster } from '@/hooks/useSuperCluster'
import { loadNaverMapSdk } from '@/lib/naver-map-sdk'
import { pickNearestIds } from '@/lib/nearest'
import { decodePoints, type ParkingPoint, type PointTuple } from '@/lib/points'
import { Route as RootRoute } from '@/routes/__root'
import { fetchDestination } from '@/server/destinations'
import { fetchParkingDetail, fetchParkingLots, fetchParkingLotsByIds } from '@/server/parking'
import type { MapBounds, ParkingFilters, ParkingLot } from '@/types/parking'

const PANEL_WIDTH = 360
const FILTER_LEFT = 12 + PANEL_WIDTH + 8

/**
 * 필터가 기본값인가 (B-1 후보 수 결정용).
 * 필터가 없으면 최근접 250개로 목록 200개를 채울 수 있고, 필터가 걸리면 걸러질 몫을 감안해 600개를 보낸다.
 */
function isDefaultFilters(f: ParkingFilters): boolean {
  return (
    !f.freeOnly &&
    !f.publicOnly &&
    !f.excludeNoSang &&
    !f.openNow &&
    f.feeRange === 'any' &&
    !f.minSpaces &&
    Object.values(f.difficulty).every(Boolean)
  )
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    lotId: typeof search.lotId === 'string' ? search.lotId : undefined,
    // 목적지 페이지의 "지도에서 보기" (#166). 'D-0001' 형식만 받는다
    near:
      typeof search.near === 'string' && /^D-\d{1,8}$/.test(search.near) ? search.near : undefined,
  }),
  head: () => ({
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz' }],
  }),
  component: App,
})

function App() {
  const siteStats = RootRoute.useLoaderData()
  const { lotId, near } = Route.useSearch()
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
  const [mapSdkReady, setMapSdkReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [mapLoadFailed, setMapLoadFailed] = useState(false)
  const [allPoints, setAllPoints] = useState<ParkingPoint[] | null>(null)
  const [parkingLots, setParkingLots] = useState<ParkingLot[]>([])
  const [features, setFeatures] = useState<MapFeature[]>([])
  const [selectedLot, setSelectedLot] = useState<ParkingLot | null>(null)
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list')
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

  useEffect(() => {
    if (!isClient || initializing || mapSdkReady || mapLoadFailed) return

    let cancelled = false
    loadNaverMapSdk(import.meta.env.VITE_NAVER_MAP_CLIENT_ID)
      .then(() => {
        if (!cancelled) setMapSdkReady(true)
      })
      .catch((err) => {
        console.error('[Naver Maps SDK] load failed:', err)
        if (!cancelled) setMapLoadFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [isClient, initializing, mapSdkReady, mapLoadFailed])

  // 전체 경량 데이터 1회 로드 (B-3: 서버 함수 대신 배열 형식 /api/points)
  useEffect(() => {
    fetch('/api/points')
      .then((res) => {
        if (!res.ok) throw new Error(`/api/points ${res.status}`)
        return res.json() as Promise<PointTuple[]>
      })
      .then((rows) => setAllPoints(decodePoints(rows)))
      .catch((err) => {
        console.error('[points] error:', err)
        // 포인트를 못 받으면 최근접 선택이 불가능하다 — 기다리던 목록을 bounds 조회로 채운다
        pointsFailedRef.current = true
        if (listSourceRef.current === 'pending' && lastViewRef.current) {
          const { bounds, zoom } = lastViewRef.current
          handleBoundsChangedRef.current(bounds, zoom)
        }
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

  // 최근접 후보 선택용 경량 포인트 (B-1). ref 로 들고 있어 handleBoundsChanged 가 새로 만들어지지 않는다
  const pointsRef = useRef(filteredPoints)
  pointsRef.current = filteredPoints
  // 지금 목록이 어느 경로로 채워졌는지 — 포인트가 늦게 오면 한 번 최근접 목록으로 바꾸려고 기록한다
  const listSourceRef = useRef<'ids' | 'bounds' | 'pending' | null>(null)
  // 포인트 로드가 실패했으면 bounds 조회로 폴백한다 (성공하기 전까지는 기다린다)
  const pointsFailedRef = useRef(false)

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
      // 경량 포인트가 준비됐으면 중심에서 가까운 후보를 골라 id 로 조회한다 (B-1) — 서버에서
      // bounds 전체를 거리순 정렬하면 rows_read 가 3.5~33배로 뛴다. 아직이면 bounds 조회로 폴백.
      try {
        const points = pointsRef.current
        const center = {
          lat: (bounds.south + bounds.north) / 2,
          lng: (bounds.west + bounds.east) / 2,
        }
        const ids = points
          ? pickNearestIds(points, bounds, center, isDefaultFilters(filters) ? 250 : 600)
          : null
        if (ids && ids.length > 0) {
          listSourceRef.current = 'ids'
          setParkingLots(await fetchParkingLotsByIds({ data: { ids, center, filters } }))
        } else if (ids) {
          listSourceRef.current = 'ids'
          setParkingLots([])
        } else if (!pointsFailedRef.current) {
          // 포인트가 아직 오는 중이다. 여기서 bounds 로 먼저 채우면 곧 최근접 목록으로 다시 바뀌어
          // 조회가 2번 나가고 목록이 한 번 뒤바뀐다 (09-11 운영: 2.21s 폴백 + 2.95s 교체).
          // 포인트가 도착하면 아래 effect 가 한 번만 조회한다.
          listSourceRef.current = 'pending'
        } else {
          listSourceRef.current = 'bounds'
          setParkingLots(await fetchParkingLots({ data: { ...bounds, filters } }))
        }
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

  // 필터가 바뀌면 현재 화면으로 다시 조회한다 (B-2).
  // 예전엔 deps 가 [handleBoundsChanged] 였다. 그 함수는 클러스터 데이터가 준비되면(clusterReady)
  // 새로 만들어지므로, 첫 로딩에서 같은 bounds 조회가 한 번 더 나갔다 (09-11 운영 실측: 2.0s·5.1s 2회).
  // 클러스터 재계산은 위 effect 가 따로 하므로 여기서는 filters 변화에만 반응한다.
  const handleBoundsChangedRef = useRef(handleBoundsChanged)
  handleBoundsChangedRef.current = handleBoundsChanged
  const filtersMountedRef = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters 변경 자체가 트리거다
  useEffect(() => {
    if (!filtersMountedRef.current) {
      filtersMountedRef.current = true
      return
    }
    if (lastViewRef.current) {
      const { bounds, zoom } = lastViewRef.current
      handleBoundsChangedRef.current(bounds, zoom)
    }
  }, [filters])

  // 첫 목록이 포인트 도착 전 bounds 폴백으로 채워졌다면, 포인트가 준비된 순간 한 번 최근접 목록으로 바꾼다 (B-1)
  useEffect(() => {
    const src = listSourceRef.current
    if (!filteredPoints || (src !== 'bounds' && src !== 'pending') || !lastViewRef.current) return
    const { bounds, zoom } = lastViewRef.current
    handleBoundsChangedRef.current(bounds, zoom)
  }, [filteredPoints])

  // 마커/사이드바 클릭: 첫 클릭은 highlight만(데스크톱), 같은 항목 재클릭 시 detail로 push.
  // 모바일은 ParkingCard가 selectedLot != null이면 자동 노출 (viewMode 무시)이므로 영향 없음.
  const handleMarkerClick = useCallback(
    (lot: ParkingLot) => {
      if (selectedLot?.id === lot.id) {
        setViewMode('detail')
      } else {
        setSelectedLot(lot)
      }
    },
    [selectedLot],
  )

  // /near/{목적지} 에서 넘어온 경우 그 좌표로 연다. 목적지가 없으면 지금과 같이 동작한다
  useEffect(() => {
    if (!near) return
    let cancelled = false
    fetchDestination({ data: { id: near } })
      .then((d) => {
        if (!cancelled && d) setMoveTo({ lat: d.lat, lng: d.lng })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [near])

  const handleSearchSelect = useCallback((lot: ParkingLot) => {
    // 검색은 명시적 의도이므로 detail로 직행
    setMoveTo({ lat: lot.lat, lng: lot.lng })
    setSelectedLot(lot)
    setViewMode('detail')
  }, [])

  const handlePlaceSelect = useCallback((coords: { lat: number; lng: number }) => {
    setSelectedLot(null)
    setViewMode('list')
    setMoveTo(coords)
  }, [])

  // 목록 클릭은 한 번에 상세로 간다 (C-1).
  // 예전에는 첫 클릭 = 강조, 같은 항목 재클릭 = 상세였다. 그런데 첫 클릭으로 지도가 움직이면
  // 목록이 새 중심 기준으로 재정렬돼(실측 약 95ms) 같은 자리를 다시 누르면 **다른 주차장**이 열렸다.
  // 마커 클릭(handleMarkerClick)은 지도 위 미리보기 의미가 있어 두 단계를 유지한다.
  const handleSidebarSelect = useCallback((lot: ParkingLot) => {
    setMoveTo({ lat: lot.lat, lng: lot.lng })
    setSelectedLot(lot)
    setViewMode('detail')
  }, [])

  const handleCloseDetail = useCallback(() => {
    setViewMode('list')
    // selectedLot은 유지 → 목록으로 돌아갔을 때 직전 선택 항목 highlight 유지
  }, [])

  // URL ?lotId= 파라미터로 진입 시: 명시적 진입이므로 detail로 직행
  useEffect(() => {
    if (!mapReady || !lotId) return
    fetchParkingDetail({ data: { id: lotId } })
      .then((lot) => {
        if (!lot) return
        setSelectedLot(lot)
        setViewMode('detail')
        setMoveTo({ lat: lot.lat, lng: lot.lng })
      })
      .catch((err) => {
        console.error('[lotId navigation] error:', err)
      })
  }, [mapReady, lotId])

  const mapLoading = !mapLoadFailed && (!isClient || initializing || !mapSdkReady || !mapReady)

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
                <Car className="size-8 text-primary animate-pulse" />
                <p className="text-sm text-muted-foreground">지도를 불러오는 중...</p>
              </div>
            </div>
          )}
          {mapLoadFailed && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted/30 p-8">
              <div className="flex max-w-md flex-col items-center gap-4 text-center">
                <TriangleAlert className="size-12 text-amber-500" />
                <h2 className="text-lg font-semibold">지도를 불러올 수 없습니다</h2>
                <p className="text-sm text-muted-foreground">
                  지도 서비스 응답이 지연되거나 일시적으로 실패했습니다.
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-2 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <RefreshCw className="size-4" />
                  새로고침
                </button>
              </div>
            </div>
          )}
          {isClient && !initializing && mapSdkReady && !mapLoadFailed && (
            <MapErrorBoundary onError={() => setMapLoadFailed(true)}>
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

        {/* 아일랜드 패널 — 지도 위에 float (List ↔ Detail 슬라이드) */}
        <div className="hidden md:block absolute top-3 left-3 bottom-3 z-10 pointer-events-none">
          <DesktopMapPanel
            parkingLots={displayedLots}
            selectedLot={selectedLot}
            viewMode={viewMode}
            hoveredLotId={hoveredLotId}
            onSelect={handleSidebarSelect}
            onHover={setHoveredLotId}
            onCloseDetail={handleCloseDetail}
            userLat={userLat}
            userLng={userLng}
            userLocated={userLocated}
            mapCenter={mapCenter}
          />
        </div>

        {/* 필터 — 패널 우측 (단일 위치) */}
        <div
          className="hidden md:block absolute top-3 z-20 pointer-events-auto"
          style={{ left: `${FILTER_LEFT}px` }}
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
