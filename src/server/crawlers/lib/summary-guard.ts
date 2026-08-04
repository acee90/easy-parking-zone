/**
 * ai_summary 품질 가드 — single source of truth
 *
 * 사양은 `ai-summary-prompt.ts`(요약 작성 규칙)가 정의하고,
 * 이 파일은 "생성된 요약이 그 사양을 위반했는지" 판정한다.
 *
 * 배경: 요약 자리에 원문 스크랩이 그대로 저장되는 사고가 반복됐다.
 * `apply-summaries.ts`(재생성 경로)에는 가드가 있었으나
 * `run-pipeline-149.ts`(신규 적재 경로)에는 없어 그쪽으로 계속 유입됐다.
 * 두 경로가 이 모듈을 공유한다.
 *
 * 패턴은 감이 아니라 2026-08-04 운영 D1 실측에서 도출했다.
 * 노출 중인 요약 12,561건 중 4,265건(34%)이 아래 아티팩트를 갖고 있었고,
 * 표본 검수 결과 전부 원문 스크랩이었다.
 */

/** 요약 권장 상한. 초과하면 본문을 raw로 복사한 신호로 본다. */
export const MAX_SUMMARY_LENGTH = 800

/**
 * 한글 비율 하한.
 * 실측: 정상 요약은 0.7~1.0에 몰려 있고, 0.55 미만은 마크다운/URL 파라미터 덩어리였다.
 */
export const MIN_HANGUL_RATIO = 0.55

/**
 * 블로그/카페 chrome·보일러플레이트·인젝션 패턴.
 * `ai-summary-prompt.ts`의 boilerplate 사양과 대응한다.
 */
const CHROME_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'naver_blog_menu', re: /MY메뉴 열기|_My Menu|클립만들기|블로그 앱|내 상품 관리 NEW/ },
  { name: 'naver_blog_chrome', re: /이 블로그의 체크인|이 장소의 다른 글/ },
  { name: 'naver_blog_font_ctrl', re: /본문 폰트 크기 (조정|작게|크게)|본문 기타 기능/ },
  { name: 'naver_cafe_chrome', re: /홈 로그인하기|로그인이 필요합니다|useCafeId=false/ },
  { name: 'site_skip_nav', re: /Skip to content|컨텐츠로 건너뛰기|본문 바로가기/ },
  { name: 'llm_injection', re: /OpenAI GPT|이 텍스트를 자동으로 처리|저작권 보호를 받습니다/ },
  { name: 'network_error', re: /로딩중입니다|네트워크 문제/ },
  { name: 'coupang_partners', re: /쿠팡 파트너스/ },
  {
    name: 'meta_only',
    re: /(정보를?\s*제공합니다|정보를?\s*확인할 수 있습니다|상세\s*정보를?\s*포함합니다|정책 변경 여부를?\s*확인)/,
  },
  { name: 'ai_disclosure', re: /(AI[가]? 분석|데이터에 따르면|본 페이지는 자동|AI 생성 콘텐츠)/ },
  { name: 'qa_template', re: /(Q\.\s*[^A]+A\.\s*)/ },
]

/**
 * 원문 스크랩 아티팩트.
 * 마크다운이 부분적으로 뭉개진 상태로 저장되기 때문에,
 * "온전한 마크다운 문법"만 보는 패턴은 전부 우회된다는 것이 확인됐다.
 * (예: `![](` 대신 맨 `(https://...png)`, 줄머리 `#` 대신 문장 중간 `#`)
 * 따라서 문법이 아니라 **잔재**를 본다.
 */
const SCRAPE_ARTIFACTS: { name: string; re: RegExp }[] = [
  // 요약에 URL이 남아 있으면 원문이다. 사양상 요약은 URL을 포함하지 않는다.
  { name: 'url', re: /https?:\/\// },
  // 네이버 블로그 본문 스크랩의 지문. 정상 생성 요약에는 나올 수 없다. (실측 2,053건)
  { name: 'zero_width', re: /​/ },
  // 마크다운 강조/링크 잔재.
  // `**`(2개)까지 넓힌 근거: 실측 2,459건 중 다른 아티팩트가 없는 1,592건을 표본 검수한 결과
  // 서로 다른 1,477종이 전부 집계사이트·날씨위젯·DB필드 나열이었다(= 사양의 boilerplate).
  // 정상 요약은 평문 산문이라 `**`를 쓰지 않는다.
  { name: 'markdown_bold_residue', re: /\*\*/ },
  { name: 'markdown_link_residue', re: /\]\(/ },
  // 스킴이 잘려 도메인 꼬리만 남은 URL: "com/grandie126/2239", "com 02haeun )" (실측 403건)
  { name: 'orphan_url_tail', re: /(?:^|\s)com[/\s][\w\-./]/ },
  // URL 쿼리 파라미터 잔재 (실측 169건)
  { name: 'query_param', re: /\b(?:blogId|categoryNo|logCode|postlist)\b/ },
  // 네이버 이미지 파라미터 잔재: "type w80_blur)"
  { name: 'image_param_residue', re: /type\s+w\d+_blur/ },
  // 퍼센트 인코딩 덩어리
  { name: 'percent_encoding', re: /%[0-9A-Fa-f]{2}%[0-9A-Fa-f]{2}/ },
]

/** 공백 제외 문자 중 한글 비율. */
export function hangulRatio(s: string): number {
  const dense = s.replace(/\s/g, '')
  if (dense.length === 0) return 0
  const hangul = dense.match(/[가-힣]/g)?.length ?? 0
  return hangul / dense.length
}

/**
 * 요약이 원문 스크랩·보일러플레이트인지 판정한다.
 * 위반하면 사유 문자열, 정상이면 null.
 *
 * 길이 하한(MIN_SUMMARY_LENGTH)은 여기서 보지 않는다 —
 * 호출부마다 정책이 달라서(신규 적재 vs 기존과 비교) 각자 판단한다.
 */
export function detectSummaryPollution(summary: string | null | undefined): string | null {
  if (!summary) return null
  if (summary.length > MAX_SUMMARY_LENGTH) return 'too_long'
  for (const { name, re } of SCRAPE_ARTIFACTS) {
    if (re.test(summary)) return `artifact:${name}`
  }
  for (const { name, re } of CHROME_PATTERNS) {
    if (re.test(summary)) return `chrome:${name}`
  }
  // 한글 비율은 아티팩트에 안 걸린 잔여 케이스를 잡는 최후 그물.
  // 짧은 문자열은 비율이 불안정하므로 일정 길이 이상에만 적용한다.
  if (summary.length >= 40 && hangulRatio(summary) < MIN_HANGUL_RATIO) return 'low_hangul'
  return null
}
