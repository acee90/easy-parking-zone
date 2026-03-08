import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { NavermapsProvider } from "react-naver-maps";
import { MapView } from "@/components/MapView";
import { Header } from "@/components/Header";
import { ParkingCard } from "@/components/ParkingCard";
import { ParkingSidebar } from "@/components/ParkingSidebar";
import { ParkingDetailPanel } from "@/components/ParkingDetailPanel";
import { useGeolocation } from "@/hooks/useGeolocation";
import { useParkingFilters } from "@/hooks/useParkingFilters";
import { FloatingFilters } from "@/components/FloatingFilters";
import { fetchParkingLots, fetchParkingClusters } from "@/server/parking";
import type { ParkingLot, MapBounds, MarkerCluster } from "@/types/parking";
import { Car } from "lucide-react";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";

export const Route = createFileRoute("/")({
  component: App,
});

function App() {
  const {
    lat: userLat,
    lng: userLng,
    loading: locationLoading,
    located: userLocated,
    initializing,
    requestLocation,
  } = useGeolocation();

  const { filters, toggle, toggleDifficulty, activeCount } = useParkingFilters();

  const [isClient, setIsClient] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [parkingLots, setParkingLots] = useState<ParkingLot[]>([]);
  const [clusters, setClusters] = useState<MarkerCluster[] | null>(null);
  const [selectedLot, setSelectedLot] = useState<ParkingLot | null>(null);
  const [hoveredLotId, setHoveredLotId] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<{ lat: number; lng: number } | null>(
    null
  );
  const lastViewRef = useRef<{ bounds: MapBounds; zoom: number } | null>(null);

  useEffect(() => {
    setIsClient(true);
  }, []);

  const handleBoundsChanged = useCallback(async (bounds: MapBounds, zoom: number) => {
    lastViewRef.current = { bounds, zoom };
    try {
      if (zoom <= 12) {
        setParkingLots([]);
        const data = await fetchParkingClusters({ data: { ...bounds, zoom, filters } });
        setClusters(data);
      } else {
        setClusters(null);
        const lots = await fetchParkingLots({ data: { ...bounds, filters } });
        setParkingLots(lots);
      }
    } catch {
      // D1 not available (e.g., dev without local D1) — silently ignore
    }
  }, [filters]);

  // Re-fetch when filters change
  useEffect(() => {
    if (lastViewRef.current) {
      const { bounds, zoom } = lastViewRef.current;
      handleBoundsChanged(bounds, zoom);
    }
  }, [filters, handleBoundsChanged]);

  const handleMarkerClick = useCallback((lot: ParkingLot) => {
    setSelectedLot(lot);
  }, []);

  const handleSearchSelect = useCallback((lot: ParkingLot) => {
    setMoveTo({ lat: lot.lat, lng: lot.lng });
    setSelectedLot(lot);
  }, []);

  const handlePlaceSelect = useCallback((coords: { lat: number; lng: number }) => {
    setSelectedLot(null);
    setMoveTo(coords);
  }, []);

  const handleSidebarSelect = useCallback((lot: ParkingLot) => {
    setMoveTo({ lat: lot.lat, lng: lot.lng });
    setSelectedLot(lot);
  }, []);

  const mapLoading = !isClient || initializing || !mapReady;

  return (
    <div className="flex h-dvh flex-col">
      <Header onSearchSelect={handleSearchSelect} onPlaceSelect={handlePlaceSelect} />

      <div className="flex flex-1 overflow-hidden">
        {/* 리스트 사이드바 — 항상 표시 (데스크톱) */}
        <ParkingSidebar
          parkingLots={parkingLots}
          selectedLotId={selectedLot?.id ?? null}
          onSelect={handleSidebarSelect}
          onHover={setHoveredLotId}
          userLat={userLat}
          userLng={userLng}
          userLocated={userLocated}
          isClustered={clusters !== null}
        />

        {/* 상세 패널 — 선택 시에만 표시 (데스크톱) */}
        {selectedLot && (
          <ParkingDetailPanel
            lot={selectedLot}
            onClose={() => setSelectedLot(null)}
            userLat={userLat}
            userLng={userLng}
            userLocated={userLocated}
          />
        )}

        {/* 지도 */}
        <div className="flex-1 relative">
          <FloatingFilters
            filters={filters}
            onToggle={toggle}
            onToggleDifficulty={toggleDifficulty}
            activeCount={activeCount}
          />
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
            <MapErrorBoundary>
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
                  parkingLots={parkingLots}
                  clusters={clusters}
                  onBoundsChanged={handleBoundsChanged}
                  onMarkerClick={handleMarkerClick}
                  selectedLotId={selectedLot?.id}
                  hoveredLotId={hoveredLotId}
                  moveTo={moveTo}
                />
              </NavermapsProvider>
            </MapErrorBoundary>
          )}
        </div>
      </div>

      {/* 하단 시트 — 모바일 전용 */}
      <ParkingCard
        lot={selectedLot}
        onClose={() => setSelectedLot(null)}
        userLat={userLat}
        userLng={userLng}
        userLocated={userLocated}
      />
    </div>
  );
}
