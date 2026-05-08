/**
 * Full-text batch fetcher (Workers Cron용)
 *
 * web_sources에서 full_text_status='pending'인 brave_search/ddg_search 항목을
 * crawl4ai로 본문 추출 후 업데이트.
 *
 * 처리 대상: 매칭 완료(web_sources) + full_text_status='pending' + 비네이버 소스
 * Workers Cron 제한: subrequest 1,000개/invocation (각 URL = 1 crawl4ai 호출)
 */

const BATCH_LIMIT = 25
const FETCH_TIMEOUT = 20_000
const MIN_TEXT_LENGTH = 200

type FullTextStatus = 'ok' | 'blocked' | 'not_found' | 'too_short' | 'error'

interface PendingRow {
  id: number
  source_url: string
}

async function fetchViaC4ai(
  url: string,
  crawl4aiUrl: string,
): Promise<{ text: string; status: FullTextStatus }> {
  try {
    const res = await fetch(`${crawl4aiUrl}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url], word_count_threshold: 10 }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })

    if (!res.ok) return { text: '', status: 'error' }

    const data = (await res.json()) as {
      success: boolean
      results: Array<{
        markdown: { raw_markdown: string }
        status_code: number
      }>
    }

    const result = data.results?.[0]
    if (!result) return { text: '', status: 'error' }
    if (result.status_code === 404) return { text: '', status: 'not_found' }
    if (result.status_code === 401 || result.status_code === 403) {
      return { text: '', status: 'blocked' }
    }

    const text = result.markdown?.raw_markdown?.trim() ?? ''
    if (text.length < MIN_TEXT_LENGTH) return { text, status: 'too_short' }
    return { text, status: 'ok' }
  } catch {
    return { text: '', status: 'error' }
  }
}

export async function runFullTextBatch(
  db: D1Database,
  env: { CRAWL4AI_URL: string },
): Promise<{ processed: number; ok: number; skipped: number }> {
  const rows = await db
    .prepare(
      `SELECT id, source_url FROM web_sources
       WHERE full_text_status = 'pending'
         AND source IN ('brave_search', 'ddg_search')
       LIMIT ?1`,
    )
    .bind(BATCH_LIMIT)
    .all<PendingRow>()

  const pending = rows.results ?? []
  if (pending.length === 0) return { processed: 0, ok: 0, skipped: 0 }

  let ok = 0
  let skipped = 0

  for (const row of pending) {
    const { text, status } = await fetchViaC4ai(row.source_url, env.CRAWL4AI_URL)
    if (status === 'ok') ok++
    else skipped++

    await db
      .prepare(
        `UPDATE web_sources
         SET full_text        = ?1,
             full_text_length = ?2,
             full_text_status = ?3,
             full_text_fetched_at = datetime('now')
         WHERE id = ?4`,
      )
      .bind(status === 'ok' ? text : null, text.length, status, row.id)
      .run()
  }

  return { processed: pending.length, ok, skipped }
}
