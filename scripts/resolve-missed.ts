/**
 * missed 정화 — web_sources_missed 행을 분류·장소검색으로 해소
 *
 * 계획: docs/exec-plans/missed-web-sources-new-parking-lots.plan.md (Phase 1+2)
 *
 * resolution_status IS NULL 인 행을 normalized name으로 그룹핑 →
 *  - 노이즈 타입 → rejected_noise
 *  - eligible(facility/parking) → Naver 장소검색 + 좌표 dedup:
 *      all_existing  → resolved_existing_lot (+ resolved_parking_lot_id)
 *      negative      → rejected_no_place
 *      ambiguous_new → review_required
 *      resolved_new  → 상태 미부여(NULL 유지) = 진짜 신규 lot 후보로 남김
 *  - organization_name → 미부여(review 보류, NULL 유지)
 *
 * 결과 UPDATE 문을 data/missed-resolution-*.sql로 출력.
 * --apply 시 로컬에 즉시 적용. 동일 SQL 파일을 remote에 적용하면 재검색 없이 반영.
 *
 * Usage:
 *   bun run scripts/resolve-missed.ts --limit 200            # 샘플 dry-run (eligible 상위 200만 검색)
 *   bun run scripts/resolve-missed.ts                        # 전체 dry-run (eligible 전량 검색)
 *   bun run scripts/resolve-missed.ts --apply                # 전체 + 로컬 적용 + SQL 파일 출력
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { d1ExecFile, d1Query } from './lib/d1'
import { classify, NOISE_TYPES, normalizeName, SEARCH_ELIGIBLE_TYPES } from './lib/missed-classify'
import { searchNaverLocal } from './lib/naver-api'
import { extractHints, loadExistingLots, type PlaceLabel, resolvePlace } from './lib/place-match'

// ── CLI ──
const args = process.argv.slice(2)
function getNumArg(name: string, fallback: number): number {
  const i = args.indexOf(name)
  const v = i >= 0 ? args[i + 1] : ''
  return v ? parseInt(v, 10) : fallback
}
const APPLY = args.includes('--apply')
const LIMIT_ELIGIBLE = getNumArg('--limit', 0) // 0 = eligible 전량
const REQUEST_DELAY_MS = getNumArg('--delay', 150)
const DEDUP_RADIUS_M = getNumArg('--dedup-radius', 60)
const todayTag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUT_SQL = `data/missed-resolution-${todayTag}.sql`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Resolution =
  | 'rejected_noise'
  | 'resolved_existing_lot'
  | 'rejected_no_place'
  | 'review_required'

interface MissedRow {
  id: number
  missed_lot_name: string
  title: string
  content: string
}

interface Candidate {
  normalized: string
  rowIds: number[]
  hintText: string
}

const PARKING_RE = /(주차장|파킹|parking)/i
function buildQuery(name: string): string {
  return PARKING_RE.test(name) ? name : `${name} 주차장`
}

function loadUnresolved(): MissedRow[] {
  return d1Query<MissedRow>(
    `SELECT id, missed_lot_name, SUBSTR(title,1,200) AS title, SUBSTR(content,1,800) AS content
     FROM web_sources_missed WHERE resolution_status IS NULL`,
  )
}

function groupByNormalized(rows: MissedRow[]): Candidate[] {
  const map = new Map<string, Candidate>()
  for (const r of rows) {
    const normalized = normalizeName(r.missed_lot_name)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    const c = map.get(key)
    if (c) {
      c.rowIds.push(r.id)
      if (c.hintText.length < 4000) c.hintText += ` ${r.title} ${r.content}`
    } else {
      map.set(key, { normalized, rowIds: [r.id], hintText: `${r.title} ${r.content}` })
    }
  }
  return [...map.values()]
}

function updateStmt(rowIds: number[], status: Resolution, lotId: string | null): string {
  const ids = rowIds.join(',')
  const lot = lotId ? `'${lotId.replace(/'/g, "''")}'` : 'NULL'
  return `UPDATE web_sources_missed SET resolution_status='${status}', resolved_parking_lot_id=${lot}, resolved_at=datetime('now') WHERE id IN (${ids});`
}

async function main() {
  console.log(`\n🧹 missed 정화 — ${APPLY ? 'APPLY(로컬 적용)' : 'DRY-RUN'}`)

  const rows = loadUnresolved()
  const candidates = groupByNormalized(rows)
  console.log(
    `  미해소 행 ${rows.length.toLocaleString()} → 정규화 후보 ${candidates.length.toLocaleString()}개`,
  )

  // 1) 분류
  const noise: Candidate[] = []
  const eligible: Candidate[] = []
  const orgOrOther: Candidate[] = []
  for (const c of candidates) {
    const { type } = classify(c.normalized)
    if (NOISE_TYPES.has(type)) noise.push(c)
    else if (SEARCH_ELIGIBLE_TYPES.has(type)) eligible.push(c)
    else orgOrOther.push(c) // organization_name 등 → NULL 유지(보류)
  }
  eligible.sort((a, b) => b.rowIds.length - a.rowIds.length)
  const searchTargets = LIMIT_ELIGIBLE > 0 ? eligible.slice(0, LIMIT_ELIGIBLE) : eligible
  console.log(
    `  분류: 노이즈 ${noise.length} / eligible ${eligible.length}(검색 ${searchTargets.length}) / 보류(org등) ${orgOrOther.length}\n`,
  )

  const statements: string[] = []
  const resCount: Record<string, number> = {}
  const rowCount: Record<string, number> = {}
  const tally = (status: string, rowIds: number[]) => {
    resCount[status] = (resCount[status] ?? 0) + 1
    rowCount[status] = (rowCount[status] ?? 0) + rowIds.length
  }

  // 노이즈 즉시 처리 (API 불필요)
  for (const c of noise) {
    statements.push(updateStmt(c.rowIds, 'rejected_noise', null))
    tally('rejected_noise', c.rowIds)
  }

  // eligible 장소검색
  const lots = loadExistingLots()
  console.log(`  기존 parking_lots ${lots.length.toLocaleString()}개 로드. 장소검색 시작...`)
  const labelToRes: Record<Exclude<PlaceLabel, 'resolved_new'>, Resolution> = {
    all_existing: 'resolved_existing_lot',
    negative: 'rejected_no_place',
    ambiguous_new: 'review_required',
  }
  let keptNew = 0
  for (let i = 0; i < searchTargets.length; i++) {
    const c = searchTargets[i]
    const query = buildQuery(c.normalized)
    const hints = extractHints(c.hintText)
    try {
      const items = await searchNaverLocal(query, 5)
      const o = resolvePlace(c.normalized, items, lots, hints, DEDUP_RADIUS_M)
      if (o.label === 'resolved_new') {
        keptNew++ // NULL 유지 = 진짜 신규 후보
      } else {
        const status = labelToRes[o.label]
        const lotId = o.label === 'all_existing' ? (o.best?.existing_lot_id ?? null) : null
        statements.push(updateStmt(c.rowIds, status, lotId))
        tally(status, c.rowIds)
      }
    } catch (e: unknown) {
      console.log(`\n  ⚠️  "${query}" 검색 실패: ${e instanceof Error ? e.message : String(e)}`)
    }
    if ((i + 1) % 100 === 0 || i + 1 === searchTargets.length) {
      process.stdout.write(`\r  검색 진행: ${i + 1}/${searchTargets.length}`.padEnd(40))
    }
    await sleep(REQUEST_DELAY_MS)
  }
  console.log('\n')

  // 리포트
  console.log(`  해소 결과 (resolution_status별 후보/행 수):`)
  for (const [status, cnt] of Object.entries(resCount).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status.padEnd(22)} 후보 ${String(cnt).padStart(6)}  행 ${rowCount[status]}`)
  }
  console.log(`    ${'(NULL 유지) resolved_new'.padEnd(22)} 후보 ${keptNew}`)
  console.log(`    ${'(NULL 유지) org/보류'.padEnd(22)} 후보 ${orgOrOther.length}`)
  const unprocessed = eligible.length - searchTargets.length
  if (unprocessed > 0) console.log(`    (미검색 eligible) ${unprocessed} 후보 — --limit로 제한됨`)

  // SQL 출력
  const outPath = resolve(import.meta.dir, '..', OUT_SQL)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, statements.join('\n') + '\n', 'utf-8')
  console.log(`\n  📄 UPDATE ${statements.length}문 저장: ${outPath}`)

  if (APPLY) {
    d1ExecFile(outPath)
    console.log(
      `  ✅ 로컬 적용 완료. (remote 반영: wrangler d1 execute parking-db --remote --file=${OUT_SQL})`,
    )
  } else {
    console.log(`  (dry-run — 적용하려면 --apply)`)
  }
  console.log('')
}

main()
