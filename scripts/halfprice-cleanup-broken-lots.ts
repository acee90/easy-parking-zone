/**
 * halfprice-travel-spots-geocoded.json 의 nearbyParking 항목 중
 * D1 DB 에 더 이상 존재하지 않는 주차장 ID 를 제거.
 *
 * Usage:
 *   bun run scripts/halfprice-cleanup-broken-lots.ts --remote   # remote DB 기준 (배포 전 권장)
 *   bun run scripts/halfprice-cleanup-broken-lots.ts            # local DB 기준
 *
 * 변경된 JSON 은 같은 파일에 덮어쓰기. `git diff` 로 변경 사항 확인 후 commit.
 *
 * 동작:
 *   1) JSON 의 모든 nearbyParking[].id 수집
 *   2) parking_lots WHERE id IN (...) 한 번에 조회
 *   3) 누락 ID 가 들어있는 nearbyParking 항목 제거
 *   4) 변경된 JSON 저장
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { d1Query, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

const JSON_PATH = resolve(import.meta.dir, 'data/halfprice-travel-spots-geocoded.json')

interface NearbyParking {
  id: string
  name: string
  address?: string
  lat?: number
  lng?: number
  distanceM: number
  isFree: boolean
  totalSpaces: number
  finalScore: number | null
}

interface Spot {
  name: string
  description?: string
  longDescription?: string
  tips?: string[]
  lat: number | null
  lng: number | null
  address?: string | null
  imageUrl?: string | null
  nearbyParking: NearbyParking[]
}

interface RegionData {
  region: string
  spots: Spot[]
}

interface IdRow {
  id: string
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function fetchExistingIds(ids: string[]): Set<string> {
  const existing = new Set<string>()
  for (const batch of chunk(ids, 200)) {
    const list = batch.map((id) => `'${esc(id)}'`).join(',')
    const rows = d1Query<IdRow>(`SELECT id FROM parking_lots WHERE id IN (${list})`)
    for (const r of rows) existing.add(r.id)
  }
  return existing
}

function main() {
  const raw = readFileSync(JSON_PATH, 'utf-8')
  const data: RegionData[] = JSON.parse(raw)

  const allIds = new Set<string>()
  for (const region of data) {
    for (const spot of region.spots) {
      for (const p of spot.nearbyParking) allIds.add(p.id)
    }
  }

  console.log(`[${isRemote ? 'REMOTE' : 'LOCAL'}] JSON 내 unique 주차장 ID: ${allIds.size}개`)

  const existing = fetchExistingIds([...allIds])
  const missing = [...allIds].filter((id) => !existing.has(id))

  console.log(`DB 존재: ${existing.size}개`)
  console.log(`DB 누락: ${missing.length}개`)

  if (missing.length > 0) {
    console.log(`\n=== 제거 대상 ID (${missing.length}) ===`)
    for (const id of missing) console.log(`  - ${id}`)
  }

  let removedRefs = 0
  let cleared: { region: string; spot: string; before: number; after: number }[] = []
  for (const region of data) {
    for (const spot of region.spots) {
      const before = spot.nearbyParking.length
      spot.nearbyParking = spot.nearbyParking.filter((p) => existing.has(p.id))
      const after = spot.nearbyParking.length
      if (after !== before) {
        removedRefs += before - after
        cleared.push({ region: region.region, spot: spot.name, before, after })
      }
    }
  }

  console.log(`\n=== 제거된 참조 ===`)
  console.log(`총 nearbyParking 참조 제거: ${removedRefs}개`)
  if (cleared.length > 0) {
    console.log(`영향받은 spot:`)
    for (const c of cleared) {
      console.log(`  - ${c.region} / ${c.spot}: ${c.before} → ${c.after}`)
    }
  }

  if (missing.length === 0) {
    console.log(`\n제거할 항목 없음. 파일 변경 없음.`)
    return
  }

  writeFileSync(JSON_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  console.log(`\n저장 완료: ${JSON_PATH}`)
  console.log(`다음 단계: \`git diff scripts/data/halfprice-travel-spots-geocoded.json\` 로 변경 확인 후 commit.`)
}

main()
