/**
 * 마커 클릭 시 지도 패닝 오프셋 계산.
 *
 * 레이아웃: [Sidebar][DetailPanel][Map] — flex 형제.
 * 패널은 지도 컨테이너 **밖**에 있으므로, 지도 좌표계 내에서
 * 마커를 지도 중앙에 위치시키면 됨.
 *
 * @param markerPixel  마커의 지도 컨테이너 내 픽셀 좌표 (fromCoordToOffset)
 * @param mapSize      지도 컨테이너의 width/height (px)
 * @returns            panBy에 넘길 { dx, dy } 또는 이동 불필요 시 null
 */
export function calcPanOffset(
  markerPixel: { x: number; y: number },
  mapSize: { width: number; height: number },
): { dx: number; dy: number } | null {
  const centerX = mapSize.width / 2;
  const centerY = mapSize.height / 2;

  const dx = markerPixel.x - centerX;
  const dy = markerPixel.y - centerY;

  // 이미 중앙 근처면 패닝 스킵
  if (Math.abs(dx) < 50 && Math.abs(dy) < 50) return null;

  return { dx, dy };
}
