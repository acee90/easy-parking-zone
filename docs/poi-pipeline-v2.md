# POI 파이프라인 v2 — 개편 계획

> 작성: 2026-03-13 | 파일럿 결론 반영: 2026-03-13

## 목적

POI(인기 목적지) 블로그/카페 글에서 **특정 주차장을 언급·추천하는 내용**을 정확히 추출하여,
해당 주차장의 난이도 점수에 **리뷰급 가중치**로 반영한다.

### 핵심 시나리오

```
블로그: "자양전통시장 주차장 추천 5곳"
본문: "... 건국대학교동문회관 주차장이 넓고 편해요 ..."

→ 건국대학교동문회관 주차장의 web_sources에 이 블로그 연결
→ "넓고 편해요" 감성 → 높은 긍정 점수
→ 건국대학교동문회관 주차장의 final_score 상승 (green 방향)
```

### v1 대비 변경 이유

| 항목 | v1 | v2 |
|------|-----|-----|
| 콘텐츠 | snippet ~200자 | **원문 전체** (URL 방문) |
| 매칭 | 500m proximity + AI 추출명 | **스크립트 필터링 + AI 최종 매칭** |
| 관계 | 1 source → 1 주차장 | 1 source → **N 주차장** |
| 스코어 가중치 | blog 0.15 (리뷰 0.50) | **텍스트 소스 간 가중치 제거**, 감성×relevance로 통합 |

---

## 파일럿 결론 (Phase 1 완료)

### 실험 결과 요약

80개 POI 블로그 샘플로 키워드 매칭 vs AI 매칭(Haiku) 비교 실험 수행.

| 지표 | AI 매칭 | 키워드 매칭 |
|------|---------|------------|
| 매칭 성공률 | **71%** (57/80) | 60% (48/80) |
| 총 매칭 건수 | 89건 (블로그당 1.6개) | 197건 (블로그당 4.1개) |
| 정밀도 | **≈95%** (high 92%, med 7%, low 1%) | **≈30~40%** (과매칭 다수) |
| 벤다이어그램 | AI만: 11건 | KW만: 1건 | 겹침: 46건 | 둘다없음: 21건 |

### 핵심 발견

**AI 매칭이 압도적으로 우수:**
- 약어/애칭 이해: "동현아에 놓고" → 동대문현대시티아울렛 주차장
- 맥락 추론: 카페 방문기에서 해당 건물 주차장 식별
- 1→N 관계 정확 파악: 코엑스 블로그 → 코엑스주차장 + 동문주차장 + 북문주차장
- DB에 없는 주차장도 인지 (한계이자 장점)

**키워드 매칭의 한계:**
- 과매칭: "남대문" 키워드 → 11개 주차장 (AI는 정확히 2개)
- "롯데백화점" → 다른 지점까지 매칭 (강남점 글에서 잠실점, 건대점 등)
- 블로거는 공식 DB 이름을 쓰지 않음: "올림픽공원 주차" ≠ "SK올림픽핸드볼경기장 주차장"

### 결정: 스크립트 필터링 + AI 최종 매칭

키워드 매칭은 **정밀 매칭에 부적합** → 쓸모없는 글 제거용 필터로 전환.
최종 주차장 매칭은 **AI(Haiku)**가 담당.

```
전체 web_sources (~70K)
  ↓ 1차: 원문 수집 실패 / 100자 미만 제거
  ↓ 2차: 제외 키워드 포함 제거 (경매/분양/매매/임대/모델하우스/입찰/낙찰/감정가/체험단)
  ↓ 3차: 주차 키워드 무관 글 제거 ("주차", "parking" 등 언급 없음)
  ↓ 4차: 5km 이내 DB 주차장 후보 0건 → 제거
  ──────────────────────────────────
  생존한 글만 AI 매칭 (Haiku)
  ↓ high/medium confidence → DB 적재
  ↓ low → 제외
```

> **is_ad 필터 제거 이유:** 500건 파일럿에서 is_ad가 유효한 주차 글 10건을 오분류(FN).
> 제외 키워드 필터가 경매/분양 광고를 더 정확히 걸러내면서 FP도 줄임 (49→39건).

**비용 추정 (Haiku 3.5 기준):**
- input ~2,000 tok (본문 2,000자 + 후보 30개 + 시스템 프롬프트), output ~200 tok
- 1건당 ~$0.003 (input $1/M + output $5/M)
- 필터링 후 추정 ~10K건 → 약 **$25~35**
- 모델 교체 검토 가능 (e.g. GPT-4o mini로 비용 절감)

---

## 파이프라인 구조 (v2 확정)

```
1. POI 후보 발굴           → collect-poi-pilot.ts (기존 유지)
2. 콘텐츠 수집 (snippet)   → collect-poi-content.ts (기존 유지)
3. 원문 수집               → fetch-poi-fulltext.ts (신규)
   - 네이버 블로그/카페 URL → HTML fetch → 본문 추출
   - rate limiting, 중단/재개 지원
4. 스크립트 필터링          → filter-poi-sources.ts (신규)
   - is_ad 제거, 본문 길이 필터, 주차 키워드 존재 확인, 근접 주차장 후보 확인
5. AI 매칭                 → match-poi-ai.ts (신규)
   - 본문 2000자 + 5km 이내 주차장 후보 (최대 30개) → Haiku
   - 1 블로그 → N 주차장 매칭 (confidence: high/medium/low)
6. DB 적재                → load-poi-to-db.ts (개편)
   - 1 source → N 주차장: web_sources에 같은 source_url로 N개 행
   - relevance_score: AI confidence 기반 (high=90, medium=70, low=40)
7. 스코어 반영            → compute-text-scores.ts / compute-parking-stats.ts (가중치 개편)
```

---

## Phase 2: 원문 수집 스크립트

**`scripts/fetch-poi-fulltext.ts`**
- 입력: DB web_sources에서 source='poi' (또는 poi-content-result.json)
- 네이버 블로그/카페 URL → HTML fetch → 본문 추출
  - `se-main-container` 기반 추출 (indexOf 방식, regex 아님)
  - 종료 마커: `se-viewer-footer`, `comment`, `</main>`, `printPost1`
- rate limiting, 중단/재개 지원 (JSON 체크포인트 파일 기반)
- 출력: fulltext JSON 또는 DB 직접 업데이트 (web_sources.content 확장)

### 실패 처리 전략

| 케이스 | HTTP 상태 | 처리 | 비고 |
|--------|-----------|------|------|
| 삭제된 글 | 404 | skip + 로그 | |
| 비공개 전환 | 403 | skip + 로그 | |
| 카페 비로그인 차단 | 200 (본문 없음) | skip + 로그 | 비로그인 접근 불가, 전체 ~30% 추정 |
| Rate limit | 429 | 대기 후 재시도 (exponential backoff) | |
| 타임아웃 / 네트워크 오류 | - | 3회 재시도 후 skip + 로그 | |

- 모든 실패 건은 `fetch-failures.json`에 기록하여 추후 재시도 또는 수동 확인 가능
- 체크포인트: 처리 완료된 source_url 목록을 JSON에 저장, 스크립트 재실행 시 skip

---

## Phase 3: 필터링 + AI 매칭 + DB 적재

### 3-1. 스크립트 필터링 (`scripts/filter-poi-sources.ts`)

**파일럿 검증 완료 (500건 샘플, 3개 설정 비교)**

| 설정 | Precision | Recall | F1 | 비고 |
|------|-----------|--------|-----|------|
| v1: is_ad + 주차키워드 | 79.9% | 89.9% | 84.6% | baseline |
| **v2: 제외키워드 + 주차키워드** | **83.4%** | **90.3%** | **86.7%** | **채택** |
| v3: is_ad + 제외키워드 | 83.9% | 86.2% | 85.0% | FN 증가 |

**채택 필터 (v2):**
- ~~is_ad=1 제거~~ → is_ad 필터 제거 (오분류로 FN 발생, classify-ads.ts 광고 판정이 과적합)
- 본문 100자 미만 제거
- 제외 키워드 포함 시 제거: "경매", "분양", "매매", "임대", "모델하우스", "입찰", "낙찰", "감정가", "체험단", "원룸", "투룸"
- "주차" / "parking" 등 주차 키워드 미포함 글 제거
- 5km 이내 DB 주차장 후보 0건인 글 제거

### 3-2. AI 매칭 (`scripts/match-poi-ai.ts`)
- 필터 통과한 글 → Haiku API 호출
- 입력: 본문 2,000자 발췌 + 근접 주차장 후보 리스트
- 출력: `{ lotId, lotName, confidence, reason }[]`
- confidence high/medium만 DB 적재 대상

### 3-3. DB 적재 (`scripts/load-poi-to-db.ts` 개편)
- 1 source → N 주차장 관계: web_sources에 같은 source_url로 N개 행 INSERT
  - (web_sources.source_url에 unique 제약 없으므로 N행 INSERT 가능)
- relevance_score: AI confidence 기반 (high=90, medium=70)
- 감성 점수: 해당 주차장 언급 컨텍스트 기반 (compute-text-scores.ts에서 재처리)

---

## Phase 4: 스코어링 개편

### 가중치 변경

**현재:**
```typescript
const WEIGHTS = {
  user: 0.50,      // 사용자 리뷰
  community: 0.30, // 커뮤니티 (clien 등)
  blog: 0.15,      // 블로그/카페 텍스트
  youtube: 0.15,   // 유튜브 댓글
};
```

**변경:**
```typescript
// 텍스트 소스 간 가중치 제거 (community, blog, youtube, poi 동등 취급)
// 모든 텍스트 소스 (community, blog, youtube, poi) 동등 취급
// 각 글의 영향력 = sentiment_score × (relevance_score / 100)
// → 확실한 추천/비추천(감성 강함) + 높은 관련도 = 강한 영향력
// → 애매한 감성 + 낮은 관련도 = 약한 영향력

const WEIGHTS = {
  user: 0.50,  // 사용자 직접 리뷰 (5점 척도)
  text: 0.50,  // 모든 텍스트 소스 통합 (감성 × 관련도 가중 평균)
};
```

### 감성 분석 강화
- 확실한 추천: "넓다", "편하다", "추천", "초보도 OK" → sentiment 4.0~5.0
- 확실한 비추천: "좁다", "헬", "비추", "긁힘" → sentiment 1.0~2.0
- 애매한 언급: "주차장 있음", "이용 가능" → sentiment 3.0 (중립, 낮은 영향력)

---

### 검증 계획

가중치 변경 시 기존 13,775개 주차장 점수가 전부 변경됨. 반영 전 반드시 검증:

- hell 큐레이션 83건 + easy 16건 일관성 재검증 (v1 대비 방향 역전 없는지)
- 전체 점수 분포 비교 (히스토그램 before/after)
- 상위/하위 50개 주차장 리스트 비교

---

## Phase 5: 기존 데이터 재처리

기존 ~58K web_sources는 v1 파이프라인으로 적재되어 relevance_score가 없음.
v2 스코어링(`sentiment × relevance/100`)에서 relevance 없으면 영향력 0이 되므로, **기존 데이터도 v2 기준으로 재처리 필수**.

### 재처리 흐름

```
1. 기존 ~58K web_sources
   ↓ 스크립트 필터링 (Phase 3의 filter-poi-sources.ts 재사용)
   ↓ 본문 길이, 제외 키워드, 주차 키워드, 근접 후보 필터
2. 필터 통과분만 AI 매칭 (Haiku) → relevance_score 산출
3. compute-text-scores.ts 재실행 (감성 × relevance 반영)
4. compute-parking-stats.ts 재실행 (새 가중치 적용)
```

### 비용 추정

- 필터링 후 추정 생존 건수: ~15K~25K (광고·무관 글 제거)
- AI 매칭: ~$45~75 (Haiku 3.5, 필터 효과에 따라 변동)

---

## 실행 순서

```
[완료] Phase 1: 파일럿 매칭 로직 튜닝 ✅
  1-1. 샘플 80건 선정 + 원문 수집 ✅
  1-2. 키워드 매칭 구현 (지리필터 + 일반명사 필터) ✅
  1-3. AI 매칭 파일럿 (Haiku) ✅
  1-4. 비교 분석 → 결론: 스크립트 필터링 + AI 최종 매칭 ✅

[완료] Phase 1.5: 필터링 파일럿 ✅
  1.5-1. 80건 기본 검증 (FN 0건 확인) ✅
  1.5-2. 500건 확대 검증 (blog/cafe/poi/기타 계층 샘플) ✅
  1.5-3. 3개 설정 비교 → 결론: v2 채택 (isAd 제거 + 제외 키워드) ✅
         F1 86.7%, Precision 83.4%, Recall 90.3%

[다음] Phase 2: 전체 원문 수집 자동화
[이후] Phase 3: 필터링 + AI 매칭 + DB 적재
[이후] Phase 4: 스코어링 가중치 개편
[이후] Phase 5: 기존 데이터 재처리 (필터링 → AI 매칭 → 스코어 재계산)
```

---

## 파일럿 산출물

| 파일 | 내용 |
|------|------|
| **Phase 1: 매칭 로직 파일럿** | |
| `scripts/pilot-poi-fulltext.ts` | 원문 수집 + 키워드 매칭 파일럿 |
| `scripts/pilot-poi-ai-match.ts` | AI 매칭 파일럿 (Haiku) |
| `scripts/pilot-fulltext-sample-v2.json` | 80건 샘플 목록 |
| `scripts/pilot-fulltext-result-v2.json` | 원문 + 키워드 매칭 결과 |
| `scripts/pilot-ai-match-result.json` | AI 매칭 결과 |
| **Phase 1.5: 필터링 파일럿** | |
| `scripts/pilot-filter.ts` | 필터링 v1 파일럿 (80건, 기본 검증) |
| `scripts/pilot-filter-v2-collect.ts` | 필터링 v2 수집 (500건 샘플 + 원문 + AI 매칭, 체크포인트) |
| `scripts/pilot-filter-v2-eval.ts` | 필터링 v2 평가 (무비용, 설정 비교 반복 실행) |
| `scripts/pilot-filter-v2-sample.json` | 500건 계층 샘플 (blog 250, cafe 150, poi 70, 기타 30) |
| `scripts/pilot-filter-v2-data.json` | 500건 원문 + AI 매칭 답지 (eval 입력 데이터) |
| `scripts/pilot-filter-result.json` | v1 필터 결과 (80건) |
