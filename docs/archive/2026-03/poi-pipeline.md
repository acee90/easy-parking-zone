# POI 주차 콘텐츠 파이프라인

> 최종 업데이트: 2026-03-11

## 개요

인기 목적지(POI) 기반 주차 콘텐츠를 수집·분석하여 DB에 적재하는 파이프라인.
"서울역 주차" 같은 검색 시 블로그/카페 콘텐츠를 기반으로 주차 정보를 제공하기 위한 데이터 기반.

## 파이프라인 구조

```
1. POI 후보 발굴        → collect-poi-pilot.ts
2. 콘텐츠 수집          → collect-poi-content.ts
3. AI 분석 (구조화)     → analyze-poi-content.ts
4. DB 적재             → load-poi-to-db.ts
   ├─ 이름 매칭 (DB 기존 주차장)
   ├─ 1차 fallback: 카카오 키워드 검색 → 신규 주차장 등록
   └─ 2차 fallback: poi_unmatched 테이블 → admin에서 수동 처리
```

---

## 1단계: POI 후보 발굴 (`collect-poi-pilot.ts`)

카카오 Local API로 카테고리별 POI 후보를 검색하고, 네이버 검색 볼륨으로 실행 가능성 평가.

**카테고리:**
| 카테고리 | 검색어 | 필터 | 상태 |
|---------|--------|------|------|
| 기차역 | 서울 기차역 | - | ✅ 완료 |
| 대형병원 | 서울 대학병원 | maxNameLength: 15 | ✅ 완료 |
| 쇼핑몰/백화점 | 서울 백화점 | 백화점/대형마트 등 | ✅ 완료 |
| 터미널 | 서울 터미널 | 화물/트럭 제외 | ✅ 완료 |
| 대형마트 | 서울 대형마트 | - | ✅ 완료 |
| 놀이공원 | 서울 놀이공원 | - | 🔲 다음 |
| 경기장 | 서울 경기장 | - | 🔲 예정 |
| 공연장 | 서울 공연장 | - | 🔲 예정 |
| 대학교 | 서울 대학교 | - | 🔲 예정 |
| 관광명소 | 서울 관광명소 | - | 🔲 예정 |
| 전통시장 | 서울 전통시장 | - | 🔲 예정 |

**품질 필터링:**
- 좌표 기반 중복 제거 (300m 반경 Haversine)
- 이름 길이 제한 (병원 과단위 제외)
- 이름 키워드 제외 (화물터미널 등)
- 네이버 블로그/카페 검색 최소 10건 이상

**카테고리별 실행:**
```bash
bun run scripts/collect-poi-pilot.ts --category=대형마트
```

**산출물:** `scripts/poi-pilot-result.json` (또는 `poi-pilot-대형마트.json`)

---

## 2단계: 콘텐츠 수집 (`collect-poi-content.ts`)

각 POI에 대해 "OO 주차" 키워드로 네이버 블로그/카페 글 수집.

**설정:**
- POI당 블로그 최대 30건 + 카페 최대 30건
- 주차 키워드 필터: 제목/본문에 "주차", "parking", "파킹" 포함 필수
- 네이버 API 딜레이: 300ms

**카테고리별 실행:**
```bash
bun run scripts/collect-poi-content.ts --input=poi-pilot-대형마트.json
```

**산출물:** `scripts/poi-content-result.json` (또는 `poi-content-대형마트.json`)

---

## 3단계: AI 분석 (`analyze-poi-content.ts`)

Claude Haiku로 수집된 블로그/카페 스니펫에서 구조화된 주차 정보 추출.

**추출 항목:**
- `parkingLots[]`: 주차장 이름, 요금, 무료조건, 팁
- `generalTips[]`: 해당 장소 방문 시 주차 팁
- `difficulty`: easy / normal / hard / unknown
- `summary`: 주차 상황 요약 2-3문장

**카테고리별 실행:**
```bash
bun run scripts/analyze-poi-content.ts --input=poi-content-대형마트.json
```

**산출물:** `scripts/poi-analysis-result.json` (또는 `poi-analysis-대형마트.json`)

---

## 4단계: DB 적재 (`load-poi-to-db.ts`)

분석 결과를 DB에 매칭·적재. 3단계 fallback 구조.

**동작:**
1. `parking_lots` 전체 조회 → 메모리에서 좌표 기반 필터 (±0.005도 ≈ 500m)
2. 토큰 기반 이름 유사도 매칭 (Jaccard + 포함 보너스, 임계값 0.4)
3. **매칭 실패 시 1차 fallback**: 카카오 키워드 검색 (반경 2km)으로 geocoding → 주차장 카테고리 결과 발견 시 `parking_lots`에 신규 INSERT
4. **geocoding 실패 시 2차 fallback**: `poi_unmatched` 테이블에 적재 → admin에서 수동 매칭/무시
5. 매칭된 주차장 + 근처 전체 주차장에 `poi_tags` JSON 배열 업데이트
6. 대표 주차장에 블로그/카페 글을 `web_sources` (source='poi')로 적재
7. SQL 파일 생성 → `d1ExecFile`로 일괄 실행

**카테고리별 실행:**
```bash
bun run scripts/load-poi-to-db.ts --input=poi-analysis-대형마트.json --remote
```

**산출물:** `scripts/poi-match-report.json`, `scripts/poi-load-batch.sql`

---

## 실행 결과

### 1차 (기차역/병원/백화점/터미널) — 2026-03-10
| 항목 | 수량 |
|------|------|
| 대상 POI | 46건 |
| 수집 콘텐츠 | 2,437건 |
| 추출된 주차장 | 122곳 |
| 이름 매칭 성공 | 36건 |
| 이름 매칭 실패 | 86건 |
| poi_tags 업데이트 | 382개 주차장 |
| web_sources 적재 | 2,198건 |

### 2차 (대형마트) — 2026-03-10
| 항목 | 수량 |
|------|------|
| 대상 POI | 41건 |
| 수집 콘텐츠 | 2,146건 |
| 매칭 성공 | 14건 |
| 매칭 실패 | 33건 |
| poi_tags 업데이트 | 47개 주차장 |
| web_sources 적재 | 2,130건 |

---

## DB 스키마

### `0017_poi_tags.sql`
```sql
ALTER TABLE parking_lots ADD COLUMN poi_tags TEXT;
```
- `poi_tags`: JSON 배열 (예: `["서울역","용산역"]`)

### `0022_poi_unmatched.sql`
```sql
CREATE TABLE poi_unmatched (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_name TEXT NOT NULL,
  lot_name TEXT NOT NULL,
  poi_lat REAL NOT NULL,
  poi_lng REAL NOT NULL,
  category TEXT,
  status TEXT DEFAULT 'pending',  -- pending | resolved | ignored
  resolved_lot_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```
- geocoding으로도 찾지 못한 주차장 → admin에서 수동 처리

### web_sources 적재 형식
| 컬럼 | 값 |
|------|-----|
| source | `'poi'` |
| source_id | `poi_{base64url(link)[:32]}` |
| source_url | 블로그/카페 원문 링크 |
| relevance_score | 60 |

---

## Admin 관리

**경로:** `/admin/web-sources` → "POI 매칭 실패" 탭

- 미처리/매칭완료/무시 필터
- 주차장 검색 → 수동 연결
- 무시 처리 (음식점 등 잘못 추출된 항목)

---

## 실행 방법

### 전체 파이프라인 (새 카테고리)
```bash
# 1. POI 후보 발굴 (카카오 API)
bun run scripts/collect-poi-pilot.ts --category=놀이공원

# 2. 콘텐츠 수집 (네이버 API)
bun run scripts/collect-poi-content.ts --input=poi-pilot-놀이공원.json

# 3. AI 분석 (Anthropic API)
bun run scripts/analyze-poi-content.ts --input=poi-content-놀이공원.json

# 4. DB 적재 (카카오 geocoding + D1)
bun run scripts/load-poi-to-db.ts --input=poi-analysis-놀이공원.json --remote
```

### 필요 환경변수
- `KAKAO_REST_API_KEY` — 카카오 Local API (후보 발굴 + geocoding fallback)
- `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` — 네이버 검색 API
- `ANTHROPIC_API_KEY` — Claude Haiku 분석

### DB 마이그레이션
```bash
# wrangler.jsonc에 migrations_dir 설정 완료
npx wrangler d1 migrations apply parking-db --local
npx wrangler d1 migrations apply parking-db --remote
```

---

## 개선 TODO

### 매칭률 개선
- [x] 카카오 키워드 검색 geocoding fallback (1차)
- [x] 매칭 실패 → admin 수동 처리 (2차)
- [ ] AI 프롬프트 개선 — "실제 주차장만 추출, 음식점/상점 제외" 명시
- [ ] 이름 매칭 알고리즘 개선 — 접두/접미사("지하", "지상", "제1") 제거 후 비교

### POI 확장
- [x] 대형마트 (41 POI)
- [ ] 놀이공원 — 다음 진행
- [ ] 경기장
- [ ] 공연장
- [ ] 대학교
- [ ] 관광명소
- [ ] 전통시장
- [ ] 서울 외 수도권 (경기/인천) POI 추가
- [ ] 시즌성 POI: 벚꽃 명소, 단풍 명소, 해수욕장

### 프론트엔드 연동
- [x] 주차장 상세 페이지에 POI 태그 표시 (Badge)
- [x] POI 태그 기반 검색 기능
- [ ] POI별 주차 가이드 페이지 (난이도, 주차장 목록, 팁)

### 데이터 품질
- [ ] 주기적 콘텐츠 갱신 (분기별 재수집)
- [ ] 사용자 피드백으로 매칭 정확도 보정
- [ ] 중복 리뷰 정리 (같은 블로그가 여러 POI에 중복 적재될 수 있음)
