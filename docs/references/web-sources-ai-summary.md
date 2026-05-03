# web_sources.ai_summary 재추출 스킬 (v2: top-N + lot-specific long-form)

> **갱신 이력**
> - 2026-04: v1 (30~60자 한줄, 단순 한줄 재생성)
> - 2026-05: v2 (200~600자 long-form, lot당 top-N 후보군, lot-specific) — 이슈 #135
> - 2026-05: v3 (#140 풀텍스트 보강 → web_sources.full_text 1,400~2,000자 입력) — 이슈 #141 진행 중

## v2 한계 + v3 방향성

v2 의 본질적 한계: 입력으로 받는 `web_sources.content` 가 121자 snippet (Naver/DDG 검색 API description). 200~600자 long-form 을 합성적으로 만들면 hallucination 위험. PR #137 회고에서 6.7% 수율 (45→3) 확인.

v3 (#140 + #141) 가 해결하는 것:
- **#140**: `web_sources.full_text` 컬럼 도입. matched 22K row 의 source_url 을 다시 fetch 해 본문 풀텍스트 (avg 1,400~2,000자) 저장.
- **#141**: ai_summary 재생성 시 `full_text` 를 입력으로 사용 → 진짜 long-form 가능, hallucination 위험 대폭 축소.

본 문서의 v2 절차는 여전히 유효하지만 입력 컬럼이 `content` → `full_text` 로 이동한다. v3 변경은 #141 완료 후 갱신 예정.

## 배경

`web_sources.ai_summary`는 wiki 페이지 SSR 본문에 직접 노출된다 (`src/routes/wiki/$slug.tsx`).

**v1 문제점**: 한줄 요약은 SSR 단어수 향상에 기여 못함. 이슈 #135 진단 결과 평균 단어수 315 (median 859 미달).

**v2 전략**: lot당 후보군을 잘 골라서 lot-specific long-form으로 재생성.

> **핵심 원칙**: long-form 성패는 후보군 품질에 크게 의존한다. 모든 web_sources에 long-form 시도하면 content가 짧은 row(DDG/Brave snippet 등)에서 실패·환각 발생.

## 파이프라인 구조

```
[크롤링]
web_sources_raw (URL 단위, 주차장 미매칭)
    ↓ ai-filter-sources.ts (필터 + 단순 lot-agnostic 요약)
    filter_passed=1 만 web_sources로 승격

[v2 재생성]
web_sources (parking_lot_id 부여됨)
    ↓ scripts/extract-top-sources-by-lot.ts (lot당 top-N 선별)
    data/top-sources-by-lot.json
    ↓ ai-summary-generator agent (lot-specific long-form 200~600자)
    data/top-sources-by-lot.sql
    ↓ scripts/apply-summaries.ts (c안 정책: 더 좋아질 때만 UPDATE)
    data/regen-applied.sql + data/regen-rejected.json
    ↓ wrangler d1 execute --remote --file
    DB 적용
```

## 후보군 quality_score (extract-top-sources-by-lot.ts)

각 web_sources row의 점수:

```
contentNorm    = min(LENGTH(content) / 1000, 1.0)         × 0.30
relevanceNorm  = min(relevance_score / 100, 1.0)          × 0.30
sourceNorm     = (naver_blog/cafe/tistory/youtube=1.0,    × 0.10
                  others=0.3)
keywordNorm    = min(keyword_count / 5, 1.0)              × 0.10
sentimentNorm  = min(|sentiment - 3.0| / 2.0, 1.0)        × 0.05
dupPenalty     = min((matched_lot_count - 1) × 0.1, 0.5)  (감산)

quality_score = sum - dupPenalty
```

**하드 필터**: `LENGTH(content) >= 200` 미만 row는 후보군에서 제외 (짧은 content는 long-form 못 만듦).

**그리디 source 다양성**: 단순 top-N 정렬이 아닌, 절반까지는 source 다양성 강제 후 점수 순 채움.

## ai-summary-generator agent 사양 (long-form)

`.claude/agents/ai-summary-generator.md`:

- **길이**: 200~600자
- **lot-specific**: 본문에 여러 주차장 나열된 경우 (예: "남해 38곳") `parking_lot_name`에 해당하는 부분만 추출
- **포함 항목**: 진입로(폭/회전/일방통행), 주차면(크기/기둥/경사), 통로(너비/회전), 요금(시간당/할인), 혼잡도(시간대/요일), 층별 특징, 출입구, 보행 동선
- **금지**: 메타 표현(~정보, ~안내), 3인칭 관찰자 시점, content 복사·붙여넣기, 근거 없는 추측·창작
- **빈 문자열**: content < 200자, 시설 홍보 위주, lot 관련 정보 부재 시

## c안 정책 (apply-summaries.ts)

agent가 생성한 SQL을 무조건 적용하지 않음. 다음 조건 만족 시에만 UPDATE:

```
new.length >= 200 AND
(old.length < 200 OR new.length > old.length)
```

거부 사유:
- `too_short`: new < 200자
- `not_better`: old도 충분히 길고 new가 더 짧거나 같음

거부된 row는 `data/regen-rejected.json`에 dump → 다음 단계에서 batch_size↓ 또는 모델 변경(Sonnet) 검토.

## 신규 크롤 경로 (ai-filter.ts)

`src/server/crawlers/lib/ai-filter.ts` (web_sources_raw 단계):

- SYSTEM_PROMPT summary 지시: 200~600자 long-form, 항목 체크리스트 명시
- `max_tokens`: `1200 * inputs.length` (long-form + tip 출력 여유)
- `toResult` 후처리: `summary < MIN_SUMMARY_LENGTH (200)` → `filter_passed=false, removed_by='short_summary'`
- 이 변경은 web_sources_raw 단계에 작동. short_summary는 web_sources로 승격되지 않음.

## 실행 절차 (예: 파일럿 lot 10개)

```bash
# 1. 후보군 추출
bun run scripts/extract-top-sources-by-lot.ts --remote --limit-lots 10 --top-n 5

# 2. agent로 long-form 생성 (slash command)
/regen-web-summary --limit-lots 10 --top-n 5 --remote
# 또는 Agent 도구로 ai-summary-generator 직접 호출

# 3. c안 정책 적용 (SQL만 생성, DB 변경 없음)
bun run scripts/apply-summaries.ts --remote --input data/top-sources-by-lot.sql

# 4. 검증
cat data/regen-rejected.json | jq 'length'
# regen-rejected 비율 < 30% 목표

# 5. DB 적용
bunx wrangler d1 execute parking-db --remote --file data/regen-applied.sql
```

## 검증 기준 (이슈 #135)

- 스타필드시티 위례 (KA-1935812519) ai_summary 5개 이상이 200자 이상
- 샘플 wiki 페이지 SSR 단어수 ≥ 800
- Siteliner 평균 page size ≥ 50KB
- regen-rejected 비율 < 30%

## 비용 추정 (전체 처리 기준)

| 단계 | lot 수 | row 수 (top-5) | Haiku 비용 |
|------|-------|--------------|-----------|
| 파일럿 | 10 | ~50 | ~$0.05 |
| 1차 확대 | 100 | ~500 | ~$0.50 |
| 2차 확대 | 1,000 | ~5,000 | ~$5 |
| 전체 | ~13,000 | ~65,000 | ~$25 |

**합계 예상**: ~$28 (재시도 마진 10% 포함)
모델: `claude-haiku-4-5-20251001`

## 빈약한 lot 처리 (별도 이슈)

`web_sources < 3개`인 lot은 long-form 5개 못 만듦 → SSR 단어수 향상 한계.
별도 이슈로 분리하여 다음 옵션 검토:
- `parking_lot_stats` 통합 요약 강화 (`scripts/generate-lot-summary.ts`)
- 추가 크롤 source (Naver Place 풀텍스트 등)
- address 기반 generated content

## 관련 파일

- `src/server/crawlers/lib/ai-filter.ts` — 신규 크롤 SYSTEM_PROMPT (200~600자, MIN_SUMMARY_LENGTH=200)
- `src/server/crawlers/lib/ai-filter.test.ts` — toResult 후처리 단위 테스트
- `scripts/extract-top-sources-by-lot.ts` — 후보군 추출
- `scripts/apply-summaries.ts` — c안 정책 적용
- `scripts/ai-filter-sources.ts` — 신규 web_sources_raw 배치 필터링 러너
- `scripts/generate-lot-summary.ts` — `parking_lot_stats` 통합 요약 (별도 파이프라인)
- `.claude/agents/ai-summary-generator.md` — long-form 재생성 agent 사양
- `.claude/commands/regen-web-summary.md` — slash command
- `docs/exec-plans/web-sources-ai-summary-regen.plan.md` — 실행 계획 (v2)
