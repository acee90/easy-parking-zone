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

- 로컬 SQLite에서 샘플 수집 (PASS 1000건, FAIL 1000건)
- rule filter 적용 → high/medium/low 분류
- `/tmp/eval-149-medium.json` 생성 (medium tier → AI eval 대상)

### Step 2 — AI Filter Eval (haiku subagent)

medium 샘플을 60건 청크로 분할하여 haiku subagent 병렬 평가.

**청크 분할:**
```python
import json, math
d = json.load(open('/tmp/eval-149-medium.json'))
chunk_size = 60
chunks = [d[i:i+chunk_size] for i in range(0, len(d), chunk_size)]
for i, chunk in enumerate(chunks):
    json.dump(chunk, open(f'/tmp/eval-149-chunk-{i:02d}.json', 'w'), ensure_ascii=False)
```

**subagent 프롬프트 (각 청크 그룹당 1개):**

> /tmp/eval-149-chunk-XX.json 부터 /tmp/eval-149-chunk-YY.json 까지 처리하세요.
>
> 각 항목에 대해 아래 기준으로 판정 (lot_name 무시, fulltext + title만 사용):
>
> filterPassed = false 기준:
> - "thin": 식당·관광지 방문기에서 주차를 1~3문장 부수 언급 / 주차 구체 정보 없음
> - "boilerplate": 운영요일/관리기관/구획수 등 DB 필드 나열, 집계 사이트 패턴 / 실경험 없음
> - "ad": 광고·협찬 본문
> - "realestate": 분양·택지 안내
> - "news": 보도자료·공공기관 발표
> - "irrelevant": 주차 이용 정보 전혀 없음
>
> filterPassed = true: 실이용자 방문 경험 2문장 이상 OR 구체 주차 정보(위치/요금/운영시간/이용 팁)
>
> sentimentScore: 5=긍정, 3=중립, 1=부정
>
> 결과를 /tmp/eval-149-partial-XX.json 형식으로 저장:
> {"results": [{"id": 123, "filterPassed": true, "filterRemovedBy": null, "sentimentScore": 3}]}

**병합:**
```python
import json, glob
partials = sorted(glob.glob('/tmp/eval-149-partial-*.json'))
all_results = []
for f in partials:
    all_results.extend(json.load(open(f)).get('results', []))
json.dump({'results': all_results}, open('/tmp/eval-149-ai-results.json', 'w'), ensure_ascii=False, indent=2)
```

### Step 3 — 최종 리포트 생성

```bash
bun run scripts/eval-pipeline-149.ts --report
```

AI 결과 머지 후 `/tmp/eval-149-report.md` 최종 리포트 생성.

---

## 합격 기준

| 지표 | 목표 |
|------|------|
| Rule high precision | ≥ 90% |
| Medium ratio | ≤ 60% |
| AI filter recall (vs filter_v2) | ≥ 70% |
| Match name match rate | ≥ 70% |

> **AI accuracy 해석 주의**: AI filter는 lot_name 없이 평가하므로 filter_v2(lot_name 기반)와 직접 비교는 의미 없음.
> recall(filter_v2 PASS 중 얼마나 통과)이 더 유의미한 지표.

미달 시 해당 스테이지 기준 재조정 후 재eval.
