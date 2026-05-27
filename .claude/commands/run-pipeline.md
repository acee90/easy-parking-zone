---
description: "#149 크롤링 파이프라인 실행 (재배치) — fulltext-fetch → rule filter → ai-filter (subagent, lot-less) → lot-match → data-apply"
---

# run-pipeline

`scripts/run-pipeline-149.ts`로 파이프라인을 5단계로 실행한다.
AI 필터는 ANTHROPIC_API_KEY 없이 **Claude subagent (haiku)** 가 처리한다.

## 파이프라인 설계 (#149)

```
Stage 0: fulltext-fetch — pending URL → full_text 수집 → fulltext-chunk-NN.sql → local DB 적용
Stage 1: filter         — rule-only 3tier (high/medium/low) → filter-chunk-NN.sql → local DB 적용
Stage 2: ai-filter      — rule 통과(high+medium) raw를 lot-less로 dump (raw_id/title/full_text)
                          → haiku subagent (AI_SUMMARY_SYSTEM_PROMPT 단일 source)
                          → 콘텐츠 품질 판정 + lot-agnostic 200~600자 summary → ai-results.json
Stage 3: lot-match      — ai-filter 통과 글에 best lot 매칭
                          (searchCandidateLots→locComp→lotNameInFullText→getMatchConfidence)
                          → match-ai-chunk-NN.sql (ai_summary 포함) / lot 없으면 MISSED
Stage 4: data-apply     — emit된 SQL 적용 (local 먼저, remote는 fixture eval 통과 후 별도 승인)
```

> **재배치 (2026-05-15, plan §4.1)**: match를 ai-filter **뒤**로 이동. ai-filter는 lot 모른 채 콘텐츠 품질 + lot-agnostic summary만 1패스 생성, lot 매칭은 Stage 3 lot-match가 담당. (raw,lot) 쌍 평가의 청크별 불안정·FTS 과매칭 오염 제거. 구 match-dump/match-apply 스테이지는 롤백용으로 코드에 잔존.
> **통합 변경 (2026-05-13)**: 기존 FILTER_V2_SYSTEM_PROMPT(filter 전용) 폐기. `AI_SUMMARY_SYSTEM_PROMPT`만 사양 단일 source.

**로컬 DB 우선 전략**: 모든 스테이지가 local DB에서 후보를 조회한다. 각 스테이지 완료 후 SQL을 local DB에 즉시 적용해 다음 스테이지가 최신 상태를 읽는다. Remote DB는 Stage 5에서 한 번만 업데이트한다.

> **divergence 안전장치**: local과 remote가 어긋난 상태(local pending인데 remote는 이미 ok)에서 Stage 0이 다시 fetch한 후 Stage 5에서 remote에 push해도 안전하다. fulltext UPDATE에 `WHERE id=? AND full_text_status='pending'` 가드가 있어서 remote에 이미 처리된 row는 덮어쓰지 않는다.

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

### Stage 0 — Fulltext Fetch (local 조회)

```bash
bun run scripts/run-pipeline-149.ts --stage fulltext-fetch --limit 500 --concurrency 10 --sleep 0 --out $DIR
```

> `--remote` 사용 금지. local의 `full_text_status='pending'` row만 fetch. remote가 이미 처리한 같은 id가 있어도 Stage 5 push 시 가드(WHERE full_text_status='pending')가 안전을 보장.

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

### Stage 2 — AI Filter Dump (lot-less)

> **재배치 (2026-05-15 plan §4.1)**: 정상 흐름은 `ai-filter (lot-less dump) → subagent → lot-match`. 구 `match-dump → match-apply` 흐름은 lot 매칭이 빠져 `parking_lot_id=NULL`로 INSERT되니 사용 금지.

```bash
bun run scripts/run-pipeline-149.ts --stage ai-filter --limit 500 --out $DIR
```

조건: `filter_passed = 1 AND matched_at IS NULL`인 raw를 lot 정보 없이 dump.

출력: `$DIR/medium-candidates.json` (20건 이하) 또는 `medium-candidates-01.json`, `medium-candidates-02.json`, ... (20건 초과 시 자동 분할, CHUNK_SIZE=20)

> Stage 2에서는 local DB 적용이 필요 없다 (raw에 변경 없음).

### Stage 3 — AI 필터+요약 (`pipeline-ai-filter` subagent, lot-less)

**반드시 `.claude/agents/pipeline-ai-filter.md`에 정의된 `pipeline-ai-filter` 에이전트(haiku)를 사용한다. AI_SUMMARY_SYSTEM_PROMPT 단일 source로 filter 판정 + 통과 시 lot-agnostic 200~600자 summary 생성. `general-purpose`/`filter-v2-evaluator`/`ai-summary-generator`로 대체 금지.**

에이전트는 lot 정보 없이 raw 콘텐츠 품질만 평가한다. lot 매칭은 Stage 4 `lot-match`가 담당한다.

청크를 **5개씩 배치**로 나눠 병렬 spawn한다. 한 배치가 완료되면 다음 배치를 실행한다.

**청크가 1개일 때:**
```
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates.json 파일을 읽고 v3 판정 기준으로 필터링해서 {DIR}/ai-results.json을 생성해줘.
```

**청크가 여러 개일 때 (배치당 최대 5개, 배치 완료 후 다음 배치):**

배치 1 (단일 메시지에 최대 5개 Agent 호출):
```
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-01.json 읽고 filter+summary 통합 처리 → {DIR}/ai-results-01.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-02.json 읽고 filter+summary 통합 처리 → {DIR}/ai-results-02.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-03.json 읽고 filter+summary 통합 처리 → {DIR}/ai-results-03.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-04.json 읽고 filter+summary 통합 처리 → {DIR}/ai-results-04.json 생성
Agent(subagent_type="pipeline-ai-filter"): {DIR}/medium-candidates-05.json 읽고 filter+summary 통합 처리 → {DIR}/ai-results-05.json 생성
```

배치 1 완료 확인 후 → 배치 2 (06~10), 배치 3 (11~15), ... 순서로 반복한다.

Stage 4 match-apply는 같은 디렉토리의 `ai-results*.json` 파일을 자동으로 병합한다.

`ai-results.json` 출력 형식 (lot-less — lot_id 필드 없음):
```json
{
  "results": [
    { "raw_id": 123,
      "filter_passed": true, "removed_by": null,
      "sentiment_score": 3.5, "ai_difficulty_keywords": [],
      "summary": "주차장은 입구가 좁고 회전반경이 작아 초보 운전자에게는 부담이 될 수 있습니다. 평일 기본 30분 1,000원..." },
    { "raw_id": 124,
      "filter_passed": false, "removed_by": "boilerplate",
      "sentiment_score": 3.0, "ai_difficulty_keywords": [],
      "summary": "" }
  ],
  "stats": { "total": 30, "passed": 12, "pass_rate": 0.40, "removal_breakdown": {} }
}
```

평가 후 통과율 확인:
- 정상 범위: 10~65%
- 65% 초과 또는 5% 미만 → 재검토 필요

### Stage 4 — Lot Match (ai-filter 통과 글에 best lot 매칭)

```bash
bun run scripts/run-pipeline-149.ts --stage lot-match \
  --ai-results $DIR/ai-results.json \
  --out $DIR
```

`pickBestLot(title, content, fullText)` 으로 후보 lot 중 best 매칭:
- `searchCandidateLots → locComp → lotNameInFullText → lotCoreInText → getMatchConfidence`

출력:
- `$DIR/match-ai-chunk-NN.sql` — 매칭 성공분 INSERT (정상 lot_id 포함) + matched_at UPDATE
- `$DIR/missed-lot-chunk-NN.sql` — 콘텐츠는 양질이나 DB에 lot 없음 (보존)

`--ai-results` 인자는 단일 파일 경로지만, 같은 디렉토리의 `ai-results*.json`을 모두 자동 병합한다. 청크 파일 그대로 두면 됨.

완료 후 즉시 local DB 적용:
```bash
for f in $DIR/match-ai-chunk-*.sql $DIR/missed-lot-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --local --file="$f"
done
```

> **legacy 스테이지 경고**: `--stage match-dump`/`--stage match-apply`는 (raw,lot) 짝 기반 구 흐름이다. ai-filter가 lot-less로 동작하기 때문에 match-apply는 `result.lot_id=null`을 그대로 INSERT하여 `parking_lot_id=NULL` (NOT NULL 제약으로 INSERT OR IGNORE) — 매칭이 전부 lost된다. **사용 금지**.

### Stage 5 — Remote DB 일괄 적용 + fulltext purge

모든 SQL 파일을 remote DB에 한 번만 적용한다 (**fulltext 제외**, filter + match 파일만):

```bash
for f in $DIR/filter-chunk-*.sql $DIR/match-ai-chunk-*.sql $DIR/missed-lot-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --remote --file="$f"
done
```

> **fulltext-chunk-*.sql은 remote에 push하지 않는다.** D1 무료 플랜 500MB 한도를 보호하기 위해 full_text는 local에만 적재한다. remote는 cron(scheduled.ts)이 자체적으로 fetch한다. (2026-05-23 569MB 초과 사고 후 정책화)

**이어서 fulltext purge를 local + remote 양쪽에 즉시 실행한다.** ai-filter까지 끝난 raw는 full_text가 더 이상 필요 없으므로 즉시 비워 용량을 회복한다. remote는 cron(scheduled.ts)이 별도로 full_text를 누적시키므로, 라운드마다 purge를 빼먹으면 빠르게 500MB 한도를 침범한다.

```bash
PURGE="UPDATE web_sources_raw SET full_text=NULL, full_text_status='purged' WHERE ai_filtered_at IS NOT NULL AND full_text_status='ok' AND full_text IS NOT NULL"
bunx wrangler d1 execute parking-db --local  --command "$PURGE"
bunx wrangler d1 execute parking-db --remote --command "$PURGE"
```

## 전체 플로우 요약

```bash
DIR=/tmp/pipeline-149-$(date +%s)

# 0. fulltext-fetch (local pending URL 조회 → full_text 수집)
bun run scripts/run-pipeline-149.ts --stage fulltext-fetch --limit 4000 --concurrency 20 --sleep 0 --out $DIR
for f in $DIR/fulltext-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done

# 1. filter (local DB 사용)
bun run scripts/run-pipeline-149.ts --stage filter --limit 4000 --out $DIR
for f in $DIR/filter-chunk-*.sql; do bunx wrangler d1 execute parking-db --local --file="$f"; done

# 2. ai-filter dump (lot-less) — medium-candidates*.json 생성
bun run scripts/run-pipeline-149.ts --stage ai-filter --limit 4000 --out $DIR

# 3. AI eval — Claude pipeline-ai-filter subagent가 medium-candidates*.json → ai-results*.json 생성

# 4. lot-match (ai-filter 통과 글에 best lot 매칭)
bun run scripts/run-pipeline-149.ts --stage lot-match --ai-results $DIR/ai-results.json --out $DIR
for f in $DIR/match-ai-chunk-*.sql $DIR/missed-lot-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --local --file="$f"
done

# 5. remote 일괄 적용 (fulltext 제외) + 곧바로 fulltext purge (D1 500MB 한도 보호)
for f in $DIR/filter-chunk-*.sql $DIR/match-ai-chunk-*.sql $DIR/missed-lot-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --remote --file="$f"
done
PURGE="UPDATE web_sources_raw SET full_text=NULL, full_text_status='purged' WHERE ai_filtered_at IS NOT NULL AND full_text_status='ok' AND full_text IS NOT NULL"
bunx wrangler d1 execute parking-db --local  --command "$PURGE"
bunx wrangler d1 execute parking-db --remote --command "$PURGE"
```
