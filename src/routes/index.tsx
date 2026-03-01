import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { NavermapsProvider } from 'react-naver-maps'
import { MapView } from '@/components/MapView'
import { Header } from '@/components/Header'
import { useGeolocation } from '@/hooks/useGeolocation'
import { Car } from 'lucide-react'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const {
    lat: userLat,
    lng: userLng,
    loading: locationLoading,
    located: userLocated,
    initializing,
    requestLocation,
  } = useGeolocation()

  // Client-only rendering guard for NavermapsProvider
  const [isClient, setIsClient] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  useEffect(() => {
    setIsClient(true)
  }, [])

  const mapLoading = !isClient || initializing || !mapReady

  return (
    <div className="flex h-dvh flex-col">
      <Header />

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Map area */}
        <div className="flex-1 relative">
          {mapLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
              <div className="flex flex-col items-center gap-3">
                <Car className="size-8 text-blue-500 animate-pulse" />
                <p className="text-sm text-muted-foreground">
                  지도를 불러오는 중...
                </p>
              </div>
            </div>
          )}
          {isClient && !initializing && (
            <NavermapsProvider
              ncpKeyId={import.meta.env.VITE_NAVER_MAP_CLIENT_ID}
            >
              <MapView
                userLat={userLat}
                userLng={userLng}
                userLocated={userLocated}
                locationLoading={locationLoading}
                onRequestLocation={requestLocation}
                onMapReady={() => setMapReady(true)}
              />
            </NavermapsProvider>
          )}
        </div>
      </div>
    </div>
  )
}
