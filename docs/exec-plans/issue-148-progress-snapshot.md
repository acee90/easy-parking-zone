# #148 Phase C 진행 상황 스냅샷 (2026-05-05 v4)

> 목적: context clear 후 resume 가능하도록 현재 작업 상태를 보존.
> 다음 세션에서 본 문서 + `MEMORY.md` 만 보면 즉시 재개 가능.

## 현재 위치

- **브랜치**: `main`
- **Phase C 상태**: medium tier 6,214건 평가 완료, D1 적용 완료
- **중간 파일**: 전체 삭제 완료 (`data/filter-eval/`)
- **다음 단계**: #141 Phase D (ai_summary 재생성)

## 누적 평가 결과 (remote D1 기준, 2026-05-05)

```sql
SELECT filter_passed_v2, COUNT(*) FROM web_sources
WHERE filter_v2_evaluated_at IS NOT NULL
GROUP BY filter_passed_v2;
```

| 상태 | 건수 |
|---|---:|
| **passed (filter_passed_v2=1)** | **~3,368** |
| failed (filter_passed_v2=0) | ~6,081 |
| **합계 evaluated** | **~9,449** |

> Wave 1~9 (3,235건) + 이번 세션 medium tier (6,214건)

**이번 세션 결과** (medium tier 6,214건 Haiku subagent 평가):
- PASS: 2,986건 (48%)
- FAIL: 3,228건 (51%)
- 방식: 125개 chunk(50건/파일) → Haiku subagent 병렬 평가 → SQL emit → D1 bulk apply
- 품질 이슈: 일상킷 boilerplate 패턴("사용자 리뷰방문자의 의견을 확인하고 남겨보세요") → 프롬프트에 명시 추가로 해결

## 이번 세션 핵심 변경사항

### 1. Wave 방식 → 3-tier 스크립트 방식 전환

기존 wave 방식(모든 레코드 AI 평가)에서 `filter-web-sources.ts` 3-tier 모델로 전환:

| tier | 조건 | 처리 | 비용 |
|------|------|------|------|
| **high** | score ≥ 75 AND len ≥ 2000 | auto-pass | 무료 |
| **none** | score = 0 OR score < 25 OR 광고패턴 | auto-fail | 무료 |
| **medium** | 나머지 | AI filter (Haiku) | 유료 |

### 2. 스크립트 이름 변경

`scripts/refilter-matched.ts` → `scripts/filter-web-sources.ts`

크롤링 파이프라인 공식 필터 단계. 기존 `ai-filter-sources.ts` 대체.

### 3. --classify-only 출력물

`filter-web-sources.ts --classify-only` 실행 시:
- `data/filter-out/[source]-NNNN.sql` — high/none 자동분류 UPDATE SQL
- `data/filter-out/medium.json` — AI 필요 레코드 목록

### 4. 로컬 DB 주의사항

로컬 miniflare SQLite는 구버전 덤프로 `full_text` 없음 → 반드시 `--remote` 사용.
로컬 덤프는 `wrangler d1 export --remote --output=data/parking-db.sqlite` 으로 한 번만 받고, 매번 사용 전 확인.

## 다음 세션 재개 절차

### 1. 환경 점검

```bash
bunx wrangler d1 execute parking-db --remote --json --command \
  "SELECT filter_passed_v2, COUNT(*) AS n FROM web_sources \
   WHERE filter_v2_evaluated_at IS NOT NULL GROUP BY filter_passed_v2"
```

기대값: passed=382, failed=2853

### 2. 1차 필터링 (script-only, no AI)

```bash
# 분류만 — API key 불필요
bun run scripts/filter-web-sources.ts \
  --remote --source=all --limit=2000 --classify-only \
  --output-dir=data/filter-out
```

출력물 확인:
- `data/filter-out/*.sql` — high/none tier UPDATE SQL
- `data/filter-out/medium.json` — AI 평가 필요 레코드

### 3. SQL 즉시 적용 (high/none tier)

```bash
for f in data/filter-out/*.sql; do
  bunx wrangler d1 execute parking-db --remote --file="$f"
done
```

### 4. 2차 필터링 (AI for medium)

`data/filter-out/medium.json` → `filter-v2-evaluator` subagent (haiku) → `data/filter-out/medium.sql`

```bash
# 전체 실행 (medium tier AI 포함)
ANTHROPIC_API_KEY=sk-... bun run scripts/filter-web-sources.ts \
  --remote --source=all --limit=2000 \
  --concurrency=4 --batch-size=5 \
  --output-dir=data/filter-out
```

SQL 적용 전 pass율 10~25% 범위 확인 필수.

### 5. 중간 파일 정리

```bash
rm -f data/filter-out/*.sql data/filter-out/medium.json
```

## 관련 파일

- `scripts/filter-web-sources.ts` — 메인 실행 스크립트 (3-tier model)
- `scripts/lib/d1.ts` — D1 쿼리 유틸 (multiline SQL 이스케이프 수정 완료)
- `src/server/crawlers/lib/scoring.ts` — scoreBlogRelevanceFull
- `src/server/crawlers/lib/ai-filter-v2-prompt.ts` — FILTER_V2_SYSTEM_PROMPT
- `.claude/agents/filter-v2-evaluator.md` — medium tier AI 평가 agent

## 다음 단계 (filter-v2 16K 완료 후)

| issue | 작업 | 의존성 |
|---|---|---|
| #141 (Phase D) | ai_summary 재생성 | filter-v2 16K 완료 후 |
| #142 (Phase E) | lot summary 재생성 + SSR/Siteliner 검증 | #141 후 |

## 관련 PR / 이슈

- **GitHub umbrella**: #138
- **Phase C 진행 중**: #148 / PR #150 (인프라+파일럿 머지)
- **Phase D 대기**: #141
- **Phase E 대기**: #142
