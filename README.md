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

## 기술 스택

- **Framework**: [TanStack Start](https://tanstack.com/start) (SSR) + React 19
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Map**: Naver Maps (react-naver-maps)
- **Auth**: better-auth (카카오/네이버/구글 소셜 로그인)
- **Database**: Cloudflare D1
- **Deployment**: Cloudflare Workers
- **Testing**: Vitest + Testing Library
- **Runtime**: Bun

## 시작하기

### 사전 요구사항

- [Bun](https://bun.sh/) v1.0+
- Cloudflare 계정 (D1, Workers)
- 네이버 지도 API 키

### 설치 및 실행

```bash
# 의존성 설치
bun install

# 개발 서버 실행
bun --bun run dev

# 프로덕션 빌드
bun --bun run build

# 테스트
bun --bun run test

# Cloudflare Workers 배포
bun run deploy
```

## 프로젝트 구조

```
src/
├── components/         # 공유 컴포넌트
│   ├── ui/            # shadcn/ui (자동 생성)
│   ├── MapView.tsx    # 네이버 지도
│   ├── Header.tsx     # 상단 헤더
│   ├── SearchBar.tsx  # 검색바
│   ├── FloatingFilters.tsx  # 플로팅 필터
│   ├── ParkingCard.tsx      # 주차장 카드
│   ├── ParkingDetailPanel.tsx  # 주차장 상세
│   ├── ParkingSidebar.tsx   # 사이드바
│   └── VoteBookmarkBar.tsx  # 투표/북마크
├── hooks/             # 커스텀 훅
├── lib/               # 유틸리티
├── routes/            # 파일 기반 라우팅
├── server/            # 서버 함수 (리뷰, 투표, 주차장)
└── types/             # 타입 정의
scripts/               # 데이터 수집/처리 스크립트
```

## 데이터 소스

| 소스 | 용도 | 갱신 주기 |
|------|------|-----------|
| 공공데이터포털 전국주차장정보 | 기본 주차장 데이터 | 월 1회 |
| 한국교통안전공단 주차정보 API | 실시간 잔여면수 | 실시간 |
| 카카오 Local API (PK6) | 보완 데이터 | 수시 |
| 네이버 블로그/카페 크롤링 | 리뷰 데이터 (56K+건) | 수시 |
| 네이버 플레이스 크롤링 | 방문자 리뷰 (Playwright) | 수시 |
| YouTube 크롤링 | 헬 주차장 영상/댓글 | 수시 |
| 자체 크라우드소싱 | 난이도 평가 리뷰 | 실시간 |

## 데이터 수집 스크립트

모든 스크립트는 `--remote` 플래그로 리모트 D1에 직접 실행 가능.
자세한 아키텍처는 [docs/crawling-architecture-strategy.md](docs/crawling-architecture-strategy.md) 참고.

### 활성 스크립트

| 스크립트 | 역할 | 실행 시점 |
|----------|------|-----------|
| `import-csv.ts` | 공공데이터 CSV → D1 | 월 1회 (데이터 갱신 시) |
| `import-kakao.ts` | 카카오 PK6 주차장 수집 | 비정기 |
| `import-naver-local.ts` | 네이버 지역검색 주차장 수집 | 비정기 |
| `crawl-naver-blogs.ts` | 네이버 블로그/카페 리뷰 | 비정기 (리뷰 보강) |
| `crawl-youtube.ts` | YouTube 영상/댓글 | 비정기 (리뷰 보강) |
| `crawl-naver-place.ts` | 네이버 플레이스 방문자 리뷰 | 비정기 (리뷰 보강) |
| `curate-hell-parking.ts` | 헬/이지 큐레이션 태그 적용 | 큐레이션 추가 시 |
| `collect-1010-channel.ts` | 10시10분 채널 영상 분석 | 비정기 (수동) |

```bash
bun run scripts/crawl-naver-place.ts           # 로컬 D1
bun run scripts/crawl-naver-place.ts --remote  # 리모트 D1
```

### 공통 라이브러리 (`scripts/lib/`)

| 파일 | 역할 |
|------|------|
| `d1.ts` | D1 쿼리/실행 유틸, `--remote` 지원 |
| `naver-api.ts` | 네이버 검색 API 래퍼 |
| `youtube-api.ts` | YouTube Data API 래퍼 |
| `progress.ts` | JSON 기반 진행 상태 관리 (중단/재개) |
| `sql-flush.ts` | SQL escape, INSERT 생성, 배치 flush |
| `geo.ts` | 주소→지역 추출, 제네릭 이름 판별 |

## 라이선스

Private
