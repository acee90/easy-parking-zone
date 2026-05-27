/**
 * 기존 parking_media (media_type='youtube') 873개를 web_sources_raw로 backfill.
 *
 * 이전 흐름: youtube 크롤러가 검증 없이 parking_media에 직행 → 부정확 매칭 다수.
 * 새 흐름: ws_raw 적재 → subagent 검증 → 통과만 parking_media 재진입.
 *
 * Backfill 처리:
 *   - parking_media 각 행 → ws_raw INSERT (source='youtube_video', search_lot_hint=parking_lot_id)
 *   - ws_raw에 이미 같은 source_url 있으면 IGNORE
 *   - parking_media 행 삭제 (검증 통과 시 다시 INSERT됨)
 *
 * Usage:
 *   bun run scripts/backfill-youtube-media.ts --remote --dry-run    # 미리보기
 *   bun run scripts/backfill-youtube-media.ts --remote --apply      # 실제 적용
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { d1ExecFile, d1Query, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run') || !args.includes('--apply')
const OUTPUT_SQL =
  args.find((a) => a.startsWith('--output-sql='))?.split('=')[1] ??
  'data/youtube-verify/backfill.sql'

interface MediaRow {
  id: number
  parking_lot_id: string
  url: string
  title: string
  thumbnail_url: string | null
  description: string | null
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

function fetchYoutubeMedia(): MediaRow[] {
  return d1Query<MediaRow>(`
    SELECT id, parking_lot_id, url, title, thumbnail_url, description
    FROM parking_media
    WHERE media_type = 'youtube'
    ORDER BY id
  `)
}

function main(): void {
  console.log(`\n📦 backfill-youtube-media — ${isRemote ? 'remote' : 'local'} D1`)
  console.log(`   mode=${DRY_RUN ? 'dry-run' : 'apply'}`)

  const rows = fetchYoutubeMedia()
  console.log(`   fetched ${rows.length} parking_media youtube rows`)

  const sqls: string[] = []
  let backfilled = 0
  let skipped = 0

  for (const r of rows) {
    if (!r.url || !r.url.includes('youtube.com/watch')) {
      skipped++
      continue
    }

    const sourceId = hashUrl(r.url)
    const description = r.description ?? ''
    const fullText = description ? `${r.title}\n\n${description}` : r.title

    // 1. ws_raw INSERT (이미 있으면 IGNORE)
    sqls.push(
      `INSERT OR IGNORE INTO web_sources_raw ` +
        `(source, source_id, source_url, title, content, full_text, full_text_status, ` +
        `full_text_fetched_at, search_lot_hint) ` +
        `VALUES ('youtube_video', '${sourceId}', '${esc(r.url)}', ` +
        `'${esc(r.title)}', '${esc(description)}', '${esc(fullText)}', ` +
        `'ok', datetime('now'), '${esc(r.parking_lot_id)}');`,
    )

    // 2. parking_media 행 삭제 (검증 통과 시 재INSERT)
    sqls.push(`DELETE FROM parking_media WHERE id = ${r.id};`)

    backfilled++
  }

  const sqlPath = resolve(import.meta.dir, '..', OUTPUT_SQL)
  writeFileSync(sqlPath, sqls.join('\n') + '\n', 'utf-8')

  console.log(`✅ wrote ${sqlPath} (${sqls.length} statements)`)
  console.log(`   backfilled=${backfilled}, skipped=${skipped}`)

  if (DRY_RUN) {
    console.log(`\n⚠️  dry-run mode — SQL 작성만, 적용 안 함`)
    console.log(`   적용하려면 --apply 플래그 추가`)
  } else {
    console.log(`\n📤 applying...`)
    d1ExecFile(sqlPath)
    console.log(`✅ applied to ${isRemote ? 'remote' : 'local'} D1`)
    console.log(`\n다음 단계:`)
    console.log(`   1. extract-youtube-for-verify.ts로 새 ws_raw 추출`)
    console.log(`   2. youtube-video-verifier agent로 검증`)
    console.log(`   3. apply-youtube-verify.ts로 결과 적용 → 통과한 영상만 parking_media 재진입`)
  }
}

main()
