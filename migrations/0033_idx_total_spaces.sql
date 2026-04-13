-- 넓은 주차장 TOP 쿼리 성능 개선
CREATE INDEX IF NOT EXISTS idx_parking_lots_total_spaces ON parking_lots(total_spaces DESC);
