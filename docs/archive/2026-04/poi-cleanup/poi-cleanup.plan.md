# POI 소스 정리 및 크롤러 개선 Planning Document

> **Summary**: web_sources의 잘못 매칭된 POI 소스 12,376건을 삭제하고, 크롤러 POI 쿼리 전략을 제거하여 데이터 품질을 복원한다
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-07
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | POI 기반 크롤링이 "롯데백화점 잠실점 주차장" 같은 시설 자체 주차 콘텐츠를 인근 공영주차장(서호2 등)에 잘못 연결하여, 위키 "웹에서 많이 언급된 주차장" 랭킹이 왜곡됨 |
| **Solution** | web_sources/web_sources_raw에서 source='poi' 데이터를 삭제하고, 크롤러의 POI 쿼리 전략을 제거 |
| **Function/UX Effect** | 위키 인기 주차장 섹션이 실제 웹 언급 수를 정확히 반영하게 되어 사용자 신뢰도가 향상됨 |
| **Core Value** | 잘못된 데이터를 제거하여 서비스 데이터 품질의 정확성을 확보한다 |

---

## 1. Overview

### 1.1 Purpose

web_sources 테이블의 `source='poi'` 데이터를 정리하고, 향후 동일 문제가 재발하지 않도록 크롤러에서 POI 쿼리 전략을 제거한다.

### 1.2 Background

#### 문제 발견 경위

위키 홈페이지의 "웹에서 많이 언급된 주차장" 섹션에서 서호2 주차장이 350건으로 1위를 차지. 실제 확인 결과 340건이 롯데백화점 잠실점 관련 블로그/카페 글로, 서호2 공영주차장과 무관한 콘텐츠.

#### 근본 원인

1. 서호2의 `poi_tags` 첫 번째가 "롯데백화점 잠실점"
2. 크롤러가 `"롯데백화점 잠실점 주차장"`으로 네이버 검색
3. 검색 결과(롯데백화점 자체 주차 관련 글 340건)가 서호2에 연결됨
4. 대형 상업시설은 자체 주차시설이 있어, "{POI} 주차장" 검색 결과가 인근 공영주차장이 아닌 POI 자체 주차에 대한 내용

#### 영향 범위

| 항목 | 수치 |
|------|------|
| web_sources 내 poi 소스 | 12,376건 (전체 62,533건 중 19.8%) |
| web_sources_raw 내 poi 소스 | 11,204건 |
| 영향받는 주차장 수 | 931개 |
| 위키 인기 랭킹 TOP 3 | 모두 poi 소스가 대부분 (서호2: 340/350, 다동쉼터: 229/234, 황학어린이공원: 208/215) |

### 1.3 Related Documents

- [크롤링 파이프라인 v2](../../poi-pipeline-v2.md)
- [스코어링 알고리즘](../../archive/2026-03/crawlers/parking-scoring-algorithm.md)

---

## 2. Scope

### 2.1 In Scope

1. **DB 데이터 삭제**: web_sources, web_sources_raw에서 `source='poi'` 행 삭제
2. **스코어 재계산**: poi 소스 삭제로 영향받는 주차장들의 parking_lot_stats 재계산
3. **크롤러 POI 전략 제거**: naver-blogs.ts, duckduckgo-search.ts에서 POI 쿼리 전략 코드 제거
4. **LotRow 타입 정리**: poi_tags 필드를 쿼리에서 사용하지 않으므로 SELECT에서 제거

### 2.2 Out of Scope

- poi_tags 컬럼 자체 삭제 (nearby_places 등 다른 용도로 활용될 수 있음)
- naver_blog/naver_cafe 소스의 개별 오매칭 정리 (별도 작업)
- 매칭 알고리즘(scoring.ts) 개선 (별도 작업)

---

## 3. Implementation Plan

### 3.1 Step 1 — DB 데이터 삭제 (D1 remote)

```sql
-- 1) web_sources에서 poi 소스 삭제
DELETE FROM web_sources WHERE source = 'poi';

-- 2) web_sources_raw에서 poi 소스 삭제
DELETE FROM web_sources_raw WHERE source = 'poi';
```

**주의**: D1은 트랜잭션 롤백이 제한적이므로, 삭제 전 COUNT로 건수 재확인.

### 3.2 Step 2 — parking_lot_stats 재계산

poi 소스 삭제 후 community_count 등이 달라지므로, 영향받는 주차장의 스코어를 재계산해야 함. 이 작업은 다음 cron 실행 시 자동으로 처리됨 (scoring-engine.ts가 최근 변경된 주차장을 감지).

수동으로 즉시 반영하려면:
```bash
npx wrangler d1 execute parking-db --remote --command \
  "UPDATE parking_lot_stats SET updated_at = datetime('now') WHERE parking_lot_id IN (SELECT DISTINCT parking_lot_id FROM web_sources WHERE source = 'poi');"
```

→ 단, 이 UPDATE는 DELETE **전에** 실행해야 함 (DELETE 후에는 parking_lot_id를 알 수 없음).

**수정된 순서:**
1. 영향받는 parking_lot_id 목록 추출
2. web_sources, web_sources_raw에서 poi 삭제
3. 해당 parking_lot_id의 stats를 재계산 트리거

### 3.3 Step 3 — 크롤러 코드 수정

#### `src/server/crawlers/naver-blogs.ts`

- `QueryStrategy` 타입에서 `'poi'` 제거
- `buildQueries()` 함수에서 POI 전략 블록(B) 제거
- `LotRow` 인터페이스에서 `poi_tags` 제거
- `selectPriorityLots()` SQL에서 `p.poi_tags` 제거

#### `src/server/crawlers/duckduckgo-search.ts`

- 동일한 변경 적용

### 3.4 Step 4 — 문서 현행화

- `docs/poi-pipeline-v2.md`의 쿼리 전략 섹션에서 "B. POI 기반" 전략 삭제 또는 deprecated 표기

---

## 4. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| poi 삭제 후 일부 주차장의 웹 언급 수가 0으로 떨어짐 | 위키 인기 랭킹에서 제외됨 | name/region 전략 소스가 남아있으면 정상 반영. 0건이면 원래 웹 언급이 없는 것이므로 올바른 상태 |
| D1 대량 DELETE 성능 | 12,376건 + 11,204건 삭제 시 시간 소요 | D1은 대량 DELETE를 잘 처리함. 필요시 LIMIT으로 나눠 실행 |
| 크롤러 검색 커버리지 감소 | POI 전략 제거로 일부 주차장의 검색 쿼리가 줄어듦 | name 전략 + region 폴백이 있으므로 핵심 검색은 유지됨 |

---

## 5. Verification

- [ ] web_sources에 source='poi' 행이 0건인지 확인
- [ ] web_sources_raw에 source='poi' 행이 0건인지 확인
- [ ] 위키 홈 "웹에서 많이 언급된 주차장" TOP 10이 합리적인지 확인
- [ ] 서호2 주차장의 web_sources 건수가 ~10건 이하인지 확인
- [ ] 크롤러 코드에 'poi' 문자열이 남아있지 않은지 확인
- [ ] `bun --bun run build` 성공
