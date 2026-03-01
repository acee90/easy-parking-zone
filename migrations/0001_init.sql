-- 주차장 테이블
CREATE TABLE IF NOT EXISTS parking_lots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- 노상/노외/부설
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  total_spaces INTEGER NOT NULL DEFAULT 0,
  free_spaces INTEGER,

  -- 운영시간
  weekday_start TEXT,
  weekday_end TEXT,
  saturday_start TEXT,
  saturday_end TEXT,
  holiday_start TEXT,
  holiday_end TEXT,

  -- 요금정보
  is_free INTEGER NOT NULL DEFAULT 0,
  base_time INTEGER,              -- 기본시간(분)
  base_fee INTEGER,               -- 기본요금(원)
  extra_time INTEGER,             -- 추가단위시간(분)
  extra_fee INTEGER,              -- 추가단위요금(원)
  daily_max INTEGER,              -- 1일 최대요금
  monthly_pass INTEGER,           -- 월정기권

  -- 난이도 자동추론 점수
  auto_difficulty_score REAL NOT NULL DEFAULT 3.0,

  phone TEXT,
  payment_methods TEXT,
  notes TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 리뷰 테이블
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  entry_score INTEGER NOT NULL CHECK(entry_score BETWEEN 1 AND 5),
  space_score INTEGER NOT NULL CHECK(space_score BETWEEN 1 AND 5),
  passage_score INTEGER NOT NULL CHECK(passage_score BETWEEN 1 AND 5),
  exit_score INTEGER NOT NULL CHECK(exit_score BETWEEN 1 AND 5),
  overall_score INTEGER NOT NULL CHECK(overall_score BETWEEN 1 AND 5),
  comment TEXT,
  visited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 좌표 인덱스 (bounds 쿼리 성능)
CREATE INDEX IF NOT EXISTS idx_parking_lots_lat ON parking_lots(lat);
CREATE INDEX IF NOT EXISTS idx_parking_lots_lng ON parking_lots(lng);

-- 리뷰 FK 인덱스
CREATE INDEX IF NOT EXISTS idx_reviews_parking_lot_id ON reviews(parking_lot_id);
