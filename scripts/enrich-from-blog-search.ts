/**
 * 네이버 블로그 검색 + AI 추출로 주차장 기본정보 보강
 *
 * 1. 미검증 KA- 주차장 중 운영시간 없는 건 조회
 * 2. 네이버 블로그 검색: "{주차장명} 운영시간 요금"
 * 3. Haiku로 스니펫에서 구조화 데이터 추출
 * 4. DB UPDATE (verified_source = 'blog_ai')
 *
 * 사용법:
 *   bun run scripts/enrich-from-blog-search.ts --remote
 *   bun run scripts/enrich-from-blog-search.ts --remote --dry-run
 *   bun run scripts/enrich-from-blog-search.ts --remote --limit 50
 */
import { d1Query, d1Execute, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100')
const DELAY_MS = 300
const BATCH_AI = 5 // Haiku 배치 크기

// ── 환경변수 ──

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.error('❌ NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 필요')
  process.exit(1)
}
if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY 필요')
  process.exit(1)
}

// ── 타입 ──

interface TargetLot {
  id: string
  name: string
  address: string
}

interface BlogSnippet {
  title: string
  description: string
}

interface ExtractedInfo {
  weekday_start: string | null
  weekday_end: string | null
  saturday_start: string | null
  saturday_end: string | null
  holiday_start: string | null
  holiday_end: string | null
  is_free: number | null
  base_time: number | null
  base_fee: number | null
  extra_time: number | null
  extra_fee: number | null
  daily_max: number | null
  phone: string | null
  total_spaces: number | null
}

// ── 네이버 블로그 검색 ──

async function searchBlog(query: string, display = 5): Promise<BlogSnippet[]> {
  const params = new URLSearchParams({ query, display: String(display), sort: 'sim' })
  const res = await fetch(`https://openapi.naver.com/v1/search/blog.json?${params}`, {
    headers: {
      'X-Naver-Client-Id': NAVER_CLIENT_ID!,
      'X-Naver-Client-Secret': NAVER_CLIENT_SECRET!,
    },
  })
  if (!res.ok) throw new Error(`Naver API ${res.status}`)
  const data = (await res.json()) as { items: { title: string; description: string }[] }
  return (data.items ?? []).map((item) => ({
    title: stripHtml(item.title),
    description: stripHtml(item.description),
  }))
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .trim()
}

// ── AI 추출 ──

const SYSTEM_PROMPT = `주차장 관련 블로그 검색 결과에서 기본정보를 추출하세요.
반드시 JSON으로만 응답하세요. 확인할 수 없는 항목은 null로 두세요.

응답 형식:
{
  "weekday_start": "HH:MM" 또는 null,
  "weekday_end": "HH:MM" 또는 null,
  "saturday_start": "HH:MM" 또는 null,
  "saturday_end": "HH:MM" 또는 null,
  "holiday_start": "HH:MM" 또는 null,
  "holiday_end": "HH:MM" 또는 null,
  "is_free": 1(무료) 또는 0(유료) 또는 null,
  "base_time": 기본시간(분) 또는 null,
  "base_fee": 기본요금(원) 또는 null,
  "extra_time": 추가단위시간(분) 또는 null,
  "extra_fee": 추가단위요금(원) 또는 null,
  "daily_max": 1일최대요금(원) 또는 null,
  "phone": "전화번호" 또는 null,
  "total_spaces": 총주차면수 또는 null
}

주의:
- 24시간 운영이면 "00:00"~"23:59"
- "무료"라고 명시된 경우만 is_free=1, 불확실하면 null
- 여러 블로그에서 정보가 다르면 가장 최신/신뢰할 만한 것 선택
- 숫자는 정수로 (콤마 제거)`

async function extractWithAI(
  lotName: string,
  snippets: BlogSnippet[],
): Promise<ExtractedInfo | null> {
  const content = snippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.description}`)
    .join('\n\n')

  const userMessage = `주차장명: ${lotName}\n\n검색 결과:\n${content}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  })

  if (!res.ok) {
    console.warn(`  AI API ${res.status}: ${await res.text()}`)
    return null
  }

  const data = (await res.json()) as { content: { text: string }[] }
  const text = data.content?.[0]?.text ?? ''

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    return JSON.parse(jsonMatch[0]) as ExtractedInfo
  } catch {
    console.warn(`  JSON 파싱 실패: ${text.slice(0, 100)}`)
    return null
  }
}

// ── UPDATE SQL ──

function buildUpdate(id: string, info: ExtractedInfo): string | null {
  const sets: string[] = []

  if (info.weekday_start) sets.push(`weekday_start = '${esc(info.weekday_start)}'`)
  if (info.weekday_end) sets.push(`weekday_end = '${esc(info.weekday_end)}'`)
  if (info.saturday_start) sets.push(`saturday_start = '${esc(info.saturday_start)}'`)
  if (info.saturday_end) sets.push(`saturday_end = '${esc(info.saturday_end)}'`)
  if (info.holiday_start) sets.push(`holiday_start = '${esc(info.holiday_start)}'`)
  if (info.holiday_end) sets.push(`holiday_end = '${esc(info.holiday_end)}'`)
  if (info.is_free !== null) sets.push(`is_free = ${info.is_free}`)
  if (info.base_time !== null) sets.push(`base_time = ${info.base_time}`)
  if (info.base_fee !== null) sets.push(`base_fee = ${info.base_fee}`)
  if (info.extra_time !== null) sets.push(`extra_time = ${info.extra_time}`)
  if (info.extra_fee !== null) sets.push(`extra_fee = ${info.extra_fee}`)
  if (info.daily_max !== null) sets.push(`daily_max = ${info.daily_max}`)
  if (info.phone) sets.push(`phone = '${esc(info.phone)}'`)
  if (info.total_spaces !== null && info.total_spaces > 0)
    sets.push(`total_spaces = ${info.total_spaces}`)

  if (sets.length === 0) return null

  sets.push("verified_source = 'blog_ai'")
  sets.push("verified_at = datetime('now')")
  sets.push("updated_at = datetime('now')")

  return `UPDATE parking_lots SET ${sets.join(', ')} WHERE id = '${esc(id)}';`
}

// ── 유틸 ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── 메인 ──

async function main() {
  console.log('=== 블로그 검색 + AI 추출 기본정보 보강 ===')
  console.log(`모드: ${DRY_RUN ? 'DRY-RUN' : isRemote ? 'REMOTE' : 'LOCAL'} | LIMIT: ${LIMIT}\n`)

  // 1. 미검증 + 운영시간 없는 주차장 조회
  console.log('📡 대상 주차장 조회...')
  const lots = d1Query<TargetLot>(
    `SELECT id, name, address FROM parking_lots
     WHERE id LIKE 'KA-%'
       AND verified_source IS NULL
       AND (weekday_start = '' OR weekday_start IS NULL)
       AND type IN ('노외', '노상')
     ORDER BY RANDOM()
     LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${lots.length}건\n`)

  if (lots.length === 0) {
    console.log('✅ 보강 대상 없음.')
    return
  }

  // 2. 검색 + AI 추출
  let searched = 0
  let extracted = 0
  let updated = 0
  const sqls: string[] = []

  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i]
    process.stdout.write(`\r  ${i + 1}/${lots.length} ${lot.name.slice(0, 20).padEnd(20)}`)

    // 네이버 블로그 검색
    let snippets: BlogSnippet[] = []
    try {
      snippets = await searchBlog(`${lot.name} 운영시간 요금`, 5)
      searched++
    } catch (err) {
      console.warn(`\n  검색 실패: ${lot.name} - ${(err as Error).message}`)
      await sleep(1000)
      continue
    }

    if (snippets.length === 0) {
      await sleep(DELAY_MS)
      continue
    }

    // AI 추출
    try {
      const info = await extractWithAI(lot.name, snippets)
      if (info) {
        const sql = buildUpdate(lot.id, info)
        if (sql) {
          sqls.push(sql)
          extracted++

          const details: string[] = []
          if (info.weekday_start) details.push(`운영:${info.weekday_start}~${info.weekday_end}`)
          if (info.is_free === 1) details.push('무료')
          else if (info.base_fee !== null) details.push(`${info.base_time}분/${info.base_fee}원`)
          if (info.daily_max !== null) details.push(`일최대:${info.daily_max}원`)
          if (info.phone) details.push(`tel:${info.phone}`)
          if (info.total_spaces) details.push(`${info.total_spaces}면`)
          console.log(`\n  ✓ ${lot.name} → ${details.join(' | ')}`)
        }
      }
    } catch (err) {
      console.warn(`\n  AI 추출 실패: ${lot.name} - ${(err as Error).message}`)
    }

    await sleep(DELAY_MS)
  }

  console.log(`\n\n📊 결과:`)
  console.log(`  검색 성공: ${searched}건`)
  console.log(`  정보 추출: ${extracted}건 (${((extracted / searched) * 100).toFixed(1)}%)`)

  if (extracted === 0) {
    console.log('\n❌ 추출 건 없음.')
    return
  }

  if (DRY_RUN) {
    console.log(`\n🔍 DRY-RUN: ${extracted}건 UPDATE 예정 (DB 미반영)`)
    return
  }

  // 3. DB UPDATE
  console.log(`\n⚡ ${sqls.length}건 UPDATE 실행...`)
  const BATCH = 50
  for (let i = 0; i < sqls.length; i += BATCH) {
    const batch = sqls.slice(i, i + BATCH).join('\n')
    d1Execute(batch)
    updated += Math.min(BATCH, sqls.length - i)
    process.stdout.write(`\r  ${updated}/${sqls.length}`)
  }

  console.log(`\n\n✅ 완료! ${updated}건 보강 (verified_source = 'blog_ai')`)
}

main().catch((err) => {
  console.error('❌ 에러:', err.message ?? err)
  process.exit(1)
})
