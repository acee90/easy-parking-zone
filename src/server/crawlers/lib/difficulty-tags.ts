/**
 * 난이도 키워드 정규화
 *
 * `web_sources.ai_difficulty_keywords` 는 AI 가 뽑은 말이 원형 그대로 들어 있다.
 * 같은 뜻이 흩어져 있어 그대로 세면 태그가 쪼개진다 —
 * 예: 좁(182) / 좁다(113) / 좁음(36) / 좁은(32) / 협소(55) 가 서로 다른 태그가 된다.
 *
 * 여기서 표준 태그로 모은다. AI 재호출 없이 사전 하나로 끝난다.
 * 원형 빈도 출처: remote D1 실측 2026-09-02.
 *
 * 순수 함수. DB 접근 없음.
 */

export type TagPolarity = 'good' | 'bad' | 'neutral'

export interface DifficultyTag {
  /** 화면에 보여줄 이름 */
  label: string
  polarity: TagPolarity
}

/**
 * 표준 태그 정의
 *
 * ⚠️ 원칙: **뜻이 하나로 읽히는 말만 매핑한다.**
 * 2026-09-02 감사에서 드러난 문제는 전부 "포괄적인 말을 구체적인 태그로 단정"한 것이었다.
 * 예: `불편`(413 lot)을 '진입 어려움'으로 매핑했는데, 불편의 원인은 요금일 수도 통로일 수도 있다.
 * 근거 없는 구체화보다 덜 구체적이더라도 맞는 말이 낫다.
 */
const TAGS: Record<string, DifficultyTag> = {
  crowded: { label: '혼잡', polarity: 'bad' },
  complicated: { label: '복잡함', polarity: 'bad' },
  narrow: { label: '협소', polarity: 'bad' },
  spacious: { label: '넓음', polarity: 'good' },
  slope: { label: '경사', polarity: 'bad' },
  mechanical: { label: '기계식', polarity: 'bad' },
  entrance: { label: '진입 어려움', polarity: 'bad' },
  pillar: { label: '기둥', polarity: 'bad' },
  underground: { label: '지하', polarity: 'neutral' },
  turning: { label: '회전 어려움', polarity: 'bad' },
  height: { label: '높이 제한', polarity: 'bad' },
  convenient: { label: '편리', polarity: 'good' },
  free: { label: '무료', polarity: 'good' },
  public: { label: '공영', polarity: 'neutral' },
  caution: { label: '주의 필요', polarity: 'bad' },
  waiting: { label: '대기 발생', polarity: 'bad' },
  oneway: { label: '일방통행', polarity: 'bad' },
  // 원인을 특정할 수 없는 말들. 구체적인 태그로 단정하지 않고 있는 그대로 보여준다.
  inconvenient: { label: '불편하다는 평', polarity: 'bad' },
  difficult: { label: '어렵다는 평', polarity: 'bad' },
}

/**
 * 원형 → 표준 태그 키
 *
 * 여기에 없는 말은 버린다. 뜻이 갈리는 말을 억지로 넣는 것보다 안 보여주는 편이 낫다.
 */
const SYNONYMS: Record<string, string> = {
  // 혼잡 계열 — 자리가 없다는 뜻으로만 읽힌다
  혼잡: 'crowded',
  만차: 'crowded',
  붐빔: 'crowded',
  대기: 'waiting',

  // 복잡 — 혼잡(자리 없음)과 구조 복잡함을 둘 다 뜻할 수 있어 따로 둔다
  복잡: 'complicated',

  // 좁다 계열
  좁: 'narrow',
  좁다: 'narrow',
  좁음: 'narrow',
  좁은: 'narrow',
  협소: 'narrow',
  작: 'narrow',
  작음: 'narrow',

  // 넓다 계열
  넓: 'spacious',
  넓다: 'spacious',
  넓음: 'spacious',
  넓은: 'spacious',
  큰: 'spacious',
  여유: 'spacious',

  경사: 'slope',
  경사로: 'slope',
  가파: 'slope',
  가파름: 'slope',
  오르막: 'slope',
  내리막: 'slope',

  기계식: 'mechanical',
  기계: 'mechanical',

  // 진입 계열 — 어디가 문제인지가 분명한 말만
  진입: 'entrance',
  진입로: 'entrance',
  진입어려움: 'entrance',
  '진입 어려움': 'entrance',
  입구: 'entrance',

  기둥: 'pillar',
  지하: 'underground',

  회전: 'turning',
  회전반경: 'turning',

  높이: 'height',
  높: 'height',
  높이제한: 'height',
  '높이 제한': 'height',

  편리: 'convenient',
  편의: 'convenient',

  무료: 'free',
  공영: 'public',

  주의: 'caution',
  위험: 'caution',

  일방통행: 'oneway',

  // 원인 불명 — 있는 그대로만
  불편: 'inconvenient',
  어렵: 'difficult',
  어려: 'difficult',
  어려움: 'difficult',
  어렵다: 'difficult',
  어려운: 'difficult',
  힘듦: 'difficult',

  // ── 일부러 뺀 것 (2026-09-02 감사) ────────────────────────────
  // 부담(45 lot)  : 요금 부담인지 운전 부담인지 알 수 없다
  // 폭(27 lot)    : '폭포'에서 잘린 조각일 수 있다
  // 급(24 lot)    : '급속충전'의 조각일 수 있다
  // 제한(19 lot)  : 시간·이용 제한일 수 있는데 '높이 제한'으로 단정했었다
  // 층(18 lot)    : 지상 N층 주차타워가 '지하'로 표시됐었다
  // 편(95 lot)    : '편의점', '한 편' 등으로도 쓰인다
}

/** 함께 뜨면 서로 말이 안 되는 짝 */
const OPPOSITES: Array<[string, string]> = [['narrow', 'spacious']]

export interface NormalizedTag extends DifficultyTag {
  key: string
  count: number
}

/**
 * 원형 키워드 배열들을 표준 태그로 모아 빈도순으로 돌려준다.
 * 사전에 없는 말은 버린다 — 화면에 뜻 모를 조각을 띄우지 않기 위해서다.
 */
export function normalizeDifficultyKeywords(
  rawArrays: (string[] | null | undefined)[],
): NormalizedTag[] {
  const counts = new Map<string, number>()
  for (const arr of rawArrays) {
    if (!arr) continue
    // 한 글에서 같은 태그가 여러 번 나와도 1회로 센다
    const seen = new Set<string>()
    for (const raw of arr) {
      // Object.prototype 상속 키('constructor', '__proto__' 등)가 원형으로 들어오면
      // SYNONYMS[...] 가 함수를 돌려줘 아래 TAGS 조회와 정렬에서 터진다 → 상세페이지 500.
      const trimmed = raw?.trim()
      if (!trimmed || !Object.hasOwn(SYNONYMS, trimmed)) continue
      const key = SYNONYMS[trimmed]
      if (!key || seen.has(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  // 상반된 태그가 나란히 뜨면 읽는 사람에게 아무 정보도 못 준다 (실측 94곳에서 '협소'와 '넓음' 동시 노출).
  // 더 많이 언급된 쪽만 남기고, 같으면 둘 다 버린다 — 어느 쪽이라고 말할 근거가 없기 때문이다.
  for (const [a, b] of OPPOSITES) {
    const ca = counts.get(a)
    const cb = counts.get(b)
    if (ca === undefined || cb === undefined) continue
    if (ca > cb) counts.delete(b)
    else if (cb > ca) counts.delete(a)
    else {
      counts.delete(a)
      counts.delete(b)
    }
  }

  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, ...TAGS[key] }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** JSON 문자열로 저장된 값을 안전하게 배열로 바꾼다 */
export function parseKeywordJson(value: string | null | undefined): string[] | null {
  if (!value || value === '[]') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null
  } catch {
    return null
  }
}
