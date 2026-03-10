-- 주차장 통합 난이도 점수 사전 계산 테이블
CREATE TABLE IF NOT EXISTS parking_lot_stats (
  parking_lot_id TEXT PRIMARY KEY REFERENCES parking_lots(id),
  -- 구조 사전 점수
  structural_prior REAL,
  -- 소스별 점수
  user_review_score REAL,
  user_review_count INTEGER DEFAULT 0,
  community_score REAL,
  community_count INTEGER DEFAULT 0,
  text_sentiment_score REAL,
  text_source_count INTEGER DEFAULT 0,
  -- 통합 결과
  n_effective REAL DEFAULT 0,
  final_score REAL,
  reliability TEXT,
  computed_at TEXT DEFAULT (datetime('now'))
);
