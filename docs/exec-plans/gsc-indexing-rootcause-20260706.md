# GSC 색인 실패 근본 원인 분석 및 해결 계획

- **작성일**: 2026-07-06
- **대상**: easy-parking.xyz (쉬운주차장)
- **문제**: GSC에서 페이지가 "Crawled - currently not indexed" / "Discovered - not indexed" 상태로 색인 안 됨
- **방법**: 5개 독립 감사 리포트(기술 크롤링 / 사이트맵 정책 / 콘텐츠 thinness / 내부 링크 / 구조화데이터) 통합 + 코드 라인 단위 직접 검증

> 이 문서의 코드 라인 주장은 모두 실제 파일을 읽어 검증했다(CONFIRMED). DB 수치(17,743 / 31,993 / ai_summary 22개 등)는 5개 감사가 독립적으로 동일 값을 산출해 상호 검증(cross-corroborated)됐으나, 이 세션에서 라이브 D1을 재쿼리하진 않았다.

---

## 1. 핵심 결론 (Executive Summary)

**근본 원인은 "대량 프로그래매틱 thin/중복 콘텐츠"다 (CONFIRMED, 최고 확신).** 기술적으로 크롤링을 막는 요소는 없다 — robots, canonical, JSON-LD, SSR 렌더링, www/https 정규화 모두 정상이다. 문제는 순수하게 **콘텐츠 품질과 색인 정책**이다. `shouldIndexParkingDetail()`이 주소·시간·요금 같은 기본 구조화 필드만으로 `구조신호 >= 3`을 충족시켜 **리뷰/블로그/영상/AI요약이 0인 페이지도 `index,follow`로 렌더링**하고(seo-indexing.ts:88), 동일한 느슨함이 사이트맵 SQL에도 있어(`is_free IS NOT NULL`이 항상 참인 죽은 신호, sitemap-handler.ts:308) **17,743개 URL 중 약 53%(9,407개)가 고유 콘텐츠 0인 템플릿 페이지**다. 이들은 이름/숫자만 바뀐 채 서로 84% 이상 문자 단위로 동일하며, 동일한 5문항 FAQ JSON-LD가 ~17,000회 반복된다. 이것이 정확히 Google의 thin-content / scaled-content-abuse 분류기가 잡아내 색인에서 제외하는 패턴이다.

**사용자의 두 가설에 대한 답:**
- **가설 1 (콘텐츠가 thin해서) → 맞다 (주요 원인).** 전체 lot의 69%(22,077개)가 web_sources·리뷰 0으로, 페이지 고유 텍스트가 600~1,200자에 불과하고 그마저 전부 mail-merge 템플릿(FAQ/meta description/title이 단일 문장 패턴)이다.
- **가설 2 (스크랩/중복 크롤링 데이터라서) → 맞다 (부차적이지만 실재, 부분적).** 콘텐츠가 *있는* 페이지조차 원본 AI 합성이 아니라 **가공 안 된 네이버/DDG 검색 스니펫 원문**을 노출한다. 이는 의도가 아니라 **읽기 경로 배선 버그** 때문이다 — `fetchBlogPosts()`가 AI 합성이 담긴 `ai_summary`(93.8% 채워짐) 대신 거의 비어있는 레거시 `summary` 컬럼(0.1%)을 SELECT해서, 카드의 99.9%가 raw `content`로 폴백된다(parking.ts / transforms.ts:184-185). 여기에 동일 블로그 URL이 최대 9개 lot에 붙는 내부 중복(14.6%)과 잘못된 lot 매칭(다른 도시 터미널 글이 붙음)이 겹친다.

**즉, 두 가설이 모두 참이며 서로를 증폭시킨다.** thin 페이지는 색인 가치가 없고, 콘텐츠가 있는 페이지는 그 콘텐츠가 스크랩/중복이라 신뢰를 못 얻는다. 기술 이슈(TTFB, 307 리다이렉트 등)는 부차적 기여 요소일 뿐 결정적 원인이 아니다.

**정정 (task 전제 오류):** `parking_lots.is_seed` 컬럼은 **존재하지 않는다.** schema.ts:173의 `isSeed`는 `user_reviews` 테이블 소속(가짜/시드 리뷰 플래그)이다. `000-*` ID 96개(전체의 0.3%)는 시드/placeholder 메커니즘이 아니라 초기 임포트의 실제 공영주차장이며, 규모상 무시 가능하다. **seed 데이터는 별도 대응 불필요** — 일반 임계값 수정에 자연히 흡수된다.

---

## 2. 근본 원인 (severity + confidence 순 정렬, 통합·중복 제거)

### 🔴 RC-1. 색인 임계값이 너무 느슨해 고유 콘텐츠 0인 페이지가 index,follow로 대량 노출 (CRITICAL / CONFIRMED)

**메커니즘 (왜 Google이 색인 안 하는가):** `shouldIndexParkingDetail()`은 외부 콘텐츠·에디토리얼이 없어도 `getParkingDetailSeoSignalCount() >= 3`이면 index를 허용한다. 그런데 9개 신호 중 `totalSpaces>0`, `운영시간`, `요금`, `전화번호`만으로도 3을 넘긴다 — 이는 전부 카카오/공공데이터에 기본 존재하는 구조화 필드이지 고유 산문이 아니다. 결과적으로 리뷰 0·블로그 0·영상 0·AI요약 0인 페이지가 그대로 `index,follow`로 나가고, 페이지 본문은 90%+가 공유 boilerplate(nav/footer/지역링크 + 이름·숫자만 바뀐 동일 5문항 FAQ)다. Google의 thin-content / scaled-content-abuse 분류기는 정확히 이 "프로그래매틱 페이지, 사실만 스왑, 고유 가치 없음" 패턴을 색인에서 제외한다.

**증거:**
- `src/lib/seo-indexing.ts:88` — `return getParkingDetailSeoSignalCount(lot) >= 3` (외부/에디토리얼 없이 구조신호만으로 통과). 신호 정의는 :56-70.
- 비큐레이션 페이지 6개 무작위 샘플 중 4개가 리뷰+영상+블로그 = 0인데도 6/6 `index, follow`.
- 무관한 두 thin lot 페이지의 전체 렌더 텍스트 char-level 유사도 = **84.4%** (~12,000자 중 10,152자 동일).
- 전체 31,993 lot 중 **22,077개(69.0%)**가 web_sources·user_reviews 둘 다 0.

**상충 신호:** 페이지 자체(9신호) 로직과 사이트맵 SQL(4신호) 로직이 독립적으로 작성돼 274개(1.5%)는 사이트맵엔 포함되나 페이지는 noindex를 렌더 — Google에 모순 신호.

---

### 🔴 RC-2. 사이트맵 포함 SQL의 "죽은 신호"로 ~53%가 순수 boilerplate (CRITICAL / CONFIRMED)

**메커니즘:** `sitemap-handler.ts`의 포함 조건이 `EXISTS web_sources OR ai_summary OR curation_reason OR (total_spaces>0 + phone + is_free!=NULL + curation_tag!=NULL) >= 3`인데, **`p.is_free IS NOT NULL`이 100% 항상 참**이다 — schema.ts:94에서 `isFree`가 `.notNull().default(false)`로 선언돼 NULL이 될 수 없다. 즉 모든 행에 공짜 +1이 붙는다. 여기에 `total_spaces>0`(~50%)와 `phone`(~43%)만 더해지면 web_sources·ai_summary·큐레이션 0인 평범한 카카오 lot도 사이트맵에 자동 포함된다. 파일 헤더 주석의 의도("web_sources 없는 thin 주차장은 sitemap에서 완전 제외 #126")가 이 분기로 무력화된다.

**증거:**
- `src/server/sitemap-handler.ts:308` (및 :85 인덱스 메타) — `(CASE WHEN p.is_free IS NOT NULL THEN 1 ELSE 0 END)`.
- `src/db/schema.ts:94` — `isFree: integer('is_free', { mode: 'boolean' }).notNull().default(false)` → `is_free IS NOT NULL`은 31,993/31,993 = 100%.
- 사이트맵 포함 총계 = **17,743** (라이브 sitemap-0..3의 5000+5000+5000+2743과 정확히 일치).
- 이 중 **7,820개(44%)**가 약한 4신호 분기로만 포함(web_sources·ai_summary·curation 전무), 그 99.9%가 페이지도 index,follow.
- 이 중 **9,407개(53%)**가 relevant web_sources(rel>=40)·리뷰·미디어·에디토리얼 전부 0.
- 라이브 30개 샘플: 30/30 index,follow, 30/30 meta에 "리뷰 0개", 30/30 빈 리뷰/영상/블로그 섹션, 동일 5문항 FAQPage JSON-LD. 2/30은 "null분 null원" 데이터 버그 노출.

**상충 신호:** 페이지 로직과 미완 일치(RC-1과 동일 문제). `EXISTS web_sources`는 relevance 무관 어떤 행이든 참이라, 페이지 tabCounts(rel>=40)와 달라 1,595개는 "web_sources 있어서 포함"되나 페이지엔 블로그 0.

---

### 🔴 RC-3. 있는 콘텐츠조차 원본 AI 합성이 아닌 raw 스크랩 스니펫 노출 (읽기 경로 배선 버그) (CRITICAL / CONFIRMED — 최고 ROI 단일 수정)

**메커니즘:** 생산 파이프라인은 원본 합성문을 `web_sources.ai_summary`에 쓰고(18,992/20,247행 = 93.8% 채워짐, ai-summary-prompt.ts는 페이지 chrome 복사 금지·200~600자 원본 추출을 강제하는 잘 정의된 프롬프트) 있는데, **읽기 함수가 엉뚱한 컬럼을 SELECT한다.** `fetchBlogPosts()`가 `summary: schema.webSources.summary`(레거시, 20/20,247행 = 0.1%만 채워짐)를 읽고, `rowToBlogPost()`는 `snippet: row.content, summary: row.summary ?? undefined`로 매핑, `BlogPostCard`는 `post.summary ?? post.snippet`를 렌더 → 99.9%가 raw `content`(가공 안 된 네이버/DDG 검색 스니펫)로 폴백된다. 이것이 사용자 가설 2("스크랩 데이터로 채워짐")의 실제 정체다.

**증거:**
- `src/server/parking.ts` `fetchBlogPosts()` SELECT에 `summary: schema.webSources.summary` — **`ai_summary`를 SELECT하지 않음** (직접 확인).
- `src/server/transforms.ts:184-185` — `snippet: row.content, summary: row.summary ?? undefined`.
- 라이브 KA-238264949 블로그 카드가 "88 안동시외버스터미널 공영주차장 주차요금 변경 뱐걍 잔 토요일…" 같은 검색 스니펫 원문 노출(같은 행의 ai_summary엔 깨끗한 합성문이 있으나 쿼리 안 됨).
- ai_summary 채워진 web_sources = 18,992 / summary 채워진 = 20.

**해결 효과:** 1줄 수정으로 ~19K행·~9,850개 lot 페이지(코퍼스의 30.8%)가 raw 스크랩→원본 AI 합성으로 즉시 승격. 생성 비용 0. **본 감사 최고 ROI.**

---

### 🟠 RC-4. 지역 허브·breadcrump 상향 링크가 53%의 lot에 아예 없음 (HIGH / CONFIRMED)

**메커니즘:** `PARKING_REGIONS`가 9개 광역(서울/경기/부산/인천/대구/대전/광주/울산/제주)만 정의. `getRegionForAddress()`가 나머지는 null 반환(코드 주석도 "강원특별자치도 → null(허브 없음)" 명시). 이 null은 (1) /wiki/all?region= 허브 링크 생성과 (2) 상세 페이지 breadcrumb 상향 링크 렌더(`$slug.index.tsx:101 {region && ...}`) 양쪽에 쓰인다. 따라서 강원/충북/충남/전북/전남/경북/경남/세종의 모든 lot은 토픽 클러스터로 돌아가는 허브·breadcrumb 경로가 0 — Google의 "약한 중요도 신호" → Discovered/Crawled-not-indexed의 교과서적 원인.

**증거:**
- `src/lib/parking-regions.ts:12-32` (9개), `src/server/sitemap-handler.ts:28` REGION_PREFIXES(9개, 동기화 필요 주석).
- 9개 지역 합계 15,074 / 전체 31,993 → **16,919개(52.9%)**가 허브 없음.

---

### 🟠 RC-5. 31,993개 상세 페이지에 도달하는 유일한 경로가 평면 320페이지 순차 페이지네이션 (HIGH / CONFIRMED)

**메커니즘:** `/wiki/all`은 PAGE_SIZE=100·필터 없음 → 320페이지. prev/next 셰브론만(숫자 페이저 없음), page 1만 index, page 2+는 noindex,follow. final_score DESC 정렬이라 thin·저점수 lot이 최심부 페이지로 밀려 홈에서 최대 300+홉. Google 크롤 우선순위는 홉 거리에 따라 link-equity가 희석되므로, 유일 경로가 noindex 허브들의 300홉 체인인 콘텐츠는 "Discovered - not indexed"의 대표 원인.

**증거:** `/wiki/all?page=1` → 100개 링크·index; `?page=2` → noindex,follow; 렌더 텍스트 "총 31,993개". `/wiki` 홈은 고유 상세 링크 113개(0.35%)만 SSR. 추가로 /wiki/all은 필터가 없어 사이트맵 부적격 14,250개(44.5%)까지 크롤 유도.

---

### 🟠 RC-6. lot-level AI 요약이 사실상 미배포 — 22개(0.07%)뿐 (HIGH / CONFIRMED)

**메커니즘:** `hasParkingDetailEditorialContent()`가 index 판단의 최강 "thin 아님" 신호로 삼는 `parking_lot_stats.ai_summary`가 코퍼스 전체에 22개만 존재. 즉 거의 전 사이트가 raw 스크랩(RC-3)이나 순수 구조신호(RC-1)에 색인을 의존하고 있고, 진짜 1st-party 페이지 합성은 부재.

**증거:** `parking_lot_stats WHERE ai_summary 채워짐` = 22 / 31,938. (RC-3의 web_sources.ai_summary 18,992개와 다른 필드 — 이건 lot 단위 종합 요약.)

---

### 🟠 RC-7. 리뷰 0인데 aggregateRating을 조작 발행 (HIGH / CONFIRMED)

**메커니즘:** `buildParkingLotJsonLd()`가 `ratingCount: lot.difficulty.reviewCount || 1`. 리뷰 0인 대다수 lot에서 `|| 1` 폴백이 "평점 1개"를 주장하고 ratingValue엔 내부 난이도 점수(신뢰도 none일 땐 기본 3.0)를 넣는다. 화면엔 "쉬움 점수 데이터 부족 / 리뷰 0"이라 표시되는데 JSON-LD는 실제 리뷰가 있다고 주장 → Google 구조화데이터 정책 위반("misleading/fake review markup")으로 도메인 전체 구조화데이터 신뢰 훼손, "auto-generated" 품질 신호 강화.

**증거:** `src/lib/parking-jsonld.ts:39` `ratingCount: lot.difficulty.reviewCount || 1`; gate는 :33 `lot.difficulty.score !== null`뿐. 라이브 000-1-000001: 화면 "리뷰 0"인데 JSON-LD `aggregateRating.ratingCount:1`. review_count 0/null + final_score 있음 = 31,857/31,938(99.7%)이 해당.

---

### 🟠 RC-8. 사이트맵 포함 로직과 페이지 noindex 로직이 미조율 — 직접 모순 (HIGH / CONFIRMED)

**메커니즘:** 사이트맵 SQL(4필드)과 seo-indexing.ts(9필드 + 에디토리얼 + tabCounts)가 독립 작성돼 재조율된 적 없음. `EXISTS web_sources`(relevance 무관)와 페이지 tabCounts(rel>=40)도 기준이 달라, "web_sources 있어서 사이트맵 포함"인데 페이지엔 블로그 0인 lot 발생.

**증거:** 두 공식을 SQL로 포팅 → 274개(1.5%)는 사이트맵 포함이나 페이지 noindex(모순). 1,595개는 rel>=40 web_sources가 0인데 bare EXISTS로 포함.

---

### 🟡 RC-9. lot-매칭 품질 버그 — 다른 도시 lot에 web_sources 오귀속 (MEDIUM~HIGH / CONFIRMED)

**메커니즘:** `fetchBlogPosts()`가 `INSTR(title, lot_name)>0`로 부스트/랭크해, 일반적 이름('시외버스터미널 공영 주차장')이 타 도시 터미널 블로그와 매칭. write-time 매칭 파이프라인도 지리 co-reference 없이 이름 substring 위주라, 페이지의 최대 비-boilerplate 텍스트가 전혀 다른 위치를 설명 → 토픽 관련성 약화 + "스크랩 집계" 인상 강화.

**증거:** 라이브 KA-238264949(영주시)의 블로그 6/6이 안동/평택/강릉/진천/거창/태백 터미널 — 영주 언급 0. 관련: `scripts/lib/place-match.ts`, `scripts/crawl-lot-keywords.ts`.

---

### 🟡 RC-10. 동일 lot 이름의 중복 <title> (MEDIUM~HIGH / CONFIRMED)

**메커니즘:** title이 `${lot.name} - 주차 난이도/요금/정보 | 쉬운주차장`으로 lot.name만 사용(주소/동 disambiguator 없음). 공공데이터 주차장명은 지자체 내 반복이 흔해(예 '완도군 공용주차장' ×28) byte-identical title이 다수 URL에 걸린다 → Google 중복 클러스터링이 대표 1개만 색인하고 나머지를 near-duplicate로 드롭.

**증거:** `src/routes/wiki/$slug.tsx:48` title 조립(주소 성분 없음). 중복 이름 그룹 850개, 최악 '완도군 공용주차장' 28개(전부 상이 좌표/주소 = 실제 별개 위치).

---

### 🟡 RC-11. 내부 중복 — 동일 source_url이 최대 9개 lot에 부착 (MEDIUM / CONFIRMED)

**메커니즘:** web_sources는 (lot_id, source) 단위 1:1이나 같은 블로그 URL이 여러 lot_id로 별 행 삽입 → 동일 스니펫 카드가 2~9개 /wiki 페이지에 near-identically 렌더. 사이트 내부 near-duplication으로 고유성 희석.

**증거:** `platformdodam.com/parking-lots/10464` → 9개 lot; 집계 GROUP BY source_url HAVING COUNT(DISTINCT lot_id)>1 → 1,034 그룹 / 2,954행(전체 web_sources의 14.6%).

---

### 🟡 RC-12. FAQPage에 비-답변 filler + 한국어 조사 버그 (MEDIUM~LOW / CONFIRMED)

**메커니즘:** (a) `buildHoursAnswer()`가 시간 미상일 때 null 대신 "정확한 운영시간은 방문 전 확인하세요."라는 비-답변을 반환해 FAQPage에 실림(faq-generator.ts:76-82). (b) 초보운전자 질문이 `${lot.name}은 …`으로 '은' 하드코딩(faq-generator.ts:21) — 받침 없는 이름('타워')에 '는'이어야 하므로 문법 오류가 schema.org Question.name에 노출.

**증거:** 라이브 '토로스 주차타워은 초보운전자도…'(should '주차타워는'). 라이브 현대41타워 FAQ3 답변이 filler 문구.

---

### ⚪ RC-13. 부차적 기술 이슈 (LOW / 일부 HYPOTHESIS)

- **viewport 핀치줌 차단** (`maximum-scale=1, user-scalable=no`) — WCAG 1.4.4 위반, page-experience 신호 저하(색인 차단은 아님). CONFIRMED. 5분 수정.
- **구조 리다이렉트 307(임시) 대신 301(영구)이어야** — trailing-slash 정규화, /wiki/all→+page=1. CONFIRMED. 크롤 효율 minor 손실.
- **임의 slug + 유효 ID가 200 반환**(canonical로만 정규화) — 크롤 공간 무한. CONFIRMED, 현재 무해.
- **TTFB ~0.9~1.2s** (loader가 6개 병렬 D1 쿼리) — 17k 규모에서 크롤율 throttling 가능성. HYPOTHESIS (GSC Crawl Stats 필요). 콘텐츠 원인 대비 부차적.

---

## 3. 오해/제외된 것 (Ruled Out — 불필요한 작업 방지)

이하는 **문제가 아님이 확인**되어 손대면 안 되는 것들:

- **`parking_lots.is_seed` 컬럼 / `000-*` 시드 lot 이론 → 존재하지 않음.** schema.ts:173 `isSeed`는 `user_reviews` 소속(가짜 리뷰 플래그). `000-*` 96개는 실제 공영주차장(부천시 초기 임포트), 전체의 0.3%로 무시 가능. **별도 대응 불필요.** (task 전제 오류 — 여기에 시간 쓰지 말 것.)
- **SSR head-tag hoisting 갭 (__root.tsx 주석의 우려) → 거짓.** JS 실행 없는 raw HTML에 title/description/robots/canonical/og/4× JSON-LD(WebSite, ParkingFacility, FAQPage, BreadcrumbList)가 lot별로 정확히 존재. React 19 metadata hoisting은 SSR에서 정상 작동.
- **Googlebot 클로킹/차단/challenge → 없음.** Googlebot UA와 기본 UA 응답이 동일 200·동일 바이트. X-Robots-Tag 헤더 없음.
- **JS 의존/CSR-only 콘텐츠 갭 → 없음.** DOM에 보이는 것(및 "글이 없습니다" 부재 표시)이 전부 raw HTML에 이미 존재.
- **JSON-LD malformed/truncated → 아님.** 4개 블록 전부 valid JSON.
- **www/http 정규화 → 정상.** www→apex 301, http→https 301 (issue-124 유효).
- **404 처리 → 정상.** 없는 ID는 진짜 404(soft-404 아님).
- **사이트맵 XML 문법/접근성 → 정상.** 전 사이트맵 200·valid XML.
- **robots.txt 차단 → 없음.** /admin/만 disallow, wiki/detail 전부 허용(Yeti 포함).
- **canonical 누락/불일치 → 아님.** self-referential·절대·byte-identical.
- **hreflang 누락 → 해당 없음.** 단일 ko-KR.
- **AI 요약 생성 프롬프트 품질 → 문제 아님.** ai-summary-prompt.ts는 잘 정의됨, 93.8% 정상 채워짐. 문제는 읽기 경로 버그(RC-3)이지 생성 품질이 아님.
- **FAQPage rich-result 자격 제한(2023.8~) → 색인이 아니라 SERP 스니펫 표시에만 영향.** 색인 원인 아님.
- **NearbyPlaces 섹션 → 내부 PageRank 미기여.** 외부 POI 대상 non-link `<div>`, /wiki 링크 없음(정상, 손댈 필요 없음).
- **지리적 고립이 주 orphan 원인 → 아님.** 300개 샘플 중 0.7%만 4km 내 이웃 0.

---

## 4. 해결 계획 (phased)

> 핵심 원칙: **RC-1(페이지 임계값)과 RC-2(사이트맵 SQL)는 반드시 lockstep으로 수정**한다. 하나만 조이면 모순 신호(RC-8)가 오히려 심해진다. 배포 전 각 변경의 index→noindex 전환 규모를 로컬 D1로 count 검증 후 진행(local-first 정책).

### Phase 1 — 즉효 Quick Wins (1일 내, 저위험·고효과)

| # | 액션 | 파일 | 기대효과 | 측정지표 |
|---|------|------|----------|----------|
| 1 | **fetchBlogPosts 컬럼 스왑**: `summary: webSources.summary` → `ai_summary`(폴백 summary→content). transforms.rowToBlogPost도 `summary: row.ai_summary ?? row.summary` | src/server/parking.ts, src/server/transforms.ts:184-185 | ~19K행·~9,850 lot이 raw 스크랩→원본 AI 합성. 가설 2 정면 해소 | 라이브 페이지에서 블로그 카드가 깨끗한 200~600자 합성문인지 확인 |
| 2 | **aggregateRating 조작 제거**: `|| 1` 삭제, `reliability !== 'none' && reviewCount > 0`일 때만 블록 발행(아니면 omit) | src/lib/parking-jsonld.ts:33-41 | 구조화데이터 정책 위반 제거, 도메인 신뢰 회복 | Rich Results Test에서 리뷰 0 페이지에 aggregateRating 미발행 |
| 3 | **FAQ filler·조사 버그 수정**: 시간 미상 시 항목 skip(null 반환), 받침 판별 헬퍼로 은/는 선택 | src/lib/faq-generator.ts:21, :76-82 | 비-답변/문법오류 schema 제거 | 라이브 FAQ에 filler·'타워은' 부재 |
| 4 | **viewport 핀치줌 허용**: `maximum-scale=1, user-scalable=no` 제거 | src/routes/__root.tsx (viewport meta) | page-experience 신호 개선 | 모바일 사용성 통과 |
| 5 | **307→301**: trailing-slash·/wiki/all page 리다이렉트를 `redirect({status:301})` | 해당 route/loader | 크롤 효율·URL 통합 | curl -I가 301 |

> Phase 1은 색인 임계값을 아직 안 건드리므로 커버리지 급변 없이 콘텐츠 품질/신뢰만 올린다. #1이 최우선.

### Phase 2 — 구조 개선 (약 1주, 색인 정책·내부 링크 재설계)

**2-A. 색인 임계값 강화 (RC-1 + RC-2 + RC-8 통합) — 최중요.**

단일 신뢰원(single source of truth) 도입: "index 가치 있음"을 **외부 콘텐츠(rel>=40 blog OR 리뷰 OR 미디어) > 0 이거나 에디토리얼(ai_summary/ai_tip*/curation_reason) 존재**로 정의하고, seo-indexing.ts와 sitemap SQL이 **동일 기준**을 쓰게 한다. 순수 구조신호(주소/시간/요금)만으로는 index 불가.

- 페이지: `src/lib/seo-indexing.ts:88` 을 아래로 변경
  ```ts
  // 구조신호만으로는 index 금지. 외부 콘텐츠 OR 에디토리얼 필수.
  return false  // (externalContentCount>0 / editorial은 이미 :85-86에서 true 반환)
  ```
  즉 `getParkingDetailSeoSignalCount >= 3` 분기를 제거하거나, 최소 `reviewCount>0 OR ai_summary` 같은 실질 바를 요구.
- 사이트맵: `src/server/sitemap-handler.ts`의 `sitemapPage`(:302-310)·`getSitemapIndexMeta`(:79-87) WHERE에서 **약한 4신호 분기 전체 삭제**하고 페이지와 동일 기준으로:
  ```sql
  WHERE EXISTS (SELECT 1 FROM web_sources ws
                WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40)
     OR s.ai_summary IS NOT NULL
     OR p.curation_reason IS NOT NULL
     OR COALESCE(s.review_count,0) > 0
  ```
  (`is_free IS NOT NULL` 죽은 신호 제거가 핵심. `EXISTS web_sources`도 rel>=40으로 조여 페이지 tabCounts와 일치시킴.)
- **배포 전 검증(local-first):** 위 두 기준의 index-eligible count를 로컬 D1에서 count하고, 예상 전환 규모(현재 17,743 → 실질 콘텐츠 보유분, 대략 9,856 has_web_sources의 rel>=40 부분집합 수준)를 확인. 급격한 대량 noindex는 GSC 커버리지 리포트로 모니터링.

기대효과: ~9,400개 boilerplate가 사이트맵에서 빠지고 noindex,follow로 전환 → Google이 소수 고품질 URL에 크롤 예산 집중. 측정: GSC "Crawled - not indexed" 감소, sitemap "제출/색인" 비율 상승.

**2-B. 지역 허브 전면 확장 (RC-4).**
- `src/lib/parking-regions.ts` PARKING_REGIONS를 17개 시/도 전체로 확장(또는 시/도→시군구 2단계 트리). `sitemap-handler.ts:28` REGION_PREFIXES 동기화(주석대로 필수 커플링). 기대: 16,919개 lot이 허브·breadcrumb 획득. 측정: 각 지역 허브가 200 반환·breadcrumb 렌더.

**2-C. /wiki/all 얕은 hub/spoke (RC-5).**
- 숫자 점프 페이저 또는 지역/시군구 계층 브라우즈 추가로 최대 홉을 3~4로 축소. 병행: /wiki/all WHERE를 사이트맵 eligibility와 일치시켜 부적격 14,250개 크롤 낭비 제거(또는 별도 저우선 뷰로 분리). 측정: 홈→임의 상세 홉 수, 크롤 통계.

**2-D. title disambiguator (RC-10).**
- `src/routes/wiki/$slug.tsx:48` title에 동/읍/면 또는 short address 삽입: `${lot.name} (${dong}) - …`. 측정: 중복 title 그룹 수 감소.

**2-E. robots.txt 사이트맵 정리 (선택).**
- 중복도 99.8%/86%인 priority·parking 사이트맵을 big 사이트맵과 비겹치게 하거나 robots.txt에서 정리. 낮은 우선순위.

### Phase 3 — 콘텐츠 품질 (지속)

**3-A. lot-level AI 요약 배치 확대 (RC-6, RC-3의 상류).**
- 기존 `gen-parking-summary` / `run-ai-summary` 파이프라인을 web_sources 보유 ~9,856 lot에 대해 스케일 실행(RC-3 수정된 ai_summary를 입력으로). 이것이 페이지를 "진짜 index 가치 있음"으로 만드는 근본. 비용은 LLM 사용량에 비례. 측정: parking_lot_stats.ai_summary 커버리지, 해당 lot의 색인율.

**3-B. lot-매칭 지리 co-reference 강화 (RC-9).**
- `scripts/lib/place-match.ts`·`crawl-lot-keywords.ts`에 이름 substring 외 시/구 지리 일치 요구. 병행: 배정 lot 주소와 지리 overlap 0인 web_sources 감사 쿼리로 오귀속 정리. 측정: 오귀속 web_sources 건수.

**3-C. cross-lot 중복 카드 dedupe (RC-11).**
- source_url당 가장 관련성 높은 단일 카드만 표시하거나 "이 글은 인근 N개 주차장도 다룹니다" 프레이밍. 낮은 우선순위.

---

## 5. 측정 & 검증 (배포 후 GSC 확인)

**즉시 (배포 후 1~2일):**
- URL 검사 도구로 대표 URL 5~10개 라이브 테스트 → 페이지가 의도대로 index/noindex인지, RC-1/RC-2 lockstep이 모순 없이 반영됐는지 확인.
- Rich Results Test → aggregateRating 미발행(리뷰 0), FAQPage에 filler 부재.
- 새 사이트맵 재제출 → GSC가 "성공"으로 읽고 URL 수가 축소됐는지(17,743 → 실질분).

**단기 (1~2주):**
- **색인 커버리지 리포트**: "Crawled - currently not indexed" / "Discovered - not indexed" 버킷의 URL 수 추세. Phase 2-A 후 boilerplate가 noindex로 빠지면 이 버킷이 줄고, 남은 고품질 URL의 "색인됨" 비율이 올라야 함.
- **Crawl Stats**: 일일 크롤 요청/응답시간. 예산이 소수 고품질 URL로 재배분되는지(및 RC-13 TTFB 가설 확인).

**중기 (3~6주):**
- 사이트맵 "제출 대비 색인" 비율 상승(핵심 성공지표).
- Phase 3-A로 ai_summary 커버리지 오른 lot 코호트의 색인율을 대조군 대비 비교 → 콘텐츠 품질이 색인의 인과 요인임을 실증.
- 조직 검색 노출/클릭(Performance 리포트) 회복 여부.

**롤백 가드:** Phase 2-A는 대량 noindex 전환이므로, 배포 후 색인된 URL이 예상 초과로 급감하면 임계값을 한 단계 완화(예: rel>=40 대신 rel>=30, 또는 리뷰 없이 web_sources 존재만으로 index 허용)해 재조정.

---

### 부록: 우선순위 요약

1. **RC-3 fetchBlogPosts 컬럼 스왑** (Phase 1-#1) — 1줄, 최고 ROI, 가설 2 해소.
2. **RC-1+RC-2+RC-8 임계값 lockstep 강화** (Phase 2-A) — 근본 원인, ~9,400 boilerplate 색인 제외.
3. **RC-7 aggregateRating 조작 제거** (Phase 1-#2) — 도메인 구조화데이터 신뢰 회복.

이후 RC-4/RC-5(내부 링크), RC-6(AI 요약 스케일), RC-9~12 순.
