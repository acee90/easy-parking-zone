import { useEffect, useRef } from 'react'
import { Container as MapDiv, NaverMap, Marker } from 'react-naver-maps'
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '@/lib/geo-utils'
import { Locate, Loader2 } from 'lucide-react'

interface MapViewProps {
  userLat: number
  userLng: number
  userLocated: boolean
  locationLoading: boolean
  onRequestLocation: () => void
  onMapReady: () => void
}

export function MapView({
  userLat,
  userLng,
  userLocated,
  locationLoading,
  onRequestLocation,
  onMapReady,
}: MapViewProps) {
  const mapRef = useRef<naver.maps.Map | null>(null)

  useEffect(() => {
    if (mapRef.current && userLocated) {
      mapRef.current.setCenter(new naver.maps.LatLng(userLat, userLng))
    }
  }, [userLat, userLng, userLocated])

  return (
    <MapDiv style={{ width: '100%', height: '100%' }}>
      <NaverMap
        ref={mapRef}
        defaultCenter={new naver.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng)}
        defaultZoom={DEFAULT_ZOOM}
        onInit={() => onMapReady()}
        minZoom={7}
        maxZoom={21}
        scaleControl={false}
        mapDataControl={false}
      >
        {/* User location marker */}
        {userLocated && (
          <Marker
            position={new naver.maps.LatLng(userLat, userLng)}
            icon={{
              content: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 6px rgba(59,130,246,0.5)"></div>`,
              anchor: new naver.maps.Point(8, 8),
            }}
          />
        )}
      </NaverMap>

      {/* My location button */}
      <button
        className="absolute bottom-6 right-4 z-10 flex size-10 items-center justify-center rounded-full bg-white shadow-lg border border-border hover:bg-gray-50 transition-colors"
        onClick={onRequestLocation}
        disabled={locationLoading}
        title="내 위치"
      >
        {locationLoading ? (
          <Loader2 className="size-5 text-blue-500 animate-spin" />
        ) : (
          <Locate className="size-5 text-blue-500" />
        )}
      </button>
    </MapDiv>
  )
}
