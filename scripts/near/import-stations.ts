/**
 * 전국도시철도역사정보표준데이터 (공공데이터포털 15013205) → 목적지 후보 JSON (#166 1단계)
 *
 * 원본은 XLSX 만 제공된다. 스프레드시트에서 CSV(UTF-8) 로 저장한 파일을 넣는다.
 * 컬럼은 헤더 이름으로 찾으므로 순서가 바뀌어도 된다.
 *   필요한 것: 역사명, 노선명, 역위도, 역경도   (선택: 역번호, 운영기관명, 역사도로명주소)
 *
 * 환승역은 노선마다 한 행씩 온다. 같은 이름이고 200m 안이면 한 후보로 합치고 lines 에 노선을 모은다.
 * 같은 이름인데 멀리 떨어진 역(예: 다른 도시의 동명 역)은 따로 둔다.
 *
 * Usage:
 *   bun run scripts/near/import-stations.ts --in=data/near/stations.csv --out=data/near/candidates.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { distanceMeters } from '../../src/lib/near/gate'

const args = process.argv.slice(2)
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const IN = arg('in', 'data/near/stations.csv')
const OUT = arg('out', 'data/near/candidates.json')
// 서울역·홍대입구처럼 큰 역은 노선별 노드가 200m 넘게 흩어진다 → 500m. 동명 역이 다른 도시에 있는 경우는 훨씬 멀다
const MERGE_RADIUS_M = 500

export interface StationCandidate {
  key: string // '석촌역@37.5054,127.1067'
  name: string // '석촌역'
  category: 'station'
  lat: number
  lng: number
  lines: string[] // ['8호선', '9호선']
  address: string | null
  operator: string | null
  source: string // 'public_data:15013205'
  sourceIds: string[] // 역번호들
}

// ── CSV (따옴표·개행 처리 최소 구현) ──
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}

function findCol(header: string[], ...cands: string[]): number {
  const norm = (s: string) => s.replace(/\s|﻿/g, '')
  for (const c of cands) {
    const i = header.findIndex((h) => norm(h) === norm(c))
    if (i >= 0) return i
  }
  for (const c of cands) {
    const i = header.findIndex((h) => norm(h).includes(norm(c)))
    if (i >= 0) return i
  }
  return -1
}

function normalizeStationName(raw: string): string {
  // "석촌(8호선)" / "석촌역" / "석촌 역" → "석촌역"
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
    console.error('공공데이터포털 15013205 의 XLSX 를 CSV(UTF-8) 로 저장해서 넣으세요.')
    process.exit(1)
  }
  const rows = parseCsv(readFileSync(IN, 'utf-8'))
  const header = rows[0]
  const col = {
    name: findCol(header, '역사명', '역명'),
    line: findCol(header, '노선명'),
    lat: findCol(header, '역위도', '위도'),
    lng: findCol(header, '역경도', '경도'),
    no: findCol(header, '역번호'),
    op: findCol(header, '운영기관명'),
    addr: findCol(header, '역사도로명주소', '도로명주소'),
  }
  if (col.name < 0 || col.lat < 0 || col.lng < 0) {
    console.error('필수 컬럼(역사명/역위도/역경도)을 찾지 못했습니다. 헤더:', header)
    process.exit(1)
  }

  const candidates: StationCandidate[] = []
  let skippedNoCoord = 0
  for (const r of rows.slice(1)) {
    const name = normalizeStationName(r[col.name] ?? '')
    const lat = Number.parseFloat(r[col.lat] ?? '')
    const lng = Number.parseFloat(r[col.lng] ?? '')
    if (
      !name ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < 33 ||
      lat > 39 ||
      lng < 124 ||
      lng > 132
    ) {
      skippedNoCoord++
      continue
    }
    const line = (r[col.line] ?? '').trim()
    const no = col.no >= 0 ? (r[col.no] ?? '').trim() : ''
    const existing = candidates.find(
      (c) => c.name === name && distanceMeters(c.lat, c.lng, lat, lng) <= MERGE_RADIUS_M,
    )
    if (existing) {
      if (line && !existing.lines.includes(line)) existing.lines.push(line)
      if (no && !existing.sourceIds.includes(no)) existing.sourceIds.push(no)
      continue
    }
    candidates.push({
      key: `${name}@${lat.toFixed(4)},${lng.toFixed(4)}`,
      name,
      category: 'station',
      lat,
      lng,
      lines: line ? [line] : [],
      address: col.addr >= 0 ? r[col.addr]?.trim() || null : null,
      operator: col.op >= 0 ? r[col.op]?.trim() || null : null,
      source: 'public_data:15013205',
      sourceIds: no ? [no] : [],
    })
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(candidates, null, 2))
  console.log(
    `행 ${rows.length - 1} → 후보 ${candidates.length} (좌표 없음/범위 밖 ${skippedNoCoord}) → ${OUT}`,
  )
}

main()
