/**
 * lot 강제 매핑 키워드 크롤 — 사용자 정의 검색어로 Naver Blog/Cafe 검색 후
 * `web_sources_raw.search_lot_hint=lot_id`로 INSERT (lot-match 우회).
 *
 * 사용 시점: lot 보강 사이클에서 `crawl-blogs.ts`의 자동 쿼리(`lot.name + 지역`)가
 * 일반어 충돌로 다른 lot에 결과를 빼앗기는 경우. 예: "용천", "이순신", "공영주차장"처럼
 * lot명이 동명이/일반어와 겹쳐 lot-match에서 다른 lot으로 매칭되는 케이스.
 *
 * 흐름:
 *   1) Naver Blog + Cafe Search API에 각 쿼리 호출 (display=20)
 *   2) URL 해시(`hashUrl`)로 dedup
 *   3) `search_lot_hint=lot_id`, `filter_tier='manual_keyword'` 부여한 INSERT SQL emit
 *   4) 호출자가 local + remote에 INSERT → /run-pipeline (Stage 0~2) →
 *      `force-attach-by-hint.ts`가 `search_lot_hint`로 정확히 lot에 INSERT
 *
 * Usage:
 *   bun run scripts/crawl-lot-keywords.ts <lot_id> "<q1>" "<q2>" ...
 *   예) bun run scripts/crawl-lot-keywords.ts KA-1142234873 \
 *         "중리산 공영주차장 요금" "중리산 공영주차장 후기" "중리산 공영주차장 팁"
 *
 * 출력: /tmp/lot-keyword-{LOT_ID safe}.sql  (web_sources_raw INSERT 문)
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 *
 * 한계:
 *   - DDG 미포함 (Naver만). 필요시 후속 사이클에 별도 처리.
 *   - 동일 SQL을 local·remote 양쪽에 적용 시 raw.id가 어긋남 → web_sources.raw_source_id는
 *     remote에서 NULL로 처리해야 함 ([[feedback_local_crawl_raw_id_divergence]]).
 *     이 변환은 `force-attach-by-hint.ts`가 담당.
 */
import { writeFileSync } from 'fs'
import {
  hashUrl,
  parsePostdate,
  searchNaverBlog,
  searchNaverCafe,
  stripHtml,
} from './lib/naver-api'

const LOT_ID = process.argv[2]
const QUERIES = process.argv.slice(3)
if (!LOT_ID || QUERIES.length === 0) {
  console.error('usage: bun scripts/crawl-lot-keywords.ts <lot_id> "<q1>" "<q2>" ...')
  process.exit(1)
}

interface Row {
  source: 'naver_blog' | 'naver_cafe'
  source_id: string
  url: string
  title: string
  desc: string
  author: string
  published_at: string | null
}

const all = new Map<string, Row>() // dedup by source_id (URL hash)

for (const q of QUERIES) {
  for (const [fn, source] of [
    [searchNaverBlog, 'naver_blog' as const],
    [searchNaverCafe, 'naver_cafe' as const],
  ] as const) {
    try {
      const res = await fn(q, 20)
      for (const item of res.items) {
        const source_id = await hashUrl(item.link)
        if (all.has(source_id)) continue
        all.set(source_id, {
          source,
          source_id,
          url: item.link,
          title: stripHtml(item.title),
          desc: stripHtml(item.description),
          author: stripHtml(item.bloggername ?? item.cafename ?? ''),
          published_at: parsePostdate(item.postdate),
        })
      }
      console.log(`  [${source}] "${q}" → ${res.items.length}건 (누적 unique ${all.size})`)
    } catch (e) {
      console.error(`  [${source}] "${q}" 실패: ${e instanceof Error ? e.message : e}`)
    }
  }
}

const esc = (s: string) => s.replace(/'/g, "''")
const sqlVal = (v: string | null) => (v == null ? 'NULL' : `'${esc(v)}'`)

const cols = [
  'source',
  'source_id',
  'source_url',
  'title',
  'content',
  'author',
  'published_at',
  'crawled_at',
  'full_text_status',
  'search_lot_hint',
  'filter_tier',
]
const stmts = [...all.values()].map((r) => {
  const vals = [
    sqlVal(r.source),
    sqlVal(r.source_id),
    sqlVal(r.url),
    sqlVal(r.title),
    sqlVal(r.desc),
    r.author ? sqlVal(r.author) : 'NULL',
    sqlVal(r.published_at),
    "datetime('now')",
    "'pending'",
    sqlVal(LOT_ID),
    "'manual_keyword'",
  ]
  return `INSERT OR IGNORE INTO web_sources_raw (${cols.join(', ')}) VALUES (${vals.join(', ')});`
})

const out = `/tmp/lot-keyword-${LOT_ID.replace(/[^A-Za-z0-9]/g, '_')}.sql`
writeFileSync(out, stmts.join('\n'))
console.log(`\n✓ ${stmts.length}건 raw INSERT (search_lot_hint=${LOT_ID}) → ${out}`)
