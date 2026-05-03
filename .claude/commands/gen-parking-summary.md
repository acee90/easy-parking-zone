---
description: parking_lot_stats AI 필드(ai_summary + ai_tip_*) 생성 — JSON 입력 파일을 parking-lot-summary-generator 에이전트로 처리하여 SQL UPSERT 파일 출력
---

# gen-parking-summary

## 인자 파싱

`$ARGUMENTS` 예시: `data/lots_for_summary.json --limit 100`

| 인자 | 기본값 | 설명 |
|------|--------|------|
| 첫 번째 positional | `data/lots_for_summary.json` | 입력 JSON 파일 경로 |
| `--limit N` | 전체 | 처리할 최대 건수 |

## 입력 JSON 형식

```json
[
  {
    "id": "KA-1234567890",
    "name": "스타필드 위례 주차장",
    "address": "경기도 하남시 ...",
    "web_summaries": ["요약1", "요약2", "..."],
    "reviews": ["[R1] 종합 4/5 · ... — \"...\"", "..."]
  }
]
```

- `web_summaries`: `web_sources.ai_summary` 중 비어있지 않은 값, 관련도 상위 30건 권장
- `reviews`: `user_reviews` 최근 30건. 없으면 `[]`
- 둘 다 비어있는 lot은 에이전트가 건너뜀

## 실행

`parking-lot-summary-generator` 에이전트 (Haiku, model: haiku)를 Agent 도구로 호출한다.

에이전트에 전달할 내용:
- 입력 파일 절대 경로: `/Users/junhee/Documents/projects/parking-map/main/<입력파일>`
- 출력 파일: 입력 경로에서 `.json` → `.sql` 치환
- limit 값 (지정된 경우)
- `.claude/agents/parking-lot-summary-generator.md`의 지시를 따를 것

에이전트가 완료되면 아래를 보고한다:

```
=== parking_lot_stats AI 요약 생성 완료 ===
입력: <파일명> (<전체 건수>건 중 <처리 건수>건)
생성: <건수>건
건너뜀: <건수>건 (소스 부족)
tip null 비율: pricing <%> / visit <%> / alternative <%>
출력: <SQL 파일 경로>

샘플 (3개):
[id] <name>
  요약: <summary 첫 줄>
...
```

## 적용 (수동)

에이전트는 SQL 파일까지만 만든다. 실제 D1 적용은 사용자가 수동 실행:

```bash
# 로컬
bun run scripts/lib/d1.ts --file=<출력 SQL>

# 리모트
bun run scripts/lib/d1.ts --file=<출력 SQL> --remote
```
