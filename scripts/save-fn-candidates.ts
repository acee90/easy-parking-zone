import { Database } from 'bun:sqlite'
import { classifyByRule } from '../src/server/crawlers/lib/rule-filter'

const DB_PATH = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/30ea4f54ddacc99bacae539f83f77ac1a38c074b22e8bbfbb72d7f194bbebacb.sqlite'
const db = new Database(DB_PATH, { readonly: true })

// filter_v2=1인데 우리 rule이 low로 분류하는 전체 목록
const rows = db.query<{
  id: number; title: string; full_text: string; source_url: string | null
}, []>(`
  SELECT id, title, full_text, source_url
  FROM web_sources
  WHERE filter_passed_v2 = 1
    AND full_text IS NOT NULL
    AND full_text_status = 'ok'
`).all()

const AD_PATTERNS = [/#협찬/,/협찬\s*(?:을\s*)?받[았아]/,/협찬\s*받은/,/협찬\s*(?:제품|품)/,/제품\s*협찬/,/#광고/,/#유료광고/,/유료\s*광고/,/홍보\s*포스팅입니다/,/광고\s*포스팅입니다/,/이\s*포스팅은\s*광고/,/이\s*(?:게시물|글)은?\s*광고/,/본\s*(?:포스팅|게시물|글)은?\s*(?:유료\s*)?광고/,/광고비\s*를?\s*받[아았]/,/서포터즈\s*(?:활동|후기|선정)/,/체험단\s*(?:선정|후기|글|이벤트)/,/원고료\s*를?\s*받[아았고]/]
const BOILERPLATE_RE = /주차정보\s*(?:휴무일|층별|안내)|운영시간\s*및\s*(?:요금|주차)|층별\s*안내|(?:기본\s*)?(?:시간\/요금|시간당\s*요금)|주차구획수:|운영요일:|관리기관명:|Top\s*\d+\s*(?:주차|저렴)|주변\s*주차장\s*(?:순위|Top|추천|목록)|구획수\s*\d+|1일권\s*(?:적용|요금)|월정기결제|🕒\s*운영\s*정보|운영\s*요일\s*평일|총\s*주차면수\s*\d+\s*대|주차장\s*종류\s*공영|관리번호\s*\d/
const NEWS_RE = /민원\s*증가|조성.*추진|운영하기로|추진한다|지자체\s*(?:는|은|가|이)\s*(?:발표|결정|추진)|보도자료|구청장|시의회|예산|기자\s*=|[가-힣]+기자\n|연합뉴스|뉴시스|뉴스1|[가-힣]{2,4}특파원/
const LOW_KEYWORDS_REALESTATE = ['매매','전세','분양','임대아파트','택지개발','아파트 분양']
const LOW_KEYWORDS_EVENT = ['결혼식','돌잔치','장례식','웨딩홀','예식장']
const LOW_KEYWORDS_APP = ['사업자번호:','전국 편의시설']

function getFNReason(text: string): string | null {
  const tier = classifyByRule({ fullText: text, fullTextStatus: 'ok', title: '' })
  if (tier !== 'low') return null
  if (text.length < 500) return 'too_short'
  if (AD_PATTERNS.some(p => p.test(text))) return 'ad'
  const lower = text.toLowerCase()
  if (LOW_KEYWORDS_REALESTATE.some(k => lower.includes(k))) return 'realestate'
  if (LOW_KEYWORDS_EVENT.some(k => lower.includes(k))) return 'event'
  if (BOILERPLATE_RE.test(text)) return 'boilerplate'
  if (NEWS_RE.test(text)) return 'news'
  if (LOW_KEYWORDS_APP.some(k => lower.includes(k))) return 'app_fragment'
  return 'thin'
}

const fnItems: { id: number; title: string; reason: string; len: number }[] = []
for (const row of rows) {
  const reason = getFNReason(row.full_text)
  if (reason) {
    fnItems.push({ id: row.id, title: row.title.slice(0, 80), reason, len: row.full_text.length })
  }
}

// 전체 통계
const total = rows.length
const fnCount = fnItems.length
const byReason: Record<string, number> = {}
for (const item of fnItems) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1

console.log(`전체 filter_v2=1: ${total}건`)
console.log(`FN 전체: ${fnCount}건 (${((fnCount/total)*100).toFixed(1)}%)`)
console.log('\n원인별:')
for (const [r, c] of Object.entries(byReason).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${r.padEnd(15)} ${c}건 (${((c/fnCount)*100).toFixed(1)}%)`)
}

// JSON 저장
import { writeFileSync } from 'fs'
writeFileSync('/tmp/fn-candidates.json', JSON.stringify(fnItems, null, 2))
console.log(`\n→ /tmp/fn-candidates.json 저장 (${fnCount}건)`)
