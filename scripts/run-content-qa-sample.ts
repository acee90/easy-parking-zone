/**
 * AI 콘텐츠 QA 샘플 검수 스크립트
 *
 * 2단계 실행:
 *   1) 데이터 fetch (remote D1 단 1회 쿼리):
 *      bun run scripts/run-content-qa-sample.ts --fetch --remote
 *      → data/qa-raw-sample.json 저장
 *
 *   2) 로컬 QA 체크 (remote 호출 없음):
 *      bun run scripts/run-content-qa-sample.ts --check
 *      → data/qa-sample-{timestamp}.md + .json 저장
 *
 *   한 번에 (로컬 DB 사용):
 *      bun run scripts/run-content-qa-sample.ts --fetch --check
 *
 * 옵션:
 *   --limit=50       샘플 수 (기본값: 50)
 *   --raw=<path>     fetch 결과 JSON 경로 (기본: data/qa-raw-sample.json)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { d1Query } from './lib/d1'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── CLI ──
const args = process.argv.slice(2)
const doFetch = args.includes('--fetch')
const doCheck = args.includes('--check')
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '50', 10)
const rawPath = resolve(
  __dirname,
  '../',
  args.find((a) => a.startsWith('--raw='))?.split('=')[1] ?? 'data/qa-raw-sample.json',
)

if (!doFetch && !doCheck) {
  console.error('--fetch 또는 --check 중 하나 이상 필요')
  console.error('  예: bun run scripts/run-content-qa-sample.ts --fetch --remote')
  console.error('      bun run scripts/run-content-qa-sample.ts --check')
  process.exit(1)
}

// ── 타입 ──
interface LotRow {
  id: string
  name: string
  address: string
  type: string
  is_free: number
  base_fee: number | null
  total_spaces: number
  weekday_start: string | null
  weekday_end: string | null
  ai_summary: string | null
  ai_tip_pricing: string | null
  ai_tip_visit: string | null
  ai_tip_alternative: string | null
  final_score: number | null
  source_count: number
}

// 'NA' = 미생성 (아직 생성 안 된 필드, 품질 문제 아님)
type Verdict = 'PASS' | 'FIX' | 'REGEN' | 'DROP' | 'NA'

interface FieldResult {
  verdict: Verdict
  reasons: string[]
}

interface QaRow {
  lot_id: string
  lot_name: string
  source_density: 'high' | 'medium' | 'low'
  summary_result: Verdict
  pricing_result: Verdict
  visit_result: Verdict
  alternative_result: Verdict
  failure_reasons: string[]
  action: 'keep' | 'edit' | 'regenerate' | 'hide' | 'generate_tips'
}

// ── 금지 표현 목록 (docs/design-docs/ai-content-qa-standard.md 기준) ──
const BANNED_EXPRESSIONS = [
  '무조건',
  '반드시 비어 있',
  '100%',
  '완전 무료',
  '항상 여유',
  '절대',
  '최고의',
  '가장 저렴',
  '가장 가까운',
  '확실히',
  '걱정 없이',
  '주말에도 넉넉',
  '피크타임에도 문제없',
]

const TEMPLATE_PATTERNS = [
  '방문 목적에 맞게 이용하면 좋습니다',
  '미리 확인하시는 것을 권장합니다',
  '사용자 리뷰를 참고하시기 바랍니다',
  '실제 이용 전 확인해 보시기 바랍니다',
  '다양한 이용객들의 후기가 있습니다',
]

// ── 자동 검사 ──
function checkBannedExpressions(text: string): string[] {
  return BANNED_EXPRESSIONS.filter((expr) => text.includes(expr)).map(
    (expr) => `금지 표현: "${expr}"`,
  )
}

function checkTemplatePatterns(text: string): string[] {
  return TEMPLATE_PATTERNS.filter((p) => text.includes(p)).map((p) => `템플릿 문장: "${p}"`)
}

function checkIsFreeConflict(lot: LotRow, text: string): string[] {
  const issues: string[] = []
  if (
    !lot.is_free &&
    (text.includes('완전 무료') || text.includes('무료주차') || /무료\s*주차/.test(text))
  ) {
    issues.push(`공식 데이터 충돌: is_free=false 인데 무료 표현`)
  }
  if (lot.is_free && (text.includes('요금 부담') || text.includes('비싼 편'))) {
    issues.push(`공식 데이터 충돌: is_free=true 인데 유료 표현`)
  }
  return issues
}

function checkOperatingHoursConflict(lot: LotRow, text: string): string[] {
  const issues: string[] = []
  if (!lot.weekday_start && !lot.weekday_end && text.includes('24시간')) {
    issues.push(`공식 데이터 충돌: 운영시간 데이터 없는데 "24시간" 표현`)
  }
  if (lot.weekday_end && text.includes('언제든 이용')) {
    issues.push(`공식 데이터 충돌: 종료시간 있는데 "언제든 이용" 표현`)
  }
  return issues
}

function checkSpecificity(lot: LotRow, text: string): string[] {
  const nameWords = lot.name
    .replace(/주차장$/, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  const hasSpecificRef = nameWords.some((word) => text.includes(word))
  if (!hasSpecificRef && text.length < 40) {
    return [`특이성 부족: 주차장명 미포함 + 짧은 텍스트 (일반론 의심)`]
  }
  return []
}

function assessField(lot: LotRow, fieldText: string | null, fieldName: string): FieldResult {
  // 미생성 필드는 품질 문제가 아닌 별도 상태로 처리
  if (!fieldText || fieldText.trim() === '') {
    return { verdict: 'NA', reasons: [] }
  }

  const reasons = [
    ...checkBannedExpressions(fieldText),
    ...checkTemplatePatterns(fieldText),
    ...checkIsFreeConflict(lot, fieldText),
    ...checkOperatingHoursConflict(lot, fieldText),
  ]

  if (reasons.some((r) => r.startsWith('공식 데이터 충돌'))) return { verdict: 'DROP', reasons }
  if (reasons.some((r) => r.startsWith('템플릿 문장'))) return { verdict: 'REGEN', reasons }
  if (reasons.some((r) => r.startsWith('금지 표현'))) return { verdict: 'FIX', reasons }

  if (fieldName === 'summary') {
    const spec = checkSpecificity(lot, fieldText)
    if (spec.length > 0) return { verdict: 'REGEN', reasons: spec }
  }

  return { verdict: 'PASS', reasons: [] }
}

function verdictToAction(
  results: [FieldResult, FieldResult, FieldResult, FieldResult],
): 'keep' | 'edit' | 'regenerate' | 'hide' | 'generate_tips' {
  const [sr, pr, vr, ar] = results
  const nonNa = results.filter((r) => r.verdict !== 'NA')

  // 생성된 필드 중 실제 품질 문제가 있는 경우만 부정 판정
  if (nonNa.some((r) => r.verdict === 'DROP')) return 'hide'
  if (nonNa.some((r) => r.verdict === 'REGEN')) return 'regenerate'
  if (nonNa.some((r) => r.verdict === 'FIX')) return 'edit'

  // summary는 PASS인데 팁이 모두 미생성 → 팁 생성 필요
  if (sr.verdict === 'PASS' && pr.verdict === 'NA' && vr.verdict === 'NA' && ar.verdict === 'NA')
    return 'generate_tips'

  return 'keep'
}

function densityLabel(count: number): 'high' | 'medium' | 'low' {
  if (count >= 5) return 'high'
  if (count >= 2) return 'medium'
  return 'low'
}

// ── Phase 1: Fetch ──
function fetchRawSample() {
  const highN = Math.round(limit * 0.4)
  const medN = Math.round(limit * 0.4)
  const lowN = limit - highN - medN

  const base = `
    SELECT
      p.id, p.name, p.address, p.type,
      p.is_free, p.base_fee, p.total_spaces,
      p.weekday_start, p.weekday_end,
      s.ai_summary, s.ai_tip_pricing, s.ai_tip_visit, s.ai_tip_alternative,
      s.final_score,
      COUNT(w.id) AS source_count
    FROM parking_lots p
    JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    LEFT JOIN web_sources w ON w.parking_lot_id = p.id
    WHERE s.ai_summary IS NOT NULL AND s.ai_summary != ''
    GROUP BY p.id
  `

  console.log('remote D1에서 bulk 쿼리 실행 중 (1회)...')
  const high = d1Query<LotRow>(`${base} HAVING source_count >= 5 ORDER BY RANDOM() LIMIT ${highN}`)
  const med = d1Query<LotRow>(
    `${base} HAVING source_count BETWEEN 2 AND 4 ORDER BY RANDOM() LIMIT ${medN}`,
  )
  const low = d1Query<LotRow>(`${base} HAVING source_count = 1 ORDER BY RANDOM() LIMIT ${lowN}`)

  const all = [...high, ...med, ...low]
  writeFileSync(rawPath, JSON.stringify(all, null, 2), 'utf-8')
  console.log(`✅ ${all.length}개 fetch 완료 → ${rawPath}`)
  return all
}

// ── Phase 2: Check ──
function runChecks(lots: LotRow[]): QaRow[] {
  return lots.map((lot) => {
    const sr = assessField(lot, lot.ai_summary, 'summary')
    const pr = assessField(lot, lot.ai_tip_pricing, 'pricing')
    const vr = assessField(lot, lot.ai_tip_visit, 'visit')
    const ar = assessField(lot, lot.ai_tip_alternative, 'alternative')

    return {
      lot_id: lot.id,
      lot_name: lot.name,
      source_density: densityLabel(lot.source_count),
      summary_result: sr.verdict,
      pricing_result: pr.verdict,
      visit_result: vr.verdict,
      alternative_result: ar.verdict,
      failure_reasons: [...new Set([...sr.reasons, ...pr.reasons, ...vr.reasons, ...ar.reasons])],
      action: verdictToAction([sr, pr, vr, ar]),
    }
  })
}

// ── 마크다운 렌더링 ──
function renderMarkdown(rows: QaRow[], lots: LotRow[]): string {
  // 운영 게이트: 생성된 summary 기준으로만 PASS+FIX 계산
  const summaryAssessed = rows.filter((r) => r.summary_result !== 'NA')
  const summaryPassOrFix = summaryAssessed.filter((r) =>
    ['PASS', 'FIX'].includes(r.summary_result),
  ).length
  const conflictCount = rows.filter((r) =>
    r.failure_reasons.some((reason) => reason.includes('공식 데이터 충돌')),
  ).length
  const dropCount = rows.filter((r) => r.action === 'hide').length
  const regenCount = rows.filter((r) => r.action === 'regenerate').length
  const editCount = rows.filter((r) => r.action === 'edit').length
  const keepCount = rows.filter((r) => r.action === 'keep').length
  const genTipsCount = rows.filter((r) => r.action === 'generate_tips').length
  const n = rows.length

  const passOrFixRate = summaryAssessed.length
    ? ((summaryPassOrFix / summaryAssessed.length) * 100).toFixed(1)
    : '0.0'
  const conflictRate = ((conflictCount / n) * 100).toFixed(1)
  const dropRate = ((dropCount / n) * 100).toFixed(1)
  const gatePass =
    parseFloat(passOrFixRate) >= 80 && parseFloat(conflictRate) <= 5 && parseFloat(dropRate) <= 20

  const tipsNaCount = rows.filter(
    (r) => r.pricing_result === 'NA' || r.visit_result === 'NA' || r.alternative_result === 'NA',
  ).length

  const lines: string[] = [
    `# AI 콘텐츠 QA 샘플 검수 결과`,
    ``,
    `생성 일시: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `샘플 수: ${n}개 (고밀도 ${rows.filter((r) => r.source_density === 'high').length} / 중밀도 ${rows.filter((r) => r.source_density === 'medium').length} / 저밀도 ${rows.filter((r) => r.source_density === 'low').length})`,
    ``,
    `> **참고**: NA = 미생성 (품질 문제 아님, 팁 생성 파이프라인 미실행)`,
    ``,
    `## 운영 게이트 (생성된 콘텐츠 기준)`,
    ``,
    `| 기준 | 결과 | 상태 |`,
    `|---|---|---|`,
    `| summary PASS+FIX 비율 ≥ 80% | ${passOrFixRate}% (${summaryPassOrFix}/${summaryAssessed.length}) | ${parseFloat(passOrFixRate) >= 80 ? '✅ OK' : '❌ FAIL'} |`,
    `| 공식 데이터 충돌률 ≤ 5% | ${conflictRate}% (${conflictCount}/${n}) | ${parseFloat(conflictRate) <= 5 ? '✅ OK' : '❌ FAIL'} |`,
    `| DROP 비율 ≤ 20% | ${dropRate}% (${dropCount}/${n}) | ${parseFloat(dropRate) <= 20 ? '✅ OK' : '❌ FAIL'} |`,
    ``,
    `**종합: ${gatePass ? '✅ PASS — 다음 단계(300개 확대) 검토 가능' : '❌ FAIL — 프롬프트/기준 재조정 필요'}**`,
    ``,
    `## 액션별 요약`,
    ``,
    `| 액션 | 수 | 비율 | 의미 |`,
    `|---|---|---|---|`,
    `| keep | ${keepCount} | ${((keepCount / n) * 100).toFixed(1)}% | 생성 완료, 품질 OK |`,
    `| generate_tips | ${genTipsCount} | ${((genTipsCount / n) * 100).toFixed(1)}% | summary OK, 팁 3종 아직 미생성 |`,
    `| edit (FIX) | ${editCount} | ${((editCount / n) * 100).toFixed(1)}% | 일부 표현 수정 필요 |`,
    `| regenerate (REGEN) | ${regenCount} | ${((regenCount / n) * 100).toFixed(1)}% | 재생성 필요 |`,
    `| hide (DROP) | ${dropCount} | ${((dropCount / n) * 100).toFixed(1)}% | 공식 데이터 충돌 등 미노출 |`,
    ``,
    `> 팁 1종 이상 미생성: **${tipsNaCount}건 (${((tipsNaCount / n) * 100).toFixed(1)}%)** — generate-lot-summary.ts 로 팁 생성 필요`,
    ``,
    `## 상세 결과`,
    ``,
    `| lot_id | lot_name | density | summary | pricing | visit | alternative | action | 사유 |`,
    `|---|---|---|---|---|---|---|---|---|`,
  ]

  for (const row of rows) {
    const reasons = row.failure_reasons.join('; ').slice(0, 80) || '-'
    lines.push(
      `| ${row.lot_id} | ${row.lot_name} | ${row.source_density} | ${row.summary_result} | ${row.pricing_result} | ${row.visit_result} | ${row.alternative_result} | ${row.action} | ${reasons} |`,
    )
  }

  lines.push(``, `## 수동 검수 필요 항목 원문 (hide/regenerate/edit)`, ``)

  const lotMap = new Map(lots.map((l) => [l.id, l]))
  for (const row of rows.filter((r) => ['hide', 'regenerate', 'edit'].includes(r.action))) {
    const lot = lotMap.get(row.lot_id)
    if (!lot) continue
    lines.push(
      `### [${row.action.toUpperCase()}] ${lot.name} (${lot.id})`,
      ``,
      `- **주소**: ${lot.address}`,
      `- **유형**: ${lot.type} | is_free=${lot.is_free} | 면수=${lot.total_spaces} | 소스 ${lot.source_count}개`,
      `- **운영**: ${lot.weekday_start ?? '?'} ~ ${lot.weekday_end ?? '?'}`,
      ``,
      `**요약**: ${lot.ai_summary ?? '없음'}`,
      ``,
      `**팁-요금**: ${lot.ai_tip_pricing ?? '없음'}`,
      ``,
      `**팁-방문**: ${lot.ai_tip_visit ?? '없음'}`,
      ``,
      `**팁-대안**: ${lot.ai_tip_alternative ?? '없음'}`,
      ``,
      `**실패 사유**: ${row.failure_reasons.join(' / ') || '-'}`,
      ``,
      `---`,
      ``,
    )
  }

  return lines.join('\n')
}

// ── 메인 ──
async function main() {
  let lots: LotRow[]

  if (doFetch) {
    lots = fetchRawSample()
  } else {
    if (!existsSync(rawPath)) {
      console.error(`raw 파일 없음: ${rawPath}`)
      console.error(`먼저 --fetch --remote 로 데이터를 받아오세요.`)
      process.exit(1)
    }
    lots = JSON.parse(readFileSync(rawPath, 'utf-8')) as LotRow[]
    console.log(`로컬 파일에서 ${lots.length}개 로드: ${rawPath}`)
  }

  if (!doCheck) return

  console.log(`QA 체크 실행 중...`)
  const qaRows = runChecks(lots)

  const timestamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[^0-9]/g, '')
    .slice(0, 12)
  const mdPath = resolve(__dirname, `../data/qa-sample-${timestamp}.md`)
  const jsonPath = resolve(__dirname, `../data/qa-sample-${timestamp}.json`)

  writeFileSync(mdPath, renderMarkdown(qaRows, lots), 'utf-8')
  writeFileSync(jsonPath, JSON.stringify(qaRows, null, 2), 'utf-8')

  const summaryAssessed = qaRows.filter((r) => r.summary_result !== 'NA')
  const summaryPassOrFix = summaryAssessed.filter((r) =>
    ['PASS', 'FIX'].includes(r.summary_result),
  ).length

  console.log(`\n✅ 결과 저장:`)
  console.log(`  MD  : ${mdPath}`)
  console.log(`  JSON: ${jsonPath}`)
  console.log(
    `\n  summary PASS+FIX: ${summaryPassOrFix}/${summaryAssessed.length} (${summaryAssessed.length ? ((summaryPassOrFix / summaryAssessed.length) * 100).toFixed(1) : 0}%)`,
  )
  console.log(
    `  keep=${qaRows.filter((r) => r.action === 'keep').length}  generate_tips=${qaRows.filter((r) => r.action === 'generate_tips').length}  edit=${qaRows.filter((r) => r.action === 'edit').length}  regen=${qaRows.filter((r) => r.action === 'regenerate').length}  hide=${qaRows.filter((r) => r.action === 'hide').length}`,
  )
}

main()
