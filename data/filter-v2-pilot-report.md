# #148 Phase C — Filter v2 Pilot Report (55 records)

- DB: remote D1 `parking-db`
- Generated: 2026-05-04
- Subagent: filter-v2-evaluator (Haiku via Claude Code Task tool, no API key)

## 분포

| filter_passed_v2 | reason | count | % |
|---|---|---:|---:|
| 1 (passed) | NULL | 15 | 27.3% |
| 0 | wrong_lot | 26 | 47.3% |
| 0 | boilerplate | 9 | 16.4% |
| 0 | irrelevant | 2 | 3.6% |
| 0 | news | 2 | 3.6% |
| 0 | ad | 1 | 1.8% |

→ **73% rejection rate** (raw stage 가 통과시킨 row 의 73% 가 실제로는 SEO 가치 0).

## 핵심 발견

### wrong_lot 47% — SEO 자동생성 사이트의 cross-lot mismatch

`govpped.com` / `parking.govpped.com` 같은 SEO 자동생성 사이트가 단일 주차장 정보 페이지를 여러 lot 에 잘못 매칭. title 이 "진곡일반산업단지 10 공영주차장" 이지만 lot_name 이 "진곡일반산업단지 7" 인 케이스가 26건 중 22건.

→ **scoreBlogRelevanceFull 의 키워드 매칭이 너무 관대**: "진곡" 만 매칭되어도 high score 부여. v2 분류기 (subagent) 가 본문 정독으로 잡아냄.

### relevance_score_v2 vs filter_passed_v2 불일치

relevance_score_v2 = 100 인데 wrong_lot 으로 reject 되는 케이스 다수. 이는 **로컬 키워드 알고리즘의 한계** — lot 이름 토큰이 본문에 등장한다고 해서 그 lot 에 대한 글이라는 보장 없음.

→ #141 입력 풀 결정 기준은 **`filter_passed_v2 = 1` 만**으로 충분 (relevance_score_v2 threshold 무관). 향후 scoring v3 개선 가능성.

### boilerplate 16% — 운영시간/요금만 나열

수원도시공사 서포터즈, 공영주차장 안내문 등 사용자 경험 0건. SEO 가치 낮음.

## 다음 단계

### 16K 풀 스케일링

- 50 records/subagent 호출 가정 → ~330 호출 = 컨텍스트 비용 큼
- Anthropic API 키 받으면 `scripts/refilter-matched.ts` 로 25분 + ~$25 처리 가능
- 또는 단계적 (1K → 5K → 16K) subagent 운영

### scoring v3 개선 여지

- "진곡일반산업단지 7" vs "진곡일반산업단지 10" 같은 case 잡기 위해 **숫자 일치** 가산점/감점
- SEO 자동생성 도메인 화이트/블랙리스트
- title 과 본문 lot_name 분리 검증

## 적용 효과 추정 (16K 풀 외삽)

15 / 55 = 27% pass 비율 그대로 16K 에 적용 시:
- #141 입력 풀: ~4,400 row (vs 16,322)
- ai_summary 재생성 비용: ~$11 (vs $40)
- 정밀도 ↑, hallucination 위험 ↓

## 데이터 파일

- 입력: `data/filter_v2_pilot100.json` (100 records, 50 처리)
- 출력 SQL: `data/filter_v2_pilot50.sql`, `data/filter_v2_smoke.sql` (5 records)
- relevance UPDATEs: `data/filter_v2_pilot100_relevance.sql`, `data/filter_v2_smoke_relevance.sql`
