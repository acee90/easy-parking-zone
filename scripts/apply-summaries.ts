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
const APPLY = args.includes('--apply') // 명시적 --apply 없으면 SQL만 생성, DB 적용은 안함

// ── Types ──
interface Parsed {
  id: number
  newSummary: string
}

interface Rejection {
  id: number
  reason: 'too_short' | 'not_better' | 'parse_error'
  old_len: number
  new_len: number
  old_summary?: string
  new_summary?: string
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
