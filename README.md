# 쉬운주차 (쉽주)

> 초보운전자를 위한 전국 주차장 난이도 지도 서비스

주차장의 난이도를 한눈에 파악할 수 있는 지도 서비스입니다. 크라우드소싱 리뷰와 웹 데이터 분석을 통해 주차장별 난이도를 산출합니다.

**Live**: [https://easy-parking.xyz](https://easy-parking.xyz)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | TanStack Start (SSR) |
| Frontend | React + Tailwind CSS v4 + shadcn/ui |
| Map | Naver Maps (react-naver-maps) |
| Database | Cloudflare D1 (SQLite) |
| Deployment | Cloudflare Workers |
| Testing | Vitest + Testing Library |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Data Sources                            │
├──────────┬──────────┬───────────┬───────────┬──────────────┤
│ 공공데이터 │ 네이버API │ 카카오API  │ YouTube   │ User Reviews │
│ (CSV)    │ (블로그)  │ (보완)    │ (댓글)    │ (인앱)       │
└────┬─────┴────┬─────┴─────┬────┴─────┬────┴──────┬───────┘
     │          │           │          │           │
     ▼          ▼           ▼          ▼           ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare D1 (parking-db)                     │
├─────────────────────────────────────────────────────────────┤
│ parking_lots │ web_sources │ user_reviews │ parking_media   │
│ (34K)        │ (56K)       │              │                 │
│              │ web_source_ai_matches (1:N 다중 매칭)        │
│              │ crawl_progress (크롤러 상태 추적)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Scoring Pipeline                          │
├─────────────────────────────────────────────────────────────┤
│ 1. Structural Prior (물리 특성 기반 기본점수)               │
│ 2. Source Scoring (유저리뷰 0.5 + 커뮤니티 0.3 + 텍스트 0.3)│
│ 3. Sentiment Analysis (키워드 IDF + 부정어 + 강조어)        │
│ 4. Bayesian Integration (C=1.5, 시간감쇠 365일)            │
│ 5. Reliability 분류 (confirmed/estimated/reference/...)     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Frontend                                 │
├─────────────────────────────────────────────────────────────┤
│ 지도 (클러스터/마커) │ 사이드바 (리스트) │ 상세패널/위키      │
│ 난이도: 😊 쉬움 / 🙂 보통 / 💀 주의 / 💀💀 비추            │
└─────────────────────────────────────────────────────────────┘
```

## Data Pipeline

### 자동 크롤링 (Workers Cron, 매일 UTC 03:00)

통합 크롤러가 3가지 검색 전략으로 네이버 블로그/카페를 크롤링합니다:

| 전략 | 쿼리 예시 | 대상 |
|------|----------|------|
| A. 이름 기반 | `"광화문D타워 주차장 종로구"` | 고유한 이름의 주차장 |
| B. POI 기반 | `"롯데백화점 강남점 주차장"` | poi_tags가 있는 주차장 |
| C. 지역 기반 | `"원미구 중동 주차장 추천"` | 폴백 |

- **우선순위 큐**: reliability가 낮은(데이터 부족) 주차장부터 크롤링
- **노이즈 필터**: 주차 키워드 게이트 + 부동산/광고 패턴 차단
- **다중 매칭**: B/C 전략 결과에서 여러 주차장 이름을 스캔하여 1:N 매칭

### 배치 스크립트 (수동/비정기)

| 스크립트 | 용도 |
|---------|------|
| `scripts/import-csv.ts` | 공공데이터 CSV 초기 로드 |
| `scripts/import-naver-local.ts` | 네이버 지역 검색 보완 |
| `scripts/import-kakao.ts` | 카카오 Local API 보완 |
| `scripts/poi-pipeline-local.ts` | AI 기반 1:N 주차장 매칭 |
| `scripts/compute-parking-stats.ts` | 스코어링 재계산 |
| `scripts/crawl-naver-dryrun.ts` | 크롤러 dry-run 테스트 |

## Getting Started

```bash
# 의존성 설치
bun install

# 환경변수 설정
cp .env.example .env
# .env 파일에 API 키 입력

# 개발 서버
bun --bun run dev

# 빌드
bun --bun run build

# 배포
bun run deploy
```

## Difficulty Rating

높은 점수 = 초보자에게 쉬운 주차장.

| Score | Icon | Label | 설명 |
|-------|------|-------|------|
| 4.0-5.0 | 😊 | 초보 추천 | 넓고 여유로움 |
| 2.5-3.9 | 🙂 | 보통 | 약간의 주의 필요 |
| 1.5-2.4 | 💀 | 주의 | 좁거나 복잡함 |
| 1.0-1.4 | 💀💀 | 초보 비추 | 매우 좁거나 기계식 |
