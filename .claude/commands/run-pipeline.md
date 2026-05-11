---
description: "#149 크롤링 파이프라인 실행 — fulltext-fetch → rule filter → match-dump → AI filter (subagent) → match-apply → SQL apply"
---

# run-pipeline

`scripts/run-pipeline-149.ts`로 파이프라인을 5단계로 실행한다.
AI 필터는 ANTHROPIC_API_KEY 없이 **Claude subagent (haiku)** 가 처리한다.

## 파이프라인 설계 (#149)

```
Stage 0: fulltext-fetch — pending URL → full_text 수집 → fulltext-chunk-NN.sql
Stage 1: filter         — rule-only 3tier (high/medium/low) → filter-chunk-NN.sql
Stage 2: match-dump     — 제목 "X 주차장" 패턴 FTS 매칭 → high-high: match-direct-chunk-NN.sql
                                                          medium:     medium-candidates.json
Stage 3: AI filter      — haiku subagent (FILTER_V2_SYSTEM_PROMPT v3) → ai-results.json
Stage 4: match-apply    — AI 결과 반영 → match-ai-chunk-NN.sql
Stage 5: apply          — wrangler d1 execute --file
```

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

### Stage 0 — Fulltext Fetch

```bash
bun run scripts/run-pipeline-149.ts --remote --stage fulltext-fetch --limit 500 --concurrency 3 --sleep 500
```

출력: `/tmp/pipeline-149-{ts}/fulltext-chunk-01.sql`

상태 코드:
- `ok` — 정상 수집 (full_text 저장)
- `blocked` — 크롤링 차단 (full_text=NULL)
- `too_short` — 본문 너무 짧음 (full_text=NULL)
- `not_found` — 404 (full_text=NULL)
- `timeout` — 응답 시간 초과 (full_text=NULL)
- `error` — 기타 오류 또는 30KB 초과 (full_text=NULL)

### Stage 1 — Rule Filter

```bash
bun run scripts/run-pipeline-149.ts --remote --stage filter --limit 500
```

출력: `/tmp/pipeline-149-{ts}/filter-chunk-01.sql`

### Stage 2 — Match Dump

같은 `--out` 디렉터리에 이어서 emit (또는 별도 ts 사용):

```bash
bun run scripts/run-pipeline-149.ts --remote --stage match-dump --limit 500 --out /tmp/pipeline-149-{ts}
```

출력:
- `match-direct-chunk-01.sql` — high-high 직접 INSERT
- `medium-candidates.json` — AI 평가 대기 후보

### Stage 3 — AI 필터 (`pipeline-ai-filter` subagent)

**반드시 `.claude/agents/pipeline-ai-eval.md`에 정의된 `pipeline-ai-filter` 에이전트(haiku, v3 기준)를 사용한다. `general-purpose`나 `filter-v2-evaluator`로 대체 금지.**

**Stage 2 출력: `medium-candidates.json` (20건 이하) 또는 `medium-candidates-01.json`, `medium-candidates-02.json`, ... (20건 초과 시 자동 분할, CHUNK_SIZE=20)**

청크 수만큼 `pipeline-ai-filter` 서브에이전트를 **병렬로** spawn한다.

**청크가 1개일 때:**
```
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates.json 파일을 읽고 v3 판정 기준으로 필터링해서 {DIR}/ai-results.json을 생성해줘.
```

**청크가 여러 개일 때 (병렬 spawn, 단일 메시지에 모든 Agent 호출):**
```
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-01.json 읽고 v3 기준 필터링 → {DIR}/ai-results-01.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-02.json 읽고 v3 기준 필터링 → {DIR}/ai-results-02.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-03.json 읽고 v3 기준 필터링 → {DIR}/ai-results-03.json 생성
```

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

### Stage 4 — Match Apply

```bash
bun run scripts/run-pipeline-149.ts --remote --stage match-apply \
  --ai-results /tmp/pipeline-149-{ts}/ai-results.json \
  --out /tmp/pipeline-149-{ts}
```

출력: `match-ai-chunk-01.sql` (INSERT + matched_at UPDATE)

### Stage 5 — SQL 파일 확인 후 Apply

```bash
# 내용 확인
head -5 /tmp/pipeline-149-{ts}/filter-chunk-01.sql
head -5 /tmp/pipeline-149-{ts}/match-direct-chunk-01.sql
head -5 /tmp/pipeline-149-{ts}/match-ai-chunk-01.sql

# local 먼저 테스트
for f in /tmp/pipeline-149-{ts}/*.sql; do
  bunx wrangler d1 execute parking-db --local --file="$f"
done

# 이상 없으면 remote 적용
for f in /tmp/pipeline-149-{ts}/*.sql; do
  bunx wrangler d1 execute parking-db --remote --file="$f"
done
```

또는 `--apply` 플래그로:

```bash
bun run scripts/run-pipeline-149.ts --remote --apply both --out /tmp/pipeline-149-{ts}
```

## 전체 플로우 요약

```bash
DIR=/tmp/pipeline-149-$(date +%s)

# 0. fulltext-fetch (pending → ok/blocked/...)
bun run scripts/run-pipeline-149.ts --remote --stage fulltext-fetch --limit 500 --concurrency 3 --out $DIR

# 1. filter
bun run scripts/run-pipeline-149.ts --remote --stage filter --limit 500 --out $DIR

# 2. match-dump
bun run scripts/run-pipeline-149.ts --remote --stage match-dump --limit 500 --out $DIR

# 3. AI eval — Claude subagent가 medium-candidates.json → ai-results.json 생성

# 4. match-apply
bun run scripts/run-pipeline-149.ts --remote --stage match-apply \
  --ai-results $DIR/ai-results.json --out $DIR

# 5. apply
for f in $DIR/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
```
