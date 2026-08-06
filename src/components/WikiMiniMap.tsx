import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  Container as MapDiv,
  Marker,
  NaverMap,
  NavermapsProvider,
  useNavermaps,
} from 'react-naver-maps'
import { getBearing, getDistance } from '@/lib/geo-utils'
import { loadNaverMapSdk } from '@/lib/naver-map-sdk'
import {
  buildProbeGrid,
  NEAR_ENOUGH_M,
  type PanoCandidate,
  selectPanorama,
} from '@/lib/roadview-select'

/** 데스크톱에서 지도 열이 넓어진 만큼 높이도 키워 비율을 맞춘다. */
const MEDIA_HEIGHT_CLASS = 'h-[240px] md:h-[300px]'

type ViewMode = 'map' | 'roadview'
type RoadviewState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

interface WikiMiniMapProps {
  lat: number
  lng: number
  name: string
}

interface PanoramaPov {
  pan: number
  tilt: number
  fov: number
}

/** getLocation()이 돌려주는 실제 파노라마 위치. coord는 LatLng이라 lat()/lng() 호출이 필요하다. */
interface PanoramaLocation {
  panoId?: string
  photodate?: string
  coord?: { lat: () => number; lng: () => number }
}

interface PanoramaInstance {
  setVisible: (visible: boolean) => void
  /** 서브모듈 버전에 따라 없을 수 있어 optional로 둔다 */
  getLocation?: () => PanoramaLocation | null
  setPov?: (pov: PanoramaPov) => void
  setPosition?: (position: object) => void
  setPanoId?: (panoId: string) => void
}

type PanoramaMaps = {
  LatLng: new (lat: number, lng: number) => object
  Panorama: new (
    container: HTMLElement,
    options: {
      position: object
      pov: PanoramaPov
      aroundControl: boolean
    },
  ) => PanoramaInstance
  Event: PanoramaEventApi
}

interface PanoramaEventApi {
  addListener: (target: object, eventName: string, listener: (status: string) => void) => object
  removeListener: (listener: object) => void
}

interface NaverWindow extends Window {
  naver?: { maps?: PanoramaMaps }
}

function MiniMapInner({ lat, lng, name }: WikiMiniMapProps) {
  const navermaps = useNavermaps()

  return (
    <NaverMap
      defaultCenter={new navermaps.LatLng(lat, lng)}
      defaultZoom={16}
      minZoom={14}
      maxZoom={18}
      draggable={false}
      scrollWheel={false}
      keyboardShortcuts={false}
      disableDoubleClickZoom
      disableDoubleTapZoom
      disableTwoFingerTapZoom
      scaleControl={false}
      mapDataControl={false}
    >
      <Marker position={new navermaps.LatLng(lat, lng)} title={name} />
    </NaverMap>
  )
}

function MediaLoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-zinc-100 text-xs text-muted-foreground">
      {label}
    </div>
  )
}

/** 로드뷰 초기 시야각(수평). 넓게 잡아 주변 맥락을 함께 보여준다. */
const ROADVIEW_FOV = 100

/** 프로브 1회당 pano_status 대기 한계. 넘으면 그 좌표는 후보 없음으로 넘긴다. */
const PROBE_TIMEOUT_MS = 4000

/** 파노라마의 실제 좌표. 못 읽으면 null. */
function readCoord(panorama: PanoramaInstance) {
  try {
    const coord = panorama.getLocation?.()?.coord
    if (!coord || typeof coord.lat !== 'function') return null
    const lat = coord.lat()
    const lng = coord.lng()
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { lat, lng }
  } catch (error) {
    console.error('[Naver Maps] roadview 좌표 조회 실패:', error)
    return null
  }
}

/** 선택 규칙에 넣을 후보 형태로 읽는다. panoId가 없으면 후보로 쓸 수 없다. */
function readCandidate(panorama: PanoramaInstance): PanoCandidate | null {
  const coord = readCoord(panorama)
  if (!coord) return null
  const location = panorama.getLocation?.()
  if (!location?.panoId) return null
  return { panoId: location.panoId, ...coord, photodate: location.photodate }
}

/**
 * 파노라마가 주차장 쪽을 바라보도록 pan을 보정한다.
 *
 * 네이버가 고른 파노라마는 주차장에서 수십 m 떨어진 도로 위에 있는데,
 * pan을 0으로 두면 항상 정북을 보게 되어 주차장이 화면 밖으로 나가는 경우가 많다.
 * 실제 파노라마 좌표(getLocation)를 받아 주차장 방향의 방위각으로 돌려준다.
 *
 * 좌표를 못 얻으면 조용히 넘어간다 — 방향이 어긋날 뿐 로드뷰 자체는 정상 동작한다.
 */
function aimAtLot(panorama: PanoramaInstance, lat: number, lng: number) {
  const coord = readCoord(panorama)
  if (!coord) return
  aimFrom(panorama, coord, lat, lng)
}

/** 파노라마 좌표를 이미 알고 있을 때의 pov 보정 */
function aimFrom(
  panorama: PanoramaInstance,
  from: { lat: number; lng: number },
  lat: number,
  lng: number,
) {
  // 파노라마가 주차장과 사실상 같은 지점이면 방위각이 무의미하다.
  if (getDistance(from.lat, from.lng, lat, lng) * 1000 < 1) return
  panorama.setPov?.({ pan: getBearing(from.lat, from.lng, lat, lng), tilt: 0, fov: ROADVIEW_FOV })
}

/**
 * 주차장 주변을 훑어 파노라마 후보를 모은다.
 *
 * 인스턴스 하나를 만들어 `setPosition()`으로 옮겨 다닌다. 네이버 답변상 지도 로딩 이후의
 * Panorama 조작은 호출 건수에 포함되지 않으므로 반복 이동에 과금 부담이 없다.
 *
 * 재사용 인스턴스는 조회에 실패해도 직전 위치 값을 그대로 들고 있다. 그래서
 * `pano_status === 'OK'`일 때만 읽는다 — 이 가드가 없으면 같은 후보를 중복 수집한다.
 */
async function probeCandidates(
  maps: PanoramaMaps,
  container: HTMLElement,
  lat: number,
  lng: number,
  isCancelled: () => boolean,
): Promise<PanoCandidate[]> {
  const grid = buildProbeGrid(lat, lng)
  const found = new Map<string, PanoCandidate>()

  container.replaceChildren()
  let deliverStatus: ((status: string) => void) | null = null

  const probe = new maps.Panorama(container, {
    position: new maps.LatLng(grid[0].lat, grid[0].lng),
    pov: { pan: 0, tilt: 0, fov: ROADVIEW_FOV },
    aroundControl: false,
  })
  const listener = maps.Event.addListener(probe, 'pano_status', (status) => {
    deliverStatus?.(String(status))
  })

  const nextStatus = () =>
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        deliverStatus = null
        resolve('TIMEOUT')
      }, PROBE_TIMEOUT_MS)
      deliverStatus = (status) => {
        clearTimeout(timer)
        deliverStatus = null
        resolve(status)
      }
    })

  try {
    for (const [index, point] of grid.entries()) {
      if (isCancelled()) break
      // 0번 좌표는 생성 시점에 이미 조회가 시작됐다.
      if (index > 0) probe.setPosition?.(new maps.LatLng(point.lat, point.lng))
      if ((await nextStatus()) !== 'OK') continue
      const candidate = readCandidate(probe)
      if (candidate && !found.has(candidate.panoId)) found.set(candidate.panoId, candidate)
    }
  } finally {
    maps.Event.removeListener(listener)
    probe.setVisible(false)
    container.replaceChildren()
  }

  return [...found.values()]
}

function RoadviewPanel({
  lat,
  lng,
  onStateChange,
}: {
  lat: number
  lng: number
  onStateChange: (state: RoadviewState) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const probeContainerRef = useRef<HTMLDivElement>(null)
  const panoramaRef = useRef<PanoramaInstance | null>(null)

  useEffect(() => {
    let cancelled = false
    let listener: object | null = null
    // 프로브는 한 번만. setPanoId 이후 pano_status가 다시 오므로 재진입을 막는다.
    let refineStarted = false
    // 사용자가 시야를 돌린 뒤에 화면을 바꾸면 조작을 빼앗는 꼴이 된다.
    let userTookOver = false
    const takeOver = () => {
      userTookOver = true
    }

    onStateChange('loading')

    /**
     * 최근접 파노라마가 주차장에서 멀 때만, 첫 화면이 뜬 뒤에 주변을 훑어 더 나은 후보로 바꾼다.
     * 실측상 이 경로를 타는 주차장은 약 22%다.
     */
    const refine = async (
      maps: PanoramaMaps,
      panorama: PanoramaInstance,
      origin: PanoCandidate,
    ) => {
      const probeContainer = probeContainerRef.current
      if (!probeContainer) return

      const probed = await probeCandidates(maps, probeContainer, lat, lng, () => cancelled)
      if (cancelled || userTookOver) return

      const selection = selectPanorama([origin, ...probed], lat, lng)
      if (import.meta.env.DEV && selection) {
        console.info(
          `[roadview] 후보 ${selection.candidateCount} · ${selection.reason} · ` +
            `최근접 ${selection.nearest.distanceM.toFixed(1)}m → ` +
            `선택 ${selection.chosen.distanceM.toFixed(1)}m (${selection.chosen.photodate ?? '-'})`,
        )
      }
      if (!selection || selection.chosen.panoId === origin.panoId) return

      const { chosen } = selection
      if (panorama.setPanoId) panorama.setPanoId(chosen.panoId)
      else panorama.setPosition?.(new maps.LatLng(chosen.lat, chosen.lng))
      // 좌표를 이미 알고 있으므로 pano_status를 기다리지 않고 바로 맞춘다. 교체가 끝나면
      // pano_status(OK)가 한 번 더 오는데, 그 경로의 aimAtLot()도 같은 값을 계산한다.
      aimFrom(panorama, chosen, lat, lng)
    }

    const initialize = async () => {
      try {
        await loadNaverMapSdk(import.meta.env.VITE_NAVER_MAP_CLIENT_ID, {
          submodules: ['panorama'],
        })
        if (cancelled || !containerRef.current) return

        const maps = (window as NaverWindow).naver?.maps
        if (!maps?.Panorama) throw new Error('Naver Maps panorama module is unavailable')

        const container = containerRef.current
        container.replaceChildren()
        container.addEventListener('pointerdown', takeOver)
        container.addEventListener('wheel', takeOver, { passive: true })

        const panorama = new maps.Panorama(container, {
          position: new maps.LatLng(lat, lng),
          // pano_status=OK 직후 aimAtLot()이 주차장 방향으로 pan을 보정한다.
          pov: { pan: 0, tilt: 0, fov: ROADVIEW_FOV },
          aroundControl: true,
        })
        panoramaRef.current = panorama

        const eventApi = maps.Event as unknown as PanoramaEventApi
        listener = eventApi.addListener(panorama, 'pano_status', (status) => {
          if (cancelled) return
          if (status !== 'OK') {
            onStateChange('unavailable')
            return
          }
          aimAtLot(panorama, lat, lng)
          onStateChange('ready')

          if (refineStarted) return
          refineStarted = true
          const origin = readCandidate(panorama)
          // 이미 주차장 앞이면(78%) 프로브할 이유가 없다. panoId를 못 읽으면 비교가 불가능하다.
          if (!origin) return
          if (getDistance(origin.lat, origin.lng, lat, lng) * 1000 <= NEAR_ENOUGH_M) return
          refine(maps, panorama, origin).catch((error) => {
            console.error('[Naver Maps] roadview 후보 탐색 실패:', error)
          })
        })
      } catch (error) {
        console.error('[Naver Maps] roadview load failed:', error)
        if (!cancelled) onStateChange('error')
      }
    }

    initialize()

    return () => {
      cancelled = true
      const maps = (window as NaverWindow).naver?.maps
      if (listener && maps) {
        maps.Event.removeListener(listener)
      }
      containerRef.current?.removeEventListener('pointerdown', takeOver)
      containerRef.current?.removeEventListener('wheel', takeOver)
      panoramaRef.current?.setVisible(false)
      panoramaRef.current = null
      containerRef.current?.replaceChildren()
      probeContainerRef.current?.replaceChildren()
    }
  }, [lat, lng, onStateChange])

  return (
    <>
      <div ref={containerRef} className="h-full w-full bg-zinc-100" />
      {/*
        후보 탐색용 파노라마. 화면 밖에 두되 SDK가 정상 렌더할 만한 크기는 남긴다
        (0px 컨테이너에서는 pano_status가 오지 않을 수 있다).
      */}
      <div
        ref={probeContainerRef}
        aria-hidden="true"
        className="pointer-events-none absolute -left-[9999px] top-0 size-32"
      />
    </>
  )
}

export function WikiMiniMap({ lat, lng, name }: WikiMiniMapProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('map')
  const [mapError, setMapError] = useState(false)
  const [sdkReady, setSdkReady] = useState(false)
  const [roadviewState, setRoadviewState] = useState<RoadviewState>('idle')
  const [roadviewRetryKey, setRoadviewRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    loadNaverMapSdk(import.meta.env.VITE_NAVER_MAP_CLIENT_ID)
      .then(() => {
        if (!cancelled) setSdkReady(true)
      })
      .catch((err) => {
        console.error('[Naver Maps SDK] mini map load failed:', err)
        if (!cancelled) setMapError(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const selectView = (nextView: ViewMode) => {
    setViewMode(nextView)
    if (nextView === 'map') setRoadviewState('idle')
  }

  return (
    <section className={`relative overflow-hidden rounded-2xl bg-zinc-100 ${MEDIA_HEIGHT_CLASS}`}>
      {/* 탭을 별도 바로 쌓지 않고 미디어 위에 띄운다 — 표면 중첩을 없애고 지도 높이를 확보. */}
      <div
        role="tablist"
        aria-label="주차장 위치 미디어"
        className="absolute left-3 top-3 z-10 flex gap-0.5 rounded-full bg-white/90 p-0.5 backdrop-blur-sm"
      >
        {(['map', 'roadview'] as const).map((mode) => {
          const isSelected = viewMode === mode
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={`parking-location-${mode}`}
              className={`h-7 cursor-pointer rounded-full px-3.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isSelected ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:text-zinc-900'
              }`}
              onClick={() => selectView(mode)}
            >
              {mode === 'map' ? '지도' : '로드뷰'}
            </button>
          )
        })}
      </div>

      <div className="relative h-full">
        {viewMode === 'map' ? (
          <div id="parking-location-map" role="tabpanel" className="h-full w-full">
            {mapError ? (
              <MediaLoadingState label="지도를 불러올 수 없습니다" />
            ) : sdkReady ? (
              <NavermapsProvider ncpKeyId={import.meta.env.VITE_NAVER_MAP_CLIENT_ID}>
                <MapDiv style={{ width: '100%', height: '100%' }}>
                  <MiniMapInner key={`${lat}:${lng}`} lat={lat} lng={lng} name={name} />
                </MapDiv>
              </NavermapsProvider>
            ) : (
              <MediaLoadingState label="지도를 불러오는 중입니다" />
            )}
          </div>
        ) : (
          <div id="parking-location-roadview" role="tabpanel" className="h-full w-full">
            <RoadviewPanel
              key={`${lat}:${lng}:${roadviewRetryKey}`}
              lat={lat}
              lng={lng}
              onStateChange={setRoadviewState}
            />
            {(roadviewState === 'loading' || roadviewState === 'idle') && (
              <div className="pointer-events-none absolute inset-0">
                <MediaLoadingState label="로드뷰를 불러오는 중입니다" />
              </div>
            )}
            {(roadviewState === 'unavailable' || roadviewState === 'error') && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-100 p-4 text-center">
                <p className="text-xs text-muted-foreground">
                  {roadviewState === 'unavailable'
                    ? '이 위치에는 표시할 로드뷰가 없습니다'
                    : '로드뷰를 불러오지 못했습니다'}
                </p>
                <button
                  type="button"
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-semibold text-foreground transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setRoadviewRetryKey((key) => key + 1)}
                >
                  <RefreshCw className="size-3" />
                  다시 시도
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
