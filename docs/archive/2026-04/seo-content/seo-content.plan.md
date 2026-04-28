# SEO 자체 콘텐츠 보강 Planning Document

> **Summary**: 상위 주차장 상세 페이지에 AI 기반 이용 요약과 실용 팁을 채워 thin content 판정을 줄이고, 검색 색인 수와 체류 시간을 개선한다
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-22
> **Status**: Draft
> **GitHub Issue**: [#106](https://github.com/acee90/easy-parking-zone/issues/106)

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 구글 서치 콘솔에서 3만+ 페이지 중 극소수만 색인되고 있으며, 현재 상세 페이지는 공공데이터 중심 구조라 페이지별 고유 텍스트 밀도가 낮다 |
| **Solution** | 웹소스·리뷰 기반 AI 요약과 실용 팁을 우선순위 높은 주차장부터 생성해 상세 페이지 본문 밀도를 올리고, 검색엔진이 인식할 만한 고유 문맥을 추가한다 |
| **Function/UX Effect** | 사용자는 요금/난이도/혼잡/대안 정보를 빠르게 파악하고, 검색엔진은 구조화된 고유 콘텐츠가 있는 상세 페이지로 인식할 가능성이 높아진다 |
| **Core Value** | 단순 주차장 DB를 넘어 “방문 판단에 도움 되는 콘텐츠 페이지”로 전환해 검색 유입과 서비스 탐색 시간을 함께 끌어올린다 |

---

## 1. Overview

### 1.1 Purpose

GitHub Issue `#106`의 목표는 주차장 상세 페이지를 단순 데이터 나열 화면에서, 검색엔진과 사용자 모두에게 의미 있는 고유 콘텐츠 페이지로 전환하는 것이다.

이번 작업은 다음 두 가지를 동시에 달성하는 데 초점을 둔다.

1. **SEO 관점**: thin content 가능성을 낮출 수 있을 만큼 페이지별 고유 텍스트를 안정적으로 확보
2. **UX 관점**: 주차 전 의사결정에 직접 도움이 되는 정보(요금, 진입 난이도, 혼잡, 대안)를 빠르게 제공

### 1.2 Current State

현재 코드베이스에는 이미 관련 자산이 일부 존재한다.

- `src/routes/wiki/$slug.tsx`
  상세 페이지에 `AI 총평` 및 `블로그 기반 이용 팁` UI가 일부 반영되어 있다
- `scripts/generate-lot-summary.ts`
  `web_sources + user_reviews`를 바탕으로 `parking_lot_stats.ai_summary`를 생성하는 스크립트가 있다
- `scripts/generate-parking-tips.ts`
  실용 팁 3종을 생성하는 초안 스크립트가 있으나, 결과를 `parking_lots.curation_reason`에 저장해 기존 큐레이션 의미와 충돌할 수 있다

즉, `#106`은 “완전히 새로 만드는 작업”보다, **기존 구현 조각을 SEO 목적에 맞게 재정렬하고 운영 가능한 저장 구조로 정리하는 작업**에 가깝다.

### 1.3 Problem Statement

이슈 본문 기준 현재 문제는 다음과 같다.

- 구글 서치 콘솔에서 3만 개 이상 페이지 중 3개만 색인
- 상태 메시지: `크롤링됨 - 현재 색인이 생성되지 않음`
- 네이버 모바일 검색 유입은 일부 늘고 있으나 평균 참여 시간이 10~20초 수준으로 낮음

이 현상은 단순히 sitemap/robots 문제가 아니라, 상세 페이지가 아래 조건을 동시에 가지기 때문으로 해석할 수 있다.

1. 페이지마다 텍스트 구조가 거의 유사하다
2. 공공데이터 필드 중심이라 차별적 문맥이 약하다
3. 사용자가 도착 직후 읽을 만한 핵심 문장이 부족하다
4. 검색엔진 입장에서 “이 페이지가 왜 별도로 색인될 가치가 있는지”가 약하다

### 1.4 Why This Proposal Needs More Precision

현재 이슈 설명은 방향성은 맞지만, 운영 단계로 넘어가려면 아래가 더 명확해야 한다.

- 어떤 주차장부터 채울 것인지
- 어떤 데이터를 근거로 생성할 것인지
- 무엇을 어디 컬럼에 저장할 것인지
- 어느 수준이면 “생성 완료”로 볼 것인지
- SEO 효과를 어떤 선행 지표로 확인할 것인지

이 문서는 위 빈칸을 메우기 위한 실무용 계획서다.

### 1.5 Related Documents

- GitHub Issue: [#106](https://github.com/acee90/easy-parking-zone/issues/106)
- 위키 상세 페이지: [src/routes/wiki/$slug.tsx](/Users/junhee/Documents/projects/parking-map/main/src/routes/wiki/$slug.tsx)
- 요약 생성 스크립트: [scripts/generate-lot-summary.ts](/Users/junhee/Documents/projects/parking-map/main/scripts/generate-lot-summary.ts)
- 팁 생성 초안: [scripts/generate-parking-tips.ts](/Users/junhee/Documents/projects/parking-map/main/scripts/generate-parking-tips.ts)
- 주차장 타입: [src/types/parking.ts](/Users/junhee/Documents/projects/parking-map/main/src/types/parking.ts)

---

## 2. Goals

### 2.1 Primary Goals

1. 상위 우선순위 주차장 상세 페이지에 고유한 텍스트 콘텐츠를 채운다
2. 기존 공공데이터 중심 페이지를 “방문 판단형 랜딩 페이지”로 바꾼다
3. 검색엔진 색인 개선을 위한 선행 조건을 마련한다

### 2.2 Non-Goals

- 전체 3만+ 페이지를 한 번에 생성하지 않는다
- SEO 성과를 본 작업만의 공으로 단정하지 않는다
- LLM이 없는 주차장까지 억지로 콘텐츠를 생성하지 않는다
- `hell/easy` 큐레이션용 `curation_reason` 필드를 SEO 텍스트 저장소로 전용하지 않는다

---

## 3. Scope

### 3.1 In Scope

- 우선순위 높은 주차장 최대 1,000개 선정
- 각 주차장에 대해 AI 요약 1개 + 실용 팁 3개 생성
- 저장 구조를 기존 큐레이션 필드와 분리
- 위키 상세 페이지에서 SEO/UX 목적에 맞게 노출
- 생성 결과의 품질 검수와 커버리지 리포트 작성

### 3.2 Out of Scope

- 전체 주차장 자동 생성 파이프라인의 완전 자동화
- 구글 색인 요청 운영 자체
- 이미지/동영상 등 멀티미디어 자산 생성
- 지역 가이드 페이지 확장

---

## 4. Targeting Strategy

### 4.1 Why “Top 1,000” Is Reasonable

색인 문제를 해결하려면 전체 페이지를 한 번에 채우는 것보다, 먼저 검색 가치와 데이터 밀도가 높은 페이지를 두껍게 만드는 편이 효율적이다.

우선 1,000개를 목표로 두는 이유:

- 운영 비용을 감당 가능한 범위로 제한 가능
- 수동 QA 샘플링이 가능한 규모
- SEO 효과가 나타나기 시작할 가능성이 높은 트래픽 후보군을 먼저 커버 가능

### 4.2 Priority Rules

대상 선정은 아래 우선순위를 합산한 점수 기반으로 한다.

1. `web_sources` 수가 많은 주차장
2. `user_reviews`가 존재하는 주차장
3. 검색 의도가 강한 키워드를 가진 주차장
   예: 역세권, 관광지, 대형 상권, 공영주차장, 공원 인근
4. 상세 페이지 유입이 이미 있거나 가능성이 높은 주차장
5. 중복/오매칭 정리가 끝나 데이터 신뢰도가 상대적으로 높은 주차장

### 4.3 Minimum Eligibility

다음 중 하나를 만족하는 주차장만 생성 대상으로 삼는다.

- `web_sources >= 3`
- `web_sources >= 1` and `user_reviews >= 2`
- 운영자가 전략적으로 지정한 핵심 지점

이 기준을 두는 이유는, 근거가 빈약한 상태에서 LLM이 일반론만 생성하면 thin content 해소에도 도움이 약하고 UX 가치도 낮기 때문이다.

---

## 5. Content Model

### 5.1 Required Content Units

주차장당 다음 2종을 생성한다.

1. **AI 요약**
   2~3문장, 120~180자 내외
2. **실용 팁 3종**
   요금/할인, 방문 유의사항, 대안/연계 정보

### 5.2 Why Two Layers Are Needed

- `AI 요약`은 검색엔진과 사용자 모두를 위한 본문 핵심 문단 역할
- `실용 팁`은 스캔 가능한 UI 정보로 체류 시간과 실제 유용성을 높임

둘 중 하나만 있으면 부족하다.

- 요약만 있으면 사용성이 약하다
- 팁만 있으면 페이지 문맥의 자연스러운 서술 밀도가 약하다

### 5.3 Tone and Quality Bar

- 과장 금지
- 단정적 허위 정보 금지
- 경어체 유지
- 실제 방문 판단에 도움 되는 문장 우선
- 근거 부족 시 부족하다고 명시
- 블로그 원문을 짜깁기한 느낌보다 “요약된 안내문”처럼 읽혀야 함

---

## 6. Data Source and Storage Strategy

### 6.1 Source Priority

생성 근거는 아래 순서를 따른다.

1. `web_sources`
   블로그/카페/커뮤니티의 실제 이용 맥락
2. `user_reviews`
   구조적 난이도 및 최신 체감
3. `parking_lots`
   운영시간, 무료 여부, 기본 요금, 주소 등 공식성 높은 메타데이터
4. `nearby_places`
   있으면 대안/연계 팁 보강에 활용

### 6.2 Storage Decision

현재 초안 스크립트처럼 `parking_lots.curation_reason`을 재활용하는 방식은 피한다.

이유:

- `curation_reason`은 원래 `hell/easy` 큐레이션 의미를 가진다
- 한 컬럼에 큐레이션 라벨 설명과 SEO 텍스트를 같이 넣으면 의미가 섞인다
- UI fallback과 운영 스크립트가 꼬이기 쉽다

### 6.3 Recommended Storage

**권장안**

- `parking_lot_stats.ai_summary`
  주차장 한 문단 요약 저장
- 신규 컬럼 또는 별도 테이블로 `parking_tips`
  팁 3종을 구조화 저장

예시:

```sql
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_pricing TEXT;
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_visit TEXT;
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_alternative TEXT;
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_updated_at TEXT;
```

이 구조의 장점:

- 큐레이션 필드와 의미 분리
- UI에서 줄바꿈 파싱 없이 안전하게 렌더링 가능
- 향후 재생성 시 단일 필드만 선택적으로 갱신 가능

### 6.4 Fallback Policy

데이터가 부족한 경우에는 다음 원칙을 적용한다.

- `ai_summary`만 생성 가능하면 요약만 노출
- 팁 3종 중 일부만 근거가 있으면 해당 항목만 노출
- 근거가 빈약하면 섹션 자체를 숨기고 기본 메타 정보만 보여줌

핵심은 “빈약한 페이지에 억지 텍스트를 넣는 것”보다 “충분한 근거가 있는 페이지를 확실히 두껍게 만드는 것”이다.

---

## 7. UX and Rendering Plan

### 7.1 Detail Page Layout

상세 페이지에서 콘텐츠 우선순위를 다음처럼 정리한다.

1. 히어로/핵심 액션
2. AI 요약
3. 실용 팁 3종
4. 기본 정보
5. 주변 장소, 리뷰, 블로그, 영상

이 순서가 필요한 이유는 사용자가 검색 유입으로 들어왔을 때, 5초 안에 “여기 괜찮은 주차장인지” 판단할 수 있어야 하기 때문이다.

### 7.2 Rendering Rules

- `ai_summary`가 있으면 본문 상단에 노출
- 팁 3종은 각 카드가 독립 문장으로 읽히게 구성
- 생성일이 오래된 경우 재생성 대상으로 표시 가능
- 요약/팁은 모두 disclaimer와 함께 노출

### 7.3 SEO Considerations

- 서버 렌더링 시 본문 HTML에 포함되어야 함
- 접힘 UI 안에만 숨기지 않음
- 메타 description 생성 시 `ai_summary`를 활용하는 방안 검토
- 동일한 fallback 문장을 모든 페이지에 반복 노출하지 않음

---

## 8. Implementation Plan

### Phase 1 — 저장 구조 정리 ✅ DONE (2026-04-24)

- ~~`generate-parking-tips.ts`의 저장 대상을 `curation_reason`에서 분리~~
  → `generate-lot-summary.ts`로 통합. `parking_lot_stats`에 4개 필드 UPSERT.
- `parking_lot_stats` 기반으로 summary/tips 저장 구조 확정
  → `ai_summary`, `ai_tip_pricing`, `ai_tip_visit`, `ai_tip_alternative`, `ai_tip_updated_at`
- 상세 페이지 데이터 fetch에 필요한 컬럼 연결
  → `rowToParkingLot`에서 이미 매핑됨 (`src/server/transforms.ts`)

### Phase 2 — 생성 파이프라인 정리 ✅ DONE (2026-04-24)

- 대상 주차장 선정 SQL: `ai_summary IS NULL + web_sources >= 3 ORDER BY final_score DESC`
- CLI 옵션: `--batch --limit=N --dry-run --remote --lotId --keyword`
- 단일 API 호출 → JSON `{ summary, tip_pricing, tip_visit, tip_alternative }` 동시 저장
- `@anthropic-ai/sdk` 사용 + 시스템 프롬프트 `cache_control: ephemeral` (배치 캐싱)
- 모델: `claude-haiku-4-5-20251001`, max_tokens: 600

### Phase 3 — UI 안정화 ✅ DONE (2026-04-24)

- `src/routes/wiki/$slug.tsx` 업데이트 완료:
  - `curationReason` 우선, 없으면 `aiSummary` fallback (동일 블록)
  - `aiTipPricing / aiTipVisit / aiTipAlternative` 별도 팁 카드 3개로 렌더링
- null 필드는 해당 카드 숨김 (graceful fallback)

### Phase 4 — 운영 배치 ⬜ NEXT

- 우선 50개 샘플 생성 후 수동 검수
  ```bash
  ANTHROPIC_API_KEY=sk-ant-... bun run scripts/generate-lot-summary.ts --batch --limit=50
  ```
- 품질 기준 통과 시 300개 → 1,000개 확장
- `--remote` 플래그로 프로덕션 D1에 직접 저장
- 색인/체류시간 변화 추적

---

## 9. Requirements

### 9.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | 우선순위 높은 주차장 목록을 점수 기반으로 선정할 수 있어야 한다 | P0 |
| FR-02 | 각 주차장에 대해 AI 요약 1개를 생성해 저장해야 한다 | P0 |
| FR-03 | 각 주차장에 대해 실용 팁 3종을 구조화 저장해야 한다 | P0 |
| FR-04 | 상세 페이지가 생성된 요약/팁을 SSR 본문에 노출해야 한다 | P0 |
| FR-05 | 근거 부족 페이지는 생성 대상에서 제외하거나 최소 노출만 해야 한다 | P1 |
| FR-06 | 재실행 시 기존 데이터가 안전하게 갱신되어야 한다 | P1 |

### 9.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | 생성 문장은 허위 단정 없이 근거 기반이어야 한다 |
| NFR-02 | 샘플 수동 검수 기준 품질 만족률 80% 이상 |
| NFR-03 | UI는 생성 데이터가 없어도 깨지지 않아야 한다 |
| NFR-04 | 기존 `hell/easy` 큐레이션 데이터와 충돌하지 않아야 한다 |

---

## 10. Quality Control

### 10.1 Manual QA Checklist

- 요약이 해당 주차장과 실제로 관련 있는가
- 요금/무료 여부가 원본 데이터와 충돌하지 않는가
- 진입 난이도/혼잡 표현이 근거 없이 과장되지 않았는가
- 동일 템플릿 문장이 여러 페이지에 반복되지 않는가
- `hell/easy` 큐레이션 문구를 덮어쓰지 않았는가

### 10.2 Auto Validation Ideas

- 최소 글자 수 미달 시 저장하지 않음
- 금지 표현 목록 검사
  예: “무조건”, “반드시 비어 있음”, “100%”
- 공식 데이터와 충돌하는 문장 패턴 검사
  예: 무료 주차장이 아닌데 “완전 무료” 생성

---

## 11. Success Metrics

### 11.1 Delivery Metrics

- 생성 완료 주차장 수: 1,000개
- 요약 + 팁 모두 보유한 페이지 비율: 80%+
- 샘플 QA 통과율: 80%+

### 11.2 SEO / UX Leading Indicators

- Search Console 색인 페이지 수 증가
- `크롤링됨 - 현재 색인이 생성되지 않음` 비율 감소
- 상세 페이지 평균 참여 시간 증가
- 상세 페이지 이탈률 감소 또는 2페이지 이상 탐색 비율 증가

### 11.3 Important Caveat

색인 증가는 내부 링크, 사이트 권위, 크롤링 빈도 등 외부 변수도 크게 작용한다. 따라서 `#106`의 성공은 “색인 수 즉시 폭증”보다, **색인될 만한 페이지 품질을 체계적으로 갖추는 것**으로 정의하는 편이 현실적이다.

---

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `curation_reason` 재사용으로 기존 큐레이션 의미 훼손 | 높음 | SEO용 summary/tips 저장소를 별도로 둔다 |
| 근거 부족 주차장에 일반론만 생성 | 높음 | 최소 eligibility 기준을 두고 품질 낮은 대상은 제외 |
| 오매칭 web_sources를 근거로 잘못된 요약 생성 | 높음 | match-quality, poi-cleanup 이후 데이터 우선 사용 |
| 모든 페이지에 비슷한 문장 반복 | 중간 | 프롬프트 품질 가이드 + 반복 표현 검사 |
| 생성 비용/운영 시간이 커짐 | 중간 | 50 → 300 → 1,000 단계 배포 |
| UI가 생성 데이터 포맷에 과도하게 의존 | 중간 | 구조화 컬럼 저장 + fallback 분기 명확화 |

---

## 13. Proposed Rollout

1. 저장 구조 정리와 UI 연결부터 마무리한다
2. 샘플 50개를 생성해 품질 문제를 잡는다
3. 상위 300개까지 확대해 Search Console과 engagement 변화를 본다
4. 문제가 없으면 1,000개까지 확장한다
5. 이후 색인 개선이 보이면 나머지 롱테일 페이지 확장 여부를 판단한다

---

## 14. Definition of Done

- `#106` 대상 문서와 저장 구조가 정리되어 있다
- SEO용 요약/팁이 큐레이션 필드와 분리되어 저장된다
- 상세 페이지가 구조화된 summary/tips를 정상 노출한다
- 최소 50개 샘플 주차장에 대해 품질 검수를 마쳤다
- 1차 운영 확장 대상과 성과 지표가 명확하다

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-22 | Initial draft for issue #106 proposal reinforcement | junhee |
| 0.2 | 2026-04-24 | Phase 1-3 완료. generate-lot-summary.ts 통합 리라이트 (4개 필드 단일 API 호출), UI 팁 카드 표시 추가 | junhee |
