/**
 * Raw fulltext batch fetcher (Workers Cron용)
 *
 * web_sources_raw에서 full_text_status='pending'인 항목을 crawl4ai로 본문 추출.
 * fulltext를 raw 단계에서 먼저 채워야 AI 필터가 fulltext 기반으로 동작할 수 있음 (#149).
 *
 * fulltext-batch.ts(web_sources용)와 동일 로직, 대상 테이블만 다름.
 */

const BATCH_LIMIT = 100
const FETCH_TIMEOUT = 30_000
const MIN_TEXT_LENGTH = 200

// naver_blog PostView는 본문 외 네비게이션/모달 chrome이 대량 포함되므로
// 본문 컨테이너만 CSS로 추출한다 (SmartEditor ONE + legacy 셀렉터).
const NAVER_BLOG_SELECTOR = '.se-main-container, #postViewArea, .se_component_wrap, .post_ct'
function crawlBody(url: string): string {
  if (url.includes('blog.naver.com/PostView.naver')) {
    return JSON.stringify({
      urls: [url],
      crawler_config: { css_selector: NAVER_BLOG_SELECTOR, word_count_threshold: 10 },
    })
  }
  return JSON.stringify({ urls: [url], word_count_threshold: 10 })
}

type FullTextStatus = 'ok' | 'blocked' | 'not_found' | 'too_short' | 'error'

interface PendingRow {
  id: number
  source: string
  source_url: string
}

function toMobileUrl(url: string, source: string): string {
  try {
    const u = new URL(url)
    if (source === 'naver_blog') {
      // 원본/모바일(m.blog) URL은 로그인·본문 셸만 반환하므로,
      // 본문 실체인 PostView.naver(iframe) URL로 변환한다.
      // 경로 형태: /{blogId}/{logNo}
      if (u.hostname === 'blog.naver.com' || u.hostname === 'm.blog.naver.com') {
        const segs = u.pathname.split('/').filter(Boolean)
        if (segs.length >= 2 && /^\d+$/.test(segs[1])) {
          const [blogId, logNo] = segs
          return `https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}&redirect=Dlog&widgetTypeCall=true&directAccess=false`
        }
      }
    }
    if (source === 'naver_cafe' && u.hostname === 'cafe.naver.com') {
      u.hostname = 'm.cafe.naver.com'
      return u.toString()
    }
  } catch {
    // URL 파싱 실패 시 원본 사용
  }
  return url
}

async function fetchViaC4ai(
  url: string,
  crawl4aiUrl: string,
): Promise<{ text: string; status: FullTextStatus }> {
  try {
    const res = await fetch(`${crawl4aiUrl}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: crawlBody(url),
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

export async function runRawFullTextBatch(
  db: D1Database,
  env: { CRAWL4AI_URL: string },
): Promise<{ processed: number; ok: number; skipped: number }> {
  const rows = await db
    .prepare(
      `SELECT id, source, source_url FROM web_sources_raw
       WHERE full_text_status = 'pending'
         AND source IN ('brave_search', 'ddg_search', 'naver_blog', 'naver_cafe')
       ORDER BY id ASC
       LIMIT ?1`,
    )
    .bind(BATCH_LIMIT)
    .all<PendingRow>()

  const pending = rows.results ?? []
  if (pending.length === 0) return { processed: 0, ok: 0, skipped: 0 }

  let ok = 0
  let skipped = 0

  for (const row of pending) {
    const targetUrl = toMobileUrl(row.source_url, row.source)
    const { text, status } = await fetchViaC4ai(targetUrl, env.CRAWL4AI_URL)

    if (status === 'ok') ok++
    else skipped++

    // 본문은 web_sources_raw_body에 분리 저장한다 (0048). 원장은 상태만 갖는다.
    // 본문 write를 상태 UPDATE보다 먼저 해야, 중간 실패 시 status가 'pending'으로 남아
    // 다음 사이클에 재시도된다 (본문 없는 'ok' 행이 생기지 않음).
    if (status === 'ok') {
      await db
        .prepare(`INSERT OR REPLACE INTO web_sources_raw_body (raw_id, body) VALUES (?1, ?2)`)
        .bind(row.id, text)
        .run()
    }

    await db
      .prepare(
        `UPDATE web_sources_raw
         SET full_text_status = ?1,
             full_text_fetched_at = datetime('now')
         WHERE id = ?2`,
      )
      .bind(status, row.id)
      .run()
  }

  return { processed: pending.length, ok, skipped }
}
