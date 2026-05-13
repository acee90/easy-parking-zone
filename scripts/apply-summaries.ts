/**
 * c안 정책으로 ai_summary 적용
 *
 * 이슈 #135: agent가 생성한 SQL을 무조건 적용하지 않고,
 * 기존 ai_summary와 비교하여 "더 좋아질 때만" UPDATE.
 * 짧거나 같으면 거부하고 JSON에 dump (다음 단계에서 재처리).
 *
 * 적용 기준:
 *   - new.length >= MIN_SUMMARY_LENGTH (200) 이고
 *   - new.length > old.length (또는 old가 없거나 200자 미만)
 *
 * Usage:
 *   bun run scripts/apply-summaries.ts --input data/top-sources-by-lot.sql
 *   bun run scripts/apply-summaries.ts --input data/top-sources-by-lot.sql --remote
 *   bun run scripts/apply-summaries.ts --input ... --rejected data/regen-rejected.json --output data/regen-applied.sql
 *   bun run scripts/apply-summaries.ts --input ... --lots-output data/regen-affected-lots.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { MIN_SUMMARY_LENGTH } from '../src/server/crawlers/lib/ai-filter'
import { d1ExecFile, d1Query, isRemote } from './lib/d1'

// ── CLI ──
const args = process.argv.slice(2)
function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(name)
  return idx >= 0 ? args[idx + 1] : defaultValue
}

const INPUT = getArg('--input', 'data/top-sources-by-lot.sql')
const REJECTED = getArg('--rejected', 'data/regen-rejected.json')
const OUTPUT_SQL = getArg('--output', 'data/regen-applied.sql')
const LOTS_OUTPUT = getArg('--lots-output', '')
const FAILED_OUTPUT = getArg('--failed-output', 'data/regen-failed.sql')
const APPLY = args.includes('--apply') // 명시적 --apply 없으면 SQL만 생성, DB 적용은 안함

// ── Types ──
interface Parsed {
  id: number
  newSummary: string
}

interface Rejection {
  id: number
  reason: 'too_short' | 'not_better' | 'parse_error' | 'chrome_detected' | 'too_long'
  old_len: number
  new_len: number
  old_summary?: string
  new_summary?: string
  matched_pattern?: string
}

// ── SQL 파싱 ──
// agent가 생성하는 형식:
//   UPDATE web_sources SET ai_summary = '...', ai_summary_updated_at = datetime('now') WHERE id = 123;
//
// 단일따옴표 이스케이프 ''는 ai_summary 본문에 들어있을 수 있음.
const SQL_PATTERN =
  /UPDATE\s+web_sources\s+SET\s+ai_summary\s*=\s*'((?:[^']|'')*)'\s*(?:,\s*ai_summary_updated_at\s*=\s*[^,]+)?\s+WHERE\s+id\s*=\s*(\d+)\s*;/gi

function parseSqlFile(filePath: string): { parsed: Parsed[]; errors: number } {
  const content = readFileSync(filePath, 'utf-8')
  const parsed: Parsed[] = []
  let errors = 0

  let match: RegExpExecArray | null
  // exec 루프: lastIndex 사용
  SQL_PATTERN.lastIndex = 0
  while ((match = SQL_PATTERN.exec(content)) !== null) {
    const rawSummary = match[1]
    const id = parseInt(match[2], 10)
    if (Number.isNaN(id)) {
      errors++
      continue
    }
    // SQL 이스케이프 해제: '' → '
    const newSummary = rawSummary.replace(/''/g, "'")
    parsed.push({ id, newSummary })
  }

  return { parsed, errors }
}

// ── 적용된 web_sources의 parking_lot_id 조회 ──
function fetchAffectedLotIds(ids: number[]): string[] {
  if (ids.length === 0) return []
  const CHUNK = 200
  const lotIdSet = new Set<string>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const idList = chunk.join(',')
    const rows = d1Query<{ parking_lot_id: string }>(
      `SELECT DISTINCT parking_lot_id FROM web_sources WHERE id IN (${idList}) AND parking_lot_id IS NOT NULL`,
    )
    for (const r of rows) lotIdSet.add(r.parking_lot_id)
  }
  return [...lotIdSet]
}

// ── 기존 ai_summary 일괄 조회 ──
function fetchExistingSummaries(ids: number[]): Map<number, string> {
  const result = new Map<number, string>()
  if (ids.length === 0) return result

  // 청크 단위로 IN 쿼리
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const idList = chunk.join(',')
    const rows = d1Query<{ id: number; ai_summary: string | null }>(
      `SELECT id, ai_summary FROM web_sources WHERE id IN (${idList})`,
    )
    for (const r of rows) {
      result.set(r.id, r.ai_summary ?? '')
    }
  }
  return result
}

// ── SQL 이스케이프 ──
function escSql(s: string): string {
  return s.replace(/'/g, "''")
}

// ── Chrome / boilerplate / 인젝션 패턴 ──
// agent가 본문 raw markdown을 그대로 복사한 케이스 차단.
// ai-summary-prompt.ts의 boilerplate 사양과 일치.
const CHROME_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'naver_blog_menu', re: /MY메뉴 열기|_My Menu|클립만들기|블로그 앱|내 상품 관리 NEW/ },
  { name: 'naver_blog_chrome', re: /이 블로그의 체크인|이 장소의 다른 글/ },
  { name: 'naver_blog_font_ctrl', re: /본문 폰트 크기 (조정|작게|크게)|본문 기타 기능/ },
  { name: 'naver_cafe_chrome', re: /홈 로그인하기|로그인이 필요합니다|useCafeId=false/ },
  { name: 'markdown_residue', re: /\]\(https?:\/\/m\. com\//i },
  { name: 'markdown_image', re: /!\[[^\]]*\]\(https?:/ },
  { name: 'markdown_header', re: /(?:^|\n)#{1,6} [^\n]+\n/ },
  { name: 'markdown_link_dump', re: /(?:\]\(https?:[^)]+\)[^.]{0,30}){3,}/ },
  { name: 'llm_injection', re: /OpenAI GPT|이 텍스트를 자동으로 처리|저작권 보호를 받습니다/ },
  { name: 'network_error', re: /로딩중입니다|네트워크 문제/ },
  { name: 'coupang_partners', re: /쿠팡 파트너스/ },
  {
    name: 'meta_only',
    re: /(정보를?\s*제공합니다|정보를?\s*확인할 수 있습니다|상세\s*정보를?\s*포함합니다|정책 변경 여부를?\s*확인)/,
  },
  { name: 'ai_disclosure', re: /(AI[가]? 분석|데이터에 따르면|본 페이지는 자동|AI 생성 콘텐츠)/ },
  { name: 'qa_template', re: /(Q\.\s*[^A]+A\.\s*)/ },
]

const MAX_SUMMARY_LENGTH = 800

function detectChrome(s: string): string | null {
  for (const { name, re } of CHROME_PATTERNS) {
    if (re.test(s)) return name
  }
  return null
}

// ── Main ──
function main() {
  console.log(`\n📝 c안 정책 적용 — ${isRemote ? 'remote' : 'local'} DB`)
  console.log(`  입력: ${INPUT}`)
  console.log(`  최소 길이: ${MIN_SUMMARY_LENGTH}자`)

  const inputPath = resolve(import.meta.dir, '..', INPUT)
  console.log(`\n  1. SQL 파일 파싱 중...`)
  const { parsed, errors } = parseSqlFile(inputPath)
  console.log(`     파싱: ${parsed.length}건, 에러: ${errors}건`)

  if (parsed.length === 0) {
    console.log('\n  ⚠️  파싱된 row 없음. 종료.')
    return
  }

  console.log(`\n  2. 기존 ai_summary 조회 중...`)
  const existing = fetchExistingSummaries(parsed.map((p) => p.id))
  console.log(`     조회: ${existing.size}건`)

  console.log(`\n  3. c안 정책 적용 (new > old, new >= ${MIN_SUMMARY_LENGTH}자)...`)

  const applied: Parsed[] = []
  const rejected: Rejection[] = []

  for (const p of parsed) {
    const old = existing.get(p.id) ?? ''
    const newLen = p.newSummary.length
    const oldLen = old.length

    if (newLen < MIN_SUMMARY_LENGTH) {
      rejected.push({
        id: p.id,
        reason: 'too_short',
        old_len: oldLen,
        new_len: newLen,
        old_summary: old.slice(0, 80),
        new_summary: p.newSummary.slice(0, 80),
      })
      continue
    }

    // chrome / boilerplate / 인젝션 패턴 검출 → 거부
    const chromeMatch = detectChrome(p.newSummary)
    if (chromeMatch) {
      rejected.push({
        id: p.id,
        reason: 'chrome_detected',
        old_len: oldLen,
        new_len: newLen,
        old_summary: old.slice(0, 80),
        new_summary: p.newSummary.slice(0, 80),
        matched_pattern: chromeMatch,
      })
      continue
    }

    // 너무 긴 summary → agent가 본문을 raw로 복사한 신호. 거부.
    if (newLen > MAX_SUMMARY_LENGTH) {
      rejected.push({
        id: p.id,
        reason: 'too_long',
        old_len: oldLen,
        new_len: newLen,
        old_summary: old.slice(0, 80),
        new_summary: p.newSummary.slice(0, 80),
      })
      continue
    }

    // old가 짧으면 (< MIN) 무조건 적용. 둘 다 충분히 길면 더 길 때만.
    const oldTooShort = oldLen < MIN_SUMMARY_LENGTH
    if (!oldTooShort && newLen <= oldLen) {
      rejected.push({
        id: p.id,
        reason: 'not_better',
        old_len: oldLen,
        new_len: newLen,
        old_summary: old.slice(0, 80),
        new_summary: p.newSummary.slice(0, 80),
      })
      continue
    }

    applied.push(p)
  }

  console.log(`     적용: ${applied.length}건`)
  console.log(`     거부: ${rejected.length}건`)
  if (rejected.length > 0) {
    const byReason = rejected.reduce(
      (acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }),
      {} as Record<string, number>,
    )
    for (const [reason, count] of Object.entries(byReason)) {
      console.log(`       ${reason}: ${count}건`)
    }
  }

  // 거부 리스트 dump
  const rejectedPath = resolve(import.meta.dir, '..', REJECTED)
  mkdirSync(dirname(rejectedPath), { recursive: true })
  writeFileSync(rejectedPath, JSON.stringify(rejected, null, 2), 'utf-8')
  console.log(`\n  4. 거부 리스트 저장: ${rejectedPath}`)

  // 실패 마킹 SQL 생성:
  //   NULL  → 미시도 (extract 대상)
  //   ''    → 시도했으나 실패 (extract 스킵)
  //   값 있음 → 정상 요약
  // too_short이고 기존 summary도 NULL인 row만 마킹 (not_better는 기존 summary가 충분하므로 제외)
  // too_short / chrome_detected / too_long 은 모두 "시도했으나 실패" — 재시도 방지 위해 빈 문자열로 마킹.
  // 단 기존 summary가 있으면(old_len > 0) 마킹하지 않음 (기존 값 보존).
  const failedToMark = rejected.filter(
    (r) =>
      r.old_len === 0 &&
      (r.reason === 'too_short' || r.reason === 'chrome_detected' || r.reason === 'too_long'),
  )
  if (failedToMark.length > 0) {
    const failedPath = resolve(import.meta.dir, '..', FAILED_OUTPUT)
    mkdirSync(dirname(failedPath), { recursive: true })
    const failedSql = failedToMark
      .map(
        (r) =>
          `UPDATE web_sources SET ai_summary = '', ai_summary_updated_at = datetime('now') WHERE id = ${r.id} AND (ai_summary IS NULL OR ai_summary = '') AND ai_summary_updated_at IS NULL;`,
      )
      .join('\n')
    writeFileSync(failedPath, failedSql + '\n', 'utf-8')
    console.log(`  4c. 실패 마킹 SQL 저장: ${failedPath} (${failedToMark.length}건)`)
    console.log(`      → 다음 실행 시 이 row들은 ai_summary_updated_at 마킹으로 제외됨`)
  }

  // 영향받은 lot IDs 추출 및 저장
  if (LOTS_OUTPUT && applied.length > 0) {
    const affectedLotIds = fetchAffectedLotIds(applied.map((p) => p.id))
    const lotsOutputPath = resolve(import.meta.dir, '..', LOTS_OUTPUT)
    mkdirSync(dirname(lotsOutputPath), { recursive: true })
    writeFileSync(lotsOutputPath, JSON.stringify(affectedLotIds, null, 2), 'utf-8')
    console.log(`  4b. 영향 lot IDs 저장: ${lotsOutputPath} (${affectedLotIds.length}건)`)
  }

  // 적용용 SQL 생성 (필터링된 것만)
  const outputPath = resolve(import.meta.dir, '..', OUTPUT_SQL)
  const sqlLines = applied.map(
    (p) =>
      `UPDATE web_sources SET ai_summary = '${escSql(p.newSummary)}', ai_summary_updated_at = datetime('now') WHERE id = ${p.id};`,
  )
  writeFileSync(outputPath, sqlLines.join('\n') + '\n', 'utf-8')
  console.log(`  5. 적용용 SQL 저장: ${outputPath} (${applied.length}줄)`)

  // DB 적용
  if (APPLY && applied.length > 0) {
    console.log(`\n  6. DB 적용 중... (${isRemote ? 'remote' : 'local'})`)
    d1ExecFile(outputPath)
    console.log(`     ✅ 적용 완료`)
  } else {
    console.log(`\n  ℹ️  --apply 플래그 없음. DB 변경 없이 종료.`)
    console.log(`     실제 적용: bun run scripts/apply-summaries.ts ${args.join(' ')} --apply`)
  }

  // 샘플 5개 출력
  if (applied.length > 0) {
    console.log(`\n  샘플 (적용 예정 5건):`)
    for (const p of applied.slice(0, 5)) {
      const old = existing.get(p.id) ?? ''
      console.log(`     id=${p.id} (old:${old.length}자 → new:${p.newSummary.length}자)`)
      console.log(`       ${p.newSummary.slice(0, 100)}...`)
    }
  }

  console.log()
}

main()
