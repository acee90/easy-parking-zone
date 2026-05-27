---
description: "YouTube 영상 매칭 검증 — ws_raw에 적재된 youtube_video를 subagent로 lot 매칭 검증 후 web_sources + parking_media 노출"
---

# verify-youtube

YouTube 크롤러는 lot 키워드로 검색해서 ws_raw에 적재만 한다. 검색 결과의 70~80%는 무관 콘텐츠(엘리베이터 동호인, 식당 후기, 부동산 광고 등). 이 명령어가 subagent로 검증해서 통과한 영상만 `web_sources` + `parking_media`에 노출시킨다.

## 흐름

```
Stage 1: extract — ws_raw에서 미검증 youtube_video 추출 → youtube-verify-input-{NN}.json
Stage 2: verify  — youtube-video-verifier subagent 호출 (sliding window 7-in-flight)
                   → youtube-verify-input-{NN}-verified.json
Stage 3: apply   — 결과 → SQL UPDATE/INSERT → D1 적용
```

## Stage 1 — extract

```bash
bun run scripts/extract-youtube-for-verify.ts --remote --limit=200 --shards=5
```

옵션:
- `--limit=N` 처리 건수 (기본 200)
- `--shards=N` 청크 분할 수 (기본 1)

출력: `data/youtube-verify/youtube-verify-input-{01..NN}.json`

## Stage 2 — verify (subagent sliding window)

`.claude/agents/youtube-video-verifier.md` (haiku) 사용. **반드시 `youtube-video-verifier` 에이전트를 사용한다.** `general-purpose`/`filter-v2-evaluator`로 대체 금지.

**sliding window 7-in-flight** 패턴으로 spawn (한 번에 최대 7개 동시, 완료되면 다음 청크). wave-batch 말고 sliding window.

청크 1개일 때:
```
Agent(subagent_type="youtube-video-verifier"): data/youtube-verify/youtube-verify-input.json 읽고 각 영상이 hint_lot 매칭인지 판정 → data/youtube-verify/youtube-verify-input-verified.json 생성
```

청크가 여러 개일 때 (sliding window — 동시 7개 유지, 완료되는 대로 다음 spawn):
```
Agent(subagent_type="youtube-video-verifier"): data/youtube-verify/youtube-verify-input-01.json → youtube-verify-input-01-verified.json
Agent(subagent_type="youtube-video-verifier"): data/youtube-verify/youtube-verify-input-02.json → youtube-verify-input-02-verified.json
...
```

각 agent 출력 JSON 형식:
```json
{
  "results": [
    { "raw_id": 123, "filter_passed": true,  "removed_by": null,             "reason": "..." },
    { "raw_id": 124, "filter_passed": false, "removed_by": "wrong_location", "reason": "..." }
  ],
  "stats": { "total": 30, "passed": 8, "removed_breakdown": {...} }
}
```

통과율 정상 범위: **15~50%**. 범위 밖이면 agent 정의 재검토.

## Stage 3 — apply

```bash
bun run scripts/apply-youtube-verify.ts --remote --input-dir=data/youtube-verify --apply
```

처리:
- `filter_passed=true` → `web_sources` INSERT + `parking_media` INSERT (thumbnail은 videoId에서 동적) + `ws_raw` matched_at 갱신
- `filter_passed=false` → `ws_raw` filter_passed=0, filter_removed_by 기록

## 기존 데이터 backfill (1회성)

기존 `parking_media` youtube 873개는 검증 없이 직행한 부정확 매칭 → ws_raw로 옮겨서 동일 검증 흐름 진입.

```bash
# 1. 미리보기
bun run scripts/backfill-youtube-media.ts --remote --dry-run

# 2. 실제 backfill (parking_media 873개 → ws_raw 이동 + 기존 행 삭제)
bun run scripts/backfill-youtube-media.ts --remote --apply

# 3. 이후 위 Stage 1~3 흐름 그대로 실행 → 검증 통과한 것만 parking_media 재진입
```

## 상태 확인

```bash
# ws_raw youtube_video 단계별 분포
bunx wrangler d1 execute parking-db --remote --command \
  "SELECT filter_passed, COUNT(*) FROM web_sources_raw WHERE source='youtube_video' GROUP BY filter_passed"

# parking_media youtube 현재 카운트
bunx wrangler d1 execute parking-db --remote --command \
  "SELECT COUNT(*) FROM parking_media WHERE media_type='youtube'"

# web_sources youtube_video 현재 카운트
bunx wrangler d1 execute parking-db --remote --command \
  "SELECT COUNT(*) FROM web_sources WHERE source='youtube_video'"
```

## 정기 실행

cron이 매시간 새 영상을 ws_raw에 적재한다. 적당한 주기로 (예: 일 1회 또는 주 1회) 이 명령어를 실행해서 검증 + 노출.
