# 기본정보 유저 제보 (lot_field_edits)

주차장 상세페이지 상단의 **주차 요금 / 운영 시간 / 주차면**을 유저가 고쳐 쓴다.
나무위키식으로 비어 있는 칸은 바로 채워지고, 관리자가 확인(pick)하면 잠긴다.

## 왜 `parking_lots` 를 직접 안 고치나

세 동기화 스크립트가 전부 `ON CONFLICT(id) DO UPDATE SET <모든 컬럼> = excluded.*` 다:

| 스크립트 | 덮는 컬럼 |
|---|---|
| [`sync-public-data.ts:256`](../../scripts/sync-public-data.ts) | 요금 6개 · 면수 · 운영시간 6개 전부 |
| [`sync-modu.ts:227`](../../scripts/sync-modu.ts) | `total_spaces` `is_free` `base_time` `base_fee` |
| [`sync-hiparking.ts:99`](../../scripts/sync-hiparking.ts) | 위 + `phone` `payment_methods` `notes` |

유저 값을 `parking_lots` 에 쓰면 다음 동기화에서 조용히 날아간다. 그래서 제보는
별도 테이블에 살고, **읽을 때** 원본 위에 얹는다.

## 상태 머신 (필드 그룹 단위)

그룹은 `fee` · `hours` · `spaces` 셋. 컬럼 하나가 아니라 묶음이다 — `is_free` 와
`base_fee` 를 따로 받으면 "무료인데 시간당 2,000원" 같은 모순이 만들어진다.

| 지금 상태 | 유저가 제출하면 | 화면 |
|---|---|---|
| 원본이 비어 있고 제보 없음 | **즉시 반영** (`applied`) | `유저제보` 배지 |
| `applied` | **즉시 덮어씀**, 기존 행 `superseded` | `유저제보` 배지 |
| `verified` (관리자 pick) | **승인 큐** (`pending`) | 배지 없음 |
| 원본에 값이 있고 제보 없음 | **승인 큐** (`pending`) | 배지 없음 |

**A안**을 고른 이유: 원본 값 대부분은 공공데이터·운영사에서 오고 sync 가 주기적으로
다시 덮는다. 즉시 반영을 허용해도 다음 동기화에서 되돌아가 유저가 "고쳐도 안 바뀐다"를
겪는다. 실제 결손은 전부 비어 있는 쪽에 있다(요금 19% · 운영시간 20% · 면수 41%).

판정은 [`src/lib/lot-field-transitions.ts`](../../src/lib/lot-field-transitions.ts) 의
`resolveTransition` 하나뿐이다. 순수 함수라 테스트가 상태표를 그대로 따라간다.

## 「비어 있음」은 화면과 서버가 같은 규칙을 쓴다

`isFieldGroupEmpty`([`lot-field-groups.ts`](../../src/lib/lot-field-groups.ts))를
히어로 KPI 와 서버가 함께 쓴다. 둘이 어긋나면 유저가 「정보 없음」 칸을 눌러 채웠는데
"관리자 확인 후 반영됩니다" 가 뜬다. `LotHeroSection.test.tsx` 에 두 판정이 일치하는지
확인하는 테스트가 있다.

| 그룹 | 비어 있음 |
|---|---|
| `fee` | 유료인데 1시간 예상도 1일 최대도 못 구할 때 (무료는 아는 값) |
| `hours` | 평일·토·공휴일이 **모두** 미상 |
| `spaces` | `total_spaces <= 0` |

## 검색엔진에는 확인된 값만 나간다

`stripUnverifiedEdits` 가 `source === 'user'` 인 그룹을 되돌린 뒤 JSON-LD 와
색인 판정(`shouldIndexParkingDetail`)에 넘긴다. 화면은 「유저제보」 배지로 근거를
밝히고 보여주지만 그 표시가 구글까지 따라가지는 않는다 — 같은 값이 검색 결과에서는
확정 사실로 읽힌다. `verified` 는 그대로 나간다.

## 어뷰징 방어

- `RATE_LIMITER_EDIT` — IP 기준 5회/60초
- 같은 IP 가 같은 (주차장, 그룹)을 10분 안에 다시 제보하면 거절 (`SAME_IP_COOLDOWN_SQL`). 비교는 SQL 안에서 한다 —
  `created_at` 은 `2026-09-10 00:54:12` 라 JS 의 ISO 문자열과 직접 비교하면 항상 거짓이 된다
- 부분 유니크 인덱스 `uq_lot_field_edits_active` 가 그룹당 활성 행을 하나로 강제한다.
  동시 제출이 겹치면 두 번째 INSERT 가 막히고, 서버가 한 번만 다시 읽어 재시도한다
- 모든 제보가 행으로 남는다 — 관리자 반려로 언제든 되돌릴 수 있다

비로그인도 받는다. 결손이 2만 건대라 로그인 벽을 세우면 채워질 일이 없다.
로그인 상태면 `author_user_id` 가 남는다.

## 어디까지 병합되나

병합은 `fetchParkingDetail` 안에서만 일어난다. 그 함수를 쓰는 곳은 셋이다:

| 호출부 | 배지 |
|---|---|
| `wiki/$slug.tsx` (상세페이지) | 칸마다 `유저제보` |
| `wiki/$slug.reviews.tsx` | — (기본정보를 그리지 않는다) |
| `routes/index.tsx` → `ParkingDetailPanel` (지도 시트) | 「일부 정보는 유저 제보입니다」 한 줄 |

지도 시트는 칸마다 배지를 달 자리가 없어 블록 아래 한 줄로 밝힌다. 고치는 건
상세페이지에서만 할 수 있다.

**목록 카드(`fetchParkingLots`)와 지도 마커는 병합하지 않는다** — 원본 그대로다.
같은 주차장이 목록과 상세에서 다르게 보일 수 있다.

## 범위 밖 / 알려진 한계

- `parking_lot_stats` 점수 재계산에 제보값을 넣지 않는다
- `seo-indexing.ts` 의 `hasKnownTime` 은 여전히 자체 시간 판정을 쓴다 (색인 게이트 이슈에서 함께)
- **제보가 나중 sync 를 이긴다.** `applied`·`verified` 가 서 있는 그룹은, 이후 동기화가
  원본을 채우거나 고쳐도 계속 제보값을 보여준다. `verified` 는 특히 조용히 낡을 수 있다.
  원본이 바뀐 제보를 관리자에게 다시 띄우는 장치는 아직 없다

## 서버 모듈 경계 (빌드가 깨지는 자리)

`@/db` 와 `@/lib/auth` 는 `cloudflare:workers` 를 import 한다. 이 둘을 쓰는 함수를
**server fn 이 아닌 형태로 export 하면** 그 모듈을 import 하는 라우트를 통해
클라이언트 번들로 끌려 들어가 dev 서버가 500 을 뱉는다.

- `submitFieldEdit` 같은 server fn 만 있는 모듈 → 클라이언트에서 import 해도 안전
- `mergeFieldEdits` 는 server fn 이 아니라서 [`field-edits-merge.ts`](../../src/server/field-edits-merge.ts) 로 분리했다
- `requireAdmin` 은 모듈마다 복사본을 둔다 (`admin-reports.ts` 가 같은 이유로 그렇다)
