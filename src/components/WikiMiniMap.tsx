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
  coord?: { lat: () => number; lng: () => number }
}

interface PanoramaInstance {
  setVisible: (visible: boolean) => void
  /** 서브모듈 버전에 따라 없을 수 있어 optional로 둔다 */
  getLocation?: () => PanoramaLocation | null
  setPov?: (pov: PanoramaPov) => void
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
  try {
    const coord = panorama.getLocation?.()?.coord
    if (!coord || typeof coord.lat !== 'function') return
    const panoLat = coord.lat()
    const panoLng = coord.lng()
    if (!Number.isFinite(panoLat) || !Number.isFinite(panoLng)) return
    // 파노라마가 주차장과 사실상 같은 지점이면 방위각이 무의미하다.
    if (getDistance(panoLat, panoLng, lat, lng) * 1000 < 1) return
    panorama.setPov?.({ pan: getBearing(panoLat, panoLng, lat, lng), tilt: 0, fov: ROADVIEW_FOV })
  } catch (error) {
    console.error('[Naver Maps] roadview pov 보정 실패:', error)
  }
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
  const panoramaRef = useRef<PanoramaInstance | null>(null)

  useEffect(() => {
    let cancelled = false
    let listener: object | null = null

    onStateChange('loading')

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
          if (status === 'OK') aimAtLot(panorama, lat, lng)
          onStateChange(status === 'OK' ? 'ready' : 'unavailable')
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
      panoramaRef.current?.setVisible(false)
      panoramaRef.current = null
      containerRef.current?.replaceChildren()
    }
  }, [lat, lng, onStateChange])

  return <div ref={containerRef} className="h-full w-full bg-zinc-100" />
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
