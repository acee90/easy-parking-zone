import { Database } from 'bun:sqlite'
import { classifyByRule } from '../src/server/crawlers/lib/rule-filter'

const DB_PATH =
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/30ea4f54ddacc99bacae539f83f77ac1a38c074b22e8bbfbb72d7f194bbebacb.sqlite'
const db = new Database(DB_PATH, { readonly: true })

const rows = db
  .query<
    {
      id: number
      title: string
      full_text: string
    },
    []
  >(`
  SELECT id, title, full_text
  FROM web_sources
  WHERE filter_passed_v2 = 1
    AND full_text IS NOT NULL
    AND full_text_status = 'ok'
  ORDER BY RANDOM()
  LIMIT 1000
`)
  .all()

const AD_PATTERNS = [
  /#협찬/,
  /협찬\s*(?:을\s*)?받[았아]/,
  /협찬\s*받은/,
  /협찬\s*(?:제품|품)/,
  /제품\s*협찬/,
  /#광고/,
  /#유료광고/,
  /유료\s*광고/,
  /홍보\s*포스팅입니다/,
  /광고\s*포스팅입니다/,
  /이\s*포스팅은\s*광고/,
  /이\s*(?:게시물|글)은?\s*광고/,
  /본\s*(?:포스팅|게시물|글)은?\s*(?:유료\s*)?광고/,
  /광고비\s*를?\s*받[아았]/,
  /서포터즈\s*(?:활동|후기|선정)/,
  /체험단\s*(?:선정|후기|글|이벤트)/,
  /원고료\s*를?\s*받[아았고]/,
]
const BOILERPLATE_RE =
  /주차정보\s*(?:휴무일|층별|안내)|운영시간\s*및\s*(?:요금|주차)|층별\s*안내|(?:기본\s*)?(?:시간\/요금|시간당\s*요금)|주차구획수:|운영요일:|관리기관명:|Top\s*\d+\s*(?:주차|저렴)|주변\s*주차장\s*(?:순위|Top|추천|목록)|구획수\s*\d+|1일권\s*(?:적용|요금)|월정기결제|🕒\s*운영\s*정보|운영\s*요일\s*평일|총\s*주차면수\s*\d+\s*대|주차장\s*종류\s*공영|관리번호\s*\d/
const NEWS_RE =
  /민원\s*증가|조성.*추진|운영하기로|추진한다|지자체\s*(?:는|은|가|이)\s*(?:발표|결정|추진)|보도자료|구청장|시의회|예산|기자\s*=|[가-힣]+기자\n|연합뉴스|뉴시스|뉴스1|[가-힣]{2,4}특파원/
const NARRATIVE_RE =
  /했어요|했습니다|이었어요|더라고요|더라구요|가봤|이용했|주차했|방문했|다녀왔|다녀와서|들어갔|나왔|기다렸|찾았|돌았|빙빙|힘들었|어려웠|불편했|편했|좋았|나빴/g
const CONCRETE_PARKING_RE =
  /주차하기\s*(?:어렵|힘들|불편|쉽|편리|좋)|주차가\s*(?:어렵|힘들|불편|쉽|편리|좋|안됨)|주차난|만차|자리가\s*(?:없|부족|꽉)|빈\s*자리|빈자리|진입(?:로)?(?:이|가)?\s*(?:좁|어렵|힘들|복잡|막|불편)|주차\s*(?:비|요금|료)\s*(?:\d|유료|무료|비싸|저렴|싸|부담)|(?:\d+분|\d+시간)\s*(?:주차|대기|기다)|주차\s*(?:꿀팁|팁|후기|리뷰)|출차\s*(?:했|어렵|힘들|오래)|주차면|주차공간이?\s*(?:좁|협소|넓|충분|부족)|입차|출차|회전반경|일방통행|혼잡/
const LOW_KEYWORDS_REALESTATE = ['매매', '전세', '분양', '임대아파트', '택지개발', '아파트 분양']
const LOW_KEYWORDS_EVENT = ['결혼식', '돌잔치', '장례식', '웨딩홀', '예식장']
const LOW_KEYWORDS_APP = ['사업자번호:', '전국 편의시설']

type FNReason =
  | 'too_short'
  | 'ad'
  | 'realestate'
  | 'event'
  | 'boilerplate'
  | 'news'
  | 'app_fragment'
  | 'thin'

function getFNReason(text: string): FNReason | null {
  const tier = classifyByRule({ fullText: text, fullTextStatus: 'ok', title: '' })
  if (tier !== 'low') return null
  if (text.length < 500) return 'too_short'
  if (AD_PATTERNS.some((p) => p.test(text))) return 'ad'
  const lower = text.toLowerCase()
  if (LOW_KEYWORDS_REALESTATE.some((k) => lower.includes(k))) return 'realestate'
  if (LOW_KEYWORDS_EVENT.some((k) => lower.includes(k))) return 'event'
  if (BOILERPLATE_RE.test(text)) return 'boilerplate'
  if (NEWS_RE.test(text)) return 'news'
  if (LOW_KEYWORDS_APP.some((k) => lower.includes(k))) return 'app_fragment'
  return 'thin'
}

const counts: Record<FNReason, number> = {
  too_short: 0,
  ad: 0,
  realestate: 0,
  event: 0,
  boilerplate: 0,
  news: 0,
  app_fragment: 0,
  thin: 0,
}

let fnCount = 0
for (const row of rows) {
  const reason = getFNReason(row.full_text)
  if (reason) {
    fnCount++
    counts[reason]++
  }
}

console.log(`\nFN 원인 분석 (PASS 샘플 ${rows.length}건 중 FN ${fnCount}건):`)
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
for (const [reason, count] of sorted) {
  if (count > 0) {
    console.log(`  ${reason.padEnd(15)} ${count}건 (${((count / fnCount) * 100).toFixed(1)}%)`)
  }
}

const thinFN = counts.thin
const tooShortFN = counts.too_short
const totalMediumPass = rows.filter(
  (r) => classifyByRule({ fullText: r.full_text, fullTextStatus: 'ok', title: '' }) === 'medium',
).length
const totalHighPass = rows.filter(
  (r) => classifyByRule({ fullText: r.full_text, fullTextStatus: 'ok', title: '' }) === 'high',
).length

console.log('\n── 현재 수치 ──')
console.log(`  high:   ${totalHighPass}건 (FP 0건 유지 중)`)
console.log(`  medium: ${totalMediumPass}건`)
console.log(`  low:    ${fnCount}건 (FN)`)

// FAIL 샘플 medium 추정 (eval 결과에서 알고 있음: 356건)
const failMedium = 356
const totalMedium = totalMediumPass + failMedium
console.log(
  `\n전체 medium (PASS+FAIL): ~${totalMedium}건 / 2000 = ${((totalMedium / 2000) * 100).toFixed(1)}%`,
)

console.log('\n── 시나리오별 예측 (FAIL 샘플 medium은 변동 없다고 가정) ──')
console.log(`\nA — thin rule 완전 제거:`)
console.log(
  `  medium: ${totalMediumPass + thinFN + failMedium}건 / 2000 = ${(((totalMediumPass + thinFN + failMedium) / 2000) * 100).toFixed(1)}%  (FN: ${fnCount - thinFN}건)`,
)

console.log(`\nB — too_short (500→200) 완화:`)
console.log(
  `  medium: ${totalMediumPass + tooShortFN + failMedium}건 / 2000 = ${(((totalMediumPass + tooShortFN + failMedium) / 2000) * 100).toFixed(1)}%  (FN: ${fnCount - tooShortFN}건)`,
)

console.log(`\nC — thin + too_short 둘 다 제거:`)
const cMedium = totalMediumPass + thinFN + tooShortFN + failMedium
console.log(
  `  medium: ${cMedium}건 / 2000 = ${((cMedium / 2000) * 100).toFixed(1)}%  (FN: ${fnCount - thinFN - tooShortFN}건)`,
)
