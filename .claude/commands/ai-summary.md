---
description: 주차장 AI 요약 배치 생성 — remote D1에서 추출 → Claude가 직접 요약 → remote D1에 저장
---

# AI Summary

## 인자 파싱

$ARGUMENTS 에서 아래 플래그를 읽는다.

| 플래그 | 기본값 | 설명 |
|--------|--------|------|
| `--limit=N` | `50` | 배치 크기 |
| `--local` | false | remote 대신 local D1 사용 |
| `--eval-only` | false | 저장 없이 eval만 실행 |
| `--dry-run` | false | extract만 하고 종료 (내용 확인용) |

플래그 미지정 시 기본값 사용. `--local` 미지정이면 `--remote` 플래그 적용.

## 실행 플로우

### Step 1: 추출

```bash
cd /Users/junhee/Documents/projects/parking-map/main
bun run scripts/extract-lots-for-summary.ts --limit=<N> [--remote]
```

- 출력: `summary_batch.json`
- 0건이면 "모든 대상 처리 완료" 출력 후 종료
- `--dry-run`이면 배치 목록만 출력하고 종료

### Step 2: AI 요약 생성 (Claude 직접)

`summary_batch.json`을 읽어 각 주차장의 요약을 직접 생성한다.

**출력 형식 (주차장당):**
```json
{
  "id": "주차장 ID",
  "summary": "전체 특징 2~3문장 (120~180자). 진입 난이도·주차면 넓이·요금·혼잡 시간대 위주.",
  "tip_pricing": "요금 구조·할인·무료 조건 1~2문장. 근거 없으면 null.",
  "tip_visit": "진입 경로·혼잡 시간대·주의사항 1~2문장. 근거 없으면 null.",
  "tip_alternative": "근처 대안 주차장·대중교통 연계 1~2문장. 근거 없으면 null."
}
```

**생성 규칙:**
- 경어체(~습니다, ~합니다)만 사용, 평서체 금지
- "AI가 분석했다" 등 메타 표현 금지
- 과장·이모지·마크다운 금지
- 모순 의견 → "대체로 ~하지만 ~라는 의견도 있습니다"
- 근거 빈약한 필드 → null
- content는 400자까지만 참고
- web_sources + reviews 합계 0이면 건너뜀

전체 결과를 `summary_results.json`으로 저장한다.

`--eval-only`이면 Step 3~4 건너뛰고 Step 5(eval)만 실행.

### Step 3: 저장

```bash
bun run scripts/save-summary-results.ts [--remote]
```

### Step 4: 정리

```bash
rm -f summary_batch.json summary_results.json
```

### Step 5: Eval

```bash
bun run scripts/eval-summary-quality.ts
```

eval은 임시파일 삭제 전에 실행한다. 종합 리포트(등급 분포 + 소스관련성 평균)를 출력한다.

## 완료 보고 형식

```
=== AI 요약 생성 완료 ===
추출: N건
생성: N건 (건너뜀: N건)
저장: local | remote
Eval: A:N B:N C:N F:N | 소스관련성 평균 N%
```
