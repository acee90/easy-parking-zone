# 구현 계획: 풀텍스트 fetcher 라이브러리 + 파일럿 (#139)

> Parent: #138 — Phase A
> Milestone: M9 콘텐츠 보강을 위한 크롤링 파이프라인 개선
> Scope: 로컬/배치 재처리용 라이브러리 + 단위 테스트 + 파일럿 측정. Cron 통합·schema 변경·AI filter rewiring은 별도 sub-issue (#140/#141).

## 요구사항 정리

Naver 블로그/카페·DDG 검색 결과 URL에서 본문 텍스트만 추출하는 라이브러리를 만든다. 다운스트림 (#140 batch refetch, 크롤러 통합) 에서 호출 가능한 단일 진입점.

본 문서는 #139 한정. #140 이후 작업은 본 문서 후반의 "본 이슈에서 다루지 않음" 섹션 참고.

## 현재 상태 파악

- `web_sources_raw` (215,603 row): 크롤링 원본. `content` 평균 127자 = Naver/DDG API의 description snippet
- `web_sources` (22,398 row, matched): SEO 가치 풀. `full_text` 컬럼 (migration 0024 보유) 평균 0자 — 미사용
- `match-to-lots.ts:256`: raw.ai_summary가 그대로 web_sources.ai_summary로 복사 → 22K 모두 빈약 summary
- `package.json`: `jsdom` devDep 보유, `cheerio`/`@mozilla/readability` 미보유
- 크롤러 파일: `src/server/crawlers/{naver-blogs,duckduckgo-search,brave-search}.ts` 모두 snippet 저장만

## 구현 단계 (의존성 순서)

### Phase 1 — 의존성 추가

`package.json`:
- `cheerio` (HTML 파싱)
- `@mozilla/readability` (일반 본문 추출)
- `jsdom` 은 이미 devDep 보유 → readability 호환 위해 (옵션) `dependencies` 승격 검토. 본 이슈는 라이브러리만이므로 devDep 그대로 두고 사용 시점에서만 import.

검증: `bun install` → 번들 크기 영향 측정 (참고용, 본 이슈 게이트 아님).

### Phase 2 — 라이브러리 골격

신규 파일: `src/server/crawlers/lib/full-text-fetcher.ts`

```ts
export type FetchStatus =
  | 'ok'           // 본문 정상 추출 (length >= 200)
  | 'blocked'      // 로그인/captcha/성인인증/비공개/429
  | 'not_found'    // 404, 글 삭제
  | 'too_short'    // 추출은 됐으나 length < 200
  | 'timeout'      // 10s 초과
  | 'error'        // 그 외 (DNS, 5xx, 파싱 실패)

export interface FetchResult {
  status: FetchStatus
  text: string         // 추출된 본문 ('ok' 일 때만 의미)
  contentLength: number
  finalUrl: string     // redirect 후 최종 URL
  reason?: string      // 디버그 메시지 ('blocked' 사유 등)
}

export type SourceType = 'naver_blog' | 'naver_cafe' | 'ddg_search'

export async function fetchFullText(
  url: string,
  sourceType: SourceType,
): Promise<FetchResult>
```

**내부 유틸 분리** (같은 파일 또는 `lib/full-text-fetcher/` 디렉토리로 분할):
- `fetchWithTimeout(url, opts): Promise<{ status, html, finalUrl, headers }>` — undici fetch + AbortController, 10s 타임아웃, max-redirects 5
- `normalizeFinalUrl(response): string` — redirect chain 종착지 정규화
- `detectBlocked(html, httpStatus): { blocked: boolean, reason?: string }` — 로그인 페이지 / captcha / 성인인증 / 429 / 비공개 패턴 감지
- `cleanText(rawText): string` — 공백·개행 정규화, 광고 라인 제거 휴리스틱 ("쿠팡 파트너스" 등)
- `statusFromTextLength(len): FetchStatus` — < 200 → `'too_short'`, 그 외 `'ok'`

### Phase 3 — 사이트별 추출기

같은 파일 내 함수 또는 `lib/full-text-fetcher/extractors/`:

#### naver_blog

URL 패턴: `blog.naver.com/{id}/{logNo}` 또는 `blog.naver.com/PostView.naver?...`

처리 흐름:
1. `fetchWithTimeout(url)` → HTML
2. `cheerio` 로 `#mainFrame` iframe src 추출
3. iframe URL 재호출 (`fetchWithTimeout`)
4. 셀렉터 우선순위 (첫 매칭 사용):
   - `.se-main-container` (스마트에디터3, 신규)
   - `.post-view` (구버전)
   - `#postViewArea` (구구버전)
5. text content 추출 → `cleanText`

#### naver_cafe

URL 패턴: `cafe.naver.com/{cafeId}/{articleId}` 등

처리 흐름:
1. 모바일 URL 변환 시도 (`m.cafe.naver.com/...`)
2. fetch → HTML → `detectBlocked` (cafe는 로그인/비공개 비율 높음)
3. blocked 면 즉시 return
4. 셀렉터 우선순위:
   - `.se-main-container`
   - `.ContentRenderer`
   - `.NHN_Writeform_Main` (구버전)
5. 모바일 실패 시 데스크탑 URL fallback (iframe 추적 필요)

#### ddg_search

다양한 도메인 → 일반화된 처리:
1. `fetchWithTimeout(url)` → HTML
2. `jsdom` 으로 DOM 생성
3. `@mozilla/readability` 로 본문 추출
4. readability 실패 시 cheerio fallback (`article` → `main` → `body` 순)
5. `cleanText`

도메인 화이트/블랙리스트는 본 이슈에서 도입하지 않음 (#140 파일럿 결과 본 후 결정).

### Phase 4 — 단위 테스트

신규: `src/server/crawlers/lib/full-text-fetcher.test.ts`

fixture 디렉토리: `src/server/crawlers/lib/__fixtures__/full-text-fetcher/`
- `naver_blog/se3.html` — 스마트에디터3 본문 (실제 페이지 저장)
- `naver_blog/legacy.html` — 구버전 `.post-view`
- `naver_blog/no-iframe.html` — iframe 없는 케이스 (직접 본문)
- `naver_blog/private.html` — 비공개 글
- `naver_cafe/mobile-ok.html` — 모바일 정상
- `naver_cafe/login-blocked.html` — 로그인 차단
- `naver_cafe/legacy.html` — 구버전 selector
- `naver_cafe/adult.html` — 성인인증
- `ddg/article.html` — 일반 article 본문
- `ddg/boilerplate.html` — boilerplate 99%
- `ddg/too-short.html` — 본문 100자 미만
- `ddg/404.html` — 404 페이지

**fetch 모킹**: vitest `vi.mock` 으로 `fetchWithTimeout` 모킹 → 각 fixture 반환. 실제 네트워크 호출 없음.

**검증 케이스**:
- 각 fixture 입력 시 `status` / `contentLength` / `text.startsWith(...)` 어서션
- 셀렉터 fallback 동작 (SE3 없을 때 legacy 사용)
- `detectBlocked` 휴리스틱 (로그인 폼 / captcha 키워드)
- timeout / error 분기

실행: `bun test src/server/crawlers/lib/full-text-fetcher.test.ts`

### Phase 5 — 파일럿 측정 스크립트

신규: `scripts/pilot-full-text-fetcher.ts`

CLI: `bun run scripts/pilot-full-text-fetcher.ts --remote`

처리 흐름:
1. `web_sources_raw` 에서 `naver_blog` / `naver_cafe` / `ddg_search` 각 33건 랜덤 샘플 (또는 매칭 score 상위)
2. 각 row 의 `source_url` → `fetchFullText` 호출 (실제 네트워크)
3. 동시성 3, 호출 간 sleep 1~2초
4. 결과 집계 → `data/fetcher-pilot.md`

**리포트 지표** (`data/fetcher-pilot.md`):
- source × status 매트릭스 (분포 표)
- **두 가지 성공률 분리**:
  - 전체 URL 기준 성공률: `ok / total`
  - 공개글 기준 성공률: `ok / (total - blocked - not_found)` — 추출기 품질 지표
- 본문 길이 분포: 평균 / 중앙 / p25 / p75
- 대표 실패 사유 샘플 3건씩 (blocked / too_short / error)
- 차단 발생 시 즉시 중단 + 재개 가이드

## 의존성

| 항목 | 비고 |
|---|---|
| `cheerio` | npm install |
| `@mozilla/readability` | npm install |
| `jsdom` | devDep 보유 (그대로 사용) |
| `undici` 또는 `node:fetch` | bun 내장 fetch 사용 가능 |
| 환경변수 | 신규 없음 |

## 리스크

- **HIGH** — 네이버 ToS / IP 차단: 동시성 3·sleep 1~2s 보수적 운영. 차단 감지 시 즉시 중단. 본 이슈는 99건 파일럿이라 차단 가능성 낮으나 #140 본격 배치 시 재발 위험.
- **MED** — 사이트 DOM 변경 silent failure: 본문 길이 < 200 → `'too_short'` 강제. 추출기 품질 지표를 별도로 보고하여 셀렉터 깨짐 감지.
- **MED** — Cloudflare Worker 호환성: `jsdom` / `@mozilla/readability` 가 Worker 런타임에서 동작하지 않을 가능성. 본 이슈는 로컬/Node 전용으로 한정. Worker 통합은 #140 B-3 결정 시점에 별도 분기.
- **LOW** — `@mozilla/readability` 신규 의존성: 활발히 유지보수, 라이선스 Apache 2.0.

## 검증 / 완료 기준

- [ ] `bun test src/server/crawlers/lib/full-text-fetcher.test.ts` 모든 케이스 통과
- [ ] `bun run scripts/pilot-full-text-fetcher.ts --remote` 실행, `data/fetcher-pilot.md` 생성
- [ ] 추출기 품질 지표 (공개글 기준): naver_blog ≥ 90% / ddg ≥ 70%
- [ ] naver_cafe 는 raw 성공률 baseline 측정만 (목표 수치 두지 않음 — 비공개/로그인 비율 의존)
- [ ] 단위 테스트 fixture 12종 모두 추가
- [ ] PR 리뷰 통과

## 본 이슈에서 다루지 않음 (후속)

| 작업 | sub-issue |
|---|---|
| `web_sources.full_text_status` 컬럼 추가 + matched 22K 배치 | #140 |
| `naver-blogs.ts` / `duckduckgo-search.ts` / `brave-search.ts` 에 fetcher 통합 (going forward) | #140 |
| `match-to-lots.ts` 가 raw.full_text 를 web_sources.full_text 로 복사 | #140 |
| AI filter / summary 가 full_text 를 입력으로 사용 | #141 |
| Worker Cron 환경에서 fetcher 동작 보장 | #140 결정 후 별도 |
| `web_sources_raw` 215K 풀텍스트 보강 | 미정 (사용자 컨펌: 비용 대비 효과 낮아 보류) |

## 작업 순서 요약

1. 의존성 추가 (`bun add cheerio @mozilla/readability`)
2. 라이브러리 골격 + 내부 유틸 작성
3. 사이트별 추출기 구현 (naver_blog → naver_cafe → ddg_search 순)
4. fixture 12종 수집 (기존 web_sources_raw 의 source_url 에서 실제 fetch 후 저장 — 1회만)
5. 단위 테스트 작성 + 통과 확인
6. 파일럿 스크립트 작성 + 실행
7. `data/fetcher-pilot.md` 결과 검토
8. PR 작성 (feat 브랜치 `feat/issue-139-fulltext-fetcher`)

## 예상 복잡도

**MEDIUM** (총 6~10시간)

- 라이브러리 골격 + 추출기: 3~4h
- 단위 테스트 (fixture 수집 포함): 2~3h
- 파일럿 스크립트 + 실행 + 리포트: 1~2h
- PR 정리: 0.5~1h
