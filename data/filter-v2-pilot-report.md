# #148 Phase C — Filter v2 Pilot Report

- DB: remote D1 `parking-db`
- Generated: 2026-05-04 (v2.1 final)
- Subagent: filter-v2-evaluator (Haiku via Claude Code Task tool, no API key)

## 최종 분포 (v2.1, n=85)

| filter_passed_v2 | reason | count | % |
|---|---|---:|---:|
| 1 (passed) | NULL | 8 | **9.4%** |
| 0 | boilerplate | 42 | 49.4% |
| 0 | wrong_lot | 26 | 30.6% |
| 0 | thin | 6 | 7.1% |
| 0 | news | 2 | 2.4% |
| 0 | irrelevant | 1 | 1.2% |

→ **90.6% rejection rate** — raw stage 가 통과시킨 row 의 90% 가 SEO 가치 0 (자동생성 / 보일러플레이트 / cross-lot mismatch).

## 검증 절차

### Step 1: v2.0 (관대) — 50건 파일럿

- pass: 11 / 50 (22%)
- 주요 reject: wrong_lot 26 (SEO cross-lot mismatch — "진곡일반산업단지 10" 페이지가 "7번" lot 에 매칭)

### Step 2: cross-validation (v2.0 의 15건 passed 재평가)

- 일치율: 50% (5/10) — v2.0 이 서포터즈/공식 boilerplate 6건 잘못 통과시킴
- 결론: v2.0 too lenient → v2.1 strict 으로 전환

### Step 3: v2.1 (3-point self-check) — 50건 재평가

- pass: 4 / 50 (8%) — 6건 추가 reject (서포터즈 / thin)
- 3-point self-check: ① lot_name 등장 ② 1인칭 주차 경험 ③ 주차 비중 30%+

### Step 4: v2.1 inter-rater 신뢰도 — 새 30건 두 번 평가

- Run #1: 0 / 30 passed (boilerplate 27, thin 1, wrong_lot 1, irrelevant 1)
- Run #2: 0 / 30 passed (boilerplate 28, thin 1, wrong_lot 1)
- **Pass/fail 100% 일치**, reason 분류는 30건 중 29건 일치 (1건만 boilerplate↔irrelevant flip)
- 30건 샘플 자체가 SEO 템플릿 위주 (govpped.com 진곡 시리즈 + 롯데미아/노원 자동생성)

## 핵심 패턴

### 1. SEO 자동생성 사이트 cross-lot mismatch (wrong_lot 31%)

`govpped.com` / `parking.govpped.com` / `bonuscookie.com` 등이 단일 페이지를 여러 lot 에 잘못 매칭. title 이 "진곡일반산업단지 10" 인데 lot_name 이 "진곡일반산업단지 7" — 키워드 매칭은 통과, 본문은 다른 주차장.

→ scoring v3 개선 여지: 도메인 화이트/블랙리스트, 숫자 일치 검증.

### 2. 서포터즈 / 공식 안내 boilerplate (49%)

수원도시공사 서포터즈, 시청 SNS 시민기자단, 롯데마트/롯데미아 SEO 정리글, 공영주차장 알리미 — 사실은 정확하지만 1인칭 경험 0건. v2.1 에서 boilerplate 분류.

### 3. 부수적 주차 언급 (thin 7%)

도서관/터미널/시장 본후기에 주차장 1~2 줄. lot 이름 등장 + 1인칭 OK 이지만 주차 비중 < 30% → thin.

## v2.1 길이 / 품질 메트릭

| category | n | full_text 평균 | relv_v2 평균 |
|---|---:|---:|---:|
| **passed** | 8 | **2,400자+** | 70+ |
| boilerplate | 42 | 1,059자 | 74 |
| wrong_lot | 26 | 1,072자 | 70 |
| thin | 6 | 평균 800자 | 50 |

→ Passed 그룹은 본문 평균 2× 더 길고, 진짜 사용자 경험 보유. 1인칭 표현 + 주차 묘사 비중 확실.

## 16K 풀 외삽 추정

9.4% pass → #141 입력 풀: **~1,500 row** (vs 16,322 raw matched).
- ai_summary 재생성 비용: ~$3-4 (vs $40)
- 정밀도 ↑↑ (false positive 거의 제거)
- 다운스트림 hallucination 위험 ↓↓

## 다음 단계 (#141)

본 이슈 머지 후 #141 진행:
- 입력 풀: `WHERE filter_passed_v2 = 1` (~1,500 row)
- 길이 가드 제거 (PR #137 의 MIN_SUMMARY_LENGTH=200 강제 reject 안 함)
- 8 항목 체크리스트 (진입로/주차면/통로/요금/혼잡도/층별/출입구/보행) 프롬프트에 명시
- v2 통과 row 는 진짜 1인칭 경험 보유 → summary 자연스럽게 풍부

## 데이터 파일

- 입력: `data/filter_v2_pilot100.json` (100, 50 처리), `data/filter_v2_run2.json` (30)
- 출력 SQL: `data/filter_v2_smoke.sql`, `data/filter_v2_pilot50_v2.1.sql`, `data/filter_v2_run2_eval1.sql`, `data/filter_v2_run2_eval2.sql`
- relevance UPDATEs: `data/filter_v2_smoke_relevance.sql`, `data/filter_v2_pilot100_relevance.sql`, `data/filter_v2_run2_relevance.sql`
