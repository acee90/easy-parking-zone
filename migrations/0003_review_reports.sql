-- 리뷰 요약 오류 신고 테이블
CREATE TABLE IF NOT EXISTS review_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  parking_lot_id TEXT NOT NULL,
  reason TEXT NOT NULL,           -- 'wrong_sentiment' | 'irrelevant' | 'other'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_reports_lot
  ON review_reports(parking_lot_id);
