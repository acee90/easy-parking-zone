# 주차장 리뷰 데이터 크롤링 수집 계획

## 원칙

**부정확한 데이터는 없는 것보다 못하다.**

- 크롤링 텍스트에서 수치 점수를 추출하지 않는다
- 난이도 점수의 유일한 소스는 사용자 크라우드소싱 리뷰다
- 크롤링 데이터는 원문 + 링크 형태의 **참고 자료**로만 제공한다

---

## 데이터 소스

### Phase 1 — 공식 API (즉시 가능)

| 소스 | 방식 | 일일 한도 | 리스크 |
|------|------|-----------|--------|
| 네이버 블로그 검색 API | 공식 API | 25,000콜 | 낮음 |
| 네이버 카페 검색 API | 공식 API | 25,000콜 | 낮음 |

### Phase 2 — 비공식 스크래핑 (Phase 1 이후)

| 소스 | 방식 | 가치 | 리스크 |
|------|------|------|--------|
| 네이버 Place 리뷰 | Playwright 스크래핑 | 높음 — 실제 방문자 후기, 별점, 사진 | ToS 위반 가능, 구조 변경에 취약 |
| 카카오맵 리뷰 | Playwright 스크래핑 | 높음 — 카카오 사용자 리뷰 | ToS 위반 가능, 구조 변경에 취약 |

Phase 2 운영 방침:
- 보수적 rate limit (요청 간 2-5초), 서버 부하 최소화
- User-Agent 위장하지 않음
- robots.txt 준수
- 구조 변경 감지 시 자동 중단
- Phase 1 결과 평가 후 필요 시 진행

---

## DB 스키마

```sql
-- migrations/0002_crawled_reviews.sql

CREATE TABLE IF NOT EXISTS crawled_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  source TEXT NOT NULL,        -- 'naver_blog' | 'naver_cafe' | 'naver_place' | 'kakaomap'
  source_id TEXT NOT NULL,     -- URL 해시 (중복방지)
  source_url TEXT,
  title TEXT,
  content TEXT NOT NULL,       -- 검색 결과 snippet (원문)
  author TEXT,
  published_at TEXT,
  crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_crawled_reviews_lot ON crawled_reviews(parking_lot_id);
```

점수 분석 테이블 없음. 원문 저장만 한다.

---

## 파이프라인

### 1. 크롤링 스크립트

파일: `scripts/crawl-naver-blogs.ts`

```
DB에서 주차장 목록 → 각각 네이버 블로그/카페 검색 → crawled_reviews에 INSERT OR IGNORE
```

- 환경변수: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`
- API: `https://openapi.naver.com/v1/search/blog.json?query={주차장명}+주차&display=10`
- Rate limit: 요청 간 300ms 딜레이
- 중복 방지: `source_id` = URL 해시

### 2. API 클라이언트

파일: `scripts/lib/naver-api.ts`

- 블로그/카페 검색 엔드포인트 래퍼
- 인증 헤더, 에러 핸들링, rate limit 처리

---

## 서버 연동

`src/server/parking.ts`에서 주차장 상세 조회 시 `crawled_reviews`를 함께 반환:

```sql
SELECT source, title, content, source_url, published_at
FROM crawled_reviews
WHERE parking_lot_id = ?
ORDER BY published_at DESC
LIMIT 5
```

UI에서 "관련 후기" 섹션으로 표시. 사용자가 원문 링크를 클릭해 직접 읽을 수 있도록 한다.

---

## 새 파일

```
migrations/0002_crawled_reviews.sql    -- crawled_reviews 테이블
scripts/lib/naver-api.ts               -- 네이버 API 클라이언트
scripts/crawl-naver-blogs.ts           -- 블로그/카페 크롤링
```

## 수정 파일

```
src/server/parking.ts                  -- 상세 조회 시 crawled_reviews 반환
src/types/parking.ts                   -- 관련 후기 타입 추가
package.json                           -- scripts 항목 추가
```

## 환경변수

```
NAVER_CLIENT_ID=...       # https://developers.naver.com
NAVER_CLIENT_SECRET=...
```

## 실행

```bash
wrangler d1 migrations apply parking-db --local
bun run scripts/crawl-naver-blogs.ts
```
