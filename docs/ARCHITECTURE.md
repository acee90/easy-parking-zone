# Architecture

> 최종 업데이트: 2026-04-14

## Overview

**쉬운주차** — 초보운전자를 위한 전국 주차장 난이도 지도 서비스.
TanStack Start full-stack React app deployed to Cloudflare Workers.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | TanStack Start (TanStack Router 기반, SSR) |
| Styling | Tailwind CSS v4 + shadcn/ui (new-york, zinc) |
| Map | Naver Maps (react-naver-maps) |
| Database | Cloudflare D1 (SQLite) |
| Deployment | Cloudflare Workers + wrangler |
| Testing | Vitest + @testing-library/react (jsdom) |
| Crawling | Workers Cron + Anthropic Haiku |
| Clustering | SuperCluster (서버사이드 → 클라이언트 전환) |
| Scoring | Bayesian 통합 (유저리뷰 + 텍스트 감성분석) |

## Data Sources

| 소스 | 용도 | 주기 |
|------|------|------|
| 공공데이터포털 전국주차장정보표준데이터 | 기본 데이터 | 월 1회 |
| 한국교통안전공단 주차정보 API v2 | 실시간 잔여면수 | 실시간 |
| 카카오 Local API PK6 | 보완 데이터 | 필요시 |
| 자체 크라우드소싱 리뷰 | 난이도 평가 | 상시 |
| 웹 크롤링 (블로그/카페/YouTube) | 텍스트 감성분석 | 매시간 |

## Directory Structure

```
src/
  components/         # 공유 컴포넌트 (Header, MapView)
  components/ui/      # shadcn/ui (자동 생성, 수동 편집 금지)
  hooks/              # React 훅 (useGeolocation, useSuperCluster, useParkingFilters)
  lib/                # 유틸리티 (cn, geo-utils)
  routes/             # 파일 기반 라우팅 (TanStack Router)
  routes/event/       # 이벤트 페이지 (반값여행 등)
  server/             # 서버 함수 (parking, admin, auth)
  server/crawlers/    # 크롤러 + AI 필터 + 매칭
  server/crawlers/lib/ # 공통 유틸 (scoring, sentiment, ai-filter)
  types/              # 타입 정의
  db/                 # Drizzle ORM 스키마 + D1 바인딩
scripts/              # 배치 스크립트 (import, compute, crawl)
migrations/           # D1 마이그레이션 SQL (0001~0033)
docs/                 # 프로젝트 문서
```

## Routing

파일 기반 라우팅. `src/routes/`에 파일 생성 시 자동 등록.
- `src/routeTree.gen.ts` — 자동 생성 (편집 금지)
- `src/routes/__root.tsx` — 루트 레이아웃 (`shellComponent` 패턴)

Path alias: `@/*` -> `./src/*`

## Database (2-Table Pipeline)

```
web_sources_raw    # 크롤링 원본 + 필터링 상태 관리
  -> AI 필터 + 매칭 통과
web_sources        # 검증된 데이터만 (is_ad, filter_passed 컬럼 없음)

parking_lots       # 주차장 마스터 (34,719건)
parking_lot_stats  # 통합 스코어 (Bayesian)
parking_media      # YouTube 미디어
user_reviews       # 사용자 리뷰
nearby_places      # 위키 주변 장소 (AI 추출, 0031)
content_reports    # 콘텐츠 신고
```

상세: [Crawling Pipeline](poi-pipeline-v2.md)

## SEO

### 사이트맵 구조

`src/server/sitemap-handler.ts` — Worker에서 D1 직접 쿼리로 동적 생성

| 경로 | 내용 |
|------|------|
| `/sitemap.xml` | 사이트맵 인덱스 (static + 메인 N개) |
| `/sitemap-static.xml` | 홈, /wiki |
| `/sitemap-N.xml` | **web_sources 있는 주차장만** (5,000개 단위, 구글 제출 대상) |
| `/sitemap-thin-N.xml` | web_sources 없는 주차장 (인덱스 미포함, 대기) |

web_sources가 보강되면 `sitemap-N.xml`에 자동 반영됨 (카운트 동적 계산).

### 상세 페이지 SSR 콘텐츠

`src/routes/wiki/$slug.tsx` loader에서 병렬 fetch:
- `fetchParkingDetail` — 기본 정보 + AI 요약/팁
- `fetchNearbyPlaces` — 주변 POI
- `fetchBlogPosts(limit: 5)` — **상위 5개 블로그 스니펫 SSR** (구글봇 가시성)

리뷰/영상/관련 웹사이트는 `ParkingReputationSections`와 섹션별 컴포넌트로 렌더링.

## Deployment

```bash
bun run deploy    # build + wrangler deploy
```

- Cloudflare Workers (SSR)
- D1 database binding: `DB`
- Workers Cron: 매시 정각 + 매시 30분
- Secrets: `ANTHROPIC_API_KEY`, `CRAWL4AI_URL`, `NAVER_CLIENT_ID/SECRET`, etc.
