# /project — 중장기 플랜 기획 & GitHub 이슈 생성

사용자의 요청을 바탕으로 중장기 플랜을 기획하고, GitHub Project "쉬운주차 로드맵"에 이슈를 만드는 워크플로우.

## 워크플로우

### 1단계: 현황 파악
- `gh project item-list 6 --owner acee90 --format json`으로 현재 로드맵 확인
- 현재 마일스톤별 진행 상황 요약
- 사용자 요청과 관련된 기존 이슈 식별

### 2단계: 플랜 기획 (사용자와 대화)
- 사용자의 요청을 듣고, 코드베이스와 기존 로드맵 맥락에서 중장기 플랜 초안 작성
- 플랜을 **에픽(큰 목표)** → **이슈(실행 단위)** 로 분해
- 각 이슈에 대해 제안:
  - 제목 (한국어)
  - 목표 / 작업 내용 / 완료 기준
  - 의존관계 (Blocked by / Blocks)
  - 마일스톤 (M1~M4 중 해당)
  - Priority (P0~P3)
  - Labels: feature, data-pipeline, scoring, frontend, infra
  - Size: size/S (<1시간), size/M (1-3시간), size/L (3시간+)
- **사용자 확인을 받은 후** 다음 단계 진행

### 3단계: GitHub 이슈 생성
확인받은 이슈를 생성. 이슈 본문 포맷:

```markdown
## 목표
{한 줄 설명}

## 작업 내용
- [ ] {체크리스트}

## 완료 기준
- {완료 조건}

## 의존관계
- Blocked by: #{number} — {이유}
- Blocks: #{number} — {이유}
```

이슈 생성 명령:
```bash
gh issue create \
  --title "{제목}" \
  --body "$(cat <<'EOF'
{본문}
EOF
)" \
  --label "{label1},{label2}" \
  --milestone "{마일스톤 제목}"
```

### 4단계: GitHub Project에 등록
생성된 이슈를 로드맵 프로젝트에 추가하고 필드 설정:

```bash
# 이슈를 프로젝트에 추가
gh project item-add 6 --owner acee90 --url {issue_url}

# Status, Priority 필드 설정
gh project item-edit --project-id PVT_kwHOBItEOc4BR-ZT --id {item_id} \
  --field-id PVTSSF_lAHOBItEOc4BR-ZTzg_pOAI --single-select-option-id {status_option_id}
```

## 참조 정보

**Repository:** acee90/easy-parking-zone
**Project:** #6 "쉬운주차 로드맵" (PVT_kwHOBItEOc4BR-ZT)

**마일스톤:**
- M1: 신뢰도 & 커버리지 (믿을 수 있는 데이터)
- M2: 킬러 콘텐츠 UX (30초 만에 느끼는 가치)
- M3: 인터랙션 강화 (함께 만드는 주차 지도)
- M4: 최적화 & 확장 (데이터 퀄리티 & 성장)

**Priority:** P0: critical, P1: important, P2: normal, P3: later
**Labels:** feature, data-pipeline, scoring, frontend, infra, bug, size/S, size/M, size/L

**필드 ID:**
- Status: PVTSSF_lAHOBItEOc4BR-ZTzg_pOAI
- Priority: PVTSSF_lAHOBItEOc4BR-ZTzg_pQp8

## 주의사항
- 이슈 생성 전 반드시 사용자 확인
- 의존관계는 기존 이슈 번호 참조
- 한국어로 작성
- Sub-issue가 필요하면 Parent issue 연결
- $ARGUMENTS 가 있으면 해당 주제로 바로 플래닝 시작
