# #148 Phase C 진행 상황 스냅샷 (2026-05-04)

> 목적: context clear 후 resume 가능하도록 현재 작업 상태를 보존.
> 다음 세션에서 본 문서 + `data/filter-v2-pilot-report.md` + `MEMORY.md` 만 보면 즉시 재개 가능.

## 현재 위치

- **브랜치**: `main` (PR #150 머지 완료, sub-issue 코드 + 파일럿 결과 모두 main 에 있음)
- **머지된 M9 PRs**:
  - #145 — Phase A (#139) 풀텍스트 fetcher 라이브러리
  - #146 — Phase B (#140) full_text 22K 보강
  - #147 — design 문서 갱신
  - #149 — Phase 라벨 정리
  - #150 — Phase C (#148) 인프라 + 50건 파일럿
- **In-flight 작업** (PR 외): 16K 풀 스케일업 (subagent batch). PR 없이 remote D1 직접 업데이트 진행 중.

## 누적 평가 결과 (remote D1 기준)

```sql
-- 검증용 쿼리
SELECT filter_passed_v2, COUNT(*) FROM web_sources
WHERE filter_v2_evaluated_at IS NOT NULL
GROUP BY filter_passed_v2;
```

| 상태 | 건수 |
|---|---:|
| **passed (filter_passed_v2=1)** | **321** |
| failed (filter_passed_v2=0) | 2,114 |
| **합계 evaluated** | **2,435** |
| pending (남은 평가 대상) | ~13,887 (16,322 full_text=ok 중 잔여) |

**진행률**: 14.9% / 100%

### Wave 별 누적 (대략)

| Wave | records | passed | rate |
|---|---:|---:|---:|
| Smoke + Pilot v2.1 | 85 | 8 | 9.4% |
| Wave 1 | 200 | 16 | 8.0% |
| Wave 2 | 400 | 51 | 12.8% |
| Wave 3 | 400 (c0 retry 포함) | 66 | 16.5% |
| Wave 4 | 400 | 48 | 12.0% |
| Wave 5 | 400 (c4-c7 retry 포함) | 64 | 16.0% |
| Wave 6 | 200 (c0~c3, c4-c7 dup skip) | 33 | 16.5% |
| Wave 7 | 400 | 48 | 12.0% |
| **합계** | ~2,435 | ~321 | **~13.2% pass rate** |

## 🚨 크리티컬: 다음 세션에서 반드시 수정

### subagent_type 잘못 사용했음

이번 작업의 모든 subagent 가 `subagent_type: "general-purpose"` 로 launch 됐는데, 이는 **main 세션의 모델 (Sonnet/Opus)** 을 사용함. agent definition (`.claude/agents/filter-v2-evaluator.md`) 의 `model: haiku` frontmatter 는 무시됨.

**결과**:
- 비용 ~10× 폭주
- Anthropic rate limit 빈발 (3시간 / 5시간 단위 reset)
- 마지막 reset: **6:30pm KST 2026-05-04**

**수정 방법**:
```ts
// ❌ 이번 작업 — general-purpose (Sonnet/Opus 사용)
Agent({
  subagent_type: "general-purpose",
  prompt: "filter-v2-evaluator agent (v2.1 strict). Read .claude/agents/...md..."
})

// ✅ 다음 세션 — filter-v2-evaluator (진짜 Haiku 사용)
Agent({
  subagent_type: "filter-v2-evaluator",
  prompt: "Process /Users/junhee/.../wave9-c0.json → write SQL to wave9-c0.sql"
})
```

→ 비용/속도 모두 ~10× 개선 + rate limit 빈도 ↓.

### Wave 2 spot check finding (품질 우려)

Wave 1+2 의 6건 spot check 에서 **4/6 binary agreement (67%)** — original passed 중 일부가 fresh subagent 에서 reject 됨:
- 425351 (감천문화마을): 저자가 다른 lot 이용 → wrong_lot
- 425421 (양재근린공원): SEO 가이드 톤 → boilerplate

→ 현재 321 passed 중 **약 10~15% (32~48 건) 가 false positive** 추정. #141 ai_summary 재생성 시 입력에 들어가면 hallucination 위험.

**완화 방안**:
- (a) 무시 — #141 의 추가 reject 메커니즘 (인용 규율, generic filler 가드) 으로 자동 약화
- (b) 321 passed 전체에 2nd-pass cross-validation 진행 (subagent ~7 calls × 50 records)
- 결정: #141 착수 시 결과 보고 판단

## 다음 세션 재개 절차

### 1. 환경 점검 (1분)

```bash
git -C /Users/junhee/Documents/projects/parking-map/main status -s | head -5
git -C /Users/junhee/Documents/projects/parking-map/main log --oneline -3
bunx wrangler d1 execute parking-db --remote --json --command \
  "SELECT filter_passed_v2, COUNT(*) AS n FROM web_sources \
   WHERE filter_v2_evaluated_at IS NOT NULL GROUP BY filter_passed_v2"
```

기대값: passed=321 / failed=2114 (변동 없으면 재개 가능)

### 2. Wave 9 부터 재개 — `subagent_type: "filter-v2-evaluator"` 사용

```bash
# Step A: extract 200 records (Wave 9)
bun run scripts/extract-for-filter-v2.ts --remote --source=all --limit=100 \
  --output=data/wave9.json

# Step B: split 4-8 chunks
bun run scripts/split-filter-v2-input.ts data/wave9.json --chunks=8

# Step C: apply relevance UPDATEs first
bunx wrangler d1 execute parking-db --remote --file=data/wave9_relevance.sql

# Step D: Launch 8 subagent in parallel (NEW: filter-v2-evaluator type)
# In Claude Code Task tool:
#   subagent_type: "filter-v2-evaluator"   ← 핵심 변경
#   prompt: "Process data/wave9-c{N}.json → data/wave9-c{N}.sql, report counts"

# Step E: After all 8 complete, apply SQL
for f in data/wave9-c{0,1,2,3,4,5,6,7}.sql; do
  bunx wrangler d1 execute parking-db --remote --file=$f
done

# Step F: Verify count increase, repeat for Wave 10+
```

### 3. 16K 잔여 ~13,887 레코드 처리 시간 추정

- Wave size: 400 records (8 parallel × 50)
- Pass rate ~13% → 1 wave 당 ~52 passed
- 잔여 wave 수: ~35 waves
- Wave per 시간 (정상 시): ~3-5 분
- **총 추정 시간**: 100-180 분 (rate limit 0 가정, 실제로는 + 대기시간)

만약 **API 키 사용 가능**하면 (`scripts/refilter-matched.ts`) → 25 분 / ~$25 으로 한 번에 가능.

### 4. 16K 완료 후 다음 단계

| issue | 작업 | 의존성 |
|---|---|---|
| #141 (Phase D) | ai_summary 재생성 | 본 작업 완료 후 |
| #142 (Phase E) | lot summary 재생성 + SSR/Siteliner 검증 | #141 후 |
| #143 (P2) | 메타-only lot 합성 | #142 결과 보고 결정 |

## 데이터 파일 위치

`data/` (uncommitted, 작업 산출물):
- `wave1.json` ~ `wave7.json` (각 200 records, 누적 1,400)
- `wave1-c{0..3}.json` ~ `wave7-c{0..7}.json` (chunk inputs)
- `wave1-c{0..3}.sql` ~ `wave7-c{0..7}.sql` (chunk outputs, 적용됨)
- `wave1_relevance.sql` ~ `wave7_relevance.sql` (관련도 v2 UPDATEs, 적용됨)
- `wave1_spotcheck.json`, `wave2_spotcheck.json` (검증용)
- `filter_v2_pilot100.json`, `filter_v2_run2.json` (#150 PR 내 파일럿)
- **wave8 chunks 만들어졌으나 8 chunks 모두 rate-limited 로 SQL 생성 못 함** — Wave 8 부터는 다시 추출 권장 (extract 가 자동으로 pending 만 가져오므로 OK)

`scripts/`:
- `extract-for-filter-v2.ts` — 추출 + 로컬 relevance v2 (PR #150)
- `split-filter-v2-input.ts` — JSON → 8 chunks (PR #150)
- `refilter-matched.ts` — Anthropic SDK 직접 호출 (API 키 보유 시 빠른 옵션)
- `clean-pdf-updates.ts` — 1회용 PDF cleaner (#140)

`.claude/agents/`:
- `filter-v2-evaluator.md` — v2.1 strict prompt, `model: haiku` 명시 (다음 세션에서 `subagent_type` 으로 직접 호출)
- `parking-lot-summary-generator.md` — #141 에서 사용 예정

## 비용 / 진행 가능성

### 옵션 A: subagent_type 수정 + 계속 (현재 노선)
- 6:30pm KST 후 재개
- haiku 직접 호출 → 비용 1/10 + rate limit 한산
- 시간: ~3 시간 (subagent overhead 포함)

### 옵션 B: API 키 발급 + refilter-matched.ts 직접
- ANTHROPIC_API_KEY 갱신 (`.dev.vars`)
- `scripts/refilter-matched.ts --remote --source=all --limit=15000 --concurrency=4`
- 시간: ~25 분
- 비용: ~$25 (Haiku, batch 5건/호출)

### 옵션 C: Pause + 부분 적용으로 #141 진행
- 현 321 passed 만으로 #141 ai_summary 재생성 시작
- 양적으로 부족하지만 품질 검증 가능
- 후속: 16K 완료 후 다시 #141 batch

## 관련 PR / 이슈

- **GitHub umbrella**: [#138 — 크롤링 파이프라인 improve](https://github.com/acee90/easy-parking-zone/issues/138)
- **Phase A (완료)**: #139 / PR #145
- **Phase B (완료)**: #140 / PR #146
- **Phase C 진행 중**: #148 / PR #150 (인프라+파일럿 머지) + 16K 스케일업 미커밋
- **Phase D 대기**: #141
- **Phase E 대기**: #142

## 메모리 파일 (`~/.claude/projects/.../memory/`)

- `feedback_subagent_model_routing.md` (신규) — subagent_type vs general-purpose 비용 차이
- `feedback_bulk_sql_pattern.md` — D1 대량 업데이트 패턴
- `MEMORY.md` 갱신됨 — 위 두 feedback 인덱스됨

## 인덱스 (sub-issue / 디자인)

- `docs/exec-plans/issue-141-ai-summary-regen.md` — Phase D 계획
- `docs/exec-plans/issue-148-filter-relevance-v2.md` — Phase C 계획
- `data/filter-v2-pilot-report.md` — 50건 파일럿 결과 (PR #150)
- 본 문서 — 16K 스케일업 진행 스냅샷
