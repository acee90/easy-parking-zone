# 클러스터링 설계 명세

> 관련 이슈: #33, #63
> 최종 업데이트: 2026-03-31

## 1. 문제 정의

기존 서버 SQL 고정 그리드 클러스터링(`GROUP BY CAST(lat/cellSize)`)의 한계:

- 마커 간 **거리를 고려하지 않음** — 같은 셀이면 멀리 떨어져도 하나로 합침
- **빈 중심 문제** — AVG 좌표가 마커가 없는 빈 공간에 위치
- 네이버/Google Maps는 모두 거리/반경 기반 클러스터링 사용

## 2. 알고리즘 선택: SuperCluster

| 검토 방식 | 채택 여부 | 사유 |
|-----------|----------|------|
| 서버 SQL 그리드 | **폐기** | 거리 미고려, 빈 중심 문제 |
| 뷰포트 내 SuperCluster | **기각** | load() 매번 재호출로 캐싱 이점 0, 경계 깨짐 |
| 조각 로드 (incremental) | **기각** | load()가 전체 교체라 재구축 필요, 복잡도만 증가 |
| 네이버 MarkerClustering | **기각** | 10K+ 성능 저하, idle마다 전체 재계산 |
| **전체 경량 로드 + SuperCluster** | **채택** | 1회 로드 ~400KB, 이후 서버 호출 제로, 경계 문제 없음 |

### SuperCluster 특성
- Mapbox `supercluster` (KD-tree 기반)
- `load()` 1회로 전 줌 레벨 사전 계산 (34K건 ~100ms)
- `getClusters()` 조회 <5ms, 서버 호출 없음
- `getClusterExpansionZoom()` — 클러스터가 실제 분할되는 최소 줌 반환

## 3. 데이터 흐름

```
초기 로드:  fetchAllParkingPoints() → 34K {id, lat, lng, score, name}
           → CDN 캐시 1시간
           → SuperCluster.load() (1회)

줌/팬:     getClusters(bounds, zoom) → <5ms, 서버 호출 없음
           → 클러스터 or 개별 포인트 렌더링

상세 데이터: fetchParkingLots(bounds) → 뷰포트 내 상세 (기존 API 유지)
           → 사이드바, 상세패널, 개별 마커 hover/click용

필터 변경:  filteredPoints 재계산 → SuperCluster.load() 재호출 (이때만)
```

## 4. 클러스터 파라미터

| 파라미터 | 값 | 근거 |
|---------|-----|------|
| `radius` | 200px | 화면당 ~20개 이하 클러스터 목표 (Google 기본 60, 조정됨) |
| `maxZoom` | 15 | zoom 16+에서 개별 마커만 표시 |
| `minZoom` | 0 | 전 줌 범위 |
| `minPoints` | 2 | 1개짜리는 개별 마커로 표시 (기본값) |

### 줌별 기대 동작
- **줌 7~10**: 전국/광역 — 큰 클러스터 (수백~수천개 뭉침)
- **줌 11~13**: 시/구 — 중간 클러스터 (수십개)
- **줌 14~15**: 동/블록 — 소규모 클러스터 + 개별 마커 혼재
- **줌 16+**: 클러스터링 없음, 모든 마커 개별 표시

## 5. 클러스터 클릭 동작

```
클릭 → getClusterExpansionZoom(cluster_id)
     → morph(cluster좌표, expansionZoom)  // Naver Maps morph 애니메이션
```

- `fitBounds` 사용 안 함 — Naver Maps에서 애니메이션 미지원
- `getExpansionZoom`이 클러스터가 실제 분할되는 줌을 반환하므로 정확한 줌 이동

## 6. 클러스터 비주얼: 도넛 링

### 3구간 비율 기반 conic-gradient

```
┌──────────────┐
│  🟢 초록     │  score >= 3.5 (쉬운 주차장)
│  ⚪ 회색     │  나머지 (보통)
│  🔴 빨강     │  score < 2.5 (어려운 주차장)
└──────────────┘
```

- 외곽 링: `conic-gradient`로 easy/normal/hard 비율 표시
- 내부 원: 평균 점수 기반 색상 (`markerColor(avgScore)`)
- 링 두께: 4px (ringSize = innerSize + 8)
- easy/hard 모두 0이면 링 없이 단순 원 + 흰색 테두리

### 크기 스케일링

```
innerSize = 32 + sqrt(count/300) × (160 - 32)
```

- 최소 32px, 최대 160px
- sqrt 스케일로 소규모 클러스터 구분 유지

### 집계 (SuperCluster map/reduce)

```typescript
map: (props) => ({
  sum_score, count_score,  // 평균 점수 계산용
  easy,                    // score >= 3.5 카운트
  hard,                    // score < 2.5 카운트
})
reduce: (acc, props) => { /* 합산 */ }
```

## 7. 필터 연동

### 클러스터에 반영되는 필터 (클라이언트)
- **난이도 필터** — 경량 포인트의 score로 판별 가능
  - 필터 OFF된 난이도 구간의 포인트를 제외 → SuperCluster.load() 재호출

### 서버에서만 처리되는 필터
- 무료만 (`freeOnly`) — 요금 데이터 필요
- 공영만 (`publicOnly`) — 타입 데이터 필요
- 노상 제외 (`excludeNoSang`) — 타입 데이터 필요

> 이 필터들은 사이드바/상세 마커에만 적용. 클러스터에는 미반영.
> 추후 경량 데이터에 type/isFree 필드 추가로 해결 가능.

## 8. 개별 마커 (zoom 15+)

SuperCluster가 `maxZoom(14)` 이상에서 개별 포인트를 반환.

- **상세 데이터 있음** (`parkingLots`에서 매칭): 기존 pill 마커 (이름 + 색상)
- **상세 데이터 미로드**: 경량 마커 (이름 + score 기반 색상, hover/click 미지원)

## 9. 성능 목표

| 항목 | 목표 |
|------|------|
| 초기 경량 데이터 전송 | < 500KB (gzip) |
| SuperCluster.load(34K) | < 300ms |
| getClusters() 조회 | < 5ms |
| 줌/팬 시 서버 호출 | 0회 (클러스터링) |
| 필터 변경 시 load() | < 300ms |

## 10. 참고: 네이버/Google 동작 분석

### 네이버 지도 (Web API v3)
- Grid 기반이지만 **픽셀 거리**로 판정 (고정 격자 아님)
- `maxZoom` 초과 시 즉시 전환, 점진적 분할 없음
- 클릭: `morph()` 줌+1
- 분할/병합 애니메이션 없음

### Google Maps (@googlemaps/markerclusterer)
- **SuperCluster** 기본 (KD-tree, 반경 60px)
- 정수 줌 단위 전환 (`Math.round(zoom)`)
- 클릭: `fitBounds(cluster.bounds)` 또는 `getClusterExpansionZoom()`
- count=1은 원본 마커 그대로 표시
- 분할/병합 애니메이션 없음 (깜빡임 방지만)

### 공통 결론
- Web API에서는 네이버/Google 모두 분할/병합 애니메이션 미제공
- 모바일 SDK에서만 `animate(true)` 가능
- Spiderfy 기본 미제공 (별도 라이브러리)

## 11. UI 배치

### 필터 위치 (데스크톱)
- 사이드바(280px) 오른쪽에 배치: `left: 296px`
- 상세패널(360px) 열리면 이동: `left: 660px`
- `transition-[left] duration-200`으로 부드러운 이동

### 필터 위치 (모바일)
- `absolute top-3 left-3 z-20`
