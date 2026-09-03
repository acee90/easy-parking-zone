/**
 * OpenStreetMap(Overpass) 지하철역 → 목적지 후보 JSON (#166 1단계, 공공데이터 대체 원천)
 *
 * 왜 OSM 인가: 전국도시철도역사정보표준데이터(15013205)는 XLSX 만 제공되고 레일포털 로그인 뒤에 있어
 * 스크립트로 받을 수 없다. OSM 은 로그인 없이 받을 수 있고, ODbL 이라 출처를 표기하면 좌표를 저장·표시할 수 있다.
 * 표준데이터 CSV 가 확보되면 import-stations.ts 로 갈아탄다 (source 값이 다르므로 화면이 출처를 구분한다).
 *
 * 입력은 Overpass 응답 JSON 이다 (railway=station + station=subway|light_rail, 한국 영역).
 *   bun run scripts/near/import-stations-osm.ts --in=data/near/osm-stations.json --out=data/near/candidates.json
 *
 * 같은 이름이고 200m 안이면 한 후보로 합친다 (환승역이 노드 두 개로 그려진 경우).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { distanceMeters } from '../../src/lib/near/gate'
import type { StationCandidate } from './import-stations'

const args = process.argv.slice(2)
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const IN = arg('in', 'data/near/osm-stations.json')
const OUT = arg('out', 'data/near/candidates.json')
// 서울역·홍대입구처럼 큰 역은 노선별 노드가 200m 넘게 흩어진다 → 500m. 동명 역이 다른 도시에 있는 경우는 훨씬 멀다
const MERGE_RADIUS_M = 500

interface OsmNode {
  type: string
  id: number
  lat: number
  lon: number
  tags?: Record<string, string>
}

function normalizeStationName(raw: string): string {
  // "한성대입구" / "석촌역" / "석촌 (8호선)" → "…역"
  let n = raw
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, '')
    .trim()
  if (!n.endsWith('역')) n += '역'
  return n
}

function main() {
  if (!existsSync(IN)) {
    console.error(`입력 파일이 없습니다: ${IN}`)
    console.error(
      'Overpass 쿼리: [out:json]; area["ISO3166-1"="KR"]["admin_level"="2"]->.kr; (node["railway"="station"]["station"="subway"](area.kr); node["railway"="station"]["subway"="yes"](area.kr); node["railway"="station"]["station"="light_rail"](area.kr);); out body;',
    )
    process.exit(1)
  }
  const nodes = (JSON.parse(readFileSync(IN, 'utf-8')) as { elements: OsmNode[] }).elements
  const candidates: StationCandidate[] = []
  let skipped = 0
  for (const n of nodes) {
    const t = n.tags ?? {}
    const raw = t['name:ko'] ?? t.name
    // 한글 이름이 없으면 검색어와 맞출 수 없다 — 후보에서 뺀다
    if (!raw || !/[가-힣]/.test(raw)) {
      skipped++
      continue
    }
    const name = normalizeStationName(raw)
    const line = (t.line ?? t.route_ref ?? '').trim()
    const existing = candidates.find(
      (c) => c.name === name && distanceMeters(c.lat, c.lng, n.lat, n.lon) <= MERGE_RADIUS_M,
    )
    if (existing) {
      if (line && !existing.lines.includes(line)) existing.lines.push(line)
      existing.sourceIds.push(String(n.id))
      continue
    }
    candidates.push({
      key: `${name}@${n.lat.toFixed(4)},${n.lon.toFixed(4)}`,
      name,
      category: 'station',
      lat: n.lat,
      lng: n.lon,
      lines: line ? [line] : [],
      address: null,
      operator: t.network ?? t.operator ?? null,
      // ODbL. 화면은 이 값으로 "© OpenStreetMap contributors" 를 붙인다
      source: 'osm:overpass',
      sourceIds: [String(n.id)],
    })
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(candidates, null, 2))
  console.log(
    `노드 ${nodes.length} → 후보 ${candidates.length} (한글 이름 없음 ${skipped}) → ${OUT}`,
  )
}

main()
