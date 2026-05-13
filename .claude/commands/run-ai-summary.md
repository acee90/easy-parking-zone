---
description: "AI 요약 2-phase 파이프라인 — Phase 1: web_sources.ai_summary 재생성 → Phase 2: 변경된 lot의 parking_lot_stats AI 필드 재생성"
---

# run-ai-summary

영향받은 lot의 parking_lot_stats AI 필드를 갱신한다 (Phase 2). 신규 web_sources의 ai_summary는 **run-pipeline Stage 3**에서 이미 채워지므로 Phase 1은 재생성·이전 데이터 백필용으로만 사용.

> **2026-05-13 변경**: filter+summary 통합으로 신규 row는 run-pipeline 안에서 ai_summary가 채워진다. Phase 1은 (a) 이전에 NULL이었던 row 백필, (b) 사양 강화 후 재생성 시에만 필요.

## 파이프라인 설계

```
Phase 0: remote → local 동기화 (run-pipeline 직후라면 skip 가능)

Phase 1: web_sources.ai_summary 재생성 (전부 local DB)
  Step 1-1: extract-top-sources-by-lot (local)     → data/top-sources-by-lot.json
  Step 1-2: split-json-array (20건/청크)           → top-sources-chunk-NN.json
  Step 1-3: ai-summary-generator subagent ×N       → top-sources-chunk-NN.sql
  Step 1-4: apply-summaries (local)                → data/regen-applied.sql + data/regen-affected-lots.json
  Step 1-5: local DB 적용

Phase 2: 영향받은 lot의 parking_lot_stats 재생성 (전부 local DB)
  Step 2-1: extract-lots-for-agent (local)         → data/lots_for_summary.json
  Step 2-2: split-json-array (20건/청크)           → lots-chunk-NN.json
  Step 2-3: parking-lot-summary-generator ×N       → lots-chunk-NN.sql
  Step 2-4: local DB 적용

Final: local + remote DB 일괄 적용 (Phase 1 + Phase 2 SQL)
```

**DB 전략 (local-first)**:
- 모든 SELECT/추출은 local DB에서만 수행한다 (remote D1은 CPU 한도 때문에 큰 SELECT 실패함)
- 작업 시작 전 remote와 동기화가 필요하면 Phase 0에서 dump/restore로 local을 최신화한다 (run-pipeline 직후라면 이미 동기화되어 있어 skip 가능)
- Phase 1 SQL을 local에 적용하면 Phase 2가 최신 ai_summary를 읽는다
- 모든 작업 종료 후 Final에서 SQL bulk로 local + remote 양쪽에 일괄 적용한다

## 인자

| 인자 | 기본값 | 설명 |
|------|--------|------|
| `--limit-lots N` | 전체 | Phase 1에서 처리할 lot 수 |
| `--top-n N` | 5 | lot당 web_sources 상위 N건 |
| `--source-whitelist S` | `naver_blog,naver_cafe,ddg_search` | 허용 source (콤마 구분, `all`로 전체). #149 파이프라인이 산출하는 실제 source와 일치 |
| `--max-matched-lots N` | `3` | 1 source가 N개 초과 lot에 매칭되면 나열글로 간주해 skip |
| `--phase1-only` | (없음) | Phase 1만 실행 (remote 적용 포함) |
| `--phase2-only` | (없음) | Phase 2만 실행 (data/regen-affected-lots.json 필요, remote 적용 포함) |

## 실행 순서

### Phase 1 — web_sources.ai_summary 재생성

**Step 1-1: 후보군 추출 (local DB)**

```bash
bun run scripts/extract-top-sources-by-lot.ts \
  [--limit-lots N] [--top-n N] [--source-whitelist S] \
  --output data/top-sources-by-lot.json
```

> `--remote` 사용 금지. 큰 SELECT(matched_lot_count 서브쿼리)가 D1 CPU 한도(7429)에 걸린다. run-pipeline 직후라면 local에 이미 최신 데이터가 있다.

출력: `data/top-sources-by-lot.json`
0건이면 "처리할 web_sources 없음" 메시지 출력 후 종료.

**Step 1-2: 청크 분할 (20건/청크)**

```bash
bun run scripts/split-json-array.ts \
  --input data/top-sources-by-lot.json \
  --chunk-size 20 \
  --prefix top-sources-chunk \
  --out-dir data
```

- 20건 이하(청크 1개): 분할 없이 `data/top-sources-by-lot.json` 그대로 사용
- 21건 이상: `data/top-sources-chunk-01.json`, `data/top-sources-chunk-02.json`, ... 생성

**Step 1-3: ai-summary-generator subagent (배치당 최대 5개 병렬)**

청크 파일 목록을 확인하고 **5개씩 배치**로 나눠 Agent를 실행한다. 한 배치가 완료된 후 다음 배치를 실행한다.

> **사전 확인**: `scripts/generate-ai-summaries*.{mjs,py,ts}` 같은 untracked orphan 스크립트가 있으면 먼저 제거할 것. subagent가 외부 API 호출로 빠질 수 있다. (가드는 agent 정의에도 있지만, 파일이 보이지 않으면 더 확실.)

> **prompt 작성 시 주의**: subagent에게 "skip한 row는 UPDATE 발행하지 마세요" 같은 지시를 **하지 말 것**. agent 정의는 "모든 record에 1:1 UPDATE 발행, filter_passed=false면 빈 문자열"이다. 발행을 건너뛰면 다운스트림 `apply-summaries.ts`의 실패 마킹이 동작 안 해서 다음 실행에 같은 row가 다시 잡힌다.

청크가 1개인 경우 — Agent에 전달할 prompt (agent 정의 사양 그대로 따르도록 짧게):
```
Agent(subagent_type="ai-summary-generator"):
  data/top-sources-by-lot.json 을 읽어 agent 정의 사양에 따라 처리하고
  data/top-sources-by-lot.sql 에 저장. 모든 record에 1:1 UPDATE 발행
  (filter_passed=false면 빈 문자열). 외부 API/스크립트 호출 금지.
```

청크가 여러 개인 경우 — 배치 1 (단일 메시지에 최대 5개 Agent 동시 호출):
```
Agent(subagent_type="ai-summary-generator"): data/top-sources-chunk-01.json → data/top-sources-chunk-01.sql
Agent(subagent_type="ai-summary-generator"): data/top-sources-chunk-02.json → data/top-sources-chunk-02.sql
Agent(subagent_type="ai-summary-generator"): data/top-sources-chunk-03.json → data/top-sources-chunk-03.sql
Agent(subagent_type="ai-summary-generator"): data/top-sources-chunk-04.json → data/top-sources-chunk-04.sql
Agent(subagent_type="ai-summary-generator"): data/top-sources-chunk-05.json → data/top-sources-chunk-05.sql
```
배치 1 완료 후 → 배치 2 (06~10), 배치 3 (11~15), ... 순서로 반복.

청크가 여러 개인 경우 모든 SQL을 하나로 병합:
```bash
cat data/top-sources-chunk-*.sql > data/top-sources-by-lot.sql
```

**Step 1-4: apply-summaries (c안 정책 + 영향 lot 추출, local DB 기준 비교)**

```bash
bun run scripts/apply-summaries.ts \
  --input data/top-sources-by-lot.sql \
  --output data/regen-applied.sql \
  --rejected data/regen-rejected.json \
  --lots-output data/regen-affected-lots.json \
  --failed-output data/regen-failed.sql
```

`--remote` 없음 → local DB의 기존 ai_summary와 비교해 c안 정책 적용.

출력:
- `data/regen-applied.sql` — c안 정책 통과 건
- `data/regen-rejected.json` — 거부 건 (too_short / not_better)
- `data/regen-affected-lots.json` — 업데이트 대상 parking_lot_id 목록
- `data/regen-failed.sql` — 실패 마킹 SQL (too_short이고 기존 summary도 없는 row만)

적용 건수 0건이면 Phase 2를 건너뜀 (regen-failed.sql 적용은 계속).
거부율 > 50% → 경고 출력 (계속 진행).

**Step 1-5: local DB 적용**

```bash
bunx wrangler d1 execute parking-db --local --file data/regen-applied.sql
# 실패 마킹 (파일 있을 때만)
[ -s data/regen-failed.sql ] && bunx wrangler d1 execute parking-db --local --file data/regen-failed.sql
```

Phase 2의 extract가 이 시점의 local DB에서 최신 ai_summary를 읽는다.
`regen-failed.sql`의 `ai_summary_updated_at` 마킹으로 다음 Phase 1 실행 시 실패 row가 자동 제외된다.

---

### Phase 2 — parking_lot_stats AI 필드 재생성

**Step 2-1: lot 데이터 추출 (local DB, 전체 web_summaries 누적)**

```bash
bun run scripts/extract-lots-for-agent.ts \
  --lot-ids-file=data/regen-affected-lots.json \
  --output=data/lots_for_summary.json
```

`--remote` 없음 → Phase 1이 반영된 local DB를 읽음.
`--lot-ids-file` 모드는 ai_summary IS NULL 필터 없이 해당 lot의 전체 web_sources.ai_summary를 누적해서 읽음.

**Step 2-2: 청크 분할 (20건/청크)**

```bash
bun run scripts/split-json-array.ts \
  --input data/lots_for_summary.json \
  --chunk-size 20 \
  --prefix lots-chunk \
  --out-dir data
```

- 20건 이하(청크 1개): 분할 없이 `data/lots_for_summary.json` 그대로 사용
- 21건 이상: `data/lots-chunk-01.json`, `data/lots-chunk-02.json`, ... 생성

**Step 2-3: parking-lot-summary-generator subagent (배치당 최대 5개 병렬)**

청크 파일 목록을 확인하고 **5개씩 배치**로 나눠 Agent를 실행한다.

청크가 1개인 경우:
```
Agent(subagent_type="parking-lot-summary-generator"):
  /Users/junhee/Documents/projects/parking-map/main/data/lots_for_summary.json 파일을 읽고
  ai_summary + ai_tip_* 4개 필드를 생성해서 /Users/junhee/Documents/projects/parking-map/main/data/lots_for_summary.sql 에 저장해줘.
```

청크가 여러 개인 경우 — 배치 1 (단일 메시지에 최대 5개 Agent 동시 호출):
```
Agent(subagent_type="parking-lot-summary-generator"): data/lots-chunk-01.json → data/lots-chunk-01.sql
Agent(subagent_type="parking-lot-summary-generator"): data/lots-chunk-02.json → data/lots-chunk-02.sql
Agent(subagent_type="parking-lot-summary-generator"): data/lots-chunk-03.json → data/lots-chunk-03.sql
Agent(subagent_type="parking-lot-summary-generator"): data/lots-chunk-04.json → data/lots-chunk-04.sql
Agent(subagent_type="parking-lot-summary-generator"): data/lots-chunk-05.json → data/lots-chunk-05.sql
```
배치 1 완료 후 → 배치 2 (06~10), 배치 3 (11~15), ... 순서로 반복.

청크가 여러 개인 경우 모든 SQL을 하나로 병합:
```bash
cat data/lots-chunk-*.sql > data/lots_for_summary.sql
```

**Step 2-4: local DB 적용**

```bash
bunx wrangler d1 execute parking-db --local --file data/lots_for_summary.sql
```

**Step 2-5: 짧은 summary NULL 정화 (안전망)**

agent 정의에 50자 미만 NULL 규칙이 명시되어 있으나, 실수로 단편 fact("5분당 150원 요금입니다" 등)가 들어가는 케이스를 차단하기 위한 후처리:

```bash
bun run scripts/clear-short-lot-summaries.ts --threshold 50
```

이 스크립트는 방금 적용된 lot 중 `length(ai_summary) < 50`인 행의 `ai_summary`를 NULL로 만든다 (`ai_tip_*`는 유지). `--apply` 플래그 없으면 dry-run.

---

### Final — remote DB 일괄 적용

```bash
bunx wrangler d1 execute parking-db --remote --file data/regen-applied.sql
[ -s data/regen-failed.sql ] && bunx wrangler d1 execute parking-db --remote --file data/regen-failed.sql
bunx wrangler d1 execute parking-db --remote --file data/lots_for_summary.sql
bunx wrangler d1 execute parking-db --remote --file data/clear-short-lots.sql  # Step 2-5 출력
```

## 전체 플로우 요약

```bash
# Phase 1 — web_sources.ai_summary

# 1-1. local에서 후보군 추출 (run-pipeline 직후라면 local에 최신 데이터가 있음)
bun run scripts/extract-top-sources-by-lot.ts --output data/top-sources-by-lot.json

# 1-2. 청크 분할 (20건/청크)
bun run scripts/split-json-array.ts --input data/top-sources-by-lot.json \
  --chunk-size 20 --prefix top-sources-chunk --out-dir data

# 1-3. subagent 배치 실행 (최대 5개 병렬 → 완료 후 다음 배치)
#      → data/top-sources-chunk-NN.sql 또는 data/top-sources-by-lot.sql
# (청크 여러 개면) cat data/top-sources-chunk-*.sql > data/top-sources-by-lot.sql

# 1-4. c안 정책 적용 (local DB 비교)
bun run scripts/apply-summaries.ts \
  --input data/top-sources-by-lot.sql \
  --output data/regen-applied.sql \
  --lots-output data/regen-affected-lots.json

# 1-5. local DB 적용
bunx wrangler d1 execute parking-db --local --file data/regen-applied.sql
[ -s data/regen-failed.sql ] && bunx wrangler d1 execute parking-db --local --file data/regen-failed.sql

# Phase 2 — parking_lot_stats AI 필드

# 2-1. local DB에서 lot 데이터 추출 (Phase 1 반영)
bun run scripts/extract-lots-for-agent.ts \
  --lot-ids-file=data/regen-affected-lots.json --output=data/lots_for_summary.json

# 2-2. 청크 분할 (20건/청크)
bun run scripts/split-json-array.ts --input data/lots_for_summary.json \
  --chunk-size 20 --prefix lots-chunk --out-dir data

# 2-3. subagent 배치 실행 (최대 5개 병렬 → 완료 후 다음 배치)
#      → data/lots-chunk-NN.sql 또는 data/lots_for_summary.sql
# (청크 여러 개면) cat data/lots-chunk-*.sql > data/lots_for_summary.sql

# 2-4. local DB 적용
bunx wrangler d1 execute parking-db --local --file data/lots_for_summary.sql

# 2-5. 짧은 summary NULL 정화 (안전망)
bun run scripts/clear-short-lot-summaries.ts --threshold 50 --apply

# Final. remote DB 일괄 적용
bunx wrangler d1 execute parking-db --remote --file data/regen-applied.sql
[ -s data/regen-failed.sql ] && bunx wrangler d1 execute parking-db --remote --file data/regen-failed.sql
bunx wrangler d1 execute parking-db --remote --file data/lots_for_summary.sql
[ -s data/clear-short-lots.sql ] && bunx wrangler d1 execute parking-db --remote --file data/clear-short-lots.sql
```

## 보고 형식

```
=== run-ai-summary ===

[Phase 1] web_sources.ai_summary 재생성
  추출: <N>건 (lot <M>개)
  청크: <N>개 (20건/청크)
  생성: <N>건 (빈 문자열 <K>건)
  적용: <N>건 / 거부: <N>건 (too_short=<N>, not_better=<N>)
  영향 lots: <N>개 → data/regen-affected-lots.json
  local DB 적용 완료

[Phase 2] parking_lot_stats AI 필드 재생성
  대상: <N>개 lot
  청크: <N>개 (20건/청크)
  생성: <N>건 (건너뜀 <N>건)
  tip null 비율: pricing <N>% / visit <N>% / alternative <N>%
  local DB 적용 완료

[Final] remote DB 적용 완료 (web_sources + parking_lot_stats)

샘플 (Phase 2, 3건):
  [KA-xxx] 주차장명
    요약: <summary 첫 줄>
```

## 파일럿 권장

```
/run-ai-summary --limit-lots 10 --top-n 5
```

검증 항목:
- Phase 1 거부율 < 50%
- Phase 1 생성 summary 200자 이상 비율 > 70%
- Phase 2 tip null 비율 샘플 수동 확인
