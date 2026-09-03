/**
 * 주차장 AI 요약·팁 일괄 생성 — web_sources.ai_summary 기반
 *
 * Usage:
 *   bun run scripts/generate-lot-summary.ts --lotId=KA-1234567890
 *   bun run scripts/generate-lot-summary.ts --keyword="스타필드 위례"
 *   bun run scripts/generate-lot-summary.ts --batch --limit=50 --dry-run
 *   bun run scripts/generate-lot-summary.ts --batch --limit=100 --remote --concurrency=5
 *   bun run scripts/generate-lot-summary.ts --batch --limit=10 --remote --save
 *
 * 출력: parking_lot_stats.ai_summary / ai_tip_pricing / ai_tip_visit / ai_tip_alternative
 * --save 플래그: summary_batch.json + summary_results.json (eval용)
 */

import { webQuotaFor } from '../src/server/crawlers/lib/lot-summary-input'
import {
  buildLotSummaryUserPrompt,
  LOT_SUMMARY_SYSTEM_PROMPT,
  type LotSummaryResult,
} from '../src/server/crawlers/lib/lot-summary-prompt'
import { d1Execute, d1Query } from './lib/d1'
import { esc } from './lib/sql-flush'

// ── CLI ──
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
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
        AND EXISTS (
          SELECT 1 FROM web_sources w
          WHERE w.parking_lot_id = p.id
            AND w.ai_summary IS NOT NULL AND w.ai_summary != ''
        )
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
function fetchSources(lotId: string): {
  web: WebSummaryRow[]
  reviews: ReviewRow[]
  seedReviews: ReviewRow[]
} {
  const web = d1Query<WebSummaryRow>(
    `SELECT ai_summary AS content
     FROM web_sources
     WHERE parking_lot_id = '${esc(lotId)}'
       AND ai_summary IS NOT NULL
       AND ai_summary != ''
       -- 정보 모음 사이트(경쟁 애그리게이터)는 후기가 아니라 공공데이터 재배포다.
       -- 2026-09-03 실측: 요약을 가진 행 2,794건이 그대로 입력에 섞이고 있었다.
       AND filter_v2_reason IS NOT 'aggregator_site'
       AND relevance_score >= 40
     ORDER BY relevance_score DESC
     LIMIT 30`,
  )
  // 시드 리뷰(is_seed=1)는 우리가 넣은 것이라 '이용자 후기'로 취급하면 안 된다.
  // 실사용자 리뷰를 먼저, 그다음 시드를 채운다 — 프롬프트에서 둘을 구분해 무게를 다르게 준다.
  const realReviews = d1Query<ReviewRow>(
    `SELECT overall_score, entry_score, space_score, passage_score, exit_score, comment
     FROM user_reviews
     WHERE parking_lot_id = '${esc(lotId)}' AND is_seed = 0
     ORDER BY created_at DESC
     LIMIT 20`,
  )
  const seedReviews = d1Query<ReviewRow>(
    `SELECT overall_score, entry_score, space_score, passage_score, exit_score, comment
     FROM user_reviews
     WHERE parking_lot_id = '${esc(lotId)}' AND is_seed = 1
     ORDER BY created_at DESC
     LIMIT 10`,
  )
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

// ── DB 저장 ──
function saveToDb(lotId: string, result: AiSummaryResult): void {
  d1Execute(
    `INSERT INTO parking_lot_stats (
       parking_lot_id,
       ai_summary, ai_summary_updated_at,
       ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_tip_updated_at
     ) VALUES (
       '${esc(lotId)}',
       '${esc(result.summary)}', datetime('now'),
       ${result.tip_pricing ? `'${esc(result.tip_pricing)}'` : 'NULL'},
       ${result.tip_visit ? `'${esc(result.tip_visit)}'` : 'NULL'},
       ${result.tip_alternative ? `'${esc(result.tip_alternative)}'` : 'NULL'},
       datetime('now')
     )
     ON CONFLICT(parking_lot_id) DO UPDATE SET
       ai_summary = excluded.ai_summary,
       ai_summary_updated_at = excluded.ai_summary_updated_at,
       ai_tip_pricing = excluded.ai_tip_pricing,
       ai_tip_visit = excluded.ai_tip_visit,
       ai_tip_alternative = excluded.ai_tip_alternative,
       ai_tip_updated_at = excluded.ai_tip_updated_at`,
  )
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

  const processLot = async (lot: LotRow): Promise<AiSummaryResult | null> => {
    const { web, reviews, seedReviews } = fetchSources(lot.id)
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

    console.log('  summary:', result.summary)
    if (result.tip_pricing) console.log('  tip_pricing:', result.tip_pricing)
    if (result.tip_visit) console.log('  tip_visit:', result.tip_visit)
    if (result.tip_alternative) console.log('  tip_alternative:', result.tip_alternative)

    saveToDb(lot.id, result)
    generated++
    return result
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

  console.log(`\n=== 완료 === 생성 ${generated}건, 건너뜀 ${skipped}건`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
