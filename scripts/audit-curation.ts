/**
 * 둘러보기 큐레이션 스냅샷 (D-4 평가용, 읽기 전용).
 *
 * 위키 홈 4개 섹션 + 17개 시·도 허브 3개 섹션이 실제로 보여주는 상위 9개를 JSON 으로 남긴다.
 *   --mode=before : 09-11 운영 SQL 그대로 (필터 없음)
 *   --mode=after  : 후보를 넉넉히 뽑고(홈 30 / 지역 24, 넓은 TOP 은 노상 제외) curateLots 적용
 * 쿼리는 wiki/index.tsx · wiki/region.$region.tsx 와 같은 조건이다 (표시 컬럼만 줄였다).
 *
 * 사용: bun run scripts/audit-curation.ts --remote --mode=before
 * 출력: data/d4/curation-<mode>-<ts>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { PARKING_REGIONS } from '../src/lib/parking-regions'
import { curateLots } from '../src/server/lot-name-quality'
import { d1Query } from './lib/d1'

const after = process.argv.includes('--mode=after')
const SHOWN = 9

interface Row {
  id: string
  name: string
  address: string | null
  type: string | null
  total_spaces: number | null
  is_free: number | null
  curation_reason: string | null
  review_count: number
  web_count: number
}

const COLS = `p.id, p.name, p.address, p.type, p.total_spaces, p.is_free, p.curation_reason,
  COALESCE(s.review_count, 0) AS review_count`
const WEB_V2 = `(SELECT COUNT(*) FROM web_sources ws WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40 AND ws.filter_passed_v2 IS NOT 0)`
const WEB_REGION = `(SELECT COUNT(*) FROM web_sources ws WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40)`

function sections(): Array<{ page: string; section: string; sql: string }> {
  const out: Array<{ page: string; section: string; sql: string }> = []
  const homeLimit = after ? 30 : SHOWN
  const regionLimit = after ? 24 : SHOWN
  const home = 'home'
  out.push({
    page: home,
    section: 'easy',
    sql: `SELECT ${COLS}, ${WEB_V2} AS web_count FROM parking_lots p LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.curation_tag = 'easy' ORDER BY COALESCE(s.final_score, 0) DESC, p.total_spaces DESC LIMIT ${homeLimit}`,
  })
  out.push({
    page: home,
    section: 'popular',
    sql: `SELECT ${COLS}, ${WEB_V2} AS web_count FROM parking_lots p JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE ${WEB_V2} > 0 ORDER BY web_count DESC LIMIT ${homeLimit}`,
  })
  out.push({
    page: home,
    section: 'spacious',
    sql: `SELECT ${COLS}, ${WEB_V2} AS web_count FROM parking_lots p LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.total_spaces >= 200 ${after ? `AND p.type <> '노상'` : ''}
      ORDER BY p.total_spaces DESC, COALESCE(s.final_score, 0) DESC LIMIT ${homeLimit}`,
  })
  const freeWhere = `p.is_free = 1 AND (p.total_spaces >= 100 OR p.curation_reason IS NOT NULL
      OR EXISTS (SELECT 1 FROM web_sources ws WHERE ws.parking_lot_id = p.id))`
  const freeOrder = `CASE WHEN p.curation_reason IS NOT NULL THEN 1 ELSE 0 END DESC, COALESCE(s.final_score, 0) DESC, p.total_spaces DESC`
  out.push({
    page: home,
    section: 'free',
    sql: `SELECT ${COLS}, ${WEB_V2} AS web_count FROM parking_lots p LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE ${freeWhere} ORDER BY ${freeOrder} LIMIT ${homeLimit}`,
  })

  for (const region of PARKING_REGIONS) {
    const rw = region.prefixes.map((prefix) => `p.address LIKE '${prefix}%'`).join(' OR ')
    const page = `region:${region.label}`
    out.push({
      page,
      section: 'easy',
      sql: `SELECT ${COLS}, ${WEB_REGION} AS web_count FROM parking_lots p LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE (${rw}) AND p.curation_tag = 'easy' ORDER BY COALESCE(s.final_score, 0) DESC, p.total_spaces DESC LIMIT ${regionLimit}`,
    })
    out.push({
      page,
      section: 'popular',
      sql: `SELECT ${COLS}, ${WEB_REGION} AS web_count FROM parking_lots p JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE (${rw}) AND ${WEB_REGION} > 0 ORDER BY web_count DESC LIMIT ${regionLimit}`,
    })
    out.push({
      page,
      section: 'free',
      sql: `SELECT ${COLS}, ${WEB_REGION} AS web_count FROM parking_lots p LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE (${rw}) AND ${freeWhere} ORDER BY ${freeOrder} LIMIT ${regionLimit}`,
    })
  }
  return out
}

function main() {
  const snapshot: Array<{ page: string; section: string; rows: Row[] }> = []
  for (const s of sections()) {
    const rows = d1Query<Row>(s.sql.replace(/\s+/g, ' '))
    snapshot.push({
      page: s.page,
      section: s.section,
      rows: after ? curateLots(rows, SHOWN) : rows.slice(0, SHOWN),
    })
    process.stdout.write('.')
  }
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  mkdirSync('data/d4', { recursive: true })
  const path = `data/d4/curation-${after ? 'after' : 'before'}-${ts}.json`
  writeFileSync(path, JSON.stringify(snapshot, null, 2))
  const total = snapshot.reduce((n, s) => n + s.rows.length, 0)
  console.log(`\n${snapshot.length} sections, ${total} rows → ${path}`)
}

main()
