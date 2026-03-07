import { useEffect, useRef, useCallback } from "react";
import {
  Container as MapDiv,
  NaverMap,
  Marker,
  useNavermaps,
} from "react-naver-maps";
import { DEFAULT_CENTER, DEFAULT_ZOOM, getDifficultyIcon } from "@/lib/geo-utils";
import { Locate, Loader2 } from "lucide-react";
import type { ParkingLot, MapBounds, MarkerCluster } from "@/types/parking";

interface MapViewProps {
  userLat: number;
  userLng: number;
  userLocated: boolean;
  locationLoading: boolean;
  onRequestLocation: () => void;
  onMapReady: () => void;
  parkingLots: ParkingLot[];
  onBoundsChanged: (bounds: MapBounds, zoom: number) => void;
  onMarkerClick: (lot: ParkingLot) => void;
  clusters: MarkerCluster[] | null;
  selectedLotId?: string | null;
  hoveredLotId?: string | null;
  moveTo?: { lat: number; lng: number } | null;
}

function markerColor(score: number | null): string {
  if (score === null) return "#9ca3af";  // gray — 리뷰 없음
  if (score >= 4.0) return "#22c55e";
  if (score >= 2.5) return "#eab308";
  if (score >= 1.5) return "#f97316";
  return "#ef4444";
}

function clusterMarkerHtml(count: number, score: number | null): string {
  const color = markerColor(score);
  return `<div style="
    width:44px;height:44px;
    background:${color};
    border:2px solid white;
    border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-size:14px;font-weight:700;color:white;
    box-shadow:0 2px 6px rgba(0,0,0,0.3);
    cursor:pointer;
  ">${count}</div>`;
}

function markerHtml(lot: ParkingLot, selected: boolean, hovered: boolean): string {
  const color = markerColor(lot.difficulty.score);
  const icon = getDifficultyIcon(lot.difficulty.score);
  const highlighted = selected || hovered;
  const size = highlighted ? 40 : 32;
  const border = selected
    ? "3px solid #3b82f6"
    : hovered
      ? "3px solid #60a5fa"
      : lot.curationTag
        ? "2px solid " + (lot.curationTag === "hell" ? "#ef4444" : "#22c55e")
        : "2px solid white";
  const shadow = highlighted
    ? "0 2px 8px rgba(59,130,246,0.4)"
    : lot.curationTag
      ? "0 2px 8px " + (lot.curationTag === "hell" ? "rgba(239,68,68,0.4)" : "rgba(34,197,94,0.4)")
      : "0 2px 6px rgba(0,0,0,0.3)";
  const curationBadge = lot.curationTag
    ? `<div style="position:absolute;top:-4px;right:-4px;font-size:10px;line-height:1;">${lot.curationTag === "hell" ? "🔥" : "👍"}</div>`
    : "";
  return `<div style="
    position:relative;
    width:${size}px;height:${size}px;
    background:${color};
    border:${border};
    border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-size:${highlighted ? 14 : 11}px;
    box-shadow:${shadow};
    cursor:pointer;
    transition:all 0.15s;
  ">${icon}${curationBadge}</div>`;
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
  clusters,
  selectedLotId,
  hoveredLotId,
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
    const zoom = mapRef.current.getZoom();
    onBoundsChanged(
      { south: sw.lat(), north: ne.lat(), west: sw.lng(), east: ne.lng() },
      zoom,
    );
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

        {clusters
          ? clusters.map((c) => (
              <Marker
                key={c.key}
                position={new navermaps.LatLng(c.lat, c.lng)}
                icon={{
                  content: clusterMarkerHtml(c.count, c.avgScore),
                  anchor: new navermaps.Point(22, 22),
                }}
              />
            ))
          : parkingLots.map((lot) => {
              const selected = lot.id === selectedLotId;
              const hovered = lot.id === hoveredLotId;
              const size = selected || hovered ? 40 : 32;
              return (
                <Marker
                  key={lot.id}
                  position={new navermaps.LatLng(lot.lat, lot.lng)}
                  icon={{
                    content: markerHtml(lot, selected, hovered),
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
