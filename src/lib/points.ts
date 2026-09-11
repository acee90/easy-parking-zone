/**
 * 지도 클러스터링용 전체 주차장 경량 좌표 (B-3).
 *
 * 서버 함수로 보내면 seroval 이 값마다 `{"t":1,"s":…}` 로 감싸고 객체마다 키를 반복해
 * 5.4만 곳이 해제 11.5MB 였다 (09-11 운영). `/api/points` 는 배열의 배열로 보낸다.
 * 이름은 뺐다 — 라벨은 목록 조회(fetchParkingLotsByIds)로 받은 lot 에만 그린다 (D-2).
 */
export interface ParkingPoint {
  id: string
  lat: number
  lng: number
  score: number | null
}

/** [id, lat, lng, score] — 좌표는 소수 5자리(약 1.1m) */
export type PointTuple = [id: string, lat: number, lng: number, score: number | null]

const round5 = (v: number) => Math.round(v * 1e5) / 1e5

export function encodePoint(p: ParkingPoint): PointTuple {
  return [p.id, round5(p.lat), round5(p.lng), p.score]
}

export function decodePoints(rows: readonly PointTuple[]): ParkingPoint[] {
  return rows.map(([id, lat, lng, score]) => ({ id, lat, lng, score }))
}
