# AI-generated Content Rollout and Measurement Plan

## 목적

자체 콘텐츠 확대는 한 번에 대량 생성하지 않고, 품질과 SEO/UX 선행 지표를 확인하면서 단계적으로 진행한다. 이 문서는 각 단계의 시작 조건, 확대 조건, 중단 기준, 관찰 지표, 리포트 형식을 정의하는 상시 운영 계획이다.

## 선행 조건

- [AI Content QA Standard](./ai-content-qa-standard.md) 문서가 준비되어 있다.
- 생성 결과를 `PASS`, `FIX`, `REGEN`, `DROP`으로 검수할 수 있다.
- 공식 데이터와 충돌하는 콘텐츠를 숨기거나 재생성할 운영 경로가 있다.
- 생성 대상 선정 기준이 준비되어 있거나, 최소한 상위 후보군을 추출할 수 있다.

## 단계별 롤아웃 전략

| 단계 | 규모 | 목적 | 완료 기준 |
|---|---:|---|---|
| Pilot | 50개 | 프롬프트/검수/저장/SSR 노출 품질 확인 | QA 게이트 통과 |
| Batch 1 | 300개 | 상위 후보군에서 품질과 검색 노출 선행 지표 확인 | 2주 관찰 후 유지/확대 판단 |
| Batch 2 | 1,000개 | 주요 검색 후보군 커버리지 확대 | 4주 관찰 후 다음 확장 여부 판단 |
| Scale-up | 10k+ | 전체 서비스 대상 스케일업 | 상시 품질 지표 유지 |

## 품질 게이트 (확대 조건)

각 단계에서 다음 조건을 만족해야 다음 단계로 진행한다.

- `PASS + FIX` 비율 80% 이상
- 공식 데이터 충돌률 5% 이하
- `DROP` 비율 20% 이하
- 동일/유사 템플릿 반복 10건 미만 (Batch 단위)
- 상세 페이지 SSR에서 요약/팁 누락 또는 레이아웃 깨짐 없음

## 중단 및 보류 기준

아래 중 하나라도 발생하면 다음 단계 확대를 중단하고 원인을 진단한다.

- 공식 데이터 충돌률이 5% 초과
- 다른 장소/주차장 오매칭이 반복 발견
- Search Console 제외 사유가 배포군에서 급증
- 사용자 신고 또는 내부 QA에서 요금/무료 여부 오류가 반복 발견
- 생성 콘텐츠가 UI에서 깨지거나 핵심 정보를 가림
- 수동 수정 비용이 신규 생성 속도를 지속적으로 초과

## Search Console 관찰 지표

주요 지표:

- 색인된 wiki URL 수
- `크롤링됨 - 현재 색인이 생성되지 않음` URL 수
- `발견됨 - 현재 색인이 생성되지 않음` URL 수
- 배포군 URL의 impressions / clicks / average position
- sitemap 제출/읽기 상태

판단 방식:

- 초기 단계에서는 색인 수보다 크롤링/제외 사유 변화를 본다.
- Batch 1(300개) 단계부터 impressions 증가 여부를 본다.
- 대량 배포 단계에서는 clicks보다 impressions와 색인 커버리지 추세를 우선한다.
- 2주 미만 데이터로 SEO 성패를 단정하지 않는다.

## Engagement 관찰 지표

상세 페이지 기준:

- 평균 참여 시간
- 2페이지 이상 탐색 비율
- 상세 페이지 이탈률
- 지도/길찾기/공유/전화 등 주요 액션 클릭률
- 콘텐츠 신고 또는 오류 피드백 수

비교 방식:

- 배포군과 미배포 유사군을 비교한다.
- 배포 전/후 동일 기간(최소 14일)을 비교한다.
- 계절/요일 편차가 큰 주차장은 같은 요일 기준으로 비교한다.

## 리포트 형식

각 단계 종료 시 아래 형식으로 기록한다.

| 항목 | 값 |
|---|---|
| rollout_stage | pilot / batch_300 / batch_1000 / scale_up |
| generated_count | 생성 수 |
| published_count | 노출 수 |
| hidden_count | 미노출 수 |
| qa_sample_size | 검수 샘플 수 |
| pass_rate | `PASS + FIX` 비율 |
| conflict_rate | 공식 데이터 충돌률 |
| drop_rate | `DROP` 비율 |
| gsc_observation_window | 관찰 기간 |
| indexed_delta | 색인 URL 변화 |
| impressions_delta | 노출 변화 |
| engagement_delta | 참여 지표 변화 |
| decision | expand / hold / rollback / revise |
| notes | 주요 이슈와 후속 조치 |

## 의사결정 기준

`expand`:
- QA 게이트 통과 및 치명적 데이터 충돌 없음
- Search Console 및 engagement 지표에 악화 신호 없음

`hold`:
- 품질은 양호하나 SEO 반영 확인을 위한 추가 관찰 필요
- 특정 유형에서만 오류 발생 시 대상 선정 기준 조정 후 재검토

`revise`:
- 프롬프트, 대상 선정, 검증 로직 수정이 필요한 품질 이슈 발견 시

`rollback`:
- 공식 데이터 충돌 또는 오매칭으로 인한 사용자 신뢰 저하 위험 시
