-- 주차장 투표 (thumbup/thumbdown) — 로그인 유저 전용
CREATE TABLE IF NOT EXISTS parking_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  parking_lot_id TEXT NOT NULL,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('up', 'down')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, parking_lot_id)
);

CREATE INDEX IF NOT EXISTS idx_parking_votes_lot ON parking_votes(parking_lot_id);
CREATE INDEX IF NOT EXISTS idx_parking_votes_user ON parking_votes(user_id);

-- 주차장 북마크 — 로그인 유저 전용
CREATE TABLE IF NOT EXISTS parking_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  parking_lot_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, parking_lot_id)
);

CREATE INDEX IF NOT EXISTS idx_parking_bookmarks_user ON parking_bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_parking_bookmarks_lot ON parking_bookmarks(parking_lot_id);
