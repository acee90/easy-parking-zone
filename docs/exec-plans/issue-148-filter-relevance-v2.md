# 구현 계획: filter + relevance v2 — full_text 기반 재평가 (#148 — Phase C)

> Parent: #138 — Phase C (선행, #141 직전)
> Milestone: M9 콘텐츠 보강을 위한 크롤링 파이프라인 개선
> Predecessor: #140 (full_text 22K 보강 완료)
> Successor: #141 (본 이슈 통과 subset 만 ai_summary 재생성 대상)

## 요구사항 정리

기존 `relevance_score` / raw 단계 `filter_passed` 는 모두 **snippet 121자** 입력으로 계산됨. #140 으로 16K row 의 full_text 가 확보된 지금, **풀텍스트 기반으로 재평가하여 false positive 를 제거하고 #141 입력 풀을 정제**한다.

본 이슈는 raw 단계는 손대지 않고, matched `web_sources` 만 대상으로 한다.

## 구현 단계 (확정 아키텍처)

### Phase C-1 — Schema migration ✅ 완료

`web_sources` 에 v2 컬럼 추가 완료:
- `relevance_score_v2 INTEGER`
- `filter_passed_v2 INTEGER`
- `filter_v2_reason TEXT`
- `filter_v2_evaluated_at TEXT`

### Phase C-2 — relevance v2 algorithm ✅ 완료

`src/server/crawlers/lib/scoring.ts`:
- `scoreBlogRelevanceFull(title, fullText, parkingName, address): number`
- 본문 길이 정규화, lot 이름 빈도 가중치, 풀텍스트 보일러플레이트 패턴 추가

### Phase C-3 — filter v2 prompt ✅ 완료

`src/server/crawlers/lib/ai-filter-v2-prompt.ts`:
- FILTER_V2_SYSTEM_PROMPT, FilterV2Input, FilterV2Output

### Phase C-4 — filter-web-sources.ts (구 refilter-matched.ts) ✅ 구현 완료

`scripts/filter-web-sources.ts` — 크롤링 파이프라인 공식 필터 단계. 기존 `ai-filter-sources.ts` 대체.

#### 3-tier 모델 (풀텍스트 calibrated)

| tier | 조건 | 처리 | 비용 |
|------|------|------|------|
| **high** | score ≥ 75 AND len ≥ 2000 | auto-pass (filter_passed_v2=1) | 무료 |
| **none** | score = 0 OR score < 25 OR 광고패턴 | auto-fail (filter_passed_v2=0) | 무료 |
| **medium** | 나머지 | AI filter (Haiku) | 유료 |

#### 광고 패턴 (스크립트 감지, AI 불필요)

- `#협찬`, `협찬 받았어/받은`, `서포터즈 활동/후기/선정`
- `체험단 선정/후기/글/이벤트`, `홍보/광고 포스팅입니다`
- `원고료를 받아`
- + `scoreBlogRelevanceFull` 내부 NOISE_PATTERNS, FULLTEXT_BOILERPLATE_PATTERNS (score=0 처리)

#### CLI

```bash
# 1차: 스크립트 분류만 (API key 불필요)
bun run scripts/filter-web-sources.ts \
  --source=all --limit=2000 --classify-only \
  --output-dir=data/filter-out

# 2차: 전체 실행 (medium → Haiku AI)
ANTHROPIC_API_KEY=sk-... bun run scripts/filter-web-sources.ts \
  --remote --source=all --limit=2000 \
  --concurrency=4 --batch-size=5 \
  --output-dir=data/filter-out

# apply
for f in data/filter-out/*.sql; do
  bunx wrangler d1 execute parking-db --remote --file="$f"
done
```

#### --classify-only 출력물

- `data/filter-out/[source]-NNNN.sql` — high/none 자동분류 UPDATE SQL
- `data/filter-out/medium.json` — AI 필요 레코드 (id, lot_name, lot_address, title, full_text)

### Phase C-5 — 실행 플로우 (현행)

```
1. wrangler d1 export --remote --output=data/parking-db.sqlite
   (로컬 덤프 — 스크립트 고속 실행용)

2. bun run scripts/filter-web-sources.ts --classify-only
   → [source]-NNNN.sql (high/none)
   → medium.json

3. filter-v2-evaluator subagent on medium.json
   → medium.sql

4. wrangler d1 execute --remote --file (bulk apply)

5. 중간 파일 정리
```

### Phase C-6 — 단계적 실행 게이트

| 단계 | 대상 | 게이트 |
|------|------|--------|
| ✅ Pilot | Wave 1~9 (3,235건) | 수동 검수 통과 |
| 진행 중 | 잔여 ~13K건 | pass율 8~25% 범위 |
| 대기 | 전체 완료 | filter_passed_v2 IS NULL = 0 |

## 현재 진행 상황 (2026-05-04)

| 항목 | 수치 |
|------|------|
| evaluated | 3,235건 |
| passed (filter_passed_v2=1) | 382건 |
| failed (filter_passed_v2=0) | 2,853건 |
| pending (IS NULL) | ~13K건 |

Wave 1~9 완료. 중간 산출물(wave*.json, wave*.sql) 정리 완료.
이후 작업은 `filter-web-sources.ts` 로 처리.

## 검증

- v2 평가 16K 완료
- 정밀도 향상: 수동 검수 false positive ≥ 50% 감소
- #141 입력 풀 결정 기준: `filter_passed_v2 = 1 AND relevance_score_v2 >= THRESHOLD`

## 비용 (3-tier 이후 추정)

- high/none tier: 무료 (스크립트)
- medium tier: Haiku batch, 전체의 ~70% 해당
- 13K × 70% × ~$0.0015 ≈ **~$14** (기존 $25 대비 절감)

## 의존

- #140 머지된 main (full_text + 22K 보강)
- `ANTHROPIC_API_KEY` (medium tier 처리 시)

## 후속

- #141: v2 통과 subset 만 ai_summary 재생성
- #142: lot summary 재생성 시 v2 필터링된 web_sources 만 사용

## 관련 파일

- `scripts/filter-web-sources.ts` — 메인 실행 스크립트 (구 refilter-matched.ts)
- `scripts/lib/d1.ts` — D1 쿼리 유틸 (multiline SQL 이스케이프 수정 완료)
- `src/server/crawlers/lib/scoring.ts` — scoreBlogRelevanceFull
- `src/server/crawlers/lib/ai-filter-v2-prompt.ts` — FILTER_V2_SYSTEM_PROMPT
- `.claude/agents/filter-v2-evaluator.md` — medium tier AI 평가 agent
