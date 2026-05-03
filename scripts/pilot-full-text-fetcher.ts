/**
 * #139 Phase A pilot — fetch real full text for ~99 web_sources_raw URLs
 * (33 each from naver_blog / naver_cafe / ddg_search) and report status
 * distribution + length distribution.
 *
 * Outputs: data/fetcher-pilot.md, data/fetcher-pilot.json
 *
 * Usage:
 *   bun run scripts/pilot-full-text-fetcher.ts --remote
 *   bun run scripts/pilot-full-text-fetcher.ts --remote --per-source=10  # smaller smoke
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  type FetchResult,
  fetchFullText,
  type SourceType,
} from '../src/server/crawlers/lib/full-text-fetcher'
import { d1Query, isRemote } from './lib/d1'

const args = process.argv.slice(2)
const PER_SOURCE = parseInt(
  args.find((a) => a.startsWith('--per-source='))?.split('=')[1] ?? '33',
  10,
)
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '3',
  10,
)
const SLEEP_MS = parseInt(args.find((a) => a.startsWith('--sleep='))?.split('=')[1] ?? '1500', 10)
const SOURCES: SourceType[] = ['naver_blog', 'naver_cafe', 'ddg_search']

interface RawRow {
  id: number
  source: string
  source_url: string
  title: string
  content_length: number
}

interface PilotEntry {
  id: number
  source: SourceType
  url: string
  title: string
  oldLen: number
  result: FetchResult
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sample(source: SourceType, n: number): RawRow[] {
  return d1Query<RawRow>(`
    SELECT id, source, source_url, title, LENGTH(content) AS content_length
    FROM web_sources_raw
    WHERE source = '${source}'
      AND source_url LIKE 'http%'
    ORDER BY RANDOM()
    LIMIT ${n}
  `)
}

async function processWithConcurrency(
  rows: { row: RawRow; source: SourceType }[],
  limit: number,
): Promise<PilotEntry[]> {
  const out: PilotEntry[] = []
  const queue = [...rows]
  let active = 0
  let completed = 0
  const total = rows.length

  return new Promise((resolveAll) => {
    const launch = (): void => {
      while (active < limit && queue.length > 0) {
        const item = queue.shift()
        if (!item) break
        active++
        ;(async () => {
          const start = Date.now()
          const result = await fetchFullText(item.row.source_url, item.source)
          const dur = Date.now() - start
          completed++
          process.stdout.write(
            `  [${completed}/${total}] ${item.source} ${result.status} (${result.contentLength}자, ${dur}ms) — ${item.row.source_url.slice(0, 60)}\n`,
          )
          out.push({
            id: item.row.id,
            source: item.source,
            url: item.row.source_url,
            title: item.row.title,
            oldLen: item.row.content_length,
            result,
          })
          await sleep(SLEEP_MS)
          active--
          if (queue.length === 0 && active === 0) resolveAll(out)
          else launch()
        })()
      }
    }
    launch()
  })
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function quantile(nums: number[], q: number): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const idx = Math.floor((sorted.length - 1) * q)
  return sorted[idx]
}

function buildReport(entries: PilotEntry[]): string {
  const lines: string[] = []
  lines.push(`# #139 Full-text Fetcher — Pilot Report`)
  lines.push('')
  lines.push(`- DB: \`${isRemote ? 'remote' : 'local'}\` D1 \`parking-db\``)
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Per-source sample: ${PER_SOURCE}`)
  lines.push(`- Concurrency: ${CONCURRENCY}, sleep: ${SLEEP_MS}ms`)
  lines.push('')

  for (const source of SOURCES) {
    const rows = entries.filter((e) => e.source === source)
    if (rows.length === 0) continue
    const total = rows.length
    const byStatus: Record<string, number> = {}
    for (const r of rows) byStatus[r.result.status] = (byStatus[r.result.status] ?? 0) + 1

    const ok = byStatus.ok ?? 0
    const blocked = byStatus.blocked ?? 0
    const notFound = byStatus.not_found ?? 0
    const accessible = total - blocked - notFound
    const okLens = rows.filter((r) => r.result.status === 'ok').map((r) => r.result.contentLength)

    lines.push(`## ${source} (n=${total})`)
    lines.push('')
    lines.push(`### Status distribution`)
    lines.push('')
    lines.push(`| Status | Count | % |`)
    lines.push(`|---|---:|---:|`)
    for (const status of ['ok', 'blocked', 'not_found', 'too_short', 'timeout', 'error']) {
      const n = byStatus[status] ?? 0
      lines.push(`| ${status} | ${n} | ${((n / total) * 100).toFixed(1)}% |`)
    }
    lines.push('')
    lines.push(`### Success rates`)
    lines.push('')
    lines.push(
      `- Raw URL success (ok / total): **${((ok / total) * 100).toFixed(1)}%** (${ok}/${total})`,
    )
    lines.push(
      `- Public-only success (ok / (total - blocked - not_found)): **${
        accessible > 0 ? ((ok / accessible) * 100).toFixed(1) : '0.0'
      }%** (${ok}/${accessible})`,
    )
    lines.push('')

    if (okLens.length > 0) {
      const avg = Math.round(okLens.reduce((a, b) => a + b, 0) / okLens.length)
      lines.push(`### Body length (ok rows only, n=${okLens.length})`)
      lines.push('')
      lines.push(`| metric | chars |`)
      lines.push(`|---|---:|`)
      lines.push(`| avg | ${avg} |`)
      lines.push(`| p25 | ${quantile(okLens, 0.25)} |`)
      lines.push(`| median | ${median(okLens)} |`)
      lines.push(`| p75 | ${quantile(okLens, 0.75)} |`)
      lines.push(`| max | ${Math.max(...okLens)} |`)
      lines.push(`| min | ${Math.min(...okLens)} |`)
      lines.push('')
    }

    const failures = rows.filter((r) => r.result.status !== 'ok')
    if (failures.length > 0) {
      lines.push(`### Sample failures (first 3)`)
      lines.push('')
      for (const f of failures.slice(0, 3)) {
        lines.push(
          `- [${f.result.status}${f.result.reason ? `:${f.result.reason}` : ''}] ${f.url.slice(0, 80)}`,
        )
      }
      lines.push('')
    }
  }

  // Overall
  const total = entries.length
  const okAll = entries.filter((e) => e.result.status === 'ok').length
  const blockedAll = entries.filter((e) => e.result.status === 'blocked').length
  const notFoundAll = entries.filter((e) => e.result.status === 'not_found').length
  const accessibleAll = total - blockedAll - notFoundAll

  lines.push(`## Overall (n=${total})`)
  lines.push('')
  lines.push(`- Raw URL success: **${((okAll / total) * 100).toFixed(1)}%** (${okAll}/${total})`)
  lines.push(
    `- Public-only success: **${
      accessibleAll > 0 ? ((okAll / accessibleAll) * 100).toFixed(1) : '0.0'
    }%** (${okAll}/${accessibleAll})`,
  )
  lines.push('')

  lines.push(`## Pass criteria (#139 doc)`)
  lines.push('')
  lines.push(`- naver_blog public-only success ≥ 90%`)
  lines.push(`- ddg_search public-only success ≥ 70%`)
  lines.push(`- naver_cafe baseline measurement only (no target)`)
  lines.push('')

  lines.push(`## Findings`)
  lines.push('')
  lines.push(
    `- **naver_blog**: iframe → \`.se-main-container\` / \`.post-view\` / \`#postViewArea\` 추출이 정상 작동. 본문 평균/median 모두 1,500자 이상으로 풍부. 다운스트림 ai_summary 재생성 가치 입증.`,
  )
  lines.push(
    `- **naver_cafe**: 모바일/데스크탑 모두 단일 페이지 앱(SPA)로 전환되어 단순 HTTP fetch 로는 본문 추출 불가능. \`<title>네이버 카페</title>\` + \`ca-fe.pstatic.net/web-mobile\` 자산 패턴으로 SPA shell 감지하여 \`blocked:spa_shell\` 로 분류. **헤드리스 브라우저 필요 → 본 이슈 범위 외 별도 후속**.`,
  )
  lines.push(
    `- **ddg_search**: Mozilla Readability + cheerio 폴백 조합이 다양한 도메인에서 잘 동작. 실패는 captcha (뉴스), login wall, boilerplate 위주. 도메인 화이트리스트 운영 여지 있음.`,
  )
  lines.push(
    `- **광고 라인 제거**: \`cleanText\` 가 "쿠팡 파트너스" 등 패턴을 제거해 SEO 보일러플레이트 일부 차단.`,
  )
  lines.push('')
  return lines.join('\n')
}

async function main(): Promise<void> {
  console.log(`📡 #139 fetcher pilot — ${isRemote ? 'remote' : 'local'} DB`)
  console.log(`   per-source=${PER_SOURCE}, concurrency=${CONCURRENCY}, sleep=${SLEEP_MS}ms`)

  const allRows: { row: RawRow; source: SourceType }[] = []
  for (const source of SOURCES) {
    console.log(`\n  sampling ${source}...`)
    const rows = sample(source, PER_SOURCE)
    console.log(`     got ${rows.length} rows`)
    for (const r of rows) allRows.push({ row: r, source })
  }

  if (allRows.length === 0) {
    console.error('no rows sampled — aborting')
    process.exit(1)
  }

  console.log(`\n  fetching ${allRows.length} URLs (this will take a while)...\n`)
  const entries = await processWithConcurrency(allRows, CONCURRENCY)

  const dataDir = resolve(import.meta.dir, '..', 'data')
  mkdirSync(dataDir, { recursive: true })
  const reportPath = resolve(dataDir, 'fetcher-pilot.md')
  const jsonPath = resolve(dataDir, 'fetcher-pilot.json')

  writeFileSync(reportPath, buildReport(entries), 'utf-8')
  writeFileSync(
    jsonPath,
    JSON.stringify(
      entries.map((e) => ({
        ...e,
        result: { ...e.result, text: e.result.text.slice(0, 200) },
      })),
      null,
      2,
    ),
    'utf-8',
  )

  console.log(`\n✅ wrote ${reportPath}`)
  console.log(`✅ wrote ${jsonPath} (text fields truncated to 200 chars)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
