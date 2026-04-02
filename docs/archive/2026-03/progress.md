# 쉬운주차 - 진행 현황 및 TODO

> 최종 업데이트: 2026-03-07

## 완료된 작업

### 10시10분 채널 데이터 수집 파이프라인
- [x] `collect-1010-channel.ts` — 채널 영상 500개 수집 + Claude Haiku로 주차장 192개 파싱
- [x] DB 매칭 10개 (수동 검증 완료) → hell-parking-list.json 추가
- [x] `register-1010-unmatched.ts` — 네이버 지역검색 geocoding + 3중 검증
  - 30개 매칭 성공 (high 23 + medium 7) → DB 등록 + hell-parking-list.json 추가
  - 68개 매칭 실패 → `scripts/1010-still-unmatched.json`에 저장
- [x] `curate-hell` 실행 — 99개 태깅 (hell 83 + easy 16)
- [x] `seed-reviews` 실행 — 18건 생성, 47건 스킵(블로그 후기 없음)
- [x] 리모트 D1 마이그레이션 적용 (`migrations/0009_1010_channel_data.sql`)

### 인프라 개선
- [x] `scripts/lib/d1.ts` 공통 유틸리티 추출
  - 모든 스크립트에서 `--remote` 플래그로 리모트 DB 직접 실행 가능
  - 더 이상 수동 마이그레이션 SQL 생성 불필요

### 기존 완료
- [x] 소셜 로그인 (카카오/네이버/구글) + 리뷰 시스템
- [x] 네이버 블로그/카페 크롤링 (56K+ 리뷰)
- [x] YouTube 크롤링 (기존 69개 큐레이션 주차장)
- [x] 투표/북마크 시스템
- [x] 플로팅 필터 UI
- [x] 지도 마커 큐레이션 뱃지
- [x] SEO/OG/메타태그/GA4
- [x] 에러 바운더리

---

## 진행 중

### YouTube 크롤링 (신규 30개 중 3개 남음)
- `crawl-youtube` 실행 시 27/30에서 YouTube API 일일 쿼터 초과로 중단
- 쿼터 리셋: 태평양시간 자정 (한국시간 오후 4~5시)
- `youtube-progress.json`에 진행상황 저장되어 있어 재실행 시 나머지 3개만 처리
```bash
bun run crawl-youtube          # 로컬
bun run crawl-youtube --remote  # 리모트
```

---

## 해야 할 작업

### 1. 미매칭 주차장 68개 처리 (`scripts/1010-still-unmatched.json`)
네이버 지역검색으로 매칭 실패한 68개. 대부분 소규모 빌딩/상가 부설주차장.

**선택지:**
- **A) 수동 등록** — 네이버/카카오 지도에서 직접 좌표 확인 후 DB INSERT
- **B) 검색어 변형** — 빌딩명만으로 재검색 (주차장 키워드 제거), 카카오 API 병행
- **C) 보류** — 현재 99개로 충분하면 Phase 2에서 처리

주요 미매칭 주차장:
| 지역 | 주차장 | 비고 |
|------|--------|------|
| 서울 강남 | 역삼 이마트, 큰길타워, 삼흥오피스텔, 선릉 샹제리센터 | 강남 소규모 빌딩 |
| 서울 을지로 | 패스트파이브, 삼화타워 | 을지로 3대장 |
| 서울 명동 | 밀리오레 호텔, 서울중앙우체국, 보림빌딩 | |
| 서울 여의도 | 한국거래소, BNK 금융센터, 파크센터, 루나미엘레 | |
| 경기 | 의정부 성해프라자, 일산 화이트스톤, 시흥 홍익프라자 | |
| 지방 | 창원 교보문고 마이우스, 광주 해광샹그릴라/세종요양병원/KDB | |

### 2. 시드 리뷰 보강 (블로그 후기 없는 큐레이션 주차장)
- 현재 52건 생성 (기존 34 + 신규 18)
- 약 47개 주차장은 블로그 후기가 없어 시드 리뷰 생성 불가
- **방안:** YouTube 댓글 기반으로 시드 리뷰 생성 로직 추가

### 3. 헬 주차장 TOP 큐레이션 랜딩 섹션 (#9)
- 기획서에 있는 기능 — 메인 페이지에 헬 주차장 TOP 리스트 노출
- 큐레이션 데이터(99개) 기반으로 구현 가능

### 4. Phase 2 크롤링 (보류)
- 네이버 플레이스 / 카카오맵 리뷰 스크래핑
- ToS 위반 리스크 있어 Phase 1 결과 평가 후 판단

### 5. scripts 디렉토리 정리
- 캐시 파일들 (.gitignore에 추가 완료):
  - `1010-videos.json`, `1010-parking-result.json`, `1010-still-unmatched.json`
- progress 파일들 정리 검토:
  - `youtube-progress.json`, `naver-progress.json`, `seed-review-progress.json` 등

---

## 데이터 현황 요약

| 항목 | 수량 |
|------|------|
| DB 주차장 수 | ~36,250개 |
| 큐레이션 주차장 | 99개 (hell 83 + easy 16) |
| 시드 리뷰 | 52건 |
| 네이버 블로그/카페 리뷰 | 56K+ |
| YouTube 미디어 | ~385개 |
| YouTube 댓글 | ~450개 |
| 미매칭 (10시10분) | 68개 (수동 처리 필요) |

## 스크립트 실행 가이드

```bash
# 기본 파이프라인 (로컬)
bun run curate-hell        # 큐레이션 태깅
bun run crawl-youtube      # YouTube 영상/댓글 수집
bun run seed-reviews       # AI 시드 리뷰 생성

# 리모트 DB 직접 실행
bun run curate-hell --remote
bun run crawl-youtube --remote
bun run seed-reviews --remote

# 10시10분 채널 수집 (일회성)
bun run scripts/collect-1010-channel.ts --parse-only --dry-run
bun run scripts/register-1010-unmatched.ts --dry-run
```
