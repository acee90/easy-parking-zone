/**
 * wiki SSR 어절 수 검증 스크립트 (#142)
 *
 * ai_summary 보유 lot 상위 100개의 wiki 페이지를 프로덕션에서 fetch,
 * script/style 제거 후 공백 기준 어절 수를 측정한다.
 *
 * Usage:
 *   bun run scripts/verify-wiki-seo.ts
 *   bun run scripts/verify-wiki-seo.ts --limit=50 --concurrency=3
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'

const BASE_URL = 'https://easy-parking.xyz'
const OUTPUT_PATH = resolve('data/issue-142-ssr-metrics.json')

const args = process.argv.slice(2)
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10)
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '5',
  10,
)
const THROTTLE_MS = 200

function toSlug(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[/\\?#%&=+]/g, '')
}

function makeParkingSlug(name: string, id: string): string {
  return `${toSlug(name)}-${id}`
}

function countWords(html: string): number {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.split(' ').filter((w) => w.length > 0).length
}

async function fetchWordCount(slug: string): Promise<number | null> {
  try {
    const res = await fetch(`${BASE_URL}/wiki/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': 'verify-wiki-seo/1.0 (internal)' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const html = await res.text()
    return countWords(html)
  } catch {
    return null
  }
}

async function runBatch<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
  throttleMs: number,
): Promise<void> {
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      await fn(items[i])
      if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs))
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}

interface LotRow {
  id: string
  name: string
  final_score: number | null
}

async function fetchTopLots(): Promise<LotRow[]> {
  const { execSync } = await import('child_process')
  const sql = `
    SELECT p.id, p.name, s.final_score
    FROM parking_lots p
    JOIN parking_lot_stats s ON p.id = s.parking_lot_id
    WHERE s.ai_summary IS NOT NULL AND s.ai_summary != ''
    ORDER BY COALESCE(s.final_score, 0) DESC
    LIMIT ${LIMIT};
  `.trim()

  const out = execSync(
    `npx wrangler d1 execute parking-db --remote --command="${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}" --json`,
    { encoding: 'utf-8', cwd: resolve('.') },
  )
  const parsed = JSON.parse(out)
  return parsed[0]?.results ?? []
}

interface PageResult {
  slug: string
  id: string
  name: string
  final_score: number | null
  word_count: number | null
}

async function main() {
  console.log(`=== wiki SSR 검증 ===`)
  console.log(`대상: ai_summary 상위 ${LIMIT}개 lots`)
  console.log(`동시 요청: ${CONCURRENCY}, throttle: ${THROTTLE_MS}ms`)
  console.log(`출력: ${OUTPUT_PATH}`)
  console.log()

  console.log('D1에서 대상 lots 조회 중...')
  const lots = await fetchTopLots()
  console.log(`조회 완료: ${lots.length}개`)

  const pages: PageResult[] = lots.map((l) => ({
    slug: makeParkingSlug(l.name, l.id),
    id: l.id,
    name: l.name,
    final_score: l.final_score,
    word_count: null,
  }))

  let done = 0
  await runBatch(
    pages,
    async (page) => {
      page.word_count = await fetchWordCount(page.slug)
      done++
      if (done % 10 === 0 || done === pages.length) {
        process.stdout.write(`  ${done}/${pages.length} fetched\r`)
      }
    },
    CONCURRENCY,
    THROTTLE_MS,
  )
  console.log()

  const valid = pages.filter((p) => p.word_count !== null).map((p) => p.word_count as number)
  valid.sort((a, b) => a - b)

  const avg = valid.length ? Math.round(valid.reduce((s, v) => s + v, 0) / valid.length) : 0
  const p25 = valid.length ? valid[Math.floor(valid.length * 0.25)] : 0
  const p50 = valid.length ? valid[Math.floor(valid.length * 0.5)] : 0
  const p75 = valid.length ? valid[Math.floor(valid.length * 0.75)] : 0
  const min = valid.length ? valid[0] : 0
  const max = valid.length ? valid[valid.length - 1] : 0

  const metrics = {
    measured_at: new Date().toISOString(),
    sample_size: valid.length,
    failed: pages.length - valid.length,
    avg,
    p25,
    p50,
    p75,
    min,
    max,
    target_p50: 800,
    pass: p50 >= 800,
    pages: pages.map((p) => ({ slug: p.slug, id: p.id, word_count: p.word_count })),
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(metrics, null, 2))

  console.log(`\n=== 결과 ===`)
  console.log(`샘플: ${valid.length}개 (실패: ${pages.length - valid.length}개)`)
  console.log(`avg: ${avg}, p25: ${p25}, p50: ${p50}, p75: ${p75}`)
  console.log(`min: ${min}, max: ${max}`)
  console.log(`목표(p50 ≥ 800): ${p50 >= 800 ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`\n출력: ${OUTPUT_PATH}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
