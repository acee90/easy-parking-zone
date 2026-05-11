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
> 각 항목에 대해 아래 v3 기준으로 판정 (lot_name 무시, fulltext + title만 사용):
>
> filterPassed = true 조건 (하나라도 해당하면 즉시 통과):
> 1. 특정 주차장의 요금·운영시간·주차면수 중 구체적 수치/조건이 언급됨
> 2. 진입로(폭/경사/기계식)·혼잡도·이용 편의/불편에 대한 실이용자 직접 경험 (2문장 이상)
> 3. 주차 관련 구체적 팁: 할인 방법, 덜 혼잡한 시간대, 진입 주의점 (막연한 언급 제외)
>
> filterPassed = false 기준:
> - "thin": 아래 중 하나 해당
>   · 주차 언급이 "근처 공영주차장 이용", "골목주차 가능" 수준의 1~2문장뿐이고 구체적 정보 없음
>   · 식당·카페·관광지·공원·행사 방문기가 본문 주제이고 주차 편의만 부수적으로 1~2문장 언급
> - "boilerplate": 아래 중 하나 해당 (수치 있어도 차단)
>   · 공공데이터 자동 집계: "공개 데이터 기준으로 정리했으며" 등 면책 문구 + 주소·면수·요금을 라벨:값 필드 형식으로 나열, 1인칭 경험 문장 없음
>   · 지역 N곳 목록: "OO시 주차장 N곳 완벽정리", "주변 주차장 TOP5" 등 집계 페이지
>   · SEO 자동생성: 개인 경험 없이 운영시간/요금/주소만 나열, 공식 가이드 톤
>   · 핵심: 본문에 1인칭 경험 문장("가보니", "이용해보니")이 없고 라벨:값 나열만 있으면 → boilerplate
> - "ad": 광고·협찬 본문 ("체험단", "원고료를 제공받아", "원고료를 지원받았습니다", "협찬")
> - "realestate": 분양·택지가 주제
> - "news": 기자 명의·소속 명기된 보도자료 또는 행정 발표문 ("OO시는 발표했다", "추진한다", "운영하기로 했다")
>   · 주의: "일상킷", "플레이스뷰" 등 집계 사이트는 news가 아닌 boilerplate로 처리
>   · 공영주차장 안내 페이지, 운영시간/요금 안내 페이지는 제외
> - "irrelevant": 주차 키워드(주차, 주차장, 입차, 출차)가 거의 없는 식당·관광·행사 블로그
>
> sentimentScore: 5=긍정(진입 쉽고 넓음), 3=중립/정보만, 1=부정(좁고 어려움)
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
