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

**Workflow 방식 (2026-06-30 변경 — 동시제한 하드캡)**: 과거 "전 청크를 단일 메시지에 한꺼번에 spawn해서 harness가 7-in-flight를 유지하길 기대"하던 방식([[feedback_subagent_sliding_window]])은 **동시 실행 갯수를 강제할 수단이 없어** 청크가 많아지면 한 배치가 가장 느린/멈춘 subagent에 통째로 막혀 먹통이 됐다. 대신 `.claude/workflows/ai-filter-fanout.js` **Workflow**로 돌린다. `parallel()`이 동시 `agent()` 호출을 `min(16, cpu-2)`개로 **하드캡 + 큐잉**하므로 청크 수와 무관하게 동시 실행이 결정론적으로 제한된다(이 머신은 8코어 → 6). 각 청크는 ai-filter → 무결성 verify → 실패 시 해당 청크만 재실행(최대 3회)을 워크플로 안에서 처리한다.

표준 흐름: **(1) 생성기로 청크-인라인 실행본 emit → (2) Workflow(scriptPath) 실행.**

```bash
# 1) DIR의 medium-candidates*.json을 .claude/workflows/ai-filter-fanout.js 로직에 인라인한 실행본 생성
RUN=$(bun run scripts/gen-aifilter-workflow.ts $DIR)   # 마지막 stdout 줄 = emit된 scriptPath
echo "$RUN"
```

```
# 2) 위 경로로 Workflow 실행 (parallel() 하드캡 = min(16, cpu-2). 청크 수 무관 결정론적 동시제한)
Workflow(scriptPath="<$RUN>")
```

`.claude/workflows/ai-filter-fanout.js`가 표준 로직(청크별 ai-filter → verify 무결성검사 → 실패분만 재실행, `parallel()` 하드캡)의 **source of truth**다. 생성기는 이 파일의 `[] /* __CHUNKS__ */` 마커에 청크 배열만 박아 넣은 사본을 `$DIR/ai-filter-run.workflow.js`로 쓴다. 청크가 1개여도 동일.

> **args 채널 주의 (2026-06-30 실측)**: 현재 하네스에서 `Workflow(args=...)`는 스크립트 `args` 전역으로 전달되지 **않는다**(빈 chunks로 no-op). 그래서 인라인 방식을 쓴다. args 경로는 미래 대비 fallback으로만 남아 있다.

**Workflow 반환 후 메인 루프에서 최종 권위 검증을 반드시 한 번 더 돌린다** (Workflow의 verify는 세션 한도/agent 사망 시 false-fail이 날 수 있고, filter agent는 파일을 이미 썼을 수 있으므로). **stray 파일(`ai-results-09-v2.json` 등 canonical 청크에 안 맞는 추가 출력) 탐지·삭제까지 포함한다** — lot-match는 `ai-results*.json`을 전부 glob 병합하므로 stray가 있으면 해당 청크가 중복 집계된다(2026-06-30 실측, 500→520):

```bash
node -e 'const fs=require("fs");const dir="<DIR>";const cand=new Set(fs.readdirSync(dir).filter(f=>/^medium-candidates-(\d+)\.json$/.test(f)).map(f=>f.match(/(\d+)/)[1]));const bad=[];
// 1) stray 삭제: canonical(ai-results-NN, NN∈cand)이 아닌 ai-results*.json 제거
for(const f of fs.readdirSync(dir).filter(f=>/^ai-results.*\.json$/.test(f))){const m=f.match(/^ai-results-(\d+)\.json$/);if(!(m&&cand.has(m[1]))){fs.unlinkSync(dir+"/"+f);console.log("removed stray "+f)}}
// 2) 청크별 무결성: 존재·유효JSON·prefix·raw_id 집합 일치
for(const id of cand){const f="medium-candidates-"+id+".json",outf="ai-results-"+id+".json";if(!fs.existsSync(dir+"/"+outf)){bad.push(outf+":MISSING");continue}const raw=fs.readFileSync(dir+"/"+outf,"utf8");if(!raw.trimStart().startsWith("{")){bad.push(outf+":PREFIX");continue}let out;try{out=JSON.parse(raw)}catch(e){bad.push(outf+":JSON_ERR");continue}const ic=JSON.parse(fs.readFileSync(dir+"/"+f,"utf8"));const inIds=new Set((Array.isArray(ic)?ic:ic.candidates||[]).map(c=>c.raw_id));const outIds=new Set((out.results||[]).map(r=>r.raw_id));const miss=[...inIds].filter(x=>!outIds.has(x));if(miss.length||outIds.size!==inIds.size)bad.push(outf+":IDS")}
console.log(bad.length?"BAD:\n"+bad.join("\n"):"ALL PASS")'
```

`BAD`로 잡힌 청크만 `pipeline-ai-filter` Agent로 단건 재생성(소수면 Workflow 없이 직접 Agent 호출). 전건 PASS면 Stage 4로.

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

**이어서 fulltext purge를 local + remote 양쪽에 즉시 실행한다.** 처리가 끝난(terminal) raw는 full_text가 더 이상 필요 없으므로 즉시 비워 용량을 회복한다. remote는 cron(scheduled.ts)이 별도로 full_text를 누적시키므로, 라운드마다 purge를 빼먹으면 빠르게 500MB 한도를 침범한다.

> **purge 시점 (2026-06-09 zombie 사고 후 수정)**: 과거에는 `ai_filtered_at IS NOT NULL`로 purge했는데, `ai_filtered_at`은 **rule filter(Stage 1)** 에서 이미 설정되므로 `filter_passed=1`이지만 아직 lot-match(Stage 4)를 안 거친 in-flight 후보의 full_text까지 비워버렸다. → 이 row들은 본문이 사라진 채 `filter_passed=1 AND matched_at IS NULL`로 남아 매 라운드 재dump되는 zombie가 됐다. 수정: terminal 조건(`filter_passed=0` 즉 rule-rejected, **또는** `matched_at IS NOT NULL` 즉 match 완료)인 row만 purge하고, in-flight 후보(`filter_passed=1 AND matched_at IS NULL`)는 full_text를 보존한다.

```bash
PURGE="UPDATE web_sources_raw SET full_text=NULL, full_text_status='purged' WHERE full_text_status='ok' AND full_text IS NOT NULL AND (filter_passed=0 OR matched_at IS NOT NULL)"
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

# 3. AI eval — Workflow로 실행 (parallel() 하드캡으로 동시제한). 생성기로 청크-인라인 실행본 emit 후 Workflow(scriptPath):
RUN=$(bun run scripts/gen-aifilter-workflow.ts $DIR)   # → $DIR/ai-filter-run.workflow.js
#   Workflow(scriptPath="$RUN") 실행 → ai-results*.json 생성
#   완료 후 메인 루프에서 on-disk 권위 검증(raw_id 집합·유효 JSON·prefix). BAD 청크만 단건 Agent 재생성.

# 4. lot-match (ai-filter 통과 글에 best lot 매칭)
bun run scripts/run-pipeline-149.ts --stage lot-match --ai-results $DIR/ai-results.json --out $DIR
for f in $DIR/match-ai-chunk-*.sql $DIR/missed-lot-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --local --file="$f"
done

# 5. remote 일괄 적용 (fulltext 제외) + 곧바로 fulltext purge (D1 500MB 한도 보호)
for f in $DIR/filter-chunk-*.sql $DIR/match-ai-chunk-*.sql $DIR/missed-lot-chunk-*.sql; do
  [ -f "$f" ] && bunx wrangler d1 execute parking-db --remote --file="$f"
done
PURGE="UPDATE web_sources_raw SET full_text=NULL, full_text_status='purged' WHERE full_text_status='ok' AND full_text IS NOT NULL AND (filter_passed=0 OR matched_at IS NOT NULL)"
bunx wrangler d1 execute parking-db --local  --command "$PURGE"
bunx wrangler d1 execute parking-db --remote --command "$PURGE"
```
