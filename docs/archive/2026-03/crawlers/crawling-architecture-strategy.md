# 데이터 수집 시스템 아키텍처 전략

## 실행 환경 분리

크롤러 특성에 따라 두 환경으로 분리:

| 환경 | 대상 | 이유 |
|------|------|------|
| **Cloudflare Workers Cron** (scheduled) | naver-blogs, youtube | HTTP API 기반, 가벼움, D1 직접 접근 |
| **GitHub Actions** (schedule) | naver-place | Playwright 필요 → Worker 불가 |
| **로컬 CLI** | import-*, curate-*, collect-* | 비정기 수동 실행 |

### Workers Cron (API 기반 크롤러)

`wrangler.jsonc`에 cron 트리거 설정, Worker의 `scheduled` 핸들러로 실행.
외부 노출 없는 private 실행. D1 바인딩(`env.DB`) 직접 사용.

```jsonc
// wrangler.jsonc
{
  "triggers": {
    "crons": ["0 18 * * 0"]  // 매주 일요일 새벽 3시(KST)
  }
}
```

**변환 포인트:**
- `execSync("wrangler d1 execute ...")` → `env.DB.prepare().bind().run()`
- `fs` 기반 progress JSON → D1 `crawl_progress` 테이블
- 전체 처리 → 배치 N개씩 micro-batching (Worker CPU 시간 제한)

### GitHub Actions (Playwright 크롤러)

naver-place는 Playwright 필수 → Worker에서 실행 불가 → GitHub Actions.

```yaml
# .github/workflows/crawl-naver-place.yml
on:
  schedule:
    - cron: '0 18 * * 0'  # 매주 일요일 새벽 3시(KST)
  workflow_dispatch:       # 수동 트리거
```

### 스케일 전략 (GitHub Actions 무료 한도 초과 시)

```
현재: Workers Cron (API) + GitHub Actions (Playwright)
  ↓ Actions 2,000분/월 초과 시
Option A: Self-hosted Runner (집 맥/라즈베리파이 → Actions 분 수 0)
Option B: 저렴한 VPS + crontab (Oracle Cloud 무료 / Hetzner €4/월)
```

---

## 코드 구조

### 자동 크롤링 (Workers Cron용)

```
src/server/crawlers/
  naver-blogs.ts     # 네이버 블로그/카페 배치 크롤러
  youtube.ts         # YouTube 영상/댓글 배치 크롤러
  lib/
    scoring.ts       # 관련도 채점 (키워드 매칭)
    geo.ts           # 주소→지역 추출, 제네릭 이름 판별
src/server/scheduled.ts  # scheduled 핸들러 (크롤러 디스패치)
```

Workers 환경 호환:
- D1 바인딩 직접 사용 (`env.DB`)
- `fetch()` API로 외부 API 호출
- 파일시스템/shell 의존 없음
- `crawl_progress` D1 테이블로 상태 관리

### 로컬 CLI 스크립트 (기존 유지)

```
scripts/
  lib/
    d1.ts            # (기존) wrangler CLI 기반 D1 유틸
    naver-api.ts     # (기존) 네이버 검색 API
    youtube-api.ts   # (기존) YouTube API
    progress.ts      # (신규) JSON 진행 상태 관리
    sql-flush.ts     # (신규) SQL escape + 배치 flush
    geo.ts           # (신규) 주소 파싱 (crawlers/lib/geo.ts와 공유 가능)
  crawl-naver-place.ts   # Playwright 크롤러 (GitHub Actions용)
  import-csv.ts          # 공공데이터 CSV 임포트
  import-kakao.ts        # 카카오 PK6 수집
  import-naver-local.ts  # 네이버 지역검색 수집
  curate-hell-parking.ts # 큐레이션 태그 적용
  collect-1010-channel.ts # 10시10분 채널 분석
  archive/               # 일회성 완료 스크립트
    merge-duplicates.ts
    seed-reviews.ts
    backfill-summaries.ts
    register-1010-unmatched.ts
```

---

## 스크립트 역할 정의

### Workers Cron 자동 실행 (2개)

| 크롤러 | 역할 | 주기 | 배치 크기 |
|--------|------|------|-----------|
| `naver-blogs` | 네이버 블로그/카페 리뷰 수집 | 주 1회 | 주차장 10개/실행 |
| `youtube` | YouTube 영상/댓글 수집 | 주 1회 | 주차장 5개/실행 (API 쿼터) |

### GitHub Actions 자동 실행 (1개)

| 스크립트 | 역할 | 주기 |
|----------|------|------|
| `crawl-naver-place.ts` | 네이버 플레이스 방문자 리뷰 | 주 1회 |

### 로컬 CLI 수동 실행 (5개)

| 스크립트 | 역할 | 실행 시점 |
|----------|------|-----------|
| `import-csv.ts` | 공공데이터 CSV → D1 | 월 1회 (데이터 갱신) |
| `import-kakao.ts` | 카카오 PK6 주차장 수집 | 비정기 |
| `import-naver-local.ts` | 네이버 지역검색 주차장 수집 | 비정기 |
| `curate-hell-parking.ts` | 헬/이지 큐레이션 태그 적용 | 큐레이션 추가 시 |
| `collect-1010-channel.ts` | 10시10분 채널 영상 분석 | 비정기 (수동) |

### 아카이브 (4개 → `scripts/archive/`)

| 스크립트 | 아카이브 사유 |
|----------|--------------|
| `merge-duplicates.ts` | 초기 데이터 정제 완료 |
| `seed-reviews.ts` | 초기 리뷰 시딩 완료 |
| `backfill-summaries.ts` | 기존 리뷰 요약 완료 |
| `register-1010-unmatched.ts` | 등록 작업 완료 |

---

## D1 마이그레이션: crawl_progress 테이블

Workers Cron용 상태 관리 (JSON 파일 대체):

```sql
CREATE TABLE IF NOT EXISTS crawl_progress (
  crawler_id TEXT PRIMARY KEY,        -- 'naver_blogs' | 'youtube'
  last_parking_lot_id TEXT,           -- 마지막 처리한 주차장 ID (커서)
  completed_count INTEGER DEFAULT 0,
  total_target INTEGER DEFAULT 0,
  last_run_at TEXT,                   -- ISO datetime
  metadata TEXT                       -- JSON (크롤러별 추가 정보)
);
```

---

## 리팩토링 순서

1. **공통 lib 추출** — `scripts/lib/`에 progress.ts, sql-flush.ts, geo.ts
2. **일회성 스크립트 아카이브** — `scripts/archive/` 이동
3. **Workers Cron 크롤러 구현** — `src/server/crawlers/` + scheduled 핸들러
4. **crawl_progress 마이그레이션** — D1 테이블 생성
5. **wrangler.jsonc cron 설정** — scheduled 트리거 추가
6. **GitHub Actions 워크플로우** — crawl-naver-place.yml
7. **테스트 & 배포**
