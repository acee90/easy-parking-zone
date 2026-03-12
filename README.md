# 쉬운주차

> 지도 앱에 주차장 위치는 나오는데, "얼마나 어려운 주차장인지"는 안 알려준다.

초보 운전자를 위한 전국 주차장 난이도 지도 서비스.

**문제** — 좁은 입구, 급경사 램프, 기계식 주차 등 초보에게 위험한 주차장 정보가 어디에도 없음
**해결** — 주차장 난이도를 지도 위에 시각화하여, 목적지 전에 주차 난이도부터 확인

[기획서 (Notion)](https://mellow-bracket-e7f.notion.site/3152d9c5abbf81e39f71c5ab21cd35ec)

## 주요 기능

- **주차장 난이도 지도** — 네이버 지도 기반, 난이도를 아이콘(😊/🙂/💀)으로 표시
- **난이도 평가 시스템** — 진입로, 주차면 크기, 통로 여유, 출차 난이도, 종합 추천도 5개 항목 평가
- **헬 주차장 큐레이션** — 유명 난코스 주차장 99곳 태그 + YouTube 영상/댓글 연동
- **소셜 로그인** — 카카오/네이버/구글 로그인 후 리뷰 작성
- **투표/북마크** — 주차장 난이도 투표 및 즐겨찾기
- **플로팅 필터** — 주차장 유형, 요금, 난이도 등 필터링

## 난이도 등급

| 점수 | 아이콘 | 라벨 | 설명 |
|------|--------|------|------|
| 4.0-5.0 | 😊 | 초보 추천 | 넓고 여유로움 |
| 2.5-3.9 | 🙂 | 보통 | 약간의 주의 필요 |
| 1.5-2.4 | 💀 | 주의 | 좁거나 복잡함, 경험 필요 |
| 1.0-1.4 | 💀💀 | 초보 비추 | 매우 좁거나 기계식 |

## 아키텍처

### 전체 구조

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React 19 + TanStack Router)                  │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────┐ │
│  │ MapView  │ │ Sidebar  │ │DetailPanel │ │ Filters  │ │
│  │(NaverMap)│ │(목록+검색)│ │(리뷰/블로그)│ │(난이도등)│ │
│  └────┬─────┘ └────┬─────┘ └─────┬──────┘ └────┬─────┘ │
│       └─────────────┴─────────────┴─────────────┘       │
│                         ↕ createServerFn (RPC)          │
├─────────────────────────────────────────────────────────┤
│  Server Layer (TanStack Start SSR)                      │
│  parking.ts │ reviews.ts │ votes.ts │ admin.ts          │
│  transforms.ts (순수 변환) │ auth (better-auth)         │
├─────────────────────────────────────────────────────────┤
│  Database (Cloudflare D1 + Drizzle ORM)                 │
│  17 tables │ parking_lot_stats (사전 계산 점수)          │
├─────────────────────────────────────────────────────────┤
│  Data Pipeline (scripts/)                               │
│  CSV 가져오기 → 크롤링 → 감성분석 → 베이지안 점수 산출   │
└─────────────────────────────────────────────────────────┘
```

### 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프레임워크 | [TanStack Start](https://tanstack.com/start) (SSR) + React 19 |
| 스타일 | Tailwind CSS v4 + shadcn/ui (new-york, zinc) |
| 지도 | Naver Maps (react-naver-maps) |
| DB | Cloudflare D1 (SQLite) + Drizzle ORM |
| 인증 | better-auth (카카오/네이버/구글 + 익명) |
| 배포 | Cloudflare Workers |
| 테스트 | Vitest + Testing Library |
| 런타임 | bun (로컬) / workerd (프로덕션) |

### 서버 레이어

`createServerFn()` (TanStack isomorphic RPC) 패턴으로 클라이언트↔서버 통신.

| 함수 | 역할 | 쿼리 방식 |
|------|------|-----------|
| `fetchParkingLots()` | 바운드+필터 기반 주차장 목록 | Raw SQL (공간 쿼리) |
| `fetchParkingClusters()` | 그리드 클러스터링 | Raw SQL |
| `searchParkingLots()` | 이름/주소/POI 검색 | Raw SQL LIKE |
| `createReview()` | 리뷰 작성 (24h 제한) | Drizzle ORM |
| `toggleVote()` | 추천/비추천 | Drizzle ORM |
| `fetchSiteStats()` | 통계 (6시간 캐시) | Drizzle ORM |

**하이브리드 SQL 전략**: 복잡한 쿼리(클러스터링, bounds, JOIN)는 `sql.raw()`, 단순 CRUD는 Drizzle ORM.

### DB 스키마 (17 테이블)

```
[인증]    user, account, session, verification
[주차장]  parking_lots (poi_tags JSON), parking_lot_stats (사전 계산 점수)
[리뷰]    user_reviews (5개 항목 1-5점), web_sources (크롤링 콘텐츠)
[미디어]  parking_media (유튜브, 스트리트뷰)
[참여]    parking_votes, parking_bookmarks
[어드민]  cafe_signals, cafe_signal_lots, curation_candidates, poi_unmatched
[크롤링]  crawl_progress
```

### 난이도 점수 시스템

4개 소스의 베이지안 가중 평균 → `parking_lot_stats.final_score`에 사전 계산:

| 소스 | 비중 | 데이터 |
|------|------|--------|
| 유저 리뷰 | 50% | 앱 내 5개 항목 점수 |
| 커뮤니티 리뷰 | 30% | 클리앙, 유튜브 댓글 |
| 텍스트 감성 | 15% | 블로그/카페 크롤링 (IDF 가중 63개 키워드) |
| 구조적 사전분포 | 5% | 주차면 수, 유형, 기계식 여부 |

시간감쇠 적용 — 오래된 리뷰일수록 가중치 감소.

### 지도 UX

- 줌 ≤14: **클러스터 마커** (그리드 기반, 개수에 따라 32~160px 동적 크기)
- 줌 >14: **개별 마커** (난이도 색상 😊→💀 + 큐레이션 배지 🔥/👍)
- 선택 마커: 핀 꼬리 + 바운스 애니메이션 + 파란 테두리
- 클러스터 클릭 → 해당 위치로 줌인

### 인증 & 보안

- **소셜 로그인**: 카카오/네이버/구글 (better-auth)
- **익명 참여**: `anon_[uuid]` 쿠키로 비로그인 리뷰/투표 가능
- **리뷰 제한**: IP 해시 기반 24시간 1회/주차장

## 시작하기

### 사전 요구사항

- [Bun](https://bun.sh/) v1.0+
- Cloudflare 계정 (D1, Workers)
- 네이버 지도 API 키

### 설치 및 실행

```bash
bun install              # 의존성 설치
bun --bun run dev        # 개발 서버
bun --bun run build      # 프로덕션 빌드
bun --bun run test       # 테스트
bun run deploy           # Cloudflare Workers 배포
```

## 프로젝트 구조

```
src/
├── components/              # UI 컴포넌트
│   ├── ui/                  # shadcn/ui (자동 생성)
│   ├── MapView.tsx          # 네이버 지도 + 마커/클러스터
│   ├── Header.tsx           # 상단 헤더 + 검색 + 로그인
│   ├── SearchBar.tsx        # 디바운스 검색
│   ├── FloatingFilters.tsx  # 난이도/유형/요금 필터
│   ├── ParkingCard.tsx      # 주차장 카드
│   ├── ParkingDetailPanel.tsx  # 상세 패널 (리뷰/블로그/미디어 탭)
│   ├── ParkingSidebar.tsx   # 좌측 목록
│   └── VoteBookmarkBar.tsx  # 투표/북마크
├── db/
│   ├── schema.ts            # 17 테이블 정의 (Drizzle)
│   ├── index.ts             # getDb() 팩토리 (D1 듀얼 모드)
│   └── d1-proxy.ts          # 리모트 D1 REST API 프록시
├── hooks/
│   ├── useGeolocation.ts    # 브라우저 위치 감지
│   └── useParkingFilters.ts # 필터 상태 + 쿠키 저장
├── lib/
│   ├── geo-utils.ts         # 거리 계산, 난이도 아이콘/라벨
│   ├── filter-utils.ts      # 필터 → SQL 변환
│   ├── vote-utils.ts        # 익명 투표자 ID 관리
│   └── utils.ts             # cn() Tailwind 유틸
├── routes/
│   ├── __root.tsx           # HTML 셸 (SEO/OG/GA4)
│   ├── index.tsx            # 메인 지도 페이지
│   └── admin/               # 어드민 대시보드
├── server/
│   ├── parking.ts           # 주차장 조회/검색/클러스터링
│   ├── reviews.ts           # 리뷰 CRUD + 레이트 리밋
│   ├── votes.ts             # 투표/북마크
│   ├── admin.ts             # 어드민 API
│   ├── transforms.ts        # DB row ↔ 프론트 타입 변환 (순수 함수)
│   └── lib/auth.ts          # better-auth 설정
├── types/
│   └── parking.ts           # ParkingLot, MapBounds, MarkerCluster 등
└── styles.css               # Tailwind v4 + CSS 변수 (oklch)

scripts/                     # 데이터 파이프라인
├── lib/                     # 공통 라이브러리 (d1, naver-api, progress 등)
├── import-csv.ts            # 공공데이터 CSV → D1
├── crawl-naver-blogs.ts     # 네이버 블로그/카페 크롤링
├── crawl-blogs.ts           # 멀티엔진 크롤러 (--engine=naver|kakao)
├── crawl-youtube.ts         # YouTube 영상/댓글
├── compute-text-scores.ts   # 58K 감성 점수 배치 산출
├── compute-parking-stats.ts # 베이지안 통합 점수 → parking_lot_stats
└── curate-hell-parking.ts   # 헬/이지 큐레이션 태깅

migrations/                  # D1 마이그레이션 (0001~0022)
```

## 데이터 소스

| 소스 | 용도 | 갱신 주기 |
|------|------|-----------|
| 공공데이터포털 전국주차장정보 | 기본 주차장 데이터 | 월 1회 |
| 한국교통안전공단 주차정보 API | 실시간 잔여면수 | 실시간 |
| 카카오 Local API (PK6) | 보완 데이터 | 수시 |
| 네이버 블로그/카페 크롤링 | 리뷰 데이터 (56K+건) | 수시 |
| 카카오(다음) 블로그 크롤링 | 티스토리 등 외부 블로그 | 수시 |
| 네이버 플레이스 크롤링 | 방문자 리뷰 (Playwright) | 수시 |
| YouTube 크롤링 | 헬 주차장 영상/댓글 | 수시 |
| POI 파이프라인 | 대형마트/병원/관광지 주변 주차장 | 수시 |
| 자체 크라우드소싱 | 난이도 평가 리뷰 | 실시간 |

## 데이터 파이프라인

```
1. 원본 가져오기
   import-csv.ts (공공데이터 CSV)
   import-kakao.ts (카카오 로컬 API)
   import-naver-local.ts (네이버 플레이스)

2. 크롤링 → web_sources
   crawl-blogs.ts --engine=naver|kakao (블로그/카페)
   crawl-youtube.ts (유튜브 댓글+미디어)
   collect-poi-content.ts → analyze-poi-content.ts → load-poi-to-db.ts (POI)

3. 점수 산출
   compute-keyword-idf.ts → data/keyword-idf.json (63 키워드 IDF)
   compute-text-scores.ts → web_sources.sentiment_score 배치
   compute-parking-stats.ts → parking_lot_stats 테이블

4. 큐레이션
   curate-hell-parking.ts (헬주차장 99곳 태깅)
```

모든 스크립트는 `--remote` 플래그로 리모트 D1에 직접 실행 가능.

```bash
bun run scripts/crawl-blogs.ts --engine=kakao           # 카카오 블로그
bun run scripts/crawl-blogs.ts --engine=naver --remote   # 네이버 + 리모트 D1
```

## 라이선스

Private
