/**
 * 공공데이터 → 카카오/네이버 주차장 매칭 & 덮어쓰기
 *
 * 공공데이터를 정본(ground truth)으로 취급하여:
 * 1. 카카오/네이버 소스와 좌표(100m) + 이름유사도 매칭
 * 2. 매칭 성공 시 요금/운영시간/주차면/전화번호 전 항목 덮어쓰기
 * 3. verified_source = 'public_api' 기록
 *
 * 사용법:
 *   bun run scripts/enrich-from-public-data.ts --remote
 *   bun run scripts/enrich-from-public-data.ts --remote --dry-run
 */
import { resolve } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import { d1Query, d1ExecFile, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

const DRY_RUN = process.argv.includes('--dry-run')

// ── 타입 ──

interface ParkingRow {
  id: string
  name: string
  type: string
  address: string
  lat: number
  lng: number
  total_spaces: number
  weekday_start: string | null
  weekday_end: string | null
  saturday_start: string | null
  saturday_end: string | null
  holiday_start: string | null
  holiday_end: string | null
  is_free: number
  base_time: number
  base_fee: number
  extra_time: number
  extra_fee: number
  daily_max: number | null
  monthly_pass: number | null
  phone: string | null
  payment_methods: string | null
  notes: string | null
}

// ── 거리 계산 ──

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── 이름 유사도 ──

/** 이름에서 "주차장", "공영", "노외" 등 접미사 제거 후 비교 */
function normalizeName(name: string): string {
  return name
    .replace(/\s/g, '')
    .replace(/(?:공영|민영|노외|노상|부설|유료|무료|임시)?주차장\d*$/, '')
    .replace(/\(.*?\)/g, '')
    .toLowerCase()
    .trim()
}

function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)

  if (na === nb) return 1.0
  if (na.includes(nb) || nb.includes(na)) return 0.8

  // 공통 글자 비율
  const shorter = na.length < nb.length ? na : nb
  const longer = na.length >= nb.length ? na : nb
  let matches = 0
  for (const ch of shorter) {
    if (longer.includes(ch)) matches++
  }
  return matches / longer.length
}

// ── 매칭 ──

interface MatchResult {
  kakaNaverId: string
  publicId: string
  publicRow: ParkingRow
  distance: number
  similarity: number
}

function findBestMatch(
  target: ParkingRow,
  publicLots: ParkingRow[],
  maxDistance: number = 150,
  minSimilarity: number = 0.5,
): MatchResult | null {
  let best: MatchResult | null = null

  for (const pub of publicLots) {
    const dist = haversineMeters(target.lat, target.lng, pub.lat, pub.lng)
    if (dist > maxDistance) continue

    const sim = nameSimilarity(target.name, pub.name)
    if (sim < minSimilarity) continue

    // 점수: 유사도 우선, 거리 보조
    const score = sim * 100 - dist / 10
    if (!best || score > best.similarity * 100 - best.distance / 10) {
      best = {
        kakaNaverId: target.id,
        publicId: pub.id,
        publicRow: pub,
        distance: Math.round(dist),
        similarity: sim,
      }
    }
  }

  return best
}

// ── 공간 인덱스 (격자) ──

function buildGrid(lots: ParkingRow[], cellSize: number = 0.002) {
  const grid = new Map<string, ParkingRow[]>()
  for (const lot of lots) {
    const key = `${Math.floor(lot.lat / cellSize)},${Math.floor(lot.lng / cellSize)}`
    const arr = grid.get(key) ?? []
    arr.push(lot)
    grid.set(key, arr)
  }
  return { grid, cellSize }
}

function getNearby(
  grid: Map<string, ParkingRow[]>,
  cellSize: number,
  lat: number,
  lng: number,
): ParkingRow[] {
  const cx = Math.floor(lat / cellSize)
  const cy = Math.floor(lng / cellSize)
  const result: ParkingRow[] = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${cx + dx},${cy + dy}`
      const cell = grid.get(key)
      if (cell) result.push(...cell)
    }
  }
  return result
}

// ── UPDATE SQL ──

function buildUpdate(targetId: string, pub: ParkingRow): string {
  return `UPDATE parking_lots SET
    total_spaces = ${pub.total_spaces},
    weekday_start = '${esc(pub.weekday_start ?? '')}',
    weekday_end = '${esc(pub.weekday_end ?? '')}',
    saturday_start = '${esc(pub.saturday_start ?? '')}',
    saturday_end = '${esc(pub.saturday_end ?? '')}',
    holiday_start = '${esc(pub.holiday_start ?? '')}',
    holiday_end = '${esc(pub.holiday_end ?? '')}',
    is_free = ${pub.is_free},
    base_time = ${pub.base_time},
    base_fee = ${pub.base_fee},
    extra_time = ${pub.extra_time},
    extra_fee = ${pub.extra_fee},
    daily_max = ${pub.daily_max ?? 'NULL'},
    monthly_pass = ${pub.monthly_pass ?? 'NULL'},
    phone = '${esc(pub.phone ?? '')}',
    payment_methods = '${esc(pub.payment_methods ?? '')}',
    notes = '${esc(pub.notes ?? '')}',
    verified_source = 'public_api',
    verified_at = datetime('now'),
    updated_at = datetime('now')
  WHERE id = '${esc(targetId)}';`
}

// ── 메인 ──

async function main() {
  console.log('=== 공공데이터 → 카카오/네이버 매칭 & 보강 ===')
  console.log(`모드: ${DRY_RUN ? 'DRY-RUN' : isRemote ? 'REMOTE' : 'LOCAL'}\n`)

  // 1. 공공데이터 주차장 조회
  console.log('📡 공공데이터 주차장 조회...')
  const publicLots = d1Query<ParkingRow>(
    `SELECT id, name, type, address, lat, lng, total_spaces,
            weekday_start, weekday_end, saturday_start, saturday_end,
            holiday_start, holiday_end, is_free, base_time, base_fee,
            extra_time, extra_fee, daily_max, monthly_pass,
            phone, payment_methods, notes
     FROM parking_lots
     WHERE id NOT LIKE 'KA-%' AND id NOT LIKE 'NV-%'`,
  )
  console.log(`  공공데이터: ${publicLots.length}건`)

  // 2. 카카오/네이버 주차장 조회
  console.log('📡 카카오/네이버 주차장 조회...')
  const targetLots = d1Query<ParkingRow>(
    `SELECT id, name, type, address, lat, lng, total_spaces,
            weekday_start, weekday_end, saturday_start, saturday_end,
            holiday_start, holiday_end, is_free, base_time, base_fee,
            extra_time, extra_fee, daily_max, monthly_pass,
            phone, payment_methods, notes
     FROM parking_lots
     WHERE id LIKE 'KA-%' OR id LIKE 'NV-%'`,
  )
  console.log(`  카카오/네이버: ${targetLots.length}건\n`)

  // 3. 공간 인덱스 구축
  console.log('🗂️  공간 인덱스 구축...')
  const { grid, cellSize } = buildGrid(publicLots)

  // 4. 매칭
  console.log('🔗 매칭 중...')
  const matches: MatchResult[] = []
  let noMatch = 0

  for (let i = 0; i < targetLots.length; i++) {
    const target = targetLots[i]
    const nearby = getNearby(grid, cellSize, target.lat, target.lng)
    const match = findBestMatch(target, nearby)

    if (match) {
      matches.push(match)
    } else {
      noMatch++
    }

    if ((i + 1) % 5000 === 0 || i === targetLots.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${targetLots.length} (매칭 ${matches.length}건)`)
    }
  }
  console.log()

  // 5. 리포트
  console.log('\n📊 매칭 결과:')
  console.log(`  매칭 성공: ${matches.length}건 (${((matches.length / targetLots.length) * 100).toFixed(1)}%)`)
  console.log(`  매칭 실패: ${noMatch}건`)

  // 유사도 분포
  const highSim = matches.filter((m) => m.similarity >= 0.8).length
  const medSim = matches.filter((m) => m.similarity >= 0.5 && m.similarity < 0.8).length
  console.log(`  유사도 ≥0.8: ${highSim}건, 0.5~0.8: ${medSim}건`)

  // 거리 분포
  const within50 = matches.filter((m) => m.distance <= 50).length
  const within100 = matches.filter((m) => m.distance <= 100).length
  console.log(`  거리 ≤50m: ${within50}건, ≤100m: ${within100}건`)

  if (matches.length === 0) {
    console.log('\n❌ 매칭 건 없음. 종료.')
    return
  }

  if (DRY_RUN) {
    console.log(`\n🔍 DRY-RUN: ${matches.length}건 UPDATE 예정 (DB 미반영)`)
    console.log('\n샘플 매칭 (상위 10건):')
    for (const m of matches.slice(0, 10)) {
      console.log(
        `  ${m.kakaNaverId} → ${m.publicId} (${m.distance}m, sim=${m.similarity.toFixed(2)})`,
      )
    }
    return
  }

  // 6. UPDATE 실행
  console.log(`\n⚡ ${matches.length}건 UPDATE 실행...`)
  const BATCH = 100
  const tmpSql = resolve(import.meta.dir, '../.tmp-enrich.sql')

  for (let i = 0; i < matches.length; i += BATCH) {
    const slice = matches.slice(i, i + BATCH)
    const stmts = slice.map((m) => buildUpdate(m.kakaNaverId, m.publicRow)).join('\n')
    writeFileSync(tmpSql, stmts)
    d1ExecFile(tmpSql)

    const done = Math.min(i + BATCH, matches.length)
    process.stdout.write(`\r  ${done}/${matches.length} (${Math.round((done / matches.length) * 100)}%)`)
  }

  try {
    unlinkSync(tmpSql)
  } catch {}
  console.log(`\n\n✅ 완료! ${matches.length}건 보강 (verified_source = 'public_api')`)
}

main().catch((err) => {
  console.error('❌ 에러:', err.message ?? err)
  process.exit(1)
})
