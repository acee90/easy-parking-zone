/**
 * 3-tier rule-based filter — AI 호출 없이 high/medium/low 분류
 *
 * high:   명백한 주차 경험 콘텐츠 (1인칭 서술 + 주차 경험 표현) → AI 없이 통과
 * low:    명백한 노이즈 (광고·보일러플레이트·뉴스·짧음) → AI 없이 제거
 * medium: 판단 불명확 → AI(Haiku) 호출
 *
 * 순수 함수. DB 접근 없음.
 *
 * 패턴 출처: scripts/filter-web-sources.ts (wave ground-truth 3,235건 calibrated)
 * 차이점: lot_name 없는 raw 단계이므로 lot mention count / wrong_lot 감지 미사용
 */

export type FilterTier = 'high' | 'medium' | 'low'

export interface RuleFilterInput {
  fullText: string | null
  fullTextStatus: string | null
  title: string
}

// ── 길이 임계값 ──────────────────────────────────────────────

const MIN_FULLTEXT_LENGTH = 500
const HIGH_FULLTEXT_MIN_LENGTH = 500

// ── LOW: 광고/협찬 패턴 (wave calibrated, precision ~100%) ──

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

// ── LOW: 보일러플레이트 패턴 ─────────────────────────────────
// 제거된 패턴:
//   운영\s*요일\s*평일  — 정부 공공주차장 DB(일상킷 등) 오탐 88건
//   관리번호\s*\d        — 정부 데이터 필드 오탐

const BOILERPLATE_RE =
  /주차정보\s*(?:휴무일|층별|안내)|운영시간\s*및\s*(?:요금|주차)|층별\s*안내|(?:기본\s*)?(?:시간\/요금|시간당\s*요금)|주차구획수:|운영요일:|관리기관명:|Top\s*\d+\s*(?:주차|저렴)|주변\s*주차장\s*(?:순위|Top|추천|목록)|구획수\s*\d+|1일권\s*(?:적용|요금)|월정기결제|🕒\s*운영\s*정보|총\s*주차면수\s*\d+\s*대|주차장\s*종류\s*공영/

// ── LOW: 뉴스/공공기관 발표 패턴 ─────────────────────────────

const NEWS_RE =
  /민원\s*증가|조성.*추진|운영하기로|추진한다|지자체\s*(?:는|은|가|이)\s*(?:발표|결정|추진)|보도자료|구청장|시의회|예산|기자\s*=|[가-힣]+기자\n|연합뉴스|뉴시스|뉴스1|[가-힣]{2,4}특파원|시민홍보단|SNS\s*홍보단|시민\s*기자입니다/

// ── LOW: 부동산·행사 키워드 ────────────────────────────────────

const LOW_KEYWORDS_REALESTATE = ['매매', '전세', '분양', '임대아파트', '택지개발', '아파트 분양']
const LOW_KEYWORDS_EVENT = ['결혼식', '돌잔치', '장례식', '웨딩홀', '예식장']

// 파킹 앱 UI 파편 — 앱에서 긁힌 비정형 데이터
const LOW_KEYWORDS_APP = ['사업자번호:', '전국 편의시설']

// ── HIGH: 1인칭 서술 동사 (anti-thin / anti-boilerplate) ─────

const NARRATIVE_RE =
  /했어요|했습니다|이었어요|더라고요|더라구요|가봤|이용했|주차했|방문했|다녀왔|다녀와서|들어갔|나왔|기다렸|찾았|돌았|빙빙|힘들었|어려웠|불편했|편했|좋았|나빴/g

// ── HIGH: 구체적 주차 경험 표현 ───────────────────────────────

const CONCRETE_PARKING_RE =
  /주차하기\s*(?:어렵|힘들|불편|쉽|편리|좋)|주차가\s*(?:어렵|힘들|불편|쉽|편리|좋|안됨)|주차난|만차|자리가\s*(?:없|부족|꽉)|빈\s*자리|빈자리|진입(?:로)?(?:이|가)?\s*(?:좁|어렵|힘들|복잡|막|불편)|주차\s*(?:비|요금|료)\s*(?:\d|유료|무료|비싸|저렴|싸|부담)|(?:\d+분|\d+시간)\s*(?:주차|대기|기다)|주차\s*(?:꿀팁|팁|후기|리뷰)|출차\s*(?:했|어렵|힘들|오래)|주차면|주차공간이?\s*(?:좁|협소|넓|충분|부족)|입차|출차|회전반경|일방통행|혼잡/

// high 판정용 — concrete parking 신호 출현 횟수 카운트(전역 매칭)
const CONCRETE_PARKING_RE_G = new RegExp(CONCRETE_PARKING_RE.source, 'g')

// ── 헬퍼 ─────────────────────────────────────────────────────

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase()
  return keywords.filter((kw) => lower.includes(kw)).length
}

// ── 메인 분류 함수 ────────────────────────────────────────────

export function classifyByRule(input: RuleFilterInput): FilterTier {
  // fulltext 없으면 분류 불가
  if (input.fullTextStatus !== 'ok' || !input.fullText) return 'low'

  const text = input.fullText

  // 너무 짧음
  if (text.length < MIN_FULLTEXT_LENGTH) return 'low'

  // 광고/협찬
  if (AD_PATTERNS.some((p) => p.test(text))) return 'low'

  // 부동산 / 행사
  if (countMatches(text, LOW_KEYWORDS_REALESTATE) >= 1) return 'low'
  if (countMatches(text, LOW_KEYWORDS_EVENT) >= 1) return 'low'

  // 보일러플레이트 / 뉴스
  if (BOILERPLATE_RE.test(text)) return 'low'
  if (NEWS_RE.test(text)) return 'low'

  // 앱 UI 파편
  if (countMatches(text, LOW_KEYWORDS_APP) >= 1) return 'low'

  const narrativeMatches = (text.match(NARRATIVE_RE) ?? []).length
  // 고유 신호 종류 수 (같은 토큰 반복은 1로 — "혼잡 혼잡"이 high 통과 못 하게)
  const concreteParkingCount = new Set(text.match(CONCRETE_PARKING_RE_G) ?? []).size
  const hasConcreteParking = concreteParkingCount > 0

  // 제목에 주차 키워드 없으면 → 주차 경험 콘텐츠 최소 기준 확인
  // 여행기·맛집·관광지 방문기에서 "주차장 있음" 한 줄 언급 수준은 low로 처리
  const hasParkingInTitle = /주차/.test(input.title)
  if (!hasParkingInTitle && (narrativeMatches < 2 || !hasConcreteParking)) {
    return 'low'
  }

  // high: 충분한 길이 + 1인칭 서술 2회 이상 + 구체적 주차 표현 2회 이상.
  // concrete parking 1회(맛집글의 "주차 무료" 한 줄 등)는 high 아님 → medium(AI 판정).
  if (
    text.length >= HIGH_FULLTEXT_MIN_LENGTH &&
    narrativeMatches >= 2 &&
    concreteParkingCount >= 2
  ) {
    return 'high'
  }

  return 'medium'
}
