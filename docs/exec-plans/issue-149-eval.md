# Eval 계획: fulltext-first 파이프라인 (#149)

> 목적: 새 파이프라인의 3개 스테이지(rule filter / AI filter / match) 각각의 품질을 측정한다.
> Ground truth: `web_sources.filter_passed_v2` (fulltext 기반 재평가, #148 완료분)

---

## 샘플링 전략

| 구분 | 소스 | 조건 | 건수 | 목적 |
|------|------|------|------|------|
| A | `web_sources` | `filter_passed_v2=1, full_text_status='ok'` | 15 | rule/AI filter PASS 정밀도 |
| B | `web_sources` | `filter_passed_v2=0, full_text_status='ok'` | 15 | rule/AI filter FAIL 정밀도 |
| C | `web_sources_raw` | `filter_passed=1, matched_at IS NOT NULL` | 10 | 매칭 품질 spot-check |
| D | `web_sources_raw` | `filter_passed=1, matched_at IS NULL` | 10 | 매칭 실패 원인 분석 |

총 50건. A/B는 filter 스테이지 eval, C/D는 match 스테이지 eval.

---

## Stage 1 — Rule Filter Eval

A(15) + B(15) = 30건에 `classifyByRule()` 적용.

### 측정 지표

| 지표 | 정의 | 목표 |
|------|------|------|
| High precision | high로 분류된 row 중 filter_passed_v2=1 비율 | ≥ 90% |
| Low precision | low로 분류된 row 중 filter_passed_v2=0 비율 | ≥ 90% |
| Medium ratio | 전체 30건 중 medium 건수 비율 | ≤ 50% |
| False negative rate | PASS(v2=1)인데 low로 분류된 비율 | ≤ 10% |

### 판정 기준

- High precision < 80% → rule 기준 강화 필요 (과-pass 위험)
- False negative rate > 20% → rule 기준 완화 필요 (유효 콘텐츠 over-reject)
- Medium ratio > 60% → AI 비용 절감 효과 미미, rule 재조정

---

## Stage 2 — AI Filter Eval (Medium tier)

Stage 1에서 medium으로 분류된 row들에 새 Haiku 프롬프트 적용.
입력: `full_text` (최대 2,000자). Ground truth: `filter_passed_v2`.

### 측정 지표

| 지표 | 정의 | 목표 |
|------|------|------|
| Accuracy | AI 판정 vs filter_passed_v2 일치율 | ≥ 85% |
| Precision (PASS) | AI가 PASS한 것 중 v2=1 비율 | ≥ 80% |
| Recall (PASS) | v2=1인데 AI가 PASS한 비율 | ≥ 75% |
| removed_by 분포 | thin/boilerplate 비율 (신규 기준 효과) | 기록만 |

### 비교 기준

구버전 프롬프트(snippet 120자)와 비교:
- 구버전 filter_passed가 맞았는지 vs 신버전이 맞았는지
- 특히 boilerplate / thin 케이스에서 차이 확인

---

## Stage 3 — Match Eval

### C그룹 (10건, 매칭 성공)

각 raw row의 title/content에 lot_name이 실제로 등장하는지 확인.

| 항목 | 정의 | 목표 |
|------|------|------|
| Name match rate | title 또는 content에 lot_name 포함 비율 | ≥ 70% |
| Source diversity | naver_blog / ddg / brave 비율 | 기록만 |

### D그룹 (10건, 매칭 실패)

매칭 실패 원인 분류:
- `no_candidate`: FTS5 후보 없음 (키워드 너무 일반적)
- `low_confidence`: 후보 있지만 신뢰도 미달
- `content_mismatch`: 제목에 주차장 이름 없음

---

## 실행 방법

### 방법 1: `/eval-pipeline-149` 커맨드 (권장)

Claude Code에서 `/eval-pipeline-149` 실행.
- Step 1: bun 스크립트로 데이터 수집 + rule/match eval
- Step 2: haiku subagent가 medium tier AI filter 분류
- Step 3: 결과 머지 후 최종 리포트 생성

### 방법 2: 수동 단계 실행

```bash
# 1. 데이터 수집 + rule/match eval → /tmp/eval-149-medium.json 생성
bun run scripts/eval-pipeline-149.ts --remote

# 2. /tmp/eval-149-medium.json → /tmp/eval-149-ai-results.json 생성
#    (haiku subagent 또는 수동 처리)

# 3. AI 결과 머지 후 최종 리포트
bun run scripts/eval-pipeline-149.ts --remote --report
```

> AI filter eval은 ANTHROPIC_API_KEY를 직접 사용하지 않음.
> haiku subagent를 통해 `/tmp/eval-149-medium.json`을 처리한다.

출력:
- `/tmp/eval-149-medium.json`: AI eval용 medium tier 샘플 (중간 산출물)
- `/tmp/eval-149-ai-results.json`: haiku subagent 결과 (외부 생성)
- `/tmp/eval-149-results.json`: 건별 상세 결과
- `/tmp/eval-149-report.md`: 최종 평가 리포트

---

## 합격 기준 (전체)

| 조건 | 합격 |
|------|------|
| Rule filter high precision | ≥ 90% |
| Rule filter false negative rate | ≤ 10% |
| Medium ratio | ≤ 50% |
| AI filter accuracy | ≥ 85% |
| Match name match rate | ≥ 70% |

하나라도 미달 시 해당 스테이지 기준 재조정 후 재eval.
