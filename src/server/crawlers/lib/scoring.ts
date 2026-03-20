/**
 * 관련도 채점 공통 유틸 (Workers 환경 호환)
 */

/** 주소에서 구/동 추출 */
export function extractRegion(address: string): string {
  const parts = address.split(/\s+/);
  const regionParts: string[] = [];

  for (const part of parts) {
    if (
      /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(part)
    ) continue;
    if (/시$/.test(part) && !/(구$|군$)/.test(part)) continue;
    if (/(구|군|동|읍|면|로|길)$/.test(part)) {
      regionParts.push(part);
      if (regionParts.length >= 2) break;
    }
  }

  return regionParts.join(" ");
}

/** 제네릭 주차장 이름 감지 */
const GENERIC_PATTERNS = [
  /^제?\d+주차장$/, /^지하주차장$/, /^주차장$/, /^옥상주차장$/,
  /^야외주차장$/, /^주차타워$/, /^기계식주차장$/, /^자주식주차장$/,
  /^공영주차장$/, /^\S{1,2}주차장$/,
];

export function isGenericName(name: string): boolean {
  const cleaned = name.replace(/\s/g, "");
  return GENERIC_PATTERNS.some((p) => p.test(cleaned));
}

/** HTML 태그 및 엔티티 제거 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'")
    .trim();
}

/** "20240101" → "2024-01-01" */
export function parsePostdate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr.length !== 8) return null;
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

/** URL → SHA-256 앞 16자 해시 (dedup 용) */
export async function hashUrl(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * 부동산/광고/무관 콘텐츠 노이즈 패턴
 * (validate-ad-filter.ts AD_PATTERNS 기반 + 추가 확장)
 */
const NOISE_PATTERNS = [
  // 부동산/분양
  /모델하우스/, /분양가/, /분양정보/, /분양조건/, /잔여세대/,
  /견본주택/, /입주자모집/, /입주예정/, /공급조건/,
  /시행사/, /시공사/, /투자수익/, /프리미엄분양/,
  /빌라\s*매매/, /아파트\s*매매/, /매물/, /전세\s*모/, /월세\s*모/,
  /원룸\s*\d/, /투룸/, /쓰리룸/, /임대\s*안/,
  /신축빌라/, /신축원룸/, /경매물건/,
  /임장\s*(기록|후기|보고)/, /지구\s*임장/,
  /청약/, /재개발/, /재건축/,
  // 광고/홍보
  /체험단.*모집/, /업체\s*추천\s*(깔끔|꼼꼼)/, /메디컬빌딩/,
  // 무관 콘텐츠
  /살인사건/, /뮤지컬\s*(렌트|위키드|캣츠)/, /커튼콜/,
  /추경예산/, /예산\s*편성/,
  /청소.*업체/, /이사.*업체/, /인테리어.*업체/,
  /다이어트/, /성형/, /피부과/, /치과/,
];

/** 네이버 블로그 검색 결과 관련도 점수 (0-100) */
export function scoreBlogRelevance(
  title: string,
  description: string,
  parkingName: string,
  address: string
): number {
  const titleLower = stripHtml(title).toLowerCase();
  const descLower = stripHtml(description).toLowerCase();
  const combined = titleLower + " " + descLower;

  // 주차 관련 키워드가 없으면 0점 (게이트)
  if (!combined.includes("주차") && !combined.includes("parking")) {
    return 0;
  }

  // 노이즈 필터링
  if (NOISE_PATTERNS.some((p) => p.test(combined))) {
    return 0;
  }

  let score = 0;
  const nameLower = parkingName.toLowerCase();

  const nameKeywords = nameLower
    .replace(/주차장|공영|노외|노상|부설/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (nameKeywords.some((kw) => titleLower.includes(kw))) score += 40;
  if (nameKeywords.some((kw) => descLower.includes(kw))) score += 20;

  const region = extractRegion(address).toLowerCase();
  const regionWords = region.split(/\s+/).filter((w) => w.length >= 2);
  if (regionWords.some((rw) => titleLower.includes(rw) || descLower.includes(rw))) score += 20;

  if (titleLower.includes("주차") || descLower.includes("주차")) score += 20;

  return score;
}

/** YouTube 댓글 관련도 점수 (0-100) */
export function scoreYoutubeComment(text: string, parkingName: string): number {
  let score = 0;
  const t = text.toLowerCase();

  const parkingKw = ["주차", "parking", "차", "운전"];
  const difficultyKw = ["좁", "무서", "힘들", "긁", "어려", "공포", "골뱅이", "나선", "경사", "회전", "기둥"];
  const positiveKw = ["넓", "쉬", "편", "여유", "추천"];

  if (parkingKw.some((kw) => t.includes(kw))) score += 30;
  if (difficultyKw.some((kw) => t.includes(kw))) score += 40;
  if (positiveKw.some((kw) => t.includes(kw))) score += 20;

  const nameWords = parkingName.replace(/주차장|주차/g, "").split(/\s+/).filter((w) => w.length >= 2);
  if (nameWords.some((kw) => t.includes(kw.toLowerCase()))) score += 20;

  if (text.length < 10) score -= 20;

  return Math.max(0, Math.min(100, score));
}
