# 구현 계획: matched web_sources full_text 보강 (#140)

> Parent: #138 — Phase B
> Milestone: M9 콘텐츠 보강을 위한 크롤링 파이프라인 개선
> Depends on: #139 (full-text fetcher 라이브러리)

## 요구사항 정리

#139 fetcher 라이브러리를 활용해 matched `web_sources` 22K 의 `full_text` 컬럼을 보강한다. 크롤러는 변경하지 않는다 (Worker 비호환 라이브러리).

## 현재 상태 파악

- `web_sources` (22,398 row): matched, `full_text` 평균 0자 = 미사용. PR #145 머지 시점.
- 크롤러 (`naver-blogs.ts` / `duckduckgo-search.ts` / `brave-search.ts`): Cloudflare Worker 환경에서 실행. fetcher 라이브러리의 `jsdom` / `@mozilla/readability` 는 Worker 비호환.
- `match-to-lots.ts:237` INSERT: `full_text_*` 컬럼을 명시 안 함 → 신규 matched row 는 자동으로 디폴트값 (pending) 적용.

## 구현 단계

### Phase B-1 — schema migration ✅

신규: `migrations/0037_web_sources_fulltext_status.sql`
- `web_sources.full_text_status TEXT DEFAULT 'pending'`
- `web_sources.full_text_fetched_at TEXT`
- 인덱스 `idx_ws_fulltext_status(full_text_status, source)`

Drizzle `src/db/schema.ts` 동기화 (full_text / full_text_length 포함하여 4 컬럼 추가).

### Phase B-2 — 배치 fetch 스크립트 ✅

신규: `scripts/fetch-matched-fulltext.ts`
- CLI: `--remote --source=naver_blog|naver_cafe|ddg_search|all --limit=N --concurrency=3 --sleep=1500 --status=pending --flush-every=25 [--dry-run]`
- pending row 를 source별로 N건 가져와 fetcher 호출
- 25건 단위로 `wrangler d1 execute --file` 배치 UPDATE (tmp SQL 파일)
- 동시성 3, sleep 1500ms, 차단 발생 시 즉시 status 기록 후 다음 row 진행

### Phase B-3 — 크롤러 통합 (코드 변경 없음)

**결정**: 크롤러는 변경하지 않는다.

이유:
- 크롤러는 Cloudflare Worker 환경. fetcher 라이브러리의 `jsdom` / `@mozilla/readability` 는 Worker 비호환.
- `match-to-lots.ts:237` INSERT 는 `full_text_*` 컬럼 미명시 → 신규 row 는 자동으로 `full_text_status='pending'` 으로 큐잉됨.
- 따라서 신규 크롤링 데이터는 자연스럽게 다음 B-2 배치 실행 시 픽업된다.

운영 패턴:
- B-2 스크립트를 주기적으로 실행 (Node host or 로컬 cron)
- 또는 신규 데이터가 일정량 누적된 후 수동 실행

cafe 헤드리스 브라우저 / Worker-compatible 추출기는 별도 후속 이슈 (M9 외 또는 미정).

### Phase B-4 — 단계적 실행

| 단계 | 대상 | 상태 |
|---|---|---|
| Smoke | naver_blog 5건 dry-run + 5건 실제 | ✅ 5/5 ok 검증 |
| Stage 1 | 100 × 3 sources (300 row) | ✅ blog 105/cafe 100 blocked/ddg 100 |
| Cafe bulk-mark | 5,828 cafe row 일괄 blocked:spa_shell | ✅ |
| Stage 2 | naver_blog 9,284 + ddg 9,282 풀스윕 | 🚧 진행 중 (background) |

## naver_cafe 처리

audit + #139 파일럿에서 SPA 한계 확인 (mobile + desktop 모두 단순 fetch 불가). 3,014 cafe row 는 SQL 일괄 UPDATE 로 `full_text_status='blocked'` 마킹 (fetcher 호출 없음, 비용 0).

## 검증

- 보강 후 `full_text_length` 평균 ≥ 1,500자 (naver_blog) / ≥ 800자 (ddg)
- `full_text_status` 분포 보고 → `data/fulltext-batch-report.md` (B-4 완료 후)
- A/B 비교: 같은 row 의 (snippet content) vs (full_text) 길이 분포

## 의존

- #139 fetcher 라이브러리 (PR #145 머지 완료)
- 환경: D1 remote 접근 (wrangler), bun 런타임
- 환경변수: 신규 없음

## 리스크

- **MED** — 네이버 차단: 동시성 3·sleep 1500ms 보수적 운영. Stage 2 진행 중 차단 발생 시 즉시 중단 후 재개 큐 운영.
- **LOW** — 배치 wrangler 호출 누적: 25건 단위 배치 + 임시 SQL 파일로 효율화.
- **N/A** — Worker 호환성: B-3 결정으로 회피.

## 후속 (#140 외)

- naver_cafe 헤드리스 브라우저 추출 (별도 이슈)
- Worker 호환 fetcher subset (cheerio only) — naver_blog/cafe 한정 — 우선순위 낮음
- 신규 크롤링 데이터 자동 픽업 cron (현재는 수동 실행)
