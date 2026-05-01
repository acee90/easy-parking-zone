# Architecture

> 최종 업데이트: 2026-05-01

## Overview

**쉬운주차** — 초보운전자를 위한 전국 주차장 난이도 지도 서비스.
TanStack Start full-stack React app deployed to Cloudflare Workers.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | TanStack Start (TanStack Router 기반, SSR) |
| Styling | Tailwind CSS v4 + shadcn/ui (new-york, zinc) |
| Animation | motion (Framer Motion v12 리브랜드) — 데스크톱 패널 슬라이드 |
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
  components/         # 공유 컴포넌트 (Header, MapView, DesktopMapPanel, ParkingCard)
  components/parking-reputation/  # 위키 상세 평판 섹션 (Carousel, Star*, ReviewForm)
  components/ui/      # shadcn/ui (자동 생성, 수동 편집 금지)
  hooks/              # React 훅 (useGeolocation, useSuperCluster, useParkingFilters)
  lib/                # 유틸리티 (cn, geo-utils, parking-display, sheet-snap)
  routes/             # 파일 기반 라우팅 (TanStack Router)
  routes/wiki/$slug.{reviews,media,blog}.tsx # 위키 상세 전체 보기 sub-routes (noindex)
  routes/event/       # 이벤트 페이지 (반값여행 등)
  server/             # 서버 함수 (parking, admin, auth)
  server/crawlers/    # 크롤러 + AI 필터 + 매칭
  server/crawlers/lib/ # 공통 유틸 (scoring, sentiment, ai-filter)
  types/              # 타입 정의
  db/                 # Drizzle ORM 스키마 + D1 바인딩
scripts/              # 배치 스크립트 (import, compute, crawl)
migrations/           # D1 마이그레이션 SQL (0001~0035)
docs/                 # 프로젝트 문서 (design-docs/exec-plans/product-specs/references/archive)
```

## Routing

파일 기반 라우팅. `src/routes/`에 파일 생성 시 자동 등록.
- `src/routeTree.gen.ts` — 자동 생성 (편집 금지)
- `src/routes/__root.tsx` — 루트 레이아웃 (`shellComponent` 패턴)

Path alias: `@/*` -> `./src/*`

## Desktop Map UI (`/`)

데스크톱 지도 페이지는 `DesktopMapPanel` 단일 컨테이너 안에서 List ↔ Detail
뷰를 iOS 네비게이션 컨트롤러 스타일로 push/pop 슬라이드한다.

```
DesktopMapPanel (360px, 좌측 island)
├─ Persistent header (h-12)              ← 슬라이드 안 됨
│   ├─ list 모드: ParkingSquare + "주차장 목록" + 개수
│   └─ detail 모드: ◀ "목록" 뒤로가기
│   (모드 전환 시 헤더 콘텐츠는 cross-fade 150ms)
└─ Body (flex-1, overflow-hidden)
    ├─ list 뷰: ParkingSidebar (거리순 정렬)
    └─ detail 뷰: ParkingDetailPanel (위키 톤)
    (motion AnimatePresence mode="sync"로 동시 진행 슬라이드 250ms)
```

### 인터랙션 모델
- 첫 클릭 (사이드바/마커) → highlight + 지도 센터 이동 (디테일 안 띄움)
- 같은 항목 재클릭 → detail로 push 슬라이드
- 선택된 사이드바 항목 우측 ChevronRight 아이콘이 시각적 어포던스
- 헤더 검색 / `?lotId=` deep link → detail 직행 (명시적 의도)
- ◀ "목록" 또는 ESC → list로 pop, 직전 선택은 highlight 유지

### 상태 모델
- `selectedLot` — highlight 대상. 데스크톱/모바일 공유.
- `viewMode: 'list' | 'detail'` — 데스크톱 슬라이드 토글 전용.
- 모바일은 `viewMode` 무시. `selectedLot != null`이면 `ParkingCard` 자동 노출.

## Mobile Map UI (`/`)

- `MobileBottomPanel` — 지도 위 짧은 미리보기 패널 (선택 전).
- `ParkingCard` — 선택 시 바텀시트. 2-stop 스냅 (`mid=320` / `full=85vh`).
  - 드래그 종료 시 `nearestSnap()` (`src/lib/sheet-snap.ts`)으로 가까운 스냅으로 이동.
  - mid에서 추가 120px 아래로 드래그 시 close.
  - sticky 헤더에 `touch-none` 적용, 드래그 중 `overflow-hidden`으로 콘텐츠 스크롤 충돌 방지.
- viewport-fit=cover + `pb-safe` 유틸로 노치 기기 대응.

## Database (2-Table Pipeline)

```
web_sources_raw    # 크롤링 원본 + 필터링 상태 관리
  -> AI 필터 + 매칭 통과
web_sources        # 검증된 데이터만 (is_ad, filter_passed 컬럼 없음)

parking_lots       # 주차장 마스터 (34,719건)
parking_lot_stats  # 통합 스코어 (Bayesian)
parking_media      # YouTube 미디어
user_reviews       # 사용자 리뷰 (점수 REAL, 0.5 단위)
nearby_places      # 위키 주변 장소 (AI 추출, 0031)
content_reports    # 콘텐츠 신고
```

> Note: `0036_review_score_real.sql`은 PR #117에서 최초 `0031_*`로 추가되어 prod에 직접 적용됐으나, 0031 prefix 충돌로 0036으로 rename됨. 신규 환경에서는 0035 다음에 정상 적용된다.

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
- `fetchBlogPosts(limit: 7)` — **상위 7개 블로그 스니펫 SSR** (구글봇 가시성)
- `fetchUserReviews(limit: 7)`, `fetchParkingMedia(limit: 7)` — 캐러셀 7개 SSR

리뷰/영상/관련 웹사이트는 `ParkingReputationSections`와 섹션별 컴포넌트로 렌더링.

각 섹션 캐러셀은 7개 노출, 초과 시 "전체 보기" 링크로 sub-route 이동:
- `/wiki/$slug/reviews` — 사용자 리뷰 vertical list (`noindex`)
- `/wiki/$slug/media` — 영상 grid (`noindex`)
- `/wiki/$slug/blog` — 웹사이트 compact list + 페이지네이션 (`noindex`)

sub-route는 canonical을 부모 페이지로 지정, 사이트맵 미포함.

## Deployment

```bash
bun run deploy    # build + wrangler deploy
```

- Cloudflare Workers (SSR)
- D1 database binding: `DB`
- Workers Cron: 매시 정각 + 매시 30분
- Secrets: `ANTHROPIC_API_KEY`, `CRAWL4AI_URL`, `NAVER_CLIENT_ID/SECRET`, etc.
