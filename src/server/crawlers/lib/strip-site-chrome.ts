/**
 * 블로그 메뉴·버튼 글자(site chrome) 제거
 *
 * 크롤한 본문 앞뒤에는 글 내용이 아니라 그 블로그의 내비게이션이 붙어 온다.
 * "글쓰기 관리 로그인 로그아웃 메뉴 홈 태그 방명록 RSS" 같은 것들이다.
 * 이게 그대로 요약에 섞여 화면과 검색엔진에 노출되고 있었다
 * (2026-09-02 라이브 실측: 취득 41개 페이지 중 4개에서 확인, 최악 10회).
 *
 * 순수 함수. DB 접근 없음.
 */

/** 통째로 지우는 상용구. 순서 중요 — 긴 것부터 지운다. */
const CHROME_PHRASES = [
  /skip\s+to\s+(?:main|sidebar|content)(?:\s*\|\s*skip\s+to\s+\w+)*/gi,
  /콘텐츠로\s*건너뛰기/g,
  /본문\s*바로가기/g,
  /Table\s+of\s+Contents/gi,
  /CATEGORY\s*분류\s*전체보기\s*\(\s*\d+\s*\)/g,
  /분류\s*전체보기\s*\(\s*\d+\s*\)/g,
  /티스토리\s*뷰/g,
  /(?:\*\s*)?Sample\s+Page/gi,
  /예제\s*페이지/g,
  /블로그\s*내\s*검색/g,
  /블로그\s*이미지\s*관리/g,
  /소개\s*페이지\s*\(About\)/gi,
  /연락처\s*페이지\s*\(Contact\)/gi,
  /\(\s*Privacy\s+Policy\s*\)/gi,
  /광고\s*게재\s*방침\s*\(Advertising\s+Policy\)/gi,
  /\d{3,4}x\d{2,3}/g, // 728x90 등 광고 슬롯 표기
]

/**
 * 메뉴 낱말은 두 등급으로 나눈다.
 *
 * STRONG: 주차 후기 문장에는 사실상 등장하지 않는 말. 홀로 있어도 지운다.
 * WEAK:   일반 문장에도 쓰이는 말("입구에서 관리 아저씨가", "다음 날 다시"). 2개 이상
 *         연달아 붙어 있을 때만 메뉴로 보고 지운다.
 */
const CHROME_WORDS_STRONG = [
  '글쓰기',
  '방명록',
  'RSS',
  '로그아웃',
  '구독하기',
  '즐겨찾기',
  '티스토리',
]

const CHROME_WORDS_WEAK = [
  '관리',
  '로그인',
  '메뉴',
  '홈',
  '태그',
  '검색',
  '닫기',
  '구독',
  '공유하기',
  '이전',
  '다음',
  '목록',
  '프로필',
  '알림',
]

const ALL_CHROME = [...CHROME_WORDS_STRONG, ...CHROME_WORDS_WEAK]

/**
 * 낱말 경계.
 *
 * 한국어에는 `\b` 가 듣지 않는다. 경계가 없으면 매치가 앞 낱말의 꼬리에서 시작하거나
 * 뒤 낱말의 머리를 먹는다 — 실제로 "부산신부관리 검색"이 "부산신부"로 잘렸고,
 * "이전 다음 홈페이지에서…"는 "페이지에서…"가 됐다.
 */
const B = '[가-힣A-Za-z0-9]'

/** 2개 이상 연달아 나오는 메뉴 낱말 나열 */
const WORD_RUN = new RegExp(
  `(?<!${B})(?:(?:${ALL_CHROME.join('|')})(?!${B})\\s+){2,}(?:(?:${ALL_CHROME.join('|')})(?!${B}))?`,
  'g',
)

/** 홀로 있어도 지우는 낱말 */
const STRONG_RE = new RegExp(`(?<!${B})(?:${CHROME_WORDS_STRONG.join('|')})(?!${B})`, 'g')

/**
 * 메뉴 글자를 걷어낸 뒤 이 길이 미만이면 "내용은 없고 메뉴만 있던 글"로 본다.
 *
 * ⚠️ **아무것도 안 지웠으면 이 임계를 적용하지 않는다.** 원래 짧았을 뿐인 멀쩡한 요약까지
 * 버리기 때문이다. 실제로 운영 데이터 272건이 그렇게 사라지고 있었다 —
 * "초보자도 쉬운 넓은 주차장"(14자) 같은 요약이 null 이 되면 `summary ?? snippet` 폴백이
 * 걸려 그 자리에 렌터카 시승 후기 같은 **원문 스크랩**이 대신 뜬다. 고치려던 문제를 되레 키운다.
 */
const MIN_USEFUL_LENGTH = 40

export interface StripResult {
  text: string | null
  /** 제거된 글자 수 */
  removed: number
  /** 메뉴 글자가 하나라도 있었는가 */
  hadChrome: boolean
}

export function stripSiteChrome(input: string | null | undefined): StripResult {
  if (!input) return { text: null, removed: 0, hadChrome: false }
  const original = input
  let s = input

  for (const re of CHROME_PHRASES) s = s.replace(re, ' ')
  s = s.replace(WORD_RUN, ' ')
  s = s.replace(STRONG_RE, ' ')
  // 나열이 지워지며 새로 인접해진 낱말을 한 번 더 훑는다
  s = s.replace(WORD_RUN, ' ')

  // 공백 정리
  s = s
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  // 앞머리에 남은 구두점·기호 정리
  s = s.replace(/^[\s|·•\-–—>»#*!]+/, '').trim()

  const trimmedOriginal = original.trim()
  const removed = Math.max(0, trimmedOriginal.length - s.length)
  // 공백만 정리돼도 길이가 바뀐다. 실제로 글자를 들어낸 경우만 "메뉴가 있었다"로 본다.
  const hadChrome = s !== collapseWhitespace(trimmedOriginal)

  // 지운 게 없으면 원문을 그대로 돌려준다 — 짧다는 이유만으로 버리지 않는다
  if (!hadChrome) return { text: s || null, removed, hadChrome }

  if (s.length < MIN_USEFUL_LENGTH) return { text: null, removed, hadChrome }
  return { text: s, removed, hadChrome }
}

/** 공백 정규화만 적용 — hadChrome 판정 기준을 맞추려고 쓴다 */
function collapseWhitespace(v: string): string {
  return v
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .replace(/^[\s|·•\-–—>»#*!]+/, '')
    .trim()
}

/** 메뉴 글자가 섞여 있는지만 빠르게 본다 (배치 대상 선별용) */
export function hasSiteChrome(input: string | null | undefined): boolean {
  return stripSiteChrome(input).hadChrome
}
