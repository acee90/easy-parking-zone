# Issue #138 Phase 0 — Data Audit

- Source: `remote` D1 `parking-db`
- Generated: 2026-05-03T11:15:09.862Z
- Total parking_lots: **31,939**

## 1. parking_lots column null rates (n=31939)

| Field | Null/Empty | % |
|---|---:|---:|
| address | 0 | 0.0% |
| weekday_start | 6766 | 21.2% |
| saturday_start | 12971 | 40.6% |
| holiday_start | 13014 | 40.7% |
| base_fee | 9223 | 28.9% |
| extra_fee | 15715 | 49.2% |
| daily_max | 27771 | 87.0% |
| total_spaces (null/0) | 15960 | 50.0% |
| phone | 18221 | 57.0% |
| payment_methods | 26560 | 83.2% |
| notes | 28581 | 89.5% |
| poi_tags (null/empty/[]) | 30876 | 96.7% |

- **is_free** lots: 16291 (51.0%)
- **is_curated**: 111 (0.3%) / has curation_reason: 111 (0.3%)

## 2. parking_lot_stats.ai_summary length distribution

| Bucket | Count |
|---|---:|
| 0_empty | 28087 |
| 1_under_100 | 3827 |
| 2_100_200 | 25 |

## 3. user_reviews per-lot distribution

| Bucket | Count |
|---|---:|
| 0_none | 31859 |
| 1_1_2 | 69 |
| 2_3_5 | 8 |
| 3_6plus | 3 |

## 4. web_sources (ai_summary present) per-lot distribution

| Bucket | Count |
|---|---:|
| 0_none | 24950 |
| 1_1_2 | 5364 |
| 2_3_5 | 1280 |
| 3_6_15 | 325 |
| 4_16plus | 20 |

## 5. nearby_places coverage

- total nearby rows: 56
- lots with ≥1 nearby: 46 (0.1%)
- lots with ≥1 nearby tip: 46 (0.1%)
- avg tips per lot (lots-with-tip): 1.2

## 6. parking_lot_stats coverage

- rows: 31939
- has final_score: 31939 (100.0%)
- reliability HIGH/MEDIUM/LOW: 0 / 0 / 0

## 7. Signal extremes

- lots_with_meta_only: 24871 (77.9%)
- lots_with_any_signal: 7068 (22.1%)

## 8. Sample 100 lots (4 quartiles × 25, by final_score)

Sample saved to `data/issue-138-sample-100.json` for Phase 4 pilot.

Composition:
- Q1 (lowest score): 25
- Q2: 25
- Q3: 25
- Q4 (highest score): 25

## Critical implications (pre-Phase 1 review)

### 데이터가 계획 가정보다 훨씬 sparse하다

원래 계획은 "web_sources 의존을 제거하고 meta+stats+reviews+nearby로 풍부하게"였으나 실측치는:

| 가정 | 실측 |
|---|---|
| reviews가 의미 있는 보조 시그널 | **31,859 lot (99.7%)이 review 0건**. 후기는 사실상 없는 시그널. |
| nearby_places로 주변 시설 언급 가능 | **46 lot (0.1%)만 nearby 보유**. 사용 불가. |
| stats.reliability를 메타로 활용 | **HIGH/MEDIUM/LOW 모두 0건** — reliability 컬럼이 채워져 있지 않음. |
| 외부 source 없어도 internal data로 충분 | **24,871 lot (77.9%)이 meta-only** (web 0건 + review 0건 + nearby 0건). |

### Meta 데이터 자체도 sparse

- 99% (31,939 중 31,914)이 ai_summary가 100자 미만 — preserve 정책 (`<400자만 재생성`) 조건이 사실상 모든 lot에 적용됨. **OK**
- address는 100% (good), weekday_start 79%, base_fee 71%, total_spaces 50%, phone 43% — 메타로 활용 가능한 핵심 4~5개 필드
- payment_methods/notes/poi_tags는 80% 이상 null — 입력 스키마에서 제외
- daily_max도 87% null — 제외

### 핵심 분기: 77.9% 메타-only lot을 어떻게 다룰까

**대안 A — 솔직한 짧은 summary (권장, 안전)**
- 메타-only는 200~300자 수준 짧은 요약 (운영시간, 요금, 면수, 무료 여부)으로 끝
- SSR 800단어 목표는 22.1% signal 보유 lot에서만 달성, 나머지는 단계적 보강 필요
- SEO 중복 콘텐츠 리스크 최소
- 단점: 원래 issue #138의 "31K 전체에서 800단어" 목표를 포기

**대안 B — 지역 컨텍스트 합성 (위험, 효과 불확실)**
- 주소에서 시·군·동 추출 → "○○구 일대의 일반적 주차 환경" 같은 컨텍스트 1~2 문단 추가
- 운영시간/요금 비교문 패턴 ("주변 평균 대비 ~") 추가
- 단점: 같은 동에 lot 100개면 비슷한 텍스트 100개 → Siteliner 중복 콘텐츠 폭발 위험. PR #137에서 reject했던 generic filler와 같은 패턴.

**대안 C — Phase 4 범위 좁히기 (권장, 실용)**
- Phase 4 파일럿 100건은 **signal 보유 7,068 lot 풀에서만** 4분위 mixed 샘플링
- 1K → 7K 까지는 signal 보유 풀에서. 나머지 24,871 meta-only는 **별도 이슈**로 분리 (지역 컨텍스트 / 외부 source 풀텍스트 재크롤 등).
- #138 본 이슈의 효과 측정은 7K signal 보유 풀에서 명확히 검증 가능
- Phase 0 sample-100.json도 signal 보유 풀에서 재추출 필요

### 권장 결정

1. **대안 C 채택**: Phase 4 파일럿 = signal 보유 7,068 lot 풀에서 샘플 (현 sample-100.json 재추출 필요)
2. v2 입력 스키마에서 **nearby/reliability/poi_tags/notes/payment_methods/daily_max는 drop** (sparse). 핵심 메타 = address + 운영시간 3종 + 요금 3종(base/extra/free) + total_spaces + phone + curation
3. reviews는 입력에 포함하되 99.7%가 빈 배열임을 agent에 명시
4. MIN_LOT_SUMMARY_LENGTH = **300** 유지 (signal 보유 풀에서는 충분히 도달 가능)
5. 24,871 meta-only lot은 별도 이슈 발행 (지역 컨텍스트 합성 또는 풀텍스트 재크롤 — 본 이슈 범위 밖)

### 사용자 확인 필요

위 권장 결정을 적용하면 #138 원래 목표("모든 31K lot의 SSR 800단어")는 **22.1%로 축소**됨. 진행 방향:

- **A) 권장 적용**: signal 보유 7K에 집중 → Phase 1 진행
- **B) 원래 범위 유지**: 메타-only 24K도 포함 → 대안 B(지역 컨텍스트 합성) 추가 설계 필요
- **C) 일단 7K 검증 후 24K 합성 별도 결정**: 단계적 (가장 보수적)

## Decisions taken from this audit

- Drop sparse fields: nearby, reliability, poi_tags, notes, payment_methods, daily_max
- Keep core meta: address, weekday/saturday/holiday hours, base_fee/extra_fee/is_free/extra_time/base_time, total_spaces, phone, type, curation
- Sample-100 은 signal-보유 풀에서 재추출 필요 (현 sample은 전체 풀에서 뽑힘)
- MIN_LOT_SUMMARY_LENGTH = 300 (변경 없음)
