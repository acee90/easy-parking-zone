import { useEffect, useRef, useCallback } from "react";
import {
  Container as MapDiv,
  NaverMap,
  Marker,
  useNavermaps,
} from "react-naver-maps";
import { DEFAULT_CENTER, DEFAULT_ZOOM, getDifficultyIcon } from "@/lib/geo-utils";
import { Locate, Loader2 } from "lucide-react";
import type { ParkingLot, MapBounds } from "@/types/parking";

interface MapViewProps {
  userLat: number;
  userLng: number;
  userLocated: boolean;
  locationLoading: boolean;
  onRequestLocation: () => void;
  onMapReady: () => void;
  parkingLots: ParkingLot[];
  onBoundsChanged: (bounds: MapBounds) => void;
  onMarkerClick: (lot: ParkingLot) => void;
  selectedLotId?: string | null;
  moveTo?: { lat: number; lng: number } | null;
}

function markerColor(score: number | null): string {
  if (score === null) return "#9ca3af";  // gray — 리뷰 없음
  if (score >= 4.0) return "#22c55e";
  if (score >= 2.5) return "#eab308";
  if (score >= 1.5) return "#f97316";
  return "#ef4444";
}

function markerHtml(lot: ParkingLot, selected: boolean): string {
  const color = markerColor(lot.difficulty.score);
  const icon = getDifficultyIcon(lot.difficulty.score);
  const size = selected ? 40 : 32;
  const border = selected ? "3px solid #3b82f6" : "2px solid white";
  return `<div style="
    width:${size}px;height:${size}px;
    background:${color};
    border:${border};
    border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-size:${selected ? 14 : 11}px;
    box-shadow:0 2px 6px rgba(0,0,0,0.3);
    cursor:pointer;
    transition:all 0.15s;
  ">${icon}</div>`;
}

export function MapView({
  userLat,
  userLng,
  userLocated,
  locationLoading,
  onRequestLocation,
  onMapReady,
  parkingLots,
  onBoundsChanged,
  onMarkerClick,
  selectedLotId,
  moveTo,
}: MapViewProps) {
  const navermaps = useNavermaps();
  const mapRef = useRef<naver.maps.Map | null>(null);
  const boundsTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (mapRef.current && userLocated) {
      mapRef.current.setCenter(new navermaps.LatLng(userLat, userLng));
    }
  }, [navermaps, userLat, userLng, userLocated]);

  useEffect(() => {
    if (mapRef.current && moveTo) {
      mapRef.current.setCenter(new navermaps.LatLng(moveTo.lat, moveTo.lng));
      mapRef.current.setZoom(16);
    }
  }, [navermaps, moveTo]);

  const emitBounds = useCallback(() => {
    if (!mapRef.current) return;
    const b = mapRef.current.getBounds() as naver.maps.LatLngBounds;
    const sw = b.getSW();
    const ne = b.getNE();
    onBoundsChanged({
      south: sw.lat(),
      north: ne.lat(),
      west: sw.lng(),
      east: ne.lng(),
    });
  }, [onBoundsChanged]);

  const handleBoundsChanged = useCallback(() => {
    clearTimeout(boundsTimerRef.current);
    boundsTimerRef.current = setTimeout(emitBounds, 300);
  }, [emitBounds]);

  const handleInit = useCallback(() => {
    onMapReady();
    setTimeout(emitBounds, 100);
  }, [onMapReady, emitBounds]);

  return (
    <MapDiv style={{ width: "100%", height: "100%" }}>
      <NaverMap
        ref={mapRef}
        defaultCenter={new navermaps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng)}
        defaultZoom={DEFAULT_ZOOM}
        onInit={handleInit}
        onBoundsChanged={handleBoundsChanged}
        minZoom={7}
        maxZoom={21}
        scaleControl={false}
        mapDataControl={false}
      >
        {userLocated && (
          <Marker
            position={new navermaps.LatLng(userLat, userLng)}
            icon={{
              content: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 6px rgba(59,130,246,0.5)"></div>`,
              anchor: new navermaps.Point(8, 8),
            }}
          />
        )}

        {parkingLots.map((lot) => {
          const selected = lot.id === selectedLotId;
          const size = selected ? 40 : 32;
          return (
            <Marker
              key={lot.id}
              position={new navermaps.LatLng(lot.lat, lot.lng)}
              icon={{
                content: markerHtml(lot, selected),
                anchor: new navermaps.Point(size / 2, size / 2),
              }}
              onClick={() => onMarkerClick(lot)}
            />
          );
        })}
      </NaverMap>

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
  );
}
