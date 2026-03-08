-- Workers Cron 크롤러 진행 상태 관리 테이블
-- JSON 파일 기반 progress 대체 (서버리스 환경용)
CREATE TABLE IF NOT EXISTS crawl_progress (
  crawler_id TEXT PRIMARY KEY,        -- 'naver_blogs' | 'youtube'
  last_parking_lot_id TEXT,           -- 마지막 처리한 주차장 ID (커서)
  completed_count INTEGER DEFAULT 0,
  total_target INTEGER DEFAULT 0,
  last_run_at TEXT,                   -- ISO datetime
  metadata TEXT                       -- JSON (크롤러별 추가 정보)
);
