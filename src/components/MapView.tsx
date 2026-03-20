import { useState, useEffect, useEffectEvent, useRef, useCallback, useMemo } from "react";
import {
  Container as MapDiv,
  NaverMap,
  Marker,
  useNavermaps,
} from "react-naver-maps";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/geo-utils";
import { Locate, Loader2 } from "lucide-react";
import type { ParkingLot, MapBounds, MarkerCluster } from "@/types/parking";

/** 사이드바/상세패널 너비를 고려하여 panTo 좌표를 보정 */
function getPanToAdjusted(
  map: naver.maps.Map,
  navermaps: typeof naver.maps,
  coord: { lat: number; lng: number },
  hasDetailPanel: boolean,
): naver.maps.LatLng {
  const proj = map.getProjection();
  const latLng = new navermaps.LatLng(coord.lat, coord.lng);
  const pixel = proj.fromCoordToOffset(latLng);

  const isMobile = window.innerWidth < 768;
  if (isMobile) {
    // 모바일: 하단 시트(320px)가 마커를 가리므로 위쪽으로 보정
    const bottomSheetOffset = hasDetailPanel ? 320 / 2 : 0;
    return proj.fromOffsetToCoord(
      new navermaps.Point(pixel.x, pixel.y + bottomSheetOffset)
    );
  }

  // 데스크톱: 사이드바 280px 항상 + 상세패널 360px은 열려있을 때만
  const panelWidth = hasDetailPanel ? 280 + 360 : 280;
  const panelOffset = panelWidth / 2;
  return proj.fromOffsetToCoord(
    new navermaps.Point(pixel.x - panelOffset, pixel.y)
  );
}

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
  onMarkerHover: (lotId: string | null) => void;
  clusters: MarkerCluster[] | null;
  selectedLotId?: string | null;
  hoveredLotId?: string | null;
  moveTo?: { lat: number; lng: number } | null;
}

function markerColor(score: number | null): string {
  if (score === null) return "#9ca3af";  // gray-400 — 데이터 없음
  if (score >= 4.0) return "#22c55e";    // green-500 — 초보추천
  if (score >= 3.3) return "#86efac";    // green-300 — 무난
  if (score >= 2.7) return "#d4d4d8";    // zinc-300 — 보통
  if (score >= 2.0) return "#fbbf24";    // amber-400 — 별로
  if (score >= 1.5) return "#f97316";    // orange-500 — 비추
  return "#ef4444";                      // red-500 — 헬
}

const CLUSTER_MIN_SIZE = 32;
const CLUSTER_MAX_SIZE = 160;
const CLUSTER_MAX_COUNT = 300;

function clusterSize(count: number): number {
  const t = Math.sqrt(Math.min(count, CLUSTER_MAX_COUNT) / CLUSTER_MAX_COUNT);
  return Math.round(CLUSTER_MIN_SIZE + t * (CLUSTER_MAX_SIZE - CLUSTER_MIN_SIZE));
}

function clusterMarkerHtml(count: number, score: number | null): string {
  const color = markerColor(score);
  const size = clusterSize(count);
  const fontSize = Math.round(11 + (size - CLUSTER_MIN_SIZE) / (CLUSTER_MAX_SIZE - CLUSTER_MIN_SIZE) * 5);
  return `<div style="
    width:${size}px;height:${size}px;
    background:${color};
    border:2px solid white;
    border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    font-size:${fontSize}px;font-weight:700;color:white;
    box-shadow:0 2px 6px rgba(0,0,0,0.3);
    cursor:pointer;
  ">${count}</div>`;
}

function displayName(name: string): string {
  return name.replace(/\s*(공영|노외|노상|부설)?\s*주차장$/, "").trim();
}

function markerHtml(lot: ParkingLot, selected: boolean, hovered: boolean): string {
  const color = markerColor(lot.difficulty.score);
  const isHell = lot.curationTag === "hell";
  const isEasy = lot.curationTag === "easy";

  const pillBase = "display:inline-flex;align-items:center;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none;";
  const nameStyle = "max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  const name = displayName(lot.name);

  if (selected) {
    return `<div style="${pillBase}
      padding:5px 12px;
      background:${color};
      border:3px solid #3b82f6;
      border-radius:16px;
      font-size:13px;font-weight:600;
      color:white;
      box-shadow:0 0 0 3px rgba(59,130,246,0.25);
      text-shadow:0 1px 2px rgba(0,0,0,0.3);
    ">${isHell ? "💀 " : ""}<span style="${nameStyle}">${name}</span></div>`;
  }

  const border = hovered
    ? "2px solid #60a5fa"
    : isHell ? "2px solid #ef4444"
    : isEasy ? "2px solid #22c55e"
    : "1.5px solid rgba(255,255,255,0.9)";
  const shadow = hovered
    ? "0 2px 8px rgba(59,130,246,0.4)"
    : isHell ? "0 2px 6px rgba(239,68,68,0.3)"
    : isEasy ? "0 2px 6px rgba(34,197,94,0.3)"
    : "0 1px 4px rgba(0,0,0,0.2)";

  return `<div style="${pillBase}
    padding:${hovered ? "5px 12px" : "4px 10px"};
    background:${color};
    border:${border};
    border-radius:14px;
    font-size:${hovered ? "14px" : "13px"};font-weight:600;
    color:white;
    box-shadow:${shadow};
    text-shadow:0 1px 2px rgba(0,0,0,0.25);
    letter-spacing:-0.2px;
  ">${isHell ? "💀 " : ""}<span style="${nameStyle}">${name}</span></div>`;
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
  onMarkerHover,
  clusters,
  selectedLotId,
  hoveredLotId,
  moveTo,
}: MapViewProps) {
  const navermaps = useNavermaps();
  const mapRef = useRef<naver.maps.Map | null>(null);
  const boundsTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const markerHtmlCacheRef = useRef<Map<string, string>>(new Map());
  const animatingRef = useRef(false);
  const [currentZoom, setCurrentZoom] = useState<number>(DEFAULT_ZOOM);

  const markerData = useMemo(() => {
    const cache = markerHtmlCacheRef.current;
    const currentIds = new Set(parkingLots.map((l) => l.id));
    for (const key of cache.keys()) {
      const id = key.split(":")[0];
      if (!currentIds.has(id)) cache.delete(key);
    }

    return parkingLots.map((lot) => {
      const selected = lot.id === selectedLotId;
      const hovered = lot.id === hoveredLotId;
      const cacheKey = `${lot.id}:${selected}:${hovered}`;

      let html = cache.get(cacheKey);
      if (!html) {
        html = markerHtml(lot, selected, hovered);
        cache.set(cacheKey, html);
      }

      const h = selected ? 28 : hovered ? 28 : 25;
      const anchorY = h / 2;
      return { lot, html, anchorY, selected };
    });
  }, [parkingLots, selectedLotId, hoveredLotId]);

  useEffect(() => {
    if (mapRef.current && userLocated) {
      mapRef.current.setCenter(new navermaps.LatLng(userLat, userLng));
    }
  }, [navermaps, userLat, userLng, userLocated]);

  useEffect(() => {
    if (mapRef.current && moveTo) {
      animatingRef.current = true;
      mapRef.current.setZoom(16);
      const adjusted = getPanToAdjusted(mapRef.current, navermaps, moveTo, true);
      mapRef.current.panTo(adjusted);
      setTimeout(() => { animatingRef.current = false; }, 800);
    }
  }, [navermaps, moveTo]);

  const emitBounds = useEffectEvent(() => {
    if (!mapRef.current) return;
    const b = mapRef.current.getBounds() as naver.maps.LatLngBounds;
    const sw = b.getSW();
    const ne = b.getNE();
    const zoom = mapRef.current.getZoom();
    setCurrentZoom(zoom);
    onBoundsChanged(
      { south: sw.lat(), north: ne.lat(), west: sw.lng(), east: ne.lng() },
      zoom,
    );
  });

  const handleBoundsChanged = useCallback(() => {
    clearTimeout(boundsTimerRef.current);
    boundsTimerRef.current = setTimeout(emitBounds, animatingRef.current ? 800 : 300);
  }, []);

  const handleInit = useCallback(() => {
    onMapReady();
    setTimeout(emitBounds, 100);
  }, [onMapReady]);

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
          ? clusters.map((c) => {
              const size = clusterSize(c.count);
              const half = size / 2;
              return (
                <Marker
                  key={c.key}
                  position={new navermaps.LatLng(c.lat, c.lng)}
                  icon={{
                    content: clusterMarkerHtml(c.count, c.avgScore),
                    anchor: new navermaps.Point(half, half),
                  }}
                  onClick={() => {
                    if (!mapRef.current) return;
                    animatingRef.current = true;
                    // 현재 줌 + 3 (클러스터가 풀릴만큼 확대), 최대 18
                    const targetZoom = Math.min(mapRef.current.getZoom() + 3, 18);
                    mapRef.current.morph(
                      new navermaps.LatLng(c.lat, c.lng),
                      targetZoom,
                    );
                    setTimeout(() => { animatingRef.current = false; }, 800);
                  }}
                />
              );
            })
          : markerData.map(({ lot, html, anchorY, selected }) => (
              <Marker
                key={lot.id}
                position={new navermaps.LatLng(lot.lat, lot.lng)}
                icon={{
                  content: `<div style="transform:translateX(-50%);display:inline-block;">${html}</div>`,
                  anchor: new navermaps.Point(0, anchorY),
                }}
                zIndex={selected ? 200 : lot.id === hoveredLotId ? 100 : 0}
                onClick={() => {
                  onMarkerClick(lot);
                  if (mapRef.current) {
                    animatingRef.current = true;
                    // 클릭 후 상세패널이 열리므로 true로 보정
                    const adjusted = getPanToAdjusted(mapRef.current, navermaps, lot, true);
                    mapRef.current.panTo(adjusted);
                    setTimeout(() => { animatingRef.current = false; }, 800);
                  }
                }}
                onMouseover={() => onMarkerHover(lot.id)}
                onMouseout={() => onMarkerHover(null)}
              />
            ))}
      </NaverMap>

      {import.meta.env.DEV && (
        <div className="absolute top-3 right-3 z-10 rounded bg-black/70 px-2 py-1 text-xs font-mono text-white">
          z{currentZoom}
        </div>
      )}

      <button
        className="absolute bottom-16 md:bottom-6 right-4 z-10 flex size-10 items-center justify-center rounded-full bg-white shadow-lg border border-border hover:bg-gray-50 transition-colors"
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
