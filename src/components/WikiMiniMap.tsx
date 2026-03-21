import { useState } from "react";
import {
  Container as MapDiv,
  NaverMap,
  Marker,
  useNavermaps,
  NavermapsProvider,
} from "react-naver-maps";

interface WikiMiniMapProps {
  lat: number;
  lng: number;
  name: string;
}

function MiniMapInner({ lat, lng, name }: WikiMiniMapProps) {
  const navermaps = useNavermaps();

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
      <Marker
        position={new navermaps.LatLng(lat, lng)}
        title={name}
      />
    </NaverMap>
  );
}

export function WikiMiniMap({ lat, lng, name }: WikiMiniMapProps) {
  const [error, setError] = useState(false);

  if (error) {
    return (
      <section className="rounded-xl border overflow-hidden bg-gray-100 flex items-center justify-center text-xs text-muted-foreground" style={{ height: 250 }}>
        지도를 불러올 수 없습니다
      </section>
    );
  }

  return (
    <section className="rounded-xl border overflow-hidden" style={{ height: 250 }}>
      {typeof window !== "undefined" && (
        <NavermapsProvider
          ncpKeyId={import.meta.env.VITE_NAVER_MAP_CLIENT_ID}
          onError={() => setError(true)}
        >
          <MapDiv style={{ width: "100%", height: "100%" }}>
            <MiniMapInner lat={lat} lng={lng} name={name} />
          </MapDiv>
        </NavermapsProvider>
      )}
    </section>
  );
}
