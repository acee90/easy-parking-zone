---
description: "#149 크롤링 파이프라인 실행 — fulltext-fetch → rule filter → match-dump → AI filter (subagent) → match-apply → SQL apply"
---

# run-pipeline

`scripts/run-pipeline-149.ts`로 파이프라인을 5단계로 실행한다.
AI 필터는 ANTHROPIC_API_KEY 없이 **Claude subagent (haiku)** 가 처리한다.

## 파이프라인 설계 (#149)

```
Stage 0: fulltext-fetch — pending URL → full_text 수집 → fulltext-chunk-NN.sql → local DB 적용
Stage 1: filter         — rule-only 3tier (high/medium/low) → filter-chunk-NN.sql → local DB 적용
Stage 2: match-dump     — 제목 "X 주차장" 패턴 FTS 매칭 → high-high: match-direct-chunk-NN.sql → local DB 적용
                                                          medium:     medium-candidates.json
Stage 3: AI filter      — haiku subagent (FILTER_V2_SYSTEM_PROMPT v3) → ai-results.json
Stage 4: match-apply    — AI 결과 반영 → match-ai-chunk-NN.sql → local DB 적용
Stage 5: apply          — 전체 SQL을 remote DB에 한 번만 적용
```

**로컬 DB 우선 전략**: Stage 0만 remote DB에서 pending 목록을 조회한다. 이후 스테이지는 local DB를 사용하며, 각 스테이지 완료 후 SQL을 local DB에 즉시 적용해 다음 스테이지가 최신 상태를 읽는다. Remote DB는 Stage 5에서 한 번만 업데이트한다.

| 스테이지 | 조건 | 동작 |
|---------|------|------|
| Fulltext Fetch | `full_text_status='pending'` | URL fetch → ok/blocked/too_short/timeout/error 상태 업데이트 |
| Rule Filter | `ai_filtered_at IS NULL AND full_text_status='ok'` | high/medium → filter_passed=1, low → 0 |
| Match (high-high) | `filter_tier='high' AND match='high'` | AI 없이 직접 INSERT |
| Match (medium) | 나머지 후보 | FILTER_V2_SYSTEM_PROMPT + lot_name → 판정 |

## 큐 상태 확인

```bash
bunx wrangler d1 execute parking-db --remote --command \
  "SELECT full_text_status, COUNT(*) FROM web_sources_raw GROUP BY full_text_status"

bunx wrangler d1 execute parking-db --remote --command \
  "SELECT filter_passed, filter_tier, COUNT(*) FROM web_sources_raw GROUP BY filter_passed, filter_tier"

bunx wrangler d1 execute parking-db --remote --command \
  "SELECT COUNT(*) FROM web_sources_raw WHERE filter_passed=1 AND matched_at IS NULL"
```

## 실행 순서

### Stage 0 — Fulltext Fetch (remote 조회)

```bash
bun run scripts/run-pipeline-149.ts --remote --stage fulltext-fetch --limit 500 --concurrency 10 --sleep 0 --out $DIR
```

출력: `$DIR/fulltext-chunk-NN.sql`

완료 후 즉시 local DB 적용:
```bash
for f in $DIR/fulltext-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done
```

상태 코드:
- `ok` — 정상 수집 (full_text 저장)
- `blocked` — 크롤링 차단 (full_text=NULL)
- `too_short` — 본문 너무 짧음 (full_text=NULL)
- `not_found` — 404 (full_text=NULL)
- `timeout` — 응답 시간 초과 (full_text=NULL)
- `error` — 기타 오류 또는 30KB 초과 (full_text=NULL)

### Stage 1 — Rule Filter (local DB 사용)

```bash
bun run scripts/run-pipeline-149.ts --stage filter --limit 500 --out $DIR
```

출력: `$DIR/filter-chunk-NN.sql`

완료 후 즉시 local DB 적용:
```bash
for f in $DIR/filter-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done
```

### Stage 2 — Match Dump (local DB 사용)

```bash
bun run scripts/run-pipeline-149.ts --stage match-dump --limit 500 --out $DIR
```

출력:
- `$DIR/match-direct-chunk-NN.sql` — high-high 직접 INSERT
- `$DIR/medium-candidates.json` — AI 평가 대기 후보

완료 후 즉시 local DB 적용:
```bash
for f in $DIR/match-direct-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done
```

### Stage 3 — AI 필터 (`pipeline-ai-filter` subagent)

**반드시 `.claude/agents/pipeline-ai-eval.md`에 정의된 `pipeline-ai-filter` 에이전트(haiku, v3 기준)를 사용한다. `general-purpose`나 `filter-v2-evaluator`로 대체 금지.**

**Stage 2 출력: `medium-candidates.json` (20건 이하) 또는 `medium-candidates-01.json`, `medium-candidates-02.json`, ... (20건 초과 시 자동 분할, CHUNK_SIZE=20)**

청크를 **5개씩 배치**로 나눠 병렬 spawn한다. 한 배치가 완료되면 다음 배치를 실행한다.

**청크가 1개일 때:**
```
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates.json 파일을 읽고 v3 판정 기준으로 필터링해서 {DIR}/ai-results.json을 생성해줘.
```

**청크가 여러 개일 때 (배치당 최대 5개, 배치 완료 후 다음 배치):**

배치 1 (단일 메시지에 최대 5개 Agent 호출):
```
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-01.json 읽고 v3 기준 필터링 → {DIR}/ai-results-01.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-02.json 읽고 v3 기준 필터링 → {DIR}/ai-results-02.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-03.json 읽고 v3 기준 필터링 → {DIR}/ai-results-03.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-04.json 읽고 v3 기준 필터링 → {DIR}/ai-results-04.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-05.json 읽고 v3 기준 필터링 → {DIR}/ai-results-05.json 생성
```

배치 1 완료 확인 후 → 배치 2 (06~10), 배치 3 (11~15), ... 순서로 반복한다.

Stage 4 match-apply는 같은 디렉토리의 `ai-results*.json` 파일을 자동으로 병합한다.

`ai-results.json` 출력 형식:
```json
{
  "results": [
    { "raw_id": 123, "lot_id": "lot_xxx",
      "filter_passed": true, "removed_by": null,
      "sentiment_score": 3.5, "ai_difficulty_keywords": [] }
  ],
  "stats": { "total": 30, "passed": 12, "pass_rate": 0.40, "removal_breakdown": {} }
}
```

평가 후 통과율 확인:
- 정상 범위: 10~65%
- 65% 초과 또는 5% 미만 → 재검토 필요

### Stage 4 — Match Apply (local DB 사용)

```bash
bun run scripts/run-pipeline-149.ts --stage match-apply \
  --ai-results $DIR/ai-results.json \
  --out $DIR
```

출력: `$DIR/match-ai-chunk-NN.sql` (INSERT + matched_at UPDATE)

완료 후 즉시 local DB 적용:
```bash
for f in $DIR/match-ai-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done
```

### Stage 5 — Remote DB 일괄 적용

모든 SQL 파일을 remote DB에 한 번만 적용한다 (fulltext 제외, filter + match 파일만):

```bash
for f in $DIR/filter-chunk-*.sql $DIR/match-direct-chunk-*.sql $DIR/match-ai-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --remote --file="$f"
done
```

fulltext SQL도 remote에 반영해야 다음 실행 시 중복 fetch를 방지한다:
```bash
for f in $DIR/fulltext-chunk-*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
```

## 전체 플로우 요약

```bash
DIR=/tmp/pipeline-149-$(date +%s)

# 0. fulltext-fetch (remote에서 pending URL 조회 → full_text 수집)
bun run scripts/run-pipeline-149.ts --remote --stage fulltext-fetch --limit 4000 --concurrency 20 --sleep 0 --out $DIR
for f in $DIR/fulltext-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done

# 1. filter (local DB 사용)
bun run scripts/run-pipeline-149.ts --stage filter --limit 4000 --out $DIR
for f in $DIR/filter-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done

# 2. match-dump (local DB 사용)
bun run scripts/run-pipeline-149.ts --stage match-dump --limit 4000 --out $DIR
for f in $DIR/match-direct-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done

# 3. AI eval — Claude subagent가 medium-candidates*.json → ai-results*.json 생성

# 4. match-apply (local DB 사용)
bun run scripts/run-pipeline-149.ts --stage match-apply --ai-results $DIR/ai-results.json --out $DIR
for f in $DIR/match-ai-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done

# 5. remote 일괄 적용
for f in $DIR/fulltext-chunk-*.sql $DIR/filter-chunk-*.sql $DIR/match-direct-chunk-*.sql $DIR/match-ai-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --remote --file="$f"
done
```
