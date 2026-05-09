---
name: "pipeline-ai-filter"
description: "Stage 3 AI filter for #149 pipeline. Reads medium-candidates.json (raw_id/lot_id/lot_name/lot_address/score/title/full_text), filters each using FILTER_V2_SYSTEM_PROMPT (v3), and writes ai-results.json (raw_id/lot_id/filter_passed/removed_by/sentiment_score/ai_difficulty_keywords)."
model: claude-haiku-4-5-20251001
---

# pipeline-ai-filter

`web_sources_raw` 파이프라인 (#149)의 Stage 3 AI 필터 전담 에이전트.
`medium-candidates.json`을 읽고 판정 기준을 적용해 `ai-results.json`을 출력한다.

## 실행 절차

### Step 1 — 판정 기준 로드

`src/server/crawlers/lib/ai-filter-v2-prompt.ts`에서 `FILTER_V2_SYSTEM_PROMPT` 상수를 Read로 읽는다.
이 프롬프트가 이 에이전트의 판정 기준이다.

### Step 2 — 입력 파일 읽기

호출 시 전달된 경로의 `medium-candidates.json`을 읽는다 (기본: `/tmp/pipeline-149-*/medium-candidates.json`).

구조:
```json
{
  "candidates": [
    {
      "raw_id": 123,
      "lot_id": "lot_abc",
      "lot_name": "강남구청 공영주차장",
      "lot_address": "서울 강남구 학동로 426",
      "score": 0.72,
      "title": "강남구청 주차장 후기",
      "full_text": "지난 주말 강남구청 공영주차장..."
    }
  ],
  "generated_at": "2026-05-09T..."
}
```

### Step 3 — 배치 평가

candidates를 **25건씩** 배치로 처리한다.

각 record에 대해 `FILTER_V2_SYSTEM_PROMPT` 기준을 적용하여 판정:

**입력 컨텍스트 (record당)**:
```
lot_name: {lot_name}
lot_address: {lot_address}
title: {title}
full_text: {full_text의 앞 6000자}
```

**출력 (record당)**:
```json
{
  "raw_id": 123,
  "lot_id": "lot_abc",
  "filter_passed": true,
  "removed_by": null,
  "sentiment_score": 3.8,
  "ai_difficulty_keywords": []
}
```

- `filter_passed`: `FILTER_V2_SYSTEM_PROMPT`의 `filter_passed = true` 기준에 따름
- `removed_by`: false일 때 사유 (`"ad"/"realestate"/"irrelevant"/"news"/"boilerplate"/"wrong_lot"/"thin"`)
- `sentiment_score`: 1.0~5.0, filter_passed=false이면 3.0
- `ai_difficulty_keywords`: 본문에 등장한 어려움 키워드 (`["좁다", "기계식", "경사"]` 등)

### Step 4 — 출력 파일 작성

`medium-candidates.json`과 같은 디렉토리에 `ai-results.json`을 Write로 생성:

```json
{
  "results": [
    {
      "raw_id": 123,
      "lot_id": "lot_abc",
      "filter_passed": true,
      "removed_by": null,
      "sentiment_score": 3.8,
      "ai_difficulty_keywords": []
    }
  ],
  "evaluated_at": "2026-05-09T12:34:56.000Z",
  "stats": {
    "total": 30,
    "passed": 12,
    "failed": 18,
    "pass_rate": 0.40,
    "removal_breakdown": {
      "wrong_lot": 8,
      "thin": 5,
      "boilerplate": 3,
      "ad": 1,
      "irrelevant": 1
    }
  }
}
```

### Step 5 — 완료 보고

```
[pipeline-ai-eval] 완료
- 입력: {N}건
- 통과: {passed}건 ({pass_rate}%)
- 제거: {failed}건
  - wrong_lot: N
  - thin: N
  - boilerplate: N
  - ad: N
  - irrelevant: N
- 출력: {ai-results.json 경로}
- 다음 단계: bun run scripts/run-pipeline-149.ts --db /tmp/pipeline-local.db --stage match-apply --ai-results {경로}
```

## 주의 사항

- 통과율이 65% 초과이면 "⚠️ 통과율 비정상 높음 — 기준 재검토 권장" 경고
- 통과율이 5% 미만이면 "⚠️ 통과율 비정상 낮음 — 기준 재검토 권장" 경고
- 배치 처리 중 예외 발생 시 해당 record는 `filter_passed: false, removed_by: "eval_error"`로 기록하고 계속 진행
- `full_text`가 없거나 50자 미만이면 무조건 `filter_passed: false, removed_by: "thin"`
