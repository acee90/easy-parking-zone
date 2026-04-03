/**
 * 주변 장소 AI 추출 배치 스크립트
 *
 * 난이도 3.5+ 주차장의 블로그에서 주변 장소를 Haiku로 추출하여 nearby_places에 저장.
 * mention_count >= 2인 장소만 저장 (정확도 필터).
 *
 * 사용법:
 *   bun run scripts/extract-nearby-places.ts --remote
 *   bun run scripts/extract-nearby-places.ts --remote --dry-run
 *   bun run scripts/extract-nearby-places.ts --remote --limit 50
 */
import { d1Query, d1Execute, isRemote } from './lib/d1'
import { extractFromBlogs, mergeExtractedPlaces } from '../src/server/crawlers/lib/nearby-extractor'

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '999')
const CONCURRENCY = 5
const DELAY_MS = 500

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY 필요')
  process.exit(1)
}

interface LotWithBlogs {
  lotId: string
  lotName: string
  blogs: Array<{ id: number; title: string; content: string }>
}

async function main() {
  console.log(`🚀 주변 장소 추출 시작 (${isRemote ? 'REMOTE' : 'LOCAL'}${DRY_RUN ? ', DRY-RUN' : ''})`)

  // 1. 이미 추출된 주차장 제외
  const existingLots = d1Query<{ parking_lot_id: string }>(
    `SELECT DISTINCT parking_lot_id FROM nearby_places`,
  ).map((r) => r.parking_lot_id)
  const existingSet = new Set(existingLots)
  console.log(`  기존 추출 완료: ${existingLots.length}개 주차장`)

  // 2. score >= 3.5 주차장 + 블로그 조인
  const rows = d1Query<{
    lot_id: string
    lot_name: string
    blog_id: number
    blog_title: string
    blog_content: string
  }>(`
    SELECT p.id as lot_id, p.name as lot_name,
           w.id as blog_id, w.title as blog_title, w.content as blog_content
    FROM parking_lots p
    JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    JOIN web_sources w ON w.parking_lot_id = p.id
    WHERE s.final_score >= 3.5
    ORDER BY p.id, w.id
  `)

  // 3. 주차장별 그룹핑
  const lotMap = new Map<string, LotWithBlogs>()
  for (const row of rows) {
    if (existingSet.has(row.lot_id)) continue
    let lot = lotMap.get(row.lot_id)
    if (!lot) {
      lot = { lotId: row.lot_id, lotName: row.lot_name, blogs: [] }
      lotMap.set(row.lot_id, lot)
    }
    lot.blogs.push({ id: row.blog_id, title: row.blog_title, content: row.blog_content })
  }

  const lots = Array.from(lotMap.values()).slice(0, LIMIT)
  console.log(`  대상: ${lots.length}개 주차장 (블로그 ${lots.reduce((s, l) => s + l.blogs.length, 0)}건)`)

  // 4. 배치 처리
  let totalPlaces = 0
  let totalLots = 0
  let errors = 0

  for (let i = 0; i < lots.length; i += CONCURRENCY) {
    const batch = lots.slice(i, i + CONCURRENCY)

    const results = await Promise.allSettled(
      batch.map(async (lot) => {
        const extracted = await extractFromBlogs(lot.lotName, lot.blogs, ANTHROPIC_API_KEY!)
        const merged = mergeExtractedPlaces(extracted)
        // mention_count >= 2 필터
        const filtered = merged.filter((p) => p.mentionCount >= 2)
        return { lot, places: filtered }
      }),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        errors++
        console.error(`  ❌ ${result.reason}`)
        continue
      }

      const { lot, places } = result.value
      if (places.length === 0) continue

      totalLots++
      totalPlaces += places.length

      console.log(`  ✅ ${lot.lotName}: ${places.length}개 장소`)
      for (const p of places) {
        console.log(`     ${p.category} "${p.name}" (${p.mentionCount}회)${p.tip ? ` — ${p.tip}` : ''}`)
      }

      if (!DRY_RUN) {
        for (const p of places) {
          const name = p.name.replace(/'/g, "''")
          const tip = p.tip ? `'${p.tip.replace(/'/g, "''")}'` : 'NULL'
          const blogIds = JSON.stringify(p.sourceBlogIds)
          d1Execute(
            `INSERT INTO nearby_places (parking_lot_id, name, category, tip, mention_count, source_blog_ids)
             VALUES ('${lot.lotId}', '${name}', '${p.category}', ${tip}, ${p.mentionCount}, '${blogIds}')`,
          )
        }
      }
    }

    if (i + CONCURRENCY < lots.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS))
    }
    process.stdout.write(`\r  진행: ${Math.min(i + CONCURRENCY, lots.length)}/${lots.length}`)
  }

  console.log('\n')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📊 결과: ${totalLots}개 주차장, ${totalPlaces}개 장소 저장`)
  console.log(`   에러: ${errors}건`)
  console.log(`   스킵: ${lots.length - totalLots - errors}개 (장소 없거나 mention < 2)`)
  if (DRY_RUN) console.log('   ⚠️ DRY-RUN 모드 — DB 미반영')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

main().catch(console.error)
