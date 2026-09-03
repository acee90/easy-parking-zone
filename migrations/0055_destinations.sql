-- 목적지 축 페이지 (#166)
--
-- "석촌역 근처 주차장"처럼 사람들이 실제로 치는 검색어에 대응하는 페이지 /near/{목적지} 의 원본.
-- 주차장 상세페이지가 31,994장 중 7,500장을 내용 없이 등재해 겪는 문제를 반복하지 않으려고,
-- 이 테이블에는 게이트(scripts/near/lib/gate.ts)를 통과한 목적지만 들어간다.
-- 행이 있다 = 발행이다. noindex 같은 중간 상태는 없다.
--
-- 채우는 쪽: scripts/near/evaluate-candidates.ts 가 SQL 파일을 내고 wrangler --file 로 일괄 적용.
-- 크론에 넣지 않는다. 화면(src/server/destinations.ts)은 읽기만 한다.
--
-- 좌표 원천은 공공데이터뿐이다. 카카오 로컬 API 결과는 약관상 저장할 수 없다
-- (docs/exec-plans/issue-166-destination-pages.md 2장).
CREATE TABLE IF NOT EXISTS destinations (
  -- 'D-0001' 형식. 평가 스크립트가 발급한다. 이름이 바뀌어도 URL은 이 id 로 해석된다
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- '석촌역-D-0001'. wiki 와 같은 규칙(이름-id)
  slug          TEXT NOT NULL UNIQUE,
  -- 1단계는 'station' 만. 이후 market | mall | tourist
  category      TEXT NOT NULL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  address       TEXT,
  -- 'public_data:15013205' 처럼 데이터셋 id 까지 적는다. 출처를 잃으면 R-1 을 반복한다
  source        TEXT NOT NULL,
  source_id     TEXT,
  -- 50m 안의 목적지를 하나로 묶은 대표 id. 대표는 자기 자신
  cluster_id    TEXT,
  -- 발행 시점 반경 내 주차장 수. <title> 의 "N곳" 이 여기서 나온다
  lot_count     INTEGER NOT NULL,
  free_count    INTEGER NOT NULL DEFAULT 0,
  published_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_destinations_geo ON destinations(lat, lng);

-- 검색어 변형. '석촌역' 의 '석촌역 8호선', '석촌역8호선' 같은 것들.
-- #164 자동완성과 #165 유입 검색어가 여기로 착지한다
CREATE TABLE IF NOT EXISTS destination_aliases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  alias          TEXT NOT NULL,
  -- spacing | line | search_term
  kind           TEXT NOT NULL,
  UNIQUE(destination_id, alias)
);

-- 목적지 → 주변 주차장. 거리 계산을 요청마다 하지 않으려고 미리 계산해 둔다
CREATE TABLE IF NOT EXISTS destination_lots (
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  distance_m     INTEGER NOT NULL,
  -- 직선거리 기준. 화면에 그렇게 밝힌다
  walk_minutes   INTEGER NOT NULL,
  -- 'web_source:<id>' 이면 그 글이 목적지와 이 주차장을 함께 언급했다. NULL 이면 가깝다는 것만 안다
  evidence       TEXT,
  rank           INTEGER NOT NULL,
  PRIMARY KEY (destination_id, parking_lot_id)
) WITHOUT ROWID;

-- 주차장 상세페이지의 "이 주차장으로 갈 수 있는 곳" 이 역방향으로 탄다
CREATE INDEX IF NOT EXISTS idx_destination_lots_lot ON destination_lots(parking_lot_id);
