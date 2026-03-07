# 🔥 헬 주차장 선행 DB 구축 — 상세 실행 플랜

## 1. 목표

| 항목 | 내용 |
|------|------|
| **목적** | 콜드 스타트 해결 — 유저 리뷰 없이도 지도의 가치를 느끼게 하는 Seed 데이터 구축 |
| **수량** | 악명 높은 헬 주차장 **50~100개** + 초보 추천 주차장 **20~40개** (대비용) |
| **품질** | 주차장당 Seed 리뷰 2~5개 + 블로그/YouTube 링크 3~10개 |
| **타겟 지역** | 강남/홍대/성수/여의도/용산/잠실/코엑스 등 핫플 우선 |

## 2. 헬 주차장 선정 기준

### 2.1 자동 후보 추출 (기존 DB 활용)

현재 DB 36,223건 + crawled_reviews 56,793건에서 후보를 뽑을 수 있음:

```sql
-- 1) 블로그 후기에서 "좁다/무섭다/힘들다" 키워드가 많이 언급된 주차장
SELECT p.id, p.name, p.address, COUNT(*) as negative_mentions
FROM parking_lots p
JOIN crawled_reviews cr ON cr.parking_lot_id = p.id
WHERE cr.content LIKE '%좁%' OR cr.content LIKE '%무서%'
   OR cr.content LIKE '%힘들%' OR cr.content LIKE '%골뱅이%'
   OR cr.content LIKE '%긁%' OR cr.content LIKE '%기계식%'
GROUP BY p.id
ORDER BY negative_mentions DESC
LIMIT 200;

-- 2) 기계식 주차장 (notes/type에 기계식 포함)
SELECT id, name, address FROM parking_lots
WHERE notes LIKE '%기계식%' OR name LIKE '%기계식%';

-- 3) 주차면수 대비 후기가 많은 = 유명한 주차장
SELECT p.id, p.name, p.address, p.total_spaces, COUNT(cr.id) as review_count
FROM parking_lots p
JOIN crawled_reviews cr ON cr.parking_lot_id = p.id
GROUP BY p.id
HAVING review_count >= 3
ORDER BY review_count DESC;
```

### 2.2 수동 큐레이션 리스트 (인터넷 악명)

커뮤니티/유튜브에서 이미 유명한 헬 주차장들:

| # | 주차장명 | 지역 | 악명 이유 |
|---|---------|------|----------|
| 1 | 타임스퀘어 주차장 | 영등포 | 좁은 골뱅이 나선형 |
| 2 | 용산 아이파크몰 | 용산 | 극악 나선형 진입로 |
| 3 | 그랑서울 주차장 | 종로 | 좁고 어두운 지하 |
| 4 | 코엑스 주차장 | 삼성 | 미로처럼 복잡 |
| 5 | IFC몰 주차장 | 여의도 | 좁은 회전 램프 |
| 6 | 롯데월드타워 주차장 | 잠실 | 대형/복층 미로 |
| 7 | 강남역 지하주차장 | 강남 | 좁은 기둥 간격 |
| 8 | 홍대입구역 공영 | 마포 | 좁고 만차 빈번 |

### 2.3 웹 조사 결과 추가 (2026.03 조사)

**출처**: 클리앙 "전국 극악 난이도 주차장 시즌2", 블라인드, 다음카페

| # | 주차장명 | 지역 | 악명 이유 | DB 매칭 |
|---|---------|------|----------|---------|
| 1 | 선릉역 성원빌딩-성원타워 | 강남 | 별3개 초극악, 진출입로 각도 극악 | DB에 없음 |
| 2 | 시청역 한화빌딩 | 중구 | 별2개, 굴당에서 피해자 속출 | DB에 없음 |
| 3 | 여의도 성모병원 지하 | 영등포 | 대리기사도 거절, 회전 난이도 극악 | DB에 없음 (서울성모병원은 별개) |
| 4 | 합정 명진빌딩 | 마포 | 후진으로만 출차 가능 | DB에 없음 |
| 5 | 강남 L7 호텔 | 강남 | 극악으로 좁은 지하주차장 | DB에 없음 |
| 6 | 강남 점프밀라노 | 강남 | 좁은 진입로, 사람 왕래 빈번 | DB에 없음 |
| 7 | 여의도 진미파라곤빌딩 | 영등포 | 꽈배기 통로 각도 직각에 가까움 | DB에 없음 |
| 8 | 여의도 백상빌딩 | 영등포 | 지하 깊음, 회전 난이도 극악 | DB에 없음 |
| 9 | 명동 중앙우체국(포스트타워) | 중구 | 대리기사도 거절, 선회 극악 | DB에 없음 |
| 10 | 광명 크로앙스 | 광명 | 별2개, 휠 손상 빈번 | DB에 없음 |
| 11 | 역삼역 멀티캠퍼스 | 강남 | 대리기사들이 지목한 고난이도 | DB에 없음 |
| 12 | 잠실 시그마타워 | 송파 | 좁은 지하 진입로 | **매칭 완료** |
| 13 | 청담 호림아트센터(CGV청담) | 강남 | 난이도 높은 주차 환경 | DB에 없음 |
| 14 | 부산 파라다이스호텔 | 해운대 | 해운대 대표 헬주차장 | DB에 없음 |
| 15 | 대구 신매역 아레나빌딩 | 수성구 | 대구 동부 헬주차장 | DB에 없음 |

> **DB에 없는 주차장**: 대부분 소형 빌딩/오피스텔 주차장으로 공공데이터·카카오에 등록되지 않음.
> 향후 수동 등록 또는 Google Maps Places API 매칭으로 추가 필요.

## 3. 데이터 수집 파이프라인

### Phase A: 후보 리스트 확정 (1~2일)

```
1. DB 쿼리로 자동 후보 200개 추출
2. 수동 큐레이션 리스트 50개 작성 (Notion 유튜브 DB 활용)
3. 기존 DB에서 id 매칭 (이름+좌표)
4. DB에 없는 주차장은 수동 추가
5. 최종 100개 확정 → hell_parking_lots 테이블 또는 태그
```

### Phase B: Seed 리뷰 생성 (3~5일)

**방법 1: 기존 crawled_reviews에서 핵심 정보 추출**
- 이미 수집된 56,793건 블로그/카페 후기 중 해당 주차장 후기 활용
- Claude API로 후기에서 난이도 관련 핵심 정보 요약

**방법 2: 운영자 직접 리뷰 작성**
- 실제 방문 or Google 스트리트뷰 + 블로그 후기 종합하여 작성
- reviews 테이블에 `is_seed = 1` 플래그로 구분

**방법 3: YouTube 영상 링크 수집** (신규 스크립트)
- YouTube Data API v3로 헬 주차장별 관련 영상 검색
- 영상 URL + 썸네일을 DB에 저장 → 상세 패널에 노출

### Phase C: 콘텐츠 보강 (지속)

```
- Google Custom Search로 티스토리/다음카페 추가 수집
- YouTube 댓글에서 실제 경험담 수집
- 유저 리뷰가 쌓이면 Seed 리뷰와 자연스럽게 병합
```

## 4. 기술 구현 계획

### 4.1 DB 스키마 변경

```sql
-- 0008_hell_parking.sql

-- 주차장에 큐레이션 태그 추가
ALTER TABLE parking_lots ADD COLUMN is_curated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parking_lots ADD COLUMN curation_tag TEXT;  -- 'hell' | 'easy' | null
ALTER TABLE parking_lots ADD COLUMN curation_reason TEXT; -- "골뱅이 나선형", "넓은 평면" 등

-- Seed 리뷰 구분
ALTER TABLE reviews ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0;

-- YouTube/영상 링크 테이블
CREATE TABLE IF NOT EXISTS parking_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  media_type TEXT NOT NULL,         -- 'youtube' | 'image' | 'streetview'
  url TEXT NOT NULL,
  title TEXT,
  thumbnail_url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parking_media_lot ON parking_media(parking_lot_id);
```

### 4.2 신규 스크립트

| 스크립트 | 용도 | 입력 | 출력 |
|---------|------|------|------|
| `scripts/curate-hell-parking.ts` | 자동 후보 추출 + Notion 리스트 병합 | DB 쿼리 + 수동 리스트 JSON | curated 주차장 태깅 |
| `scripts/seed-reviews.ts` | 블로그 후기 기반 Seed 리뷰 생성 | crawled_reviews + Claude API | reviews 테이블 (is_seed=1) |
| `scripts/crawl-youtube.ts` | YouTube 영상/댓글 수집 | YouTube Data API v3 | parking_media + crawled_reviews |
| `scripts/crawl-google.ts` | Google Custom Search 수집 | Google CSE API | crawled_reviews |

### 4.3 프론트엔드 변경

```
1. 지도 마커: 큐레이션된 주차장에 🔥 또는 특별 마커 표시
2. 상세 패널: "운영자 리뷰" 뱃지, YouTube 영상 임베드 섹션
3. 필터: "헬 주차장만 보기" / "초보 추천만 보기" 토글
4. 홈/랜딩: "이번 주 가장 무서운 주차장 TOP 10" 같은 큐레이션 섹션
```

## 5. 실행 순서 (우선순위)

| 순서 | 작업 | 소요 | 의존성 |
|------|------|------|--------|
| **1** | DB 쿼리로 헬 후보 자동 추출 | 0.5일 | 없음 |
| **2** | 수동 큐레이션 리스트 작성 (Notion + 웹 조사) | 1일 | 없음 |
| **3** | `0008_hell_parking.sql` 마이그레이션 | 0.5일 | 없음 |
| **4** | `curate-hell-parking.ts` — 태깅 스크립트 | 0.5일 | #1, #2, #3 |
| **5** | `seed-reviews.ts` — Seed 리뷰 생성 | 1일 | #4 |
| **6** | `crawl-youtube.ts` — YouTube 영상 수집 | 1일 | #3 (API 키 필요) |
| **7** | 프론트: 큐레이션 마커 + 상세 패널 YouTube 섹션 | 1~2일 | #4, #6 |
| **8** | `crawl-google.ts` — Google CSE 수집 | 1일 | API 키 필요 |
| **9** | 프론트: "헬 주차장 TOP" 큐레이션 섹션 | 1일 | #7 |

**총 예상: 7~9일 (병렬 작업 시 5~6일)**

## 6. 성공 지표

| 지표 | 목표 |
|------|------|
| 큐레이션된 헬 주차장 수 | ≥ 50개 |
| 큐레이션된 초보추천 주차장 수 | ≥ 20개 |
| 주차장당 평균 Seed 리뷰 수 | ≥ 2개 |
| 주차장당 평균 YouTube 링크 | ≥ 1개 |
| 큐레이션 주차장 평균 블로그 후기 수 | ≥ 5개 |

## 7. 주의사항

- **부정확한 데이터는 없는 것보다 못함** (기획서 원칙) → Seed 리뷰는 실제 후기 기반으로만 생성, 추측/자동 점수 부여 금지
- Seed 리뷰는 반드시 `is_seed=1`로 구분 → 유저 리뷰가 충분히 쌓이면 가중치 조정 가능
- YouTube 영상 저작권 → 임베드(iframe)만 사용, 다운로드/캡처 금지
- `curation_tag`는 운영자만 설정 가능 → 유저가 조작 불가한 서버사이드 필드
