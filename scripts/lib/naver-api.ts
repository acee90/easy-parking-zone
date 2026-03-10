/**
 * 네이버 블로그/카페 검색 API 래퍼
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 * https://developers.naver.com/docs/serviceapi/search/blog/blog.md
 */

const BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";
const CAFE_URL = "https://openapi.naver.com/v1/search/cafearticle.json";

interface NaverSearchItem {
  title: string;
  link: string;
  description: string;
  bloggername?: string;
  cafename?: string;
  cafeurl?: string;
  postdate?: string; // "20240101" 형태
}

interface NaverSearchResponse {
  lastBuildDate: string;
  total: number;
  start: number;
  display: number;
  items: NaverSearchItem[];
}

export type { NaverSearchItem, NaverSearchResponse };

function getHeaders(): Record<string, string> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 설정되지 않았습니다."
    );
  }
  return {
    "X-Naver-Client-Id": clientId,
    "X-Naver-Client-Secret": clientSecret,
  };
}

/** 네이버 블로그 검색 */
export async function searchNaverBlog(
  query: string,
  display = 10,
  start = 1
): Promise<NaverSearchResponse> {
  const params = new URLSearchParams({
    query,
    display: String(display),
    start: String(start),
    sort: "sim",
  });
  const res = await fetch(`${BLOG_URL}?${params}`, { headers: getHeaders() });
  if (!res.ok) throw new Error(`Naver Blog API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<NaverSearchResponse>;
}

/** 네이버 카페 검색 */
export async function searchNaverCafe(
  query: string,
  display = 10,
  start = 1
): Promise<NaverSearchResponse> {
  const params = new URLSearchParams({
    query,
    display: String(display),
    start: String(start),
    sort: "sim",
  });
  const res = await fetch(`${CAFE_URL}?${params}`, { headers: getHeaders() });
  if (!res.ok) throw new Error(`Naver Cafe API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<NaverSearchResponse>;
}

/** 네이버 검색 결과에 포함된 HTML 태그 및 엔티티 제거 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .trim();
}

/** "20240101" → "2024-01-01" */
export function parsePostdate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr.length !== 8) return null;
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

/** URL → SHA-256 앞 16자 해시 (dedup 용) */
export async function hashUrl(url: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(url);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
