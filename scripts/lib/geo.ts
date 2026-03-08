/**
 * 주소 파싱 및 주차장 이름 유틸
 *
 * 모든 크롤링 스크립트에서 공통 사용.
 */

/**
 * 주소에서 구/동 추출 — 검색 쿼리 지역 한정용
 *
 * "서울특별시 강남구 역삼동 123-4" → "강남구 역삼동"
 * "경기도 수원시 팔달구 인계동" → "팔달구 인계동"
 */
export function extractRegion(address: string): string {
  const parts = address.split(/\s+/);
  const regionParts: string[] = [];

  for (const part of parts) {
    // 시/도 레벨은 스킵 (너무 넓음)
    if (
      /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(
        part
      )
    )
      continue;
    // 시 레벨도 스킵
    if (/시$/.test(part) && !/(구$|군$)/.test(part)) continue;
    // 구/군/동/읍/면/로/길 → 유용한 지역 키워드
    if (/(구|군|동|읍|면|로|길)$/.test(part)) {
      regionParts.push(part);
      if (regionParts.length >= 2) break;
    }
  }

  return regionParts.join(" ");
}

/** 제네릭 주차장 이름 감지 — 검색해도 무의미한 결과만 나옴 */
const GENERIC_PATTERNS = [
  /^제?\d+주차장$/,
  /^지하주차장$/,
  /^주차장$/,
  /^옥상주차장$/,
  /^야외주차장$/,
  /^주차타워$/,
  /^기계식주차장$/,
  /^자주식주차장$/,
  /^공영주차장$/,
  /^\S{1,2}주차장$/, // "A주차장", "B1주차장" 등
];

export function isGenericName(name: string): boolean {
  const cleaned = name.replace(/\s/g, "");
  return GENERIC_PATTERNS.some((p) => p.test(cleaned));
}

/** sleep 유틸 */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
