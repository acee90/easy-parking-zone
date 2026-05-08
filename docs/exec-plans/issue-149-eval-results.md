# Eval 결과 & 개선 계획: #149 파이프라인

> 최종 업데이트: 2026-05-08  
> 스크립트: `scripts/eval-pipeline-149.ts`  
> Ground truth: `web_sources.filter_passed_v2` (fulltext 기반 Haiku AI 평가)  
> 로컬 DB 기준 (`.wrangler/state/v3/d1/...sqlite`)

---

## 현재 지표 (2026-05-08 최종)

| 지표 | 결과 | 목표 | 판정 |
|------|------|------|------|
| Rule high precision | **100.0%** | ≥ 90% | ✅ |
| False negative rate | **12.1%** | ≤ 10% | ❌ |
| Medium ratio | **~59%** | ≤ 50% | ❌ |
| AI filter accuracy | 미평가 | ≥ 85% | — |

> medium ratio는 random 샘플 기준. 전체 DB 기준으로도 유사할 것으로 추정.

---

## Rule Filter 진화 이력

| 날짜 | 변경 | medium ratio | FN rate | High precision |
|------|------|-------------|---------|----------------|
| 초기 (이전 세션) | 기본 룰 | ~80% | 0% | 100% |
| 2026-05-08 | NARRATIVE + CONCRETE_PARKING 패턴 추가 | ~50% | ~20% | 100% |
| 2026-05-08 | thin rule 제거 | ~59% | ~12% | 100% |

---

## FN 원인 분석 (전체 DB, filter_v2=1 3,636건 중 439건)

| 원인 | 건수 | 비중 | 비고 |
|------|------|------|------|
| boilerplate | 367건 | 83.6% | 일상킷·태가의이야기 등 공공주차장 DB 집계 사이트 |
| realestate | 23건 | 5.2% | 부동산 키워드 포함 |
| event | 17건 | 3.9% | 결혼식·장례식 키워드 포함 |
| too_short | 16건 | 3.6% | 500자 미만 |
| news | 15건 | 3.4% | 보도자료 패턴 |
| ad | 1건 | 0.2% | 광고 |

### boilerplate FN의 특성

대부분 `운영요일평일`, `관리번호\d`, `1일권 요금` 패턴에 걸리는 공영주차장 공공 데이터 스크랩:
- **일상킷** (ilsangkit.com): 공영주차장 운영시간·요금 구조화 데이터
- **태가의 이야기**: 노상주차장 DB 나열 블로그
- 사용자 경험 없음, 위치·요금·운영시간만 포함

이 FN들은 filter_v2가 lot_name 맥락으로 관대하게 통과시킨 케이스이며,
**실제 AI 필터에서는 reject될 가능성이 높음** → 실질적 FN 아닐 수 있음.

---

## thin rule 실험 결과

thin rule (`narrativeMatches === 0 && !hasConcreteParking → low`) 제거 시:

| 지표 | 제거 전 | 제거 후 |
|------|---------|---------|
| Medium ratio | ~50% | ~59% |
| FN rate | ~20% | ~12% |
| FAIL→medium | 356건 | 508건 |

thin rule이 PASS FN ~70건뿐 아니라 FAIL 노이즈 ~150건도 차단하고 있었음.  
현재는 thin rule 제거 상태 유지 (FN 감소 목적).

---

## Ground Truth 한계

현재 ground truth = `filter_passed_v2` (Haiku AI, lot_name + fulltext 기반 평가)

한계:
1. **boilerplate FN 과대계상**: lot_name 맥락에서 통과된 공공 DB 데이터가 raw 단계에서는 보일러플레이트로 정상 판정됨
2. **wrong_lot 구분 불가**: raw 단계에서 lot_name 없어 wrong_lot 감지 불가능 → FN으로 집계됨

---

## 다음 개선 방향

> filter_v2 정답지 기반 개선의 한계에 도달.  
> **새 AI-filter 로직으로 실제 분류 결과를 eval한 후 rule 재조정**이 더 효과적.

### 권장 접근법

1. **새 AI-filter eval 세트 구성**
   - medium 샘플 200건 수동 레이블링 또는 Haiku 재평가 (lot_name 없이, fulltext만)
   - 이 결과를 새 ground truth로 사용

2. **boilerplate 패턴 재검토**
   - `운영요일\s*평일`, `관리번호\s*\d`, `구획수\s*\d+` 패턴 → 단독 매칭 시 medium으로 완화 검토
   - `Top\s*\d+`, `주변\s*주차장\s*(?:순위|Top)` → 유지 (SEO 집계 페이지)

3. **FN 후보 리스트 활용**
   - `/tmp/fn-candidates.json` (439건) → 실제 AI 필터 통과율 측정 후 룰 재조정

---

## 파일 위치

- `src/server/crawlers/lib/rule-filter.ts` — 3-tier rule filter (thin rule 제거됨)
- `scripts/eval-pipeline-149.ts` — eval 스크립트 (로컬 DB, 1000건 샘플)
- `scripts/fn-analyze.ts` — FN 원인 분석 스크립트
- `/tmp/fn-candidates.json` — FN 후보 439건 (id, title, reason, len)
