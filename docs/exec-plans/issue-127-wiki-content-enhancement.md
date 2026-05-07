# 구현 계획: wiki/$slug 페이지 콘텐츠 보강 (#127)

> Parent: #106 (SEO 자체 콘텐츠)
> 목표: Average page size 28Kb → 80Kb+, Words/page 556 → 1000+, Unique content 35% → 60%+

## 현재 상태

| 항목 | 상태 |
|------|------|
| `ai_summary` (lot summary) | ✅ DB 적용 완료 (3,296건), 프론트 렌더링 완료 |
| `ai_tip_pricing / visit / alternative` | ✅ DB 적용 완료 (3,126건 1개 이상), 프론트 렌더링 완료 |
| FAQ 섹션 + JSON-LD FAQPage | ❌ 미구현 |
| 블로그 카드 방문 후기 요약 표시 | ❌ 미구현 (현재 `content` 원문만 노출) |
| Common content 39% → 25% 감축 | ❌ 미구현 |
| 시간대별/요일별 혼잡도 시각화 | ❌ 미구현 (Phase 3 이후 별도 이슈) |

**즉시 실행 가능한 항목:** Phase 1~3 (FAQ, 블로그 카드, common 감축)

---

## 요구사항 정리

구글 Helpful Content 기준 미달 원인:
- 블로그 스니펫만 나열 → 스크랩 사이트처럼 보임
- 페이지 28Kb / 556단어 → 구글이 thin content로 분류
- Common content 39% → 페이지 고유 비율 낮음

3가지 개선으로 80Kb+/1000단어+ 달성 목표:
1. FAQ 섹션 (데이터 기반 동적 생성 + JSON-LD) → +300~500단어 per page, 리치 결과 노출
2. 블로그 카드 핵심 요약 표시 → 가공된 고유 콘텐츠로 교체
3. Common content 보일러플레이트 감축 → Siteliner unique% 향상

> **측정 기준 주의:** FAQ + 블로그 카드로 80Kb+를 보장하기 위해서는 구현 전후 SSR HTML 크기와
> 단어수를 실제로 측정해야 한다. `fetchBlogPosts` limit이 7개이므로 샘플 측정 없이 80Kb+를
> 단언할 수 없다. Phase 1 완료 후, Phase 2 완료 후 각각 측정하여 목표 도달 여부를 확인한다.

---

## Phase 0: 기준점 측정 (크기: XS, 예상 15분)

구현 전에 현재 SSR HTML 크기와 단어수를 측정하여 비교 기준을 확보한다.

```bash
# 로컬 dev 서버 실행 후 wiki 페이지 SSR HTML 측정
curl -s http://localhost:3000/wiki/<slug> | wc -c    # bytes
curl -s http://localhost:3000/wiki/<slug> | wc -w    # words
```

측정 결과를 이 문서 하단 검증 기준 테이블에 실제 값으로 기록한다.

---

## Phase 1: FAQ 섹션 추가 (크기: M, 예상 2~3시간)

### 목표
각 wiki/$slug 페이지에 5개 FAQ 카드 + `schema.org/FAQPage` JSON-LD 추가.
→ 구글 리치 결과(아코디언) 노출 가능, 페이지당 +300~500 단어.

### 핵심 설계 원칙

`generateFaqItems(lot, relatedLots)`는 **순수 함수**로 `src/lib/faq-generator.ts`에 분리한다.
이 함수를 화면 컴포넌트(`FaqSection.tsx`)와 `$slug.tsx` head()의 JSON-LD 생성 양쪽에서
동일하게 호출하여, **화면에 렌더링되는 FAQ 텍스트와 JSON-LD 안의 FAQ 텍스트가 항상 일치**하도록 보장한다.
두 곳이 서로 다른 답변을 만드는 것은 Google 가이드라인 위반이다.

### 생성 로직

FAQ는 lot 데이터에서 **서버사이드**로 동적 생성. CSR 없음.

| 질문 | 답변 생성 규칙 |
|------|--------------|
| 주차요금이 얼마인가요? | `lot.pricing.isFree` → "무료입니다." / `lot.aiTipPricing` 있으면 우선 사용 / 없으면 `formatPricing()` 결과 |
| 초보운전자도 이용할 수 있나요? | `score ≥ 4.0` → "초보운전자도 편하게 이용 가능합니다." / `score < 2.0` → "진입이 어려울 수 있습니다." / null → "난이도 정보가 충분하지 않습니다." |
| 운영시간이 어떻게 되나요? | `lot.operatingHours` → `formatOperatingHours()` 결과 / 모르는 경우 "정확한 운영시간은 방문 전 확인하세요." |
| 전체 주차면수는 몇 개인가요? | `lot.totalSpaces > 0` → "총 N면 규모입니다." / 없으면 skip |
| 근처에 다른 주차장도 있나요? | `lot.aiTipAlternative` 있으면 사용 / `relatedLots.length > 0` → "인근 주차장으로 [이름1], [이름2] 등이 있습니다." |

- 답변이 생성 불가한 FAQ는 렌더링에서 제외 (null guard)
- 최소 3개 이상 답변 가능할 때만 섹션 표시

### JSON-LD 분리 방식

기존 `$slug.tsx` head()의 `scripts` 배열에 **별도 script 항목**으로 FAQPage를 추가한다.
기존 `LocalBusiness/ParkingFacility` JSON-LD와 억지로 합치지 않는다.

```typescript
// $slug.tsx head() 내 scripts 배열
scripts: [
  {
    type: 'application/ld+json',
    children: JSON.stringify(jsonLd),  // 기존 LocalBusiness/ParkingFacility
  },
  // FAQPage는 별도 script로 분리
  ...(faqItems.length >= 3
    ? [{
        type: 'application/ld+json' as const,
        children: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faqItems.map((item) => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: { '@type': 'Answer', text: item.answer },
          })),
        }),
      }]
    : []),
]
```

`faqItems`는 `generateFaqItems(lot, relatedLots)` 호출 결과.
`loaderData`에 `relatedLots`가 이미 포함되어 있으므로 추가 fetch 불필요.

### 구현 파일

```
src/lib/faq-generator.ts              — generateFaqItems(lot, relatedLots): FaqItem[] 순수 함수
src/components/wiki/FaqSection.tsx    — FAQ 카드 렌더링 (generateFaqItems 재사용)
```

`FaqSection`은 `$slug.index.tsx`의 SSR 마크업에 포함 (CSR 불필요).

### 파일별 변경

| 파일 | 변경 내용 |
|------|---------|
| `src/lib/faq-generator.ts` | 신규 — `FaqItem` 타입 + `generateFaqItems()` 순수 함수 |
| `src/components/wiki/FaqSection.tsx` | 신규 — FAQ 카드 렌더링, `generateFaqItems` 호출 |
| `src/routes/wiki/$slug.index.tsx` | `FaqSection` import + 기본정보 섹션 아래에 렌더링 추가 |
| `src/routes/wiki/$slug.tsx` | `head()` 내 `scripts` 배열에 FAQPage script 항목 추가 |

### Phase 1 완료 후 측정

```bash
curl -s http://localhost:3000/wiki/<slug> | wc -c    # bytes
curl -s http://localhost:3000/wiki/<slug> | wc -w    # words
```

---

## Phase 2: 블로그 카드 핵심 요약 표시 (크기: S, 예상 1~2시간)

### 목표
현재 `BlogPostCard`가 `post.snippet` (= `web_sources.content` 원문)을 그대로 표시 중.
`web_sources.summary` (AI 가공 요약)가 있으면 이를 우선 표시하여 고유 콘텐츠 비율을 높인다.

### 현재 코드 흐름

```
web_sources.content ─→ BlogPostRow.content ─→ rowToBlogPost().snippet ─→ BlogPost.snippet ─→ BlogPostCard
web_sources.summary   ← select 안 됨 (현재 fetchBlogPosts에서 누락)
```

### 변경 내용

**데이터 레이어 — 4곳 수정**

1. `src/types/parking.ts` — `BlogPost` 인터페이스에 `summary?: string` 추가
2. `src/server/transforms.ts` — `BlogPostRow` 인터페이스에 `summary?: string | null` 추가,
   `rowToBlogPost()`에서 `summary: row.summary ?? undefined` 매핑
3. `src/server/parking.ts` — `fetchBlogPosts()` select 블록에 `summary: schema.webSources.summary` 추가

**UI 레이어 — 2곳 수정**

4. `src/components/parking-reputation/BlogPostCard.tsx`:
   - `post.snippet` 표시 부분을 `post.summary ?? post.snippet` 으로 변경
   - `rel="noopener noreferrer"` → `rel="nofollow noopener noreferrer"` 로 변경
   - "방문 후기 요약" 레이블 추가 (summary가 있을 때만, 표시 텍스트 예: "핵심 요약")

5. `src/components/parking-reputation/RelatedWebsitesSection.tsx`:
   - `SectionTitle` title prop `"관련 웹사이트"` → `"방문자 후기 (N건)"` 으로 변경
   - `count` prop이 이미 있으므로 `방문자 후기 (${count}건)` 형태 사용

> **표현 주의:** `web_sources.summary`는 원문 그대로가 아니라 AI가 가공·요약한 문장이다.
> UI에서 "인용구" · "원문 발췌" 같은 표현은 사용하지 않는다.
> "핵심 요약", "방문 후기 요약", "AI 요약" 등의 표현을 사용한다.

### 파일별 변경

| 파일 | 변경 내용 |
|------|---------|
| `src/types/parking.ts` | `BlogPost.summary?: string` 추가 |
| `src/server/transforms.ts` | `BlogPostRow.summary?: string | null` 추가, `rowToBlogPost()` 매핑 |
| `src/server/parking.ts` | `fetchBlogPosts()` select에 `schema.webSources.summary` 추가 |
| `src/components/parking-reputation/BlogPostCard.tsx` | `post.summary ?? post.snippet`, `rel` 속성, "핵심 요약" 레이블 |
| `src/components/parking-reputation/RelatedWebsitesSection.tsx` | 섹션 제목 `"관련 웹사이트"` → `"방문자 후기 (N건)"` |

### Phase 2 완료 후 측정

```bash
curl -s http://localhost:3000/wiki/<slug> | wc -c
curl -s http://localhost:3000/wiki/<slug> | wc -w
```

측정값이 80Kb / 1000단어 미달이면 Phase 3 이후 추가 콘텐츠 보강 방안을 별도 검토한다.

---

## Phase 3: Common Content 감축 (크기: S, 예상 1~2시간)

### 사전 작업: 반복 문구 측정

Phase 3 구현 전에 실제로 Siteliner common content를 유발하는 문구를 파악한다.

```bash
# wiki 페이지 여러 개 SSR 후 공통 텍스트 상위 추출 (예시)
for slug in <slug1> <slug2> <slug3>; do
  curl -s http://localhost:3000/wiki/$slug
done | sort | uniq -c | sort -rn | head -30
```

또는 Siteliner 리포트의 "Common Content" 항목에서 반복 문구 상위 N개를 확인한다.
측정 결과로 실제 감축 대상을 확정한 후 아래 작업을 진행한다.

> **`PublicDataAttribution` 주의:** 현재 이 컴포넌트는 이미 1줄 링크로 짧다.
> 감축 효과가 제한적일 수 있으므로, 측정 후 실제 반복 문구 순위가 높을 때만 수정한다.

### 변경 내용

1. **AI 팁 카드 라벨 동적화** — `$slug.index.tsx`의 고정 라벨 "요금" / "방문 팁" / "대안"에
   lot 특성 정보를 추가하여 페이지마다 텍스트가 달라지도록 변경.
   - 예: `"요금"` → `"요금 (무료)"` / `"요금 (유료·시간제)"`
   - 예: `"대안"` → `"주변 주차장 대안"`

2. **메타 description 변형** — `$slug.tsx` head() `desc` 가 현재 정형화된 패턴.
   lot 특성에 따라 문구 변형 추가.
   - 기본: `"주차 난이도 X.X, 기본 N분 N원. 리뷰 N개."`
   - 큐레이션 lot: `"헬파킹 인증 주차장." / "초보 추천 주차장."` 앞에 붙이기

3. **PublicDataAttribution** — 측정 결과 반복 문구 순위가 높으면 짧은 버전으로 교체.
   현재 이미 `compact` prop이 있으니 inline 표시로 전환하거나 텍스트 단축.

### 파일별 변경

| 파일 | 변경 내용 |
|------|---------|
| `src/routes/wiki/$slug.index.tsx` | AI 팁 카드 라벨 동적화 |
| `src/routes/wiki/$slug.tsx` | head() `desc` 변형 로직 (큐레이션 lot 분기) |
| `src/components/PublicDataAttribution.tsx` | 측정 결과 기반 — 감축 필요 시 수정 |

---

## 구현 순서

```
Phase 0 (측정) → Phase 1 (FAQ) → 측정 → Phase 2 (블로그 카드) → 측정 → Phase 3 (common 감축) → 최종 측정
```

Phase 1이 콘텐츠 증가 임팩트가 가장 크므로 우선 구현.
각 Phase는 독립적으로 PR 분리 가능.

---

## 검증 기준

| 지표 | 현재 (측정 전) | Phase 1 후 | Phase 2 후 | 목표 |
|------|-------------|-----------|-----------|------|
| SSR HTML 크기 (bytes) | — | — | — | 80Kb+ |
| 단어수 (words) | 556 | — | — | 1000+ |
| Unique content % | 35% | — | — | 60%+ |
| Common content % | 39% | — | — | 25% |
| GSC rich result | 없음 | FAQPage 노출 | — | FAQPage 노출 |

### 자동 검증

```bash
# 1. 빌드 검증
bun --bun run build

# 2. 린트 검증
bun --bun run lint

# 3. SSR 단어수 측정 (wiki 페이지 20개 샘플)
# 아직 scripts/verify-wiki-seo.ts 없음 — 간이 측정으로 대체:
for slug in <slug1> <slug2> ... <slug20>; do
  curl -s http://localhost:3000/wiki/$slug | wc -w
done | awk '{s+=$1; n++} END {print "평균 단어수:", s/n}'
# 목표: 평균 1000 이상

# 4. FAQPage JSON-LD 구조 검증
# - https://validator.schema.org/ 에 wiki 페이지 URL 또는 소스 붙여넣기
# - "FAQPage" 타입 인식 + Question/acceptedAnswer 구조 오류 없음 확인
# - Google Search Console URL 검사 → "리치 결과로 표시 가능" 확인
```

### 수동 검증

1. 로컬 wiki/$slug 페이지에서 FAQ 섹션이 SSR 마크업에 포함되어 있는지 페이지 소스 확인
2. `<script type="application/ld+json">` 두 개 존재 (LocalBusiness + FAQPage)
3. BlogPostCard에 `rel="nofollow noopener noreferrer"` 적용 확인
4. BlogPostCard에서 `summary`가 있는 lot은 핵심 요약 텍스트가 표시되는지 확인
5. Siteliner 재실행 (배포 후) → Common content % 확인

---

## 리스크

| 리스크 | 수준 | 대응 |
|--------|------|------|
| FAQ 답변이 null인 lot 많으면 섹션 안 보임 | LOW | null guard + 최소 3개 조건 |
| JSON-LD FAQPage 구조 오류 → 구글 거부 | MEDIUM | validator.schema.org 필수 검증 |
| 화면 FAQ 텍스트 ≠ JSON-LD 텍스트 → Google 가이드라인 위반 | HIGH | `generateFaqItems()` 단일 함수 양쪽 재사용으로 원천 방지 |
| `web_sources.summary` 없는 lot은 여전히 원문 스니펫 표시 | LOW | `post.summary ?? post.snippet` fallback으로 대응 |
| 블로그 카드 변경이 기존 SSR 봇 노출 깨뜨림 | MEDIUM | `RelatedWebsitesSection` 변경 최소화, SSR 흐름 유지 |
| FAQ + 블로그 카드 후에도 80Kb 미달 | MEDIUM | Phase 2 완료 후 측정 → 미달이면 블로그 limit 늘리거나 추가 콘텐츠 보강 검토 |
| Common content 감축 시 UI 정보 누락 | LOW | 텍스트만 줄이고 데이터는 유지 |

---

## 완료 조건

- [ ] `bun --bun run build` 성공
- [ ] `bun --bun run lint` 성공 (오류 없음)
- [ ] Phase 1: FAQ 섹션이 wiki/$slug SSR 마크업에 포함되어 있음 (페이지 소스 확인)
- [ ] Phase 1: `<script type="application/ld+json">` 두 개 존재 (LocalBusiness + FAQPage 분리)
- [ ] Phase 1: FAQPage JSON-LD가 validator.schema.org 통과
- [ ] Phase 1: 화면 FAQ 텍스트와 JSON-LD 텍스트가 `generateFaqItems()` 동일 함수에서 생성됨
- [ ] Phase 2: `BlogPost.summary` 타입 추가 + `fetchBlogPosts()` select 반영
- [ ] Phase 2: `BlogPostCard`에서 `post.summary ?? post.snippet` 사용
- [ ] Phase 2: `BlogPostCard` 외부 링크에 `rel="nofollow noopener noreferrer"` 적용
- [ ] Phase 2: `RelatedWebsitesSection` 섹션 제목 `"방문자 후기 (N건)"` 으로 변경
- [ ] Phase 3: SSR 반복 문구 측정 후 감축 대상 확정 및 적용
- [ ] 최종 SSR 단어수 샘플 20개 평균 1000 이상 (또는 목표치 도달 여부 기록)
