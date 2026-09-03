/**
 * 주차장 AI 요약·팁 일괄 생성 — web_sources.ai_summary 기반
 *
 * Usage:
 *   bun run scripts/generate-lot-summary.ts --lotId=KA-1234567890
 *   bun run scripts/generate-lot-summary.ts --keyword="스타필드 위례"
 *   bun run scripts/generate-lot-summary.ts --batch --limit=50 --dry-run
 *   bun run scripts/generate-lot-summary.ts --batch --limit=100 --remote --concurrency=5
 *   bun run scripts/generate-lot-summary.ts --batch --limit=10 --remote --save
 *   bun run scripts/generate-lot-summary.ts --batch --limit=600 --remote --min-sources=3 --concurrency=5
 *
 * --min-sources=N : 출처 요약이 N건 이상인 lot만 고른다 (기본 1). 재료 많은 곳부터 채운다.
 * --no-apply      : SQL 파일만 만들고 D1에 적용하지 않는다.
 *
 * D1 접근: 읽기는 대상 전체에 대해 3회, 쓰기는 SQL 파일 1개를 --file 로 1회 적용한다.
 * lot 마다 wrangler 를 띄우지 않는다 (585곳 기준 2,340회 → 4회).
 *
 * 출력: parking_lot_stats.ai_summary / ai_tip_pricing / ai_tip_visit / ai_tip_alternative
 * --save 플래그: summary_batch.json + summary_results.json (eval용)
 *
 * 역할: 대량 backfill 전용 경로다. 정기 생성은 크론이
 * `src/server/crawlers/lot-summary-batch.ts`로 처리하며, 그쪽은 회당 6곳으로 묶여 있다
 * (건당 AI 호출이 최대 120초라 상한이 곧 wall time이다).
 *
 * ⚠️ 크론은 `ai_summary_stale = 1`인 곳만 본다. 그 표시는 `queues/score-recompute.ts`가
 *    **근거가 바뀐 lot에만** 붙이므로, 요약이 비어 있고 근거도 안 바뀌는 기존 백로그는
 *    크론 대상에 영영 들어오지 않는다. 그 구간을 메우는 것이 이 스크립트의 일이다.
 *    (2026-09-03 실측: 요약 대상 5,343곳 / stale 표시 7곳 / 요약 보유 36곳)
 *
 * 저장 전에 워커와 같은 품질 가드를 통과시킨다 (`validateResult`). 두 경로의 판정이
 * 갈라지면 한쪽이 거부하는 요약이 다른 쪽으로 그대로 들어간다.
 */

import { appendFileSync } from 'node:fs'
import { webQuotaFor } from '../src/server/crawlers/lib/lot-summary-input'
import {
  buildLotSummaryUserPrompt,
  LOT_SUMMARY_SYSTEM_PROMPT,
  type LotSummaryResult,
  MIN_LOT_SUMMARY_LENGTH,
} from '../src/server/crawlers/lib/lot-summary-prompt'
import { detectSummaryPollution } from '../src/server/crawlers/lib/summary-guard'
import { d1ExecFile, d1Query } from './lib/d1'
import { esc } from './lib/sql-flush'

// ── CLI ──
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
// 백필 순서 제어: 출처 요약이 N건 이상인 lot만 고른다. 재료가 많은 곳부터 채워 품질을 먼저 본다.
const minSources = parseInt(
  args.find((a) => a.startsWith('--min-sources='))?.split('=')[1] ?? '1',
  10,
)
// SQL 파일만 만들고 D1에는 적용하지 않는다 (적용 전 검토용).
const noApply = args.includes('--no-apply')
const isBatch = args.includes('--batch')
const isSave = args.includes('--save')
const lotIdArg = args.find((a) => a.startsWith('--lotId='))?.split('=')[1]
const keywordArg = args.find((a) => a.startsWith('--keyword='))?.split('=')[1]
const batchLimit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '50', 10)
const concurrency = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '1',
  10,
)

if (!lotIdArg && !keywordArg && !isBatch) {
  console.error('--lotId=..., --keyword=... 또는 --batch 필수')
  process.exit(1)
}

// ── 타입 ──
interface LotRow {
  id: string
  name: string
  address: string
}

interface WebSummaryRow {
  content: string // web_sources.ai_summary (eval script이 content 필드를 참조하므로 동일 키 유지)
}

interface ReviewRow {
  overall_score: number
  entry_score: number
  space_score: number
  passage_score: number
  exit_score: number
  comment: string | null
}

type AiSummaryResult = LotSummaryResult

// ── 대상 주차장 해결 ──
function resolveLots(): LotRow[] {
  if (lotIdArg) {
    return d1Query<LotRow>(
      `SELECT id, name, address FROM parking_lots WHERE id = '${esc(lotIdArg)}'`,
    )
  }
  if (isBatch) {
    // 유효한 web_sources.ai_summary가 하나라도 있으면 처리 대상
    return d1Query<LotRow>(`
      SELECT p.id, p.name, p.address
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE (s.ai_summary IS NULL OR s.ai_summary = '')
        AND (
          SELECT COUNT(*) FROM web_sources w
          WHERE w.parking_lot_id = p.id
            AND w.ai_summary IS NOT NULL AND w.ai_summary != ''
        ) >= ${minSources}
      ORDER BY COALESCE(s.final_score, 0) DESC
      LIMIT ${batchLimit}
    `)
  }
  const words = keywordArg!
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 1)
  const conds = words
    .map((w) => {
      const like = `%${esc(w)}%`
      return `(name LIKE '${like}' OR address LIKE '${like}' OR poi_tags LIKE '${like}')`
    })
    .join(' AND ')
  return d1Query<LotRow>(`SELECT id, name, address FROM parking_lots WHERE ${conds} LIMIT 20`)
}

// ── 소스 수집 ──
/**
 * lot 마다 D1 을 3번 치던 것을 대상 전체에 대해 3번으로 줄였다.
 * --remote 에서 d1Query 는 호출마다 wrangler 프로세스를 띄우므로(≈3초),
 * 585곳이면 읽기만으로 1,755회 ≈ 90분이 든다. 백필 규모에서는 성립하지 않는 구조다.
 */
interface WebRowWithLot extends WebSummaryRow {
  parking_lot_id: string
}
interface ReviewRowWithLot extends ReviewRow {
  parking_lot_id: string
}

const WEB_PER_LOT = 30
const REVIEW_PER_LOT = 20
const SEED_PER_LOT = 10

const webByLot = new Map<string, WebSummaryRow[]>()
const reviewsByLot = new Map<string, ReviewRow[]>()
const seedsByLot = new Map<string, ReviewRow[]>()

function push<T>(map: Map<string, T[]>, key: string, row: T, cap: number): void {
  const arr = map.get(key) ?? []
  if (arr.length < cap) arr.push(row)
  map.set(key, arr)
}

function prefetchSources(lots: LotRow[]): void {
  if (lots.length === 0) return
  const inList = lots.map((l) => `'${esc(l.id)}'`).join(',')

  // 정보 모음 사이트(경쟁 애그리게이터)는 후기가 아니라 공공데이터 재배포다.
  // 2026-09-03 실측: 요약을 가진 행 2,794건이 그대로 입력에 섞이고 있었다.
  const web = d1Query<WebRowWithLot>(
    `SELECT parking_lot_id, ai_summary AS content
     FROM web_sources
     WHERE parking_lot_id IN (${inList})
       AND ai_summary IS NOT NULL
       AND ai_summary != ''
       AND filter_v2_reason IS NOT 'aggregator_site'
       AND relevance_score >= 40
     ORDER BY parking_lot_id, relevance_score DESC`,
  )
  for (const row of web) push(webByLot, row.parking_lot_id, { content: row.content }, WEB_PER_LOT)

  // 시드 리뷰(is_seed=1)는 우리가 넣은 것이라 '이용자 후기'로 취급하면 안 된다.
  // 실사용자 리뷰를 먼저, 그다음 시드를 채운다 — 프롬프트에서 둘을 구분해 무게를 다르게 준다.
  const reviews = d1Query<ReviewRowWithLot & { is_seed: number }>(
    `SELECT parking_lot_id, is_seed,
            overall_score, entry_score, space_score, passage_score, exit_score, comment
     FROM user_reviews
     WHERE parking_lot_id IN (${inList})
     ORDER BY parking_lot_id, created_at DESC`,
  )
  for (const row of reviews) {
    const { parking_lot_id, is_seed, ...rest } = row
    if (is_seed === 1) push(seedsByLot, parking_lot_id, rest, SEED_PER_LOT)
    else push(reviewsByLot, parking_lot_id, rest, REVIEW_PER_LOT)
  }
}

function sourcesFor(lotId: string): {
  web: WebSummaryRow[]
  reviews: ReviewRow[]
  seedReviews: ReviewRow[]
} {
  const web = webByLot.get(lotId) ?? []
  const realReviews = reviewsByLot.get(lotId) ?? []
  const seedReviews = seedsByLot.get(lotId) ?? []
  // 리뷰가 있으면 웹 요약 수를 깎아 이용자 신호가 묻히지 않게 한다 (위 기준 참조)
  const quota = webQuotaFor(realReviews.length)
  return { web: web.slice(0, quota), reviews: realReviews, seedReviews }
}

// ── Claude CLI 서브에이전트 호출 ──
async function callClaude(userPrompt: string): Promise<AiSummaryResult> {
  const proc = Bun.spawn(
    [
      'claude',
      '-p',
      userPrompt,
      '--system-prompt',
      LOT_SUMMARY_SYSTEM_PROMPT,
      '--model',
      'claude-haiku-4-5-20251001',
      '--output-format',
      'text',
      '--dangerously-skip-permissions',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )

  const text = (await new Response(proc.stdout).text()).trim()
  const jsonText = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(jsonText) as AiSummaryResult
}

// ── 품질 가드 ──
/**
 * 워커(`src/server/crawlers/lot-summary-batch.ts`)와 동일한 판정을 백필 경로에도 적용한다.
 *
 * 한쪽에만 가드가 있으면 그쪽이 거부하는 요약이 다른 쪽으로 그대로 들어간다.
 * `summary-guard.ts` 주석이 기록한 사고가 정확히 그 구조였다 —
 * 재생성 경로에는 가드가 있었으나 신규 적재 경로에 없어 오염이 계속 유입됐다.
 * 백필은 회당 수천 건을 쓰므로 가드 없이 돌리면 그 사고를 대규모로 재현한다.
 */
type ValidationOutcome = { ok: true; value: AiSummaryResult } | { ok: false; reason: string }

function validateResult(result: AiSummaryResult): ValidationOutcome {
  const summary = result.summary?.trim()
  if (!summary) return { ok: false, reason: 'empty' }
  if (summary.length < MIN_LOT_SUMMARY_LENGTH) {
    return { ok: false, reason: `too_short:${summary.length}` }
  }

  const pollution = detectSummaryPollution(summary)
  if (pollution) return { ok: false, reason: pollution }

  // 팁이 오염돼도 요약 전체를 버리지 않고 해당 팁만 떨어뜨린다 (워커와 동일).
  const tip = (value: string | null | undefined): string | null => {
    const t = value?.trim()
    if (!t || t === 'null') return null
    return detectSummaryPollution(t) ? null : t
  }

  return {
    ok: true,
    value: {
      summary,
      tip_pricing: tip(result.tip_pricing),
      tip_visit: tip(result.tip_visit),
      tip_alternative: tip(result.tip_alternative),
    },
  }
}

// ── DB 저장 ──
/**
 * 행마다 wrangler 를 띄우지 않는다. 생성되는 대로 SQL 파일에 append 하고 끝에 --file 로
 * 한 번에 적용한다. 중간에 죽어도 그때까지의 결과가 파일에 남는다.
 * 파일은 data/ 에 남겨 두어 적용 전(--no-apply)이나 적용 후에 검토할 수 있게 한다.
 */
const sqlOutPath = (() => {
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return `data/lot-summary-backfill-${ts}.sql`
})()
let queuedStatements = 0

function upsertSql(lotId: string, result: AiSummaryResult): string {
  return `INSERT INTO parking_lot_stats (
  parking_lot_id,
  ai_summary, ai_summary_updated_at,
  ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_tip_updated_at,
  ai_summary_stale
) VALUES (
  '${esc(lotId)}',
  '${esc(result.summary)}', datetime('now'),
  ${result.tip_pricing ? `'${esc(result.tip_pricing)}'` : 'NULL'},
  ${result.tip_visit ? `'${esc(result.tip_visit)}'` : 'NULL'},
  ${result.tip_alternative ? `'${esc(result.tip_alternative)}'` : 'NULL'},
  datetime('now'),
  0
)
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary,
  ai_summary_updated_at = excluded.ai_summary_updated_at,
  ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit,
  ai_tip_alternative = excluded.ai_tip_alternative,
  ai_tip_updated_at = excluded.ai_tip_updated_at,
  ai_summary_stale = 0;
`
}

function queueSave(lotId: string, result: AiSummaryResult): void {
  appendFileSync(sqlOutPath, upsertSql(lotId, result))
  queuedStatements++
}

function applyQueued(): void {
  if (queuedStatements === 0) {
    console.log('\n적용할 SQL 없음')
    return
  }
  console.log(`\nSQL ${queuedStatements}건 → ${sqlOutPath}`)
  if (noApply) {
    console.log('--no-apply: D1 에 적용하지 않음. 검토 후 다음으로 적용:')
    console.log(`  bunx wrangler d1 execute parking-db --remote --file="${sqlOutPath}"`)
    return
  }
  d1ExecFile(sqlOutPath)
  console.log('D1 적용 완료')
}

// ── 동시성 제한 실행 ──
async function processWithConcurrency(
  lots: LotRow[],
  process: (lot: LotRow) => Promise<AiSummaryResult | null>,
  limit: number,
): Promise<Array<{ lot: LotRow; result: AiSummaryResult | null }>> {
  const results: Array<{ lot: LotRow; result: AiSummaryResult | null }> = []
  const queue = [...lots]
  const running: Promise<void>[] = []

  const runNext = async (): Promise<void> => {
    const lot = queue.shift()
    if (!lot) return
    const result = await process(lot)
    results.push({ lot, result })
  }

  while (queue.length > 0 || running.length > 0) {
    while (running.length < limit && queue.length > 0) {
      const p = runNext().then(() => {
        running.splice(running.indexOf(p), 1)
      })
      running.push(p)
    }
    if (running.length > 0) await Promise.race(running)
  }

  return results
}

// ── Main ──
async function main() {
  const lots = resolveLots()
  if (lots.length === 0) {
    console.error('매칭된 주차장 없음')
    process.exit(1)
  }

  if (isBatch) {
    console.log(
      `=== 배치 요약 생성 === (limit=${batchLimit}, concurrency=${concurrency}, ${isDryRun ? 'DRY-RUN' : 'WRITE'})`,
    )
  }
  console.log(`대상 ${lots.length}개`)
  prefetchSources(lots)

  // eval용 배치 데이터 수집
  const batchData: Array<{
    id: string
    name: string
    address: string
    web_sources: WebSummaryRow[]
    reviews: ReviewRow[]
  }> = []
  const resultsData: Array<AiSummaryResult & { id: string }> = []

  let generated = 0
  let skipped = 0
  let rejected = 0
  const rejectReasons = new Map<string, number>()

  const processLot = async (lot: LotRow): Promise<AiSummaryResult | null> => {
    const { web, reviews, seedReviews } = sourcesFor(lot.id)
    console.log(
      `\n▶ ${lot.name} (${lot.id}) — web_summary ${web.length}건, review ${reviews.length}건`,
    )

    if (web.length === 0) {
      console.log('  web_sources.ai_summary 없음, 건너뜀')
      skipped++
      return null
    }

    if (isSave) {
      batchData.push({
        id: lot.id,
        name: lot.name,
        address: lot.address,
        web_sources: web,
        reviews,
      })
    }

    const userPrompt = buildLotSummaryUserPrompt(lot, web, reviews, seedReviews)

    if (isDryRun) {
      console.log('  [dry-run] 프롬프트 길이:', userPrompt.length, 'chars')
      console.log('  프롬프트 미리보기:\n' + userPrompt.slice(0, 400))
      generated++
      return null
    }

    let result: AiSummaryResult
    try {
      result = await callClaude(userPrompt)
    } catch (e) {
      console.error('  Claude 호출 실패:', e)
      skipped++
      return null
    }

    const outcome = validateResult(result)
    if (!outcome.ok) {
      console.log(`  ✗ 가드 거부 (${outcome.reason}) — 저장하지 않음`)
      console.log('    ', result.summary?.slice(0, 120) ?? '(빈 요약)')
      rejected++
      rejectReasons.set(outcome.reason, (rejectReasons.get(outcome.reason) ?? 0) + 1)
      return null
    }
    const clean = outcome.value

    console.log('  summary:', clean.summary)
    if (clean.tip_pricing) console.log('  tip_pricing:', clean.tip_pricing)
    if (clean.tip_visit) console.log('  tip_visit:', clean.tip_visit)
    if (clean.tip_alternative) console.log('  tip_alternative:', clean.tip_alternative)

    queueSave(lot.id, clean)
    generated++
    return clean
  }

  if (concurrency > 1) {
    const outcomes = await processWithConcurrency(lots, processLot, concurrency)
    for (const { lot, result } of outcomes) {
      if (result && isSave) resultsData.push({ id: lot.id, ...result })
    }
  } else {
    for (const lot of lots) {
      const result = await processLot(lot)
      if (result && isSave) resultsData.push({ id: lot.id, ...result })
    }
  }

  if (isSave && !isDryRun) {
    await Bun.write('summary_batch.json', JSON.stringify(batchData, null, 2))
    await Bun.write('summary_results.json', JSON.stringify(resultsData, null, 2))
    console.log('\n  → summary_batch.json, summary_results.json 저장 완료')
  }

  if (!isDryRun) applyQueued()

  console.log(`\n=== 완료 === 생성 ${generated}건, 건너뜀 ${skipped}건, 가드 거부 ${rejected}건`)
  if (rejectReasons.size > 0) {
    const total = generated + rejected
    const rate = total > 0 ? ((rejected / total) * 100).toFixed(1) : '0.0'
    console.log(`  거부율 ${rate}% (생성+거부 ${total}건 기준)`)
    for (const [reason, count] of [...rejectReasons].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason}: ${count}건`)
    }
    console.log('  거부율이 높으면 확장하기 전에 프롬프트나 입력 품질을 먼저 본다.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
