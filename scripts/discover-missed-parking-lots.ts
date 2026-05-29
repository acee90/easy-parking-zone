/**
 * Stage A — web_sources_missed 신규 주차장 후보 집계 (dry-run)
 *
 * 계획: docs/exec-plans/missed-web-sources-new-parking-lots.plan.md
 *
 * web_sources_missed의 missed_lot_name을 정규화·그룹핑해서
 * candidate_type(parking_lot_name/facility_name/region_name/...)으로 분류하고
 * 후보 수 / 노이즈 수 / source 분포 / 상위 후보 샘플을 리포트한다.
 * 새 테이블·외부 API 없이 노이즈 비율과 hit 후보 규모를 실측하는 단계.
 *
 * Usage:
 *   bun run scripts/discover-missed-parking-lots.ts --remote --limit 500 --dry-run
 *   bun run scripts/discover-missed-parking-lots.ts --remote --limit 500 --out data/missed-discovery-20260528.json
 *
 * --apply (Stage B: 후보 테이블 적재)는 아직 미구현.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { d1Query, isRemote } from './lib/d1'
import {
  type CandidateType,
  classify,
  confidence,
  NOISE_TYPES,
  normalizeName,
  SEARCH_ELIGIBLE_TYPES,
} from './lib/missed-classify'

// ── CLI ──
const args = process.argv.slice(2)
function getArg(name: string, fallback: string): string {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
function getNumArg(name: string, fallback: number): number {
  const v = getArg(name, '')
  return v ? parseInt(v, 10) : fallback
}

const LIMIT = getNumArg('--limit', 500) // MVP: evidence 상위 N개 후보 대상
const APPLY = args.includes('--apply')
const todayTag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUT = getArg('--out', `data/missed-discovery-candidates-${todayTag}.json`)

// 분류 로직은 scripts/lib/missed-classify.ts로 추출 (resolve-missed.ts와 공유)

// ── DB ──
interface RawGroup {
  missed_lot_name: string
  evidence_count: number
  source_count: number
  sources: string | null
}

interface Candidate {
  missed_lot_name: string // 대표 원본 이름
  normalized_name: string
  evidence_count: number
  source_count: number
  sources: string[]
  candidate_type: CandidateType
  extraction_confidence: number
  search_eligible: boolean
  reason: string
}

function selectGroups(): RawGroup[] {
  return d1Query<RawGroup>(`
    SELECT missed_lot_name,
           COUNT(*) AS evidence_count,
           COUNT(DISTINCT source) AS source_count,
           GROUP_CONCAT(DISTINCT source) AS sources
    FROM web_sources_missed
    GROUP BY missed_lot_name
  `)
}

function selectSourceDist(): { source: string; cnt: number }[] {
  return d1Query<{ source: string; cnt: number }>(`
    SELECT source, COUNT(*) AS cnt
    FROM web_sources_missed
    GROUP BY source
    ORDER BY cnt DESC
  `)
}

function selectTotals(): { total: number; distinct_names: number } {
  return d1Query<{ total: number; distinct_names: number }>(`
    SELECT COUNT(*) AS total, COUNT(DISTINCT missed_lot_name) AS distinct_names
    FROM web_sources_missed
  `)[0]
}

// ── 정규화 그룹 병합 ──
function buildCandidates(groups: RawGroup[]): Candidate[] {
  const merged = new Map<string, Candidate>()

  for (const g of groups) {
    const normalized = normalizeName(g.missed_lot_name)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    const sources = (g.sources ?? '').split(',').filter(Boolean)

    const existing = merged.get(key)
    if (existing) {
      existing.evidence_count += g.evidence_count
      for (const s of sources) {
        if (!existing.sources.includes(s)) existing.sources.push(s)
      }
      existing.source_count = existing.sources.length
      continue
    }

    const { type, reason } = classify(normalized)
    merged.set(key, {
      missed_lot_name: g.missed_lot_name,
      normalized_name: normalized,
      evidence_count: g.evidence_count,
      source_count: sources.length,
      sources,
      candidate_type: type,
      extraction_confidence: 0, // 병합 후 재계산
      search_eligible: SEARCH_ELIGIBLE_TYPES.has(type),
      reason,
    })
  }

  // 병합 후 evidence/source 기준 confidence 재계산
  for (const c of merged.values()) {
    c.extraction_confidence = confidence(
      c.candidate_type,
      c.normalized_name,
      c.evidence_count,
      c.source_count,
    )
  }

  return [...merged.values()]
}

// ── Main ──
function main() {
  if (APPLY) {
    console.log(
      '\n⚠️  --apply (Stage B: parking_lot_discovery_candidates 적재)는 아직 미구현입니다.',
    )
    console.log('   Stage A 집계만 dry-run으로 실행합니다.\n')
  }

  console.log(`\n🔍 Stage A — missed 후보 집계 (dry-run) — ${isRemote ? 'remote' : 'local'} DB`)

  const totals = selectTotals()
  console.log(
    `\n  web_sources_missed: 총 ${totals.total.toLocaleString()}건, distinct missed_lot_name ${totals.distinct_names.toLocaleString()}개`,
  )

  const groups = selectGroups()
  const candidates = buildCandidates(groups)
  console.log(`  정규화 병합 후 후보: ${candidates.length.toLocaleString()}개`)

  // candidate_type 분포
  const typeDist = new Map<CandidateType, number>()
  for (const c of candidates) {
    typeDist.set(c.candidate_type, (typeDist.get(c.candidate_type) ?? 0) + 1)
  }
  console.log(`\n  candidate_type 분포 (후보 단위):`)
  for (const [t, n] of [...typeDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(20)} ${n.toLocaleString()}`)
  }

  // MVP는 plan대로 evidence_count 상위 N개를 대상으로 한다.
  // confidence 우선 정렬은 ev=1 홍보 블로그(투루파킹/파킹박 등 브랜드)를 최상위로 끌어올려 부적합.
  const eligible = candidates
    .filter((c) => c.search_eligible)
    .sort(
      (a, b) =>
        b.evidence_count - a.evidence_count ||
        b.source_count - a.source_count ||
        b.extraction_confidence - a.extraction_confidence,
    )
  const noise = candidates.filter((c) => NOISE_TYPES.has(c.candidate_type))
  console.log(`\n  장소검색 대상 후보(eligible): ${eligible.length.toLocaleString()}개`)
  console.log(`  노이즈/제외 후보: ${noise.length.toLocaleString()}개`)

  // source 분포 (raw row 기준)
  console.log(`\n  source 분포 (raw row 기준):`)
  for (const { source, cnt } of selectSourceDist()) {
    console.log(`    ${source.padEnd(16)} ${cnt.toLocaleString()}`)
  }

  // 상위 eligible 후보 샘플 (MVP 대상)
  const mvp = eligible.slice(0, LIMIT)
  console.log(`\n  MVP 대상 상위 ${mvp.length}개 (limit=${LIMIT}) 샘플:`)
  for (const c of mvp.slice(0, 25)) {
    console.log(
      `    [${c.candidate_type.padEnd(16)} conf=${c.extraction_confidence.toFixed(2)}] ` +
        `ev=${c.evidence_count} src=${c.source_count}  ${c.normalized_name}`,
    )
  }

  // 노이즈 상위 샘플 (extractor 개선 신호)
  const topNoise = [...noise].sort((a, b) => b.evidence_count - a.evidence_count).slice(0, 15)
  console.log(`\n  노이즈 상위 샘플 (extractor 개선 대상):`)
  for (const c of topNoise) {
    console.log(`    [${c.candidate_type.padEnd(16)}] ev=${c.evidence_count}  ${c.normalized_name}`)
  }

  // 출력: 전체 후보를 evidence·confidence 순으로 저장 (MVP 선별 기준과 동일)
  const sorted = [...candidates].sort(
    (a, b) =>
      b.evidence_count - a.evidence_count || b.extraction_confidence - a.extraction_confidence,
  )
  const outPath = resolve(import.meta.dir, '..', OUT)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source_db: isRemote ? 'remote' : 'local',
        totals,
        limit: LIMIT,
        eligible_count: eligible.length,
        noise_count: noise.length,
        candidates: sorted,
      },
      null,
      2,
    ),
    'utf-8',
  )
  console.log(`\n  ✅ 후보 ${sorted.length}개 저장: ${outPath}\n`)
}

main()
