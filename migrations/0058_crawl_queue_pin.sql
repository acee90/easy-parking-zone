-- 크롤 우선순위 수동 고정 (A-2).
--
-- 목적: GA4 트래픽이 있는데 근거가 없는 주차장을 큐 맨 앞으로 끌어올린다.
--   syncQueue 는 하루 1회 priority 를 reliability 로 다시 계산하므로,
--   그냥 priority 만 바꿔두면 다음 날 되돌아간다. 고정 표시가 필요하다.
--
-- 왜 `priority_override` 컬럼 + `ORDER BY COALESCE(override, priority)` 가 아닌가:
--   그 정렬은 idx_crawl_queue_pick(crawler, priority, next_at) 를 못 탄다.
--   선정이 다시 전체 스캔(크롤러당 54,130행)이 되어 0052 가 없앤 비용이 그대로 돌아온다.
--   그래서 **정렬 키는 priority 하나로 유지**하고, 고정 여부만 따로 기록한다.
--   고정된 행은 syncQueue 의 UPDATE 대상에서 빠진다 (crawl-queue.ts).
--
-- pinned_at 이 NULL 이 아니면 사람이 의도적으로 정한 priority 라는 뜻이다.
-- 고정을 풀려면 pinned_at 을 NULL 로 되돌리면 다음 sync 가 알아서 재계산한다.

ALTER TABLE crawl_queue ADD COLUMN pinned_at TEXT;
