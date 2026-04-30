-- user_reviews 점수 컬럼 INTEGER → REAL 변환 (0.5점 단위 입력 지원)
-- SQLite는 ALTER COLUMN을 지원하지 않으므로 새 테이블 생성 → 데이터 복사 → 교체 패턴

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE user_reviews_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  user_id TEXT,
  guest_nickname TEXT,
  ip_hash TEXT,
  entry_score REAL NOT NULL CHECK(entry_score BETWEEN 0.5 AND 5),
  space_score REAL NOT NULL CHECK(space_score BETWEEN 0.5 AND 5),
  passage_score REAL NOT NULL CHECK(passage_score BETWEEN 0.5 AND 5),
  exit_score REAL NOT NULL CHECK(exit_score BETWEEN 0.5 AND 5),
  overall_score REAL NOT NULL CHECK(overall_score BETWEEN 0.5 AND 5),
  comment TEXT,
  visited_at TEXT,
  is_seed INTEGER NOT NULL DEFAULT 0,
  source_type TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO user_reviews_new (
  id, parking_lot_id, user_id, guest_nickname, ip_hash,
  entry_score, space_score, passage_score, exit_score, overall_score,
  comment, visited_at, is_seed, source_type, source_url, created_at
)
SELECT
  id, parking_lot_id, user_id, guest_nickname, ip_hash,
  entry_score, space_score, passage_score, exit_score, overall_score,
  comment, visited_at, is_seed, source_type, source_url, created_at
FROM user_reviews;

DROP TABLE user_reviews;
ALTER TABLE user_reviews_new RENAME TO user_reviews;

-- 인덱스 재생성 (구 reviews 테이블에서 RENAME된 인덱스 포함)
CREATE INDEX IF NOT EXISTS idx_reviews_parking_lot_id ON user_reviews(parking_lot_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON user_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_source_created ON user_reviews(source_type, created_at DESC);

COMMIT;

PRAGMA foreign_keys = ON;
