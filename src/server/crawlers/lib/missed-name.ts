/**
 * 매칭에 실패한 글에서 「DB 에 없는 주차장」 이름을 뽑는다 (A-5).
 *
 * 크론 매처(`match-to-lots.ts`)의 `extractSearchKeywords` 는 FTS 후보 검색용이라
 * 제목·본문 앞 5단어를 그대로 쓴다. 이름으로 쓰기엔 "오늘 다녀온 …" 같은 필러가 섞인다.
 * 여기 추출기는 `scripts/run-pipeline-149.ts` 가 `web_sources_missed.missed_lot_name` 을
 * 만들 때 쓰던 **장소명 추출기를 그대로 옮긴 것**이다 — 크론으로 넘어가며 missed 적재가
 * 끊겼으니(2026-08-19 이후 0건) 같은 규칙으로 이어 붙인다.
 *
 * 매칭 검색 키워드는 건드리지 않는다. 이 추출기는 missed 이름을 짓는 데만 쓴다.
 */

import { classify, NOISE_TYPES, normalizeName } from './missed-classify'

const STOP_WORDS = new Set([
  '주차장',
  '주차',
  '후기',
  '정보',
  '공유',
  '추천',
  '이용',
  '이용후기',
  '요금',
  '무료',
  '저렴',
  '가격',
  '시간',
  '위치',
  '근처',
  '주변',
  '최신',
  '리스트',
  '포함',
  '안내',
  '방법',
  '꿀팁',
  '총정리',
  '비교',
  '네이버',
  '블로그',
  '카페',
  '유튜브',
  '플레이스',
  '리뷰',
  // 장소 유형 제네릭 명사 — 단독 키워드로는 너무 범용적
  '축구장',
  '야구장',
  '수영장',
  '운동장',
  '경기장',
  '공연장',
  '박물관',
  '미술관',
  '도서관',
  '터미널',
  '입장',
  '관람',
  '가볼만한곳',
  // 블로그 제목 필러 — 장소명이 아닌 머리말/수식어 (place name이 뒤로 밀려 누락되는 주원인)
  '여행',
  '가기',
  '좋은',
  '함께',
  '나의',
  '다녀와서',
  '다녀온',
  '다녀왔어요',
  '아이랑',
  '아이들과',
  '가족여행',
  '나들이',
  '당일치기',
  '둘러보기',
  '방문기',
  '방문',
  '코스',
  '명소',
  '인근',
  '예약',
  '갈만한',
  '갈만한곳',
  '가볼만한',
  '주말',
  // 주차장 유형 수식어 — lot name에 포함돼도 너무 범용적 (공영주차장 등)
  '공영',
  '민영',
  '노상',
  '노외',
  '부설',
  '임시',
  '기계식',
])

const keep = (w: string) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)

/** 제목(없으면 본문 앞부분)에서 장소명 토큰을 뽑는다. run-pipeline-149 의 추출기와 같다. */
export function extractMissedLotName(title: string, content: string): string[] {
  // Primary: words before '주차장' in title
  if (title.includes('주차장')) {
    const beforeParking = title.slice(0, title.indexOf('주차장')).trim()
    const words = beforeParking
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(keep)
    const unique = [...new Set(words)]
    // 선두(보통 장소명) + 말미(주차장 직전) 토큰을 함께 보존.
    // slice(-3)만 쓰면 "스타필드 시티 위례 … 다이소 주차장"에서 장소명을 통째로 잃음.
    const candidates = [...new Set([...unique.slice(0, 3), ...unique.slice(-3)])]
    if (candidates.length > 0 && candidates.some((w) => w.length >= 2)) return candidates
  }

  // Fallback 1: strip parking keywords from title, extract remaining
  const titleUnique = [
    ...new Set(
      title
        .replace(/주차장|주차/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(keep),
    ),
  ]
  // 장소명은 보통 가장 긴 복합명사(김제시립도서관/양구선사박물관/과천과학관).
  // 앞 N개 컷은 "아이들과 함께 가기 좋은 …" 같은 필러 머리말을 잡아 장소명을 잃음.
  if (titleUnique.length > 0)
    return [...titleUnique].sort((a, b) => b.length - a.length).slice(0, 5)

  // Fallback 2: extract from content snippet (covers "XX 방문기" titles with parking in body)
  const contentUnique = [
    ...new Set(
      content
        .slice(0, 300)
        .replace(/주차장|주차/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(keep),
    ),
  ]
  if (contentUnique.length === 0) return []
  return [...contentUnique].sort((a, b) => b.length - a.length).slice(0, 5)
}

/**
 * 추출된 장소명이 노이즈(지역명/일반명/페이지·서비스명/추출 파편)인가.
 * 노이즈면 missed 로 보내지 않는다 — 이미 DB 에 있는 lot 이나 파편으로 missed 가 재오염되지 않게.
 */
export function isNoiseLotName(name: string): boolean {
  return NOISE_TYPES.has(classify(normalizeName(name)).type)
}
