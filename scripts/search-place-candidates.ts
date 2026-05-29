/**
 * Stage C — missed 후보 장소검색 + 신규 lot 판정 (측정용)
 *
 * 계획: docs/exec-plans/missed-web-sources-new-parking-lots.plan.md
 * 하이브리드 "네이버로 찾고, 카카오로 확정" 중 네이버 발견 파트.
 *
 * Stage A 산출 JSON(data/missed-discovery-candidates-*.json)의 상위 eligible 후보에
 * `{이름} 주차장` 쿼리로 Naver Local Search를 돌리고, 기존 parking_lots 좌표 dedup +
 * 본문 지역 힌트로 신규 lot을 판정한다. (resolve-missed.ts와 판정 로직 공유: lib/place-match)
 * 결과 라벨: resolved_new / ambiguous_new / all_existing / negative.
 *
 * Usage:
 *   bun run scripts/search-place-candidates.ts --provider naver --limit 100
 *   bun run scripts/search-place-candidates.ts --provider naver --limit 100 --in data/missed-discovery-candidates-20260528.json
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { d1Query } from './lib/d1'
import { searchNaverLocal } from './lib/naver-api'
import {
  type AnnotatedResult,
  extractHints,
  loadExistingLots,
  type PlaceLabel,
  resolvePlace,
} from './lib/place-match'

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

const PROVIDER = getArg('--provider', 'naver')
const LIMIT = getNumArg('--limit', 100)
const REQUEST_DELAY_MS = getNumArg('--delay', 150)
const DEDUP_RADIUS_M = getNumArg('--dedup-radius', 60)
const todayTag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const IN = getArg('--in', '')
const OUT = getArg('--out', `data/place-candidates-naver-${todayTag}.json`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface DiscoveryCandidate {
  missed_lot_name: string
  normalized_name: string
  evidence_count: number
  source_count: number
  sources: string[]
  candidate_type: string
  extraction_confidence: number
  search_eligible: boolean
  reason: string
}

interface StageAFile {
  candidates: DiscoveryCandidate[]
}

interface SearchOutcome {
  normalized_name: string
  candidate_type: string
  evidence_count: number
  source_count: number
  query: string
  label: PlaceLabel
  parking_result_count: number
  new_result_count: number
  best: AnnotatedResult | null
}

function resolveInputPath(): string {
  if (IN) return resolve(import.meta.dir, '..', IN)
  const dataDir = resolve(import.meta.dir, '..', 'data')
  const files = readdirSync(dataDir)
    .filter((f) => f.startsWith('missed-discovery-candidates-') && f.endsWith('.json'))
    .sort()
  if (files.length === 0) {
    throw new Error(
      'Stage A 산출 파일(data/missed-discovery-candidates-*.json)이 없습니다. 먼저 discover-missed-parking-lots.ts 실행.',
    )
  }
  return resolve(dataDir, files[files.length - 1])
}

const PARKING_RE = /(주차장|파킹|parking)/i
function buildQuery(c: DiscoveryCandidate): string {
  return PARKING_RE.test(c.normalized_name) ? c.normalized_name : `${c.normalized_name} 주차장`
}

// 후보별 블로그 본문에서 지역 힌트 토큰 추출 (missed_lot_name 대표값 기준)
function loadHints(names: string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  if (names.length === 0) return map
  const inList = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')
  const rows = d1Query<{ missed_lot_name: string; t: string | null }>(
    `SELECT missed_lot_name, SUBSTR(title,1,200) || ' ' || SUBSTR(content,1,800) AS t
     FROM web_sources_missed WHERE missed_lot_name IN (${inList})`,
  )
  for (const r of rows) {
    const h = map.get(r.missed_lot_name) ?? new Set<string>()
    for (const tok of extractHints(r.t ?? '')) h.add(tok)
    map.set(r.missed_lot_name, h)
  }
  return map
}

async function main() {
  if (PROVIDER !== 'naver') {
    console.log(`\n⚠️  --provider ${PROVIDER}는 아직 미구현입니다. 현재는 naver 발견 단계만 지원.`)
    return
  }

  const inputPath = resolveInputPath()
  const file = JSON.parse(readFileSync(inputPath, 'utf-8')) as StageAFile
  const eligible = file.candidates
    .filter((c) => c.search_eligible)
    .sort((a, b) => b.evidence_count - a.evidence_count || b.source_count - a.source_count)
    .slice(0, LIMIT)

  console.log(`\n🗺️  Stage C — Naver 장소검색 + 신규 lot 판정`)
  console.log(`  입력: ${inputPath}`)
  console.log(
    `  대상: 상위 eligible ${eligible.length}개 (limit=${LIMIT}, dedup=${DEDUP_RADIUS_M}m)`,
  )

  const lots = loadExistingLots()
  console.log(`  기존 parking_lots: ${lots.length.toLocaleString()}개 로드`)
  const hintMap = loadHints(eligible.map((c) => c.missed_lot_name))
  console.log(`  블로그 힌트 로드: ${hintMap.size}개 후보\n`)

  const outcomes: SearchOutcome[] = []
  for (let i = 0; i < eligible.length; i++) {
    const c = eligible[i]
    const query = buildQuery(c)
    const hints = hintMap.get(c.missed_lot_name) ?? new Set<string>()
    try {
      const items = await searchNaverLocal(query, 5)
      const o = resolvePlace(c.normalized_name, items, lots, hints, DEDUP_RADIUS_M)
      outcomes.push({
        normalized_name: c.normalized_name,
        candidate_type: c.candidate_type,
        evidence_count: c.evidence_count,
        source_count: c.source_count,
        query,
        label: o.label,
        parking_result_count: o.parking_result_count,
        new_result_count: o.new_result_count,
        best: o.best,
      })
      process.stdout.write(
        `\r  진행: ${i + 1}/${eligible.length}  [${o.label.padEnd(13)}] ${query}`.padEnd(80),
      )
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`\n  ⚠️  검색 실패: "${query}" — ${msg}`)
      outcomes.push({
        normalized_name: c.normalized_name,
        candidate_type: c.candidate_type,
        evidence_count: c.evidence_count,
        source_count: c.source_count,
        query,
        label: 'negative',
        parking_result_count: 0,
        new_result_count: 0,
        best: null,
      })
    }
    await sleep(REQUEST_DELAY_MS)
  }
  console.log('')

  const dist = new Map<PlaceLabel, number>()
  for (const o of outcomes) dist.set(o.label, (dist.get(o.label) ?? 0) + 1)
  const total = outcomes.length || 1
  const get = (l: PlaceLabel) => dist.get(l) ?? 0

  console.log(`\n  라벨 분포:`)
  for (const label of [
    'resolved_new',
    'ambiguous_new',
    'all_existing',
    'negative',
  ] as PlaceLabel[]) {
    const n = get(label)
    console.log(`    ${label.padEnd(14)} ${n}  (${((n / total) * 100).toFixed(1)}%)`)
  }
  console.log(
    `\n  주차장 존재율 (negative 제외): ${(((total - get('negative')) / total) * 100).toFixed(1)}%`,
  )
  console.log(
    `  ★ 신규 lot 확정율 (resolved_new): ${((get('resolved_new') / total) * 100).toFixed(1)}%`,
  )

  console.log(`\n  resolved_new 샘플:`)
  for (const o of outcomes.filter((o) => o.label === 'resolved_new').slice(0, 12)) {
    console.log(
      `    "${o.query}" → ${o.best?.name} @ ${o.best?.address} ` +
        `[최근접 기존 ${o.best?.existing_dist_m}m, rs=${o.best?.region_score}]`,
    )
  }

  const outPath = resolve(import.meta.dir, '..', OUT)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(
    outPath,
    JSON.stringify(
      { generated_at: new Date().toISOString(), provider: 'naver', limit: LIMIT, outcomes },
      null,
      2,
    ),
    'utf-8',
  )
  console.log(`\n  ✅ 결과 ${outcomes.length}건 저장: ${outPath}\n`)
}

main()
