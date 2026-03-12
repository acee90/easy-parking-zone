import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Container as MapDiv,
  NaverMap,
  Marker,
  useNavermaps,
} from "react-naver-maps";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/geo-utils";
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

function shortName(name: string): string {
  const stripped = name.replace(/\s*(공영|노외|노상|부설)?\s*주차장$/, "").trim();
  return stripped.length > 8 ? stripped.slice(0, 7) + "…" : stripped;
}

const LABEL_ZOOM = 16;

function markerHtml(lot: ParkingLot, selected: boolean, hovered: boolean, showLabel: boolean): string {
  const color = markerColor(lot.difficulty.score);
  const isHell = lot.curationTag === "hell";
  const isEasy = lot.curationTag === "easy";

  // 공통 스타일
  const pillBase = "display:inline-flex;align-items:center;white-space:nowrap;cursor:pointer;";

  if (selected) {
    const inner = showLabel
      ? `${isHell ? "💀 " : ""}${shortName(lot.name)}`
      : isHell ? "💀" : "P";
    return `<div style="
      display:flex;flex-direction:column;align-items:center;
      animation:marker-bounce 0.8s ease-in-out infinite alternate;
      filter:drop-shadow(0 4px 12px rgba(59,130,246,0.5));
    ">
      <div style="${pillBase}
        padding:6px 12px;
        background:${color};
        border:3px solid #3b82f6;
        border-radius:16px;
        font-size:12px;font-weight:600;
        color:white;
        box-shadow:0 0 0 3px rgba(59,130,246,0.25);
        text-shadow:0 1px 2px rgba(0,0,0,0.3);
      ">${inner}</div>
      <div style="
        width:0;height:0;
        border-left:6px solid transparent;
        border-right:6px solid transparent;
        border-top:7px solid #3b82f6;
        margin-top:-1px;
      "></div>
    </div>`;
  }

  // 테두리/그림자
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

  if (showLabel) {
    const prefix = isHell ? "💀 " : "";
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
    ">${prefix}${shortName(lot.name)}</div>`;
  }

  // 줌 낮을 때: 작은 dot pill
  const h = hovered ? 16 : 12;
  const w = isHell ? (hovered ? 28 : 24) : (hovered ? 16 : 12);
  return `<div style="${pillBase}justify-content:center;
    width:${w}px;height:${h}px;
    background:${color};
    border:${border};
    border-radius:${h}px;
    font-size:10px;
    box-shadow:${shadow};
  ">${isHell ? "💀" : ""}</div>`;
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
  const markerHtmlCacheRef = useRef<Map<string, string>>(new Map());
  const [currentZoom, setCurrentZoom] = useState<number>(DEFAULT_ZOOM);

  // 마커 HTML을 캐시하여 selected/hovered 변경 시 해당 마커만 재생성
  const showLabels = currentZoom >= LABEL_ZOOM;
  const markerData = useMemo(() => {
    const cache = markerHtmlCacheRef.current;
    // parkingLots가 바뀌면 (bounds 변경) 캐시 정리
    const currentIds = new Set(parkingLots.map((l) => l.id));
    for (const key of cache.keys()) {
      const id = key.split(":")[0];
      if (!currentIds.has(id)) cache.delete(key);
    }

    return parkingLots.map((lot) => {
      const selected = lot.id === selectedLotId;
      const hovered = lot.id === hoveredLotId;
      const cacheKey = `${lot.id}:${selected}:${hovered}:${showLabels}`;

      let html = cache.get(cacheKey);
      if (!html) {
        html = markerHtml(lot, selected, hovered, showLabels);
        cache.set(cacheKey, html);
      }

      // pill 높이: selected ~30px+꼬리, label ~26px, dot ~12px
      const h = selected ? 30 : showLabels ? (hovered ? 28 : 25) : (hovered ? 16 : 12);
      const anchorY = selected ? h + 7 : h / 2;
      return { lot, html, anchorY, selected };
    });
  }, [parkingLots, selectedLotId, hoveredLotId, showLabels]);

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
    setCurrentZoom(zoom);
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
                    const cur = mapRef.current.getZoom();
                    mapRef.current.morph(
                      new navermaps.LatLng(c.lat, c.lng),
                      Math.min(cur + 3, 21),
                    );
                  }}
                />
              );
            })
          : markerData.map(({ lot, html, anchorY, selected }) => (
              <Marker
                key={lot.id}
                position={new navermaps.LatLng(lot.lat, lot.lng)}
                icon={{
                  content: `<div style="display:flex;justify-content:center;">${html}</div>`,
                  anchor: new navermaps.Point(0, anchorY),
                }}
                zIndex={selected ? 200 : 0}
                onClick={() => onMarkerClick(lot)}
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
