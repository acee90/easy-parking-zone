/**
 * 검색 엔진 추상화 — Naver / Kakao(Daum) 블로그 검색 통합 인터페이스
 *
 * 환경변수:
 *   Naver: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 *   Kakao: KAKAO_CLIENT_ID (= REST API 키)
 */

// ─── 공통 인터페이스 ───

export interface SearchItem {
  title: string;        // HTML 태그 포함 가능
  link: string;
  description: string;  // HTML 태그 포함 가능
  author: string;
  postdate: string | undefined; // "20240101" or ISO
}

export interface SearchResult {
  total: number;
  items: SearchItem[];
}

export type SourceType = "naver_blog" | "naver_cafe" | "daum_blog";

export interface SearchChannel {
  name: string;
  sourceType: SourceType;
  search(query: string, display: number): Promise<SearchResult>;
}

export interface SearchEngine {
  name: string;
  channels: SearchChannel[];
  validateEnv(): void;
}

// ─── Naver 구현 ───

const NAVER_BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";
const NAVER_CAFE_URL = "https://openapi.naver.com/v1/search/cafearticle.json";

function naverHeaders(): Record<string, string> {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) throw new Error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정");
  return { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret };
}

interface NaverItem {
  title: string;
  link: string;
  description: string;
  bloggername?: string;
  cafename?: string;
  postdate?: string; // "20240101"
}

interface NaverResponse {
  total: number;
  items: NaverItem[];
}

function naverToSearchItem(item: NaverItem, isCafe: boolean): SearchItem {
  return {
    title: item.title,
    link: item.link,
    description: item.description,
    author: (isCafe ? item.cafename : item.bloggername) ?? "",
    postdate: item.postdate,
  };
}

async function searchNaver(
  url: string,
  query: string,
  display: number,
  isCafe: boolean,
): Promise<SearchResult> {
  const params = new URLSearchParams({
    query,
    display: String(display),
    start: "1",
    sort: "sim",
  });
  const res = await fetch(`${url}?${params}`, { headers: naverHeaders() });
  if (!res.ok) throw new Error(`Naver API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as NaverResponse;
  return {
    total: data.total,
    items: data.items.map((i) => naverToSearchItem(i, isCafe)),
  };
}

export function createNaverEngine(): SearchEngine {
  return {
    name: "naver",
    channels: [
      {
        name: "블로그",
        sourceType: "naver_blog",
        search: (q, d) => searchNaver(NAVER_BLOG_URL, q, d, false),
      },
      {
        name: "카페",
        sourceType: "naver_cafe",
        search: (q, d) => searchNaver(NAVER_CAFE_URL, q, d, true),
      },
    ],
    validateEnv() {
      if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
        throw new Error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 .env에 설정되지 않았습니다.");
      }
    },
  };
}

// ─── Kakao (Daum) 구현 ───

const KAKAO_BLOG_URL = "https://dapi.kakao.com/v2/search/blog";

interface KakaoDocument {
  title: string;
  contents: string;
  url: string;
  blogname: string;
  datetime: string; // ISO 8601
}

interface KakaoResponse {
  meta: { total_count: number; pageable_count: number };
  documents: KakaoDocument[];
}

function kakaoHeaders(): Record<string, string> {
  const key = process.env.KAKAO_CLIENT_ID;
  if (!key) throw new Error("KAKAO_CLIENT_ID 미설정");
  return { Authorization: `KakaoAK ${key}` };
}

function kakaoToSearchItem(doc: KakaoDocument): SearchItem {
  // datetime "2024-03-15T12:00:00.000+09:00" → "20240315"
  const postdate = doc.datetime ? doc.datetime.slice(0, 10).replace(/-/g, "") : undefined;
  return {
    title: doc.title,
    link: doc.url,
    description: doc.contents,
    author: doc.blogname,
    postdate,
  };
}

async function searchKakaoBlog(query: string, display: number): Promise<SearchResult> {
  const params = new URLSearchParams({
    query,
    size: String(Math.min(display, 50)),
    sort: "accuracy",
  });
  const res = await fetch(`${KAKAO_BLOG_URL}?${params}`, { headers: kakaoHeaders() });
  if (!res.ok) throw new Error(`Kakao Blog API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as KakaoResponse;
  return {
    total: data.meta.total_count,
    items: data.documents.map(kakaoToSearchItem),
  };
}

export function createKakaoEngine(): SearchEngine {
  return {
    name: "kakao",
    channels: [
      {
        name: "블로그",
        sourceType: "daum_blog",
        search: searchKakaoBlog,
      },
    ],
    validateEnv() {
      if (!process.env.KAKAO_CLIENT_ID) {
        throw new Error("KAKAO_CLIENT_ID가 .env에 설정되지 않았습니다.");
      }
    },
  };
}

// ─── 엔진 팩토리 ───

export function getEngine(name: string): SearchEngine {
  switch (name) {
    case "naver": return createNaverEngine();
    case "kakao": return createKakaoEngine();
    default: throw new Error(`알 수 없는 검색 엔진: ${name}. (naver | kakao)`);
  }
}
