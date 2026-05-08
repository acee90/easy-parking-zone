---
description: "#149 파이프라인 eval — rule/AI/match 스테이지별 품질 측정. haiku subagent로 AI filter eval 자동 실행"
model: claude-haiku-4-5-20251001
---

# #149 파이프라인 Eval

## 실행 순서

### Step 0 — 로컬 DB 덤프 (최초 1회 또는 데이터 최신화 필요 시)

```bash
bunx wrangler d1 export parking-db --remote --output=.wrangler/d1-eval-dump.sqlite
```

이후 eval은 로컬 SQLite로 실행 (네트워크 불필요).

### Step 1 — 데이터 수집 & Rule/Match Eval

```bash
bun run scripts/eval-pipeline-149.ts
```

- 로컬 SQLite에서 샘플 수집 (PASS 500건, FAIL 500건, 매칭성공 30건, 매칭실패 30건)
- rule filter 적용 → high/medium/low 분류
- match eval 실행
- `/tmp/eval-149-medium.json` 생성 (medium tier → AI eval 대상)

### Step 2 — AI Filter Eval (haiku subagent)

`/tmp/eval-149-medium.json` 파일을 읽어 각 항목을 주차장 정보 콘텐츠인지 분류한다.

**입력 포맷** (`/tmp/eval-149-medium.json`):
```json
[
  {
    "id": 123,
    "title": "...",
    "full_text": "...",
    "lot_name": "...",
    "ground_truth": 1
  }
]
```

**분류 기준** (아래 기준으로 각 항목 판정):

filter_passed = true 조건 (1건 이상 포함 시):
- 사용자 후기: 방문 경험, 진입로, 주차면, 요금, 혼잡도, 편의/불편 묘사
- 주차장 정보: 위치, 요금, 운영시간, 주차면수, 무료/유료, 결제/할인, 접근 동선, 이용 팁

filter_passed = false 판정 기준:
- `thin`: 본문 200자 미만이거나 주차장 구체 정보 전무
- `boilerplate`: SEO 자동생성 템플릿 (운영시간/요금만 나열, 공식 가이드 톤)
  단, 실제 요금/이용팁/진입 정보 있으면 통과
- `ad`: 광고/협찬 본문 ("쿠팡 파트너스", "체험단", "원고료를 제공받아")
- `realestate`: 분양/택지 안내
- `news`: 보도자료/공공기관 발표
- `irrelevant`: 주차장 사용자 후기/경험 정보 0건

**출력 포맷** (`/tmp/eval-149-ai-results.json`):
```json
{
  "results": [
    {
      "id": 123,
      "filterPassed": true,
      "filterRemovedBy": null,
      "sentimentScore": 4
    }
  ]
}
```

- `sentimentScore`: 5=매우 긍정(진입 쉽고 면 넓음), 3=중립, 1=매우 부정(좁고 무서움)
- `filterRemovedBy`: filterPassed=false 시 사유, true 시 null
- 모든 항목을 처리한 후 파일 저장. 처리 결과 요약(총건수/통과/제거)도 출력

### Step 3 — 최종 리포트 생성

```bash
bun run scripts/eval-pipeline-149.ts --report
```

AI 결과 머지 후 `/tmp/eval-149-report.md` 최종 리포트 생성.
리포트 내용을 출력하여 합격/불합격 판정을 확인한다.

---

## 합격 기준

| 지표 | 목표 |
|------|------|
| Rule high precision | ≥ 90% |
| False negative rate | ≤ 10% |
| Medium ratio | ≤ 50% |
| AI filter accuracy | ≥ 85% |
| Match name match rate | ≥ 70% |

미달 시 해당 스테이지 기준 재조정 후 재eval.
