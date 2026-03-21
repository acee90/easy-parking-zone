import { useState } from "react";
import {
  Container as MapDiv,
  NaverMap,
  Marker,
  useNavermaps,
} from "react-naver-maps";
import { NavermapsProvider } from "react-naver-maps";

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
      logoControl={false}
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
      <div className="h-[250px] rounded-xl border bg-gray-100 flex items-center justify-center text-xs text-muted-foreground">
        지도를 불러올 수 없습니다
      </div>
    );
  }

  return (
    <section className="rounded-xl border overflow-hidden" style={{ height: 250 }}>
      <NavermapsProvider
        ncpKeyId={import.meta.env.VITE_NAVER_MAP_CLIENT_ID}
        onError={() => setError(true)}
      >
        <MapDiv style={{ width: "100%", height: "100%" }}>
          <MiniMapInner lat={lat} lng={lng} name={name} />
        </MapDiv>
      </NavermapsProvider>
    </section>
  );
}
