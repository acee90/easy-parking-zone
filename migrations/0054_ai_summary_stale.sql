-- 주차장 종합 요약(parking_lot_stats.ai_summary) 재생성 대기 표시
--
-- 왜 큐에서 바로 만들지 않는가:
--   요약 생성은 AI 호출이라 건당 수 초 걸린다. score-recompute-queue 는 max_batch_size 25 라
--   소비자에서 직접 만들면 한 배치가 수십 초로 늘어난다. 지금 소비자는 D1 계산만 해서 빠르다.
--   그래서 큐는 "다시 만들어야 한다"는 표시만 남기고, 실제 생성은 크론이 회당 상한을 걸어 처리한다.
ALTER TABLE parking_lot_stats ADD COLUMN ai_summary_stale INTEGER NOT NULL DEFAULT 0;

-- 크론이 "대기 중인 것 N곳"만 집어가므로 부분 인덱스로 충분하다.
-- 전체 31,939행을 스캔하지 않는다 (D1 무료 티어 rows_read 절감).
CREATE INDEX IF NOT EXISTS idx_lot_stats_summary_stale
  ON parking_lot_stats(ai_summary_stale) WHERE ai_summary_stale = 1;
