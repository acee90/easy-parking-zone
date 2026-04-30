# 주변 장소 AI 추출 파이프라인

> 최초 작성: 2026-04-03

## 목적

주차 쉬운 주차장(난이도 3.5+) 근처의 카페/맛집/공원 등을 기존 블로그 크롤링 데이터에서
AI로 추출하여, 위키 상세 페이지에 "주변 갈만한 곳" 큐레이션을 제공한다.

## 데이터 흐름

```
web_sources (기존 크롤링 데이터)
  ↓ score >= 3.5 주차장만 필터
  ↓ 주차장별 블로그 묶기
  ↓
nearby-extractor.ts (Haiku API)
  ↓ 블로그 텍스트 → {places: [{name, category, tip}]}
  ↓
merge + 중복 제거
  ↓ 동일 장소명 → mention_count 합산
  ↓ mention_count >= 2만 저장 (정확도 필터)
  ↓
nearby_places 테이블
  ↓
fetchNearbyPlaces API → 위키 UI 렌더링
```

---

## DB 스키마

```sql
-- migrations/0031_nearby_places.sql
CREATE TABLE nearby_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  name TEXT NOT NULL,           -- 실제 상호명/장소명
  category TEXT NOT NULL,       -- cafe | restaurant | park | tourist | market | hospital | etc
  tip TEXT,                     -- 방문 팁 ("주말 오전이 한적해요")
  mention_count INTEGER NOT NULL DEFAULT 1,
  source_blog_ids TEXT,         -- JSON array: 출처 web_sources.id 목록
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## AI 추출 로직

### 모듈: `src/server/crawlers/lib/nearby-extractor.ts`

`ai-filter.ts`의 `classifyBatch()` 패턴을 따르는 구조.

**입력**: 주차장 1개의 블로그 묶음 (N건)

**프롬프트 핵심 규칙**:
- 실제 상호명/장소명만 추출 (일반 명사 "카페", "공원" 등은 제외)
- 주차장 자체는 제외
- 카테고리 7종: cafe, restaurant, park, tourist, market, hospital, etc
- 팁은 20자 이내, 없으면 null
- 블로그당 최대 5개

**비용**: Haiku 사용, 블로그 content 앞 500자만 전송. 341건 기준 ~$0.34.

### 병합 로직: `mergeExtractedPlaces()`

같은 주차장의 여러 블로그에서 추출된 장소를 병합:

```
주차장 "구리 제1공영주차장" 블로그 3건:
  블로그 #101: [{name: "카페모카", category: "cafe"}]
  블로그 #102: [{name: "카페모카", category: "cafe"}, {name: "중앙공원", category: "park"}]
  블로그 #103: [{name: "중앙공원", category: "park"}, {name: "구리시장", category: "market"}]

병합 결과:
  카페모카:  mention_count=2, source_blog_ids=[101,102] → ✅ 저장
  중앙공원:  mention_count=2, source_blog_ids=[102,103] → ✅ 저장
  구리시장:  mention_count=1, source_blog_ids=[103]     → ❌ 제외 (1회만 언급)
```

**왜 mention_count >= 2인가?**
- 1회만 언급 = 블로거 개인 취향일 수 있음, 노이즈 높음
- 2회 이상 = 여러 블로거가 독립적으로 언급, 실제 인근 장소일 가능성 높음
- 데이터 정확도 vs 커버리지 트레이드오프에서 정확도 우선

---

## 배치 스크립트

### `scripts/extract-nearby-places.ts`

```bash
# dry-run (DB 미반영, 결과만 확인)
bun run scripts/extract-nearby-places.ts --remote --dry-run

# 실행 (DB 반영)
bun run scripts/extract-nearby-places.ts --remote

# 소량 테스트
bun run scripts/extract-nearby-places.ts --remote --limit 10 --dry-run
```

**실행 흐름**:
1. `nearby_places`에 이미 있는 주차장 제외 (incremental)
2. score >= 3.5 주차장 + web_sources JOIN
3. 주차장별 그룹핑 → Haiku API 호출 (5건 병렬)
4. 병합 + mention >= 2 필터 → INSERT
5. 결과 리포트 출력

**환경변수**: `ANTHROPIC_API_KEY`

**1회성 스크립트**: 초기 배치 완료 후 삭제. 이후 신규 블로그는 cron 파이프라인에서 처리.

---

## 위키 UI

### 위치

```
위키 상세 페이지 ($slug.tsx):
  [기본 정보] → [미니 지도] → [주변 갈만한 곳] → [리뷰/블로그/영상 탭]
```

### 데이터 로딩

`loader`에서 `fetchParkingDetail`과 `fetchNearbyPlaces`를 **병렬 호출**:

```typescript
const [lot, nearbyPlaces] = await Promise.all([
  fetchParkingDetail({ data: { id } }),
  fetchNearbyPlaces({ data: { parkingLotId: id } }),
])
```

### 표시 조건

- `nearbyPlaces.length > 0` → 섹션 표시
- `nearbyPlaces.length === 0` → 섹션 숨김 (Graceful degradation)

### 카테고리 아이콘

| category | icon | label |
|----------|------|-------|
| cafe | ☕ | 카페 |
| restaurant | 🍽️ | 맛집 |
| park | 🌳 | 공원 |
| tourist | 🎫 | 관광 |
| market | 🛒 | 시장 |
| hospital | 🏥 | 병원 |
| etc | 📍 | 기타 |

---

## 데이터 현황 (2026-04-03 기준)

| 항목 | 수치 |
|------|------|
| 대상 주차장 (score >= 3.5) | 349개 |
| 블로그 보유 주차장 | 341개 (97.7%) |
| 블로그 내 장소 키워드 | 공원 210, 맛집 204, 시장 169, 카페 114 |
| 지역 분포 TOP 5 | 경기 120, 경상 59, 전라 22, 충청 21, 강원 20 |

---

## 관련 파일

| 파일 | 역할 |
|------|------|
| `src/server/crawlers/lib/nearby-extractor.ts` | AI 추출 모듈 |
| `scripts/extract-nearby-places.ts` | 1회성 배치 스크립트 |
| `src/db/schema.ts` (nearbyPlaces) | Drizzle 스키마 |
| `src/server/parking.ts` (fetchNearbyPlaces) | API 함수 |
| `src/routes/wiki/$slug.tsx` (NearbyPlacesSection) | UI 컴포넌트 |
| `src/types/parking.ts` (NearbyPlaceInfo) | 타입 정의 |

## 관련 문서

- [크롤링 파이프라인 v2](poi-pipeline-v2.md) — 원본 블로그 수집 아키텍처
- [스코어링 알고리즘](archive/2026-03/crawlers/parking-scoring-algorithm.md) — 난이도 점수 산출
- [M7 Plan](01-plan/features/M7-curation.plan.md) — 기획 문서
- [M7 Design](02-design/features/M7-curation.design.md) — 설계 문서
