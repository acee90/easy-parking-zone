# 구현 계획: filter + relevance v2 — full_text 기반 재평가 (#148 — Phase C)

> Parent: #138 — Phase C (선행, #141 직전)
> Milestone: M9 콘텐츠 보강을 위한 크롤링 파이프라인 개선
> Predecessor: #140 (full_text 22K 보강 완료)
> Successor: #141 (본 이슈 통과 subset 만 ai_summary 재생성 대상)

## 요구사항 정리

기존 `relevance_score` / 라우 단계 `filter_passed` 는 모두 **snippet 121자** 입력으로 계산됨. #140 으로 16K row 의 full_text 가 확보된 지금, **풀텍스트 기반으로 재평가하여 false positive 를 제거하고 #141 입력 풀을 정제**한다.

본 이슈는 raw 단계는 손대지 않고, matched `web_sources` 만 대상으로 한다.

## 현재 상태 파악

### relevance_score (snippet 기반)

`src/server/crawlers/lib/scoring.ts` `scoreBlogRelevance(title, description, parkingName, address)`:
- 키워드 매칭 (lot 이름 + 주차 + 지역)
- noise pattern 차감
- 0~100 점, 매칭 threshold 기본 60
- 모든 입력이 snippet (title + description, 둘 다 짧음)

### filter_passed (snippet 기반)

`src/server/crawlers/lib/ai-filter.ts` + `ai-summary-prompt.ts`:
- raw 단계 SYSTEM_PROMPT 가 snippet content 입력으로 분류
- `filter_passed`, `removed_by`, `sentiment_score`, `summary` (~21자) 출력
- match-to-lots 가 raw → web_sources 승격 시 결과 그대로 복사

### 한계

- snippet 만 보고 매칭됐으나 본문은 무관한 false positive 가능 (e.g. "스타필드 위례" 검색 결과에 "위례 카페" 글 매칭)
- 광고/보일러플레이트가 짧은 snippet 에서는 통과했으나 본문은 99% 광고
- #141 ai_summary 재생성 시 이런 row 가 입력에 섞이면 hallucination/filler 위험

## 구현 단계

### Phase C-1 — Schema migration

`migrations/00XX_web_sources_filter_v2.sql`:
- `web_sources.relevance_score_v2 INTEGER`
- `web_sources.filter_passed_v2 INTEGER`
- `web_sources.filter_v2_reason TEXT`
- `web_sources.filter_v2_evaluated_at TEXT`
- 인덱스: `idx_ws_filter_v2 ON web_sources(filter_passed_v2, relevance_score_v2)`

기존 `relevance_score` / 라우 분류 결과는 보존. v2 컬럼은 부가 정보. Drizzle schema 동기화.

### Phase C-2 — relevance v2 algorithm

`src/server/crawlers/lib/scoring.ts` 에 신규:

```ts
export function scoreBlogRelevanceFull(
  title: string,
  fullText: string,
  parkingName: string,
  address: string,
): number
```

기존 `scoreBlogRelevance` 와 동일 시그너처 (description → fullText). 차이점:

- **본문 길이 정규화**: 본문 길수록 키워드 1회 등장의 가중치 ↓ (밀도 기반)
- **lot 이름 빈도 가중치**: 1회 vs 3회 vs 10회 등장에 따른 stepwise 보너스
- **본문 vs 제목 가중치 재조정**: 본문이 풍부하므로 본문 매칭 가중치 ↑
- **NOISE_PATTERNS** 강화: 풀텍스트 보일러플레이트 패턴 추가
- 기존 0~100 범위 유지 (downstream 호환)

단위 테스트: `eval-scoring.ts` 패턴 차용 → `eval/scoring-v2/answer-key.json` 신규 30~50 케이스 (snippet vs full_text 동일 row 매핑)

### Phase C-3 — filter v2 prompt

`src/server/crawlers/lib/ai-summary-prompt.ts` 또는 신규 `ai-filter-v2-prompt.ts` 에 `FILTER_V2_SYSTEM_PROMPT`:

- 입력: full_text + lot meta (name, address)
- 출력 JSON: `{ filter_passed, removed_by, sentiment_score, ai_difficulty_keywords }`
- **summary 출력 안 함** (별도 #141 에서 처리, 책임 분리)
- 판정 강화:
  - 본문 200자 미만 → filter_passed=false
  - lot 이름 등장 0회 → filter_passed=false (본문이 다른 주차장 얘기)
  - 광고/협찬 명시 ("쿠팡 파트너스", "체험단" 등) → filter_passed=false
  - SEO 보일러플레이트 패턴 ("Top5 저렴한 주변 주차장 정리") → filter_passed=false
  - "운영 시간을 확인하시기 바랍니다" 류 generic safety filler 만 → filter_passed=false

PR #137 reject 패턴 그대로 계승.

### Phase C-4 — Re-run script

신규: `scripts/refilter-matched.ts` (#140 패턴 차용)

CLI:
- `--remote --source=naver_blog|ddg_search|all`
- `--limit=N --concurrency=4 --batch-size=10`
- `--shards=N --shard=K` (모듈로 분할)
- `--output-dir=/tmp/refilter-out`
- `--dry-run`

대상 쿼리:
```sql
SELECT id, source, parking_lot_id, title, full_text
FROM web_sources
WHERE full_text_status = 'ok'
  AND LENGTH(full_text) >= 200
  AND filter_passed_v2 IS NULL
  AND source IN ('naver_blog','ddg_search')
  ${shardClause}
LIMIT N
```

처리:
1. lot 메타 lookup (parking_lots JOIN)
2. **로컬**: `scoreBlogRelevanceFull()` 호출 → relevance_score_v2 계산 (AI 호출 없음, 무료)
3. **AI**: Anthropic Haiku 배치 10건/호출 → filter_passed_v2 + sentiment + reason
4. SQL UPDATE 생성 → chunk emit (1000 row/file)
5. `wrangler d1 execute --file` 일괄 적용

### Phase C-5 — A/B eval

신규: `scripts/eval-filter-v2.ts`

같은 30~50 row 에 대해:
- (v1) 기존 relevance_score, raw 단계 filter_passed
- (v2) full_text 기반 재평가

비교 메트릭:
- relevance: avg/p25/p50 분포 변화
- filter_passed flip 카운트 (v1=1 → v2=0 = false positive 발견; v1=0 → v2=1 = 미주류)
  - 기대: 1→0 ≤ 25% (false positive 정밀도 향상), 0→1 ≤ 5% (raw 단계도 이미 잘 거름)
- 수동 검수 샘플 10 row → `eval/filter-v2/report.md`
- hallucination 의심 0건

### Phase C-6 — 단계적 실행

| 단계 | 대상 | 게이트 |
|---|---|---|
| C0-1~C0-4 구현 + 단위 테스트 | — | scoring v2 회귀 통과 |
| Pilot | 100 row (소스 50/50 mixed) | 수동 검수 OK |
| Eval | 30 row v1 vs v2 비교 | flip 분포 합리적 |
| Stage 1 | 1,000 row | over-rejection 없음 |
| Stage 2 | 16,322 row 전체 | — |

## 검증

- v2 평가 16K 완료
- 정밀도 향상: 수동 검수 false positive ≥ 50% 감소
- #141 입력 풀 결정 기준: `filter_passed_v2 = 1 AND relevance_score_v2 >= THRESHOLD`
- 다운스트림: #141 가 정제된 ~12K row 입력으로 ai_summary 재생성

## 비용

- relevance v2: 로컬, 무료
- filter v2: Haiku batch 10건/호출, 16K row × ~$0.0015 = **~$25**

## 의존

- `ANTHROPIC_API_KEY` (`.dev.vars`)
- #140 머지된 main (full_text + 22K 보강)
- bun 런타임

## 리스크

- **MED** — over-filtering: v2 가 너무 엄격하면 진짜 가치 있는 row 도 reject. → eval 게이트 + 보수적 threshold + 수동 검수 의무.
- **MED** — relevance threshold 결정: 기존 60 점 기준. v2 분포가 다르면 재조정 필요. eval 결과 보고 결정.
- **LOW** — Anthropic rate limit: Haiku 빠른 모델, 동시성 4~8 안전.

## 후속

- #141: v2 통과 subset 만 ai_summary 재생성
- #142: lot summary 재생성 시 v2 필터링된 web_sources 만 사용

## 관련 파일

- 기존: `src/server/crawlers/lib/scoring.ts`, `src/server/crawlers/lib/ai-filter.ts`, `src/server/crawlers/lib/ai-summary-prompt.ts`
- 신규: `migrations/00XX_web_sources_filter_v2.sql`, `scripts/refilter-matched.ts`, `scripts/eval-filter-v2.ts`
- 변경: `src/db/schema.ts` (4 컬럼 추가)
