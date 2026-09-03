-- 후기에서 함께 언급된 주차장 (3-1)
--
-- 후기 본문에 반복해서 등장하는 "여기 말고 갈 곳"을 저장한다.
-- 차이나타운공영주차장 후기에서 인천내항 8부두(무료)가 5건, 송월동 동화마을이 3건
-- 언급되는 식이다. 사람들이 그 블로그를 읽는 진짜 이유인데 지금은 덤프 안에 묻혀 있다.
--
-- 배치(scripts/extract-alternative-lots.ts)가 채운다. 화면은 읽기만 한다.
CREATE TABLE IF NOT EXISTS lot_alternatives (
  -- 이 주차장의 후기에서
  parking_lot_id  TEXT NOT NULL,
  -- 이런 이름이 언급됐다 (정규화형이 키다 — "송월동 동화마을 공영주차장"/"동화마을공영주차장"을 한 건으로)
  normalized      TEXT NOT NULL,
  -- 화면에 보여줄 원형 이름 (가장 많이 쓰인 표기)
  display_name    TEXT NOT NULL,
  -- 몇 건의 글에서 언급됐나. 이 숫자가 신뢰의 근거라 화면에 그대로 보여준다
  mention_count   INTEGER NOT NULL DEFAULT 0,
  -- 언급 주변에 '무료'가 있었나
  is_free_hint    INTEGER NOT NULL DEFAULT 0,
  -- 우리 DB 주차장과 매칭됐다면 그 id. NULL 이면 링크 없이 이름만 보여준다
  -- (매칭 안 된 이름을 검색으로 흘려보내면 엉뚱한 곳으로 갈 수 있다)
  matched_lot_id  TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parking_lot_id, normalized)
) WITHOUT ROWID;

-- 상세페이지는 lot 하나로 언급 많은 순 조회만 한다
CREATE INDEX IF NOT EXISTS idx_lot_alt_pick
  ON lot_alternatives(parking_lot_id, mention_count DESC);
