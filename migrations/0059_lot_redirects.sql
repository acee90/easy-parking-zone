-- 병합으로 사라진 주차장 id → 남은 주차장 id (A-4 출처 간 중복 병합).
--
-- 같은 주차장이 공공데이터·카카오·네이버로 여러 번 들어와 있으면 리뷰·블로그 근거가
-- 중복 행 사이에 쪼개진다. 병합은 자식 행을 대표 lot 으로 옮기고 흡수된 lot 행을 지운다.
--
-- 지운 lot 의 위키 URL 은 이미 색인됐거나 외부에서 링크됐을 수 있다. 404 대신
-- 대표 lot 으로 301 을 보내려고 이 표를 남긴다 (src/routes/wiki/$slug.tsx loader).
--
-- merged_into 컬럼으로 soft-merge 하지 않은 이유: parking_lots 를 읽는 경로가 14개 파일에
-- 흩어져 있어 전부 `merged_into IS NULL` 을 달아야 한다. 하나라도 빠지면 중복이 되살아난다.
-- 행을 지우고 리다이렉트만 따로 두면 읽기 경로는 손대지 않아도 된다.
-- (MODU 내부 중복 정리 2026-09-08 도 삭제 + 백업 JSON 방식이었다.)

CREATE TABLE IF NOT EXISTS lot_redirects (
  from_id    TEXT PRIMARY KEY,           -- 사라진 lot id
  to_id      TEXT NOT NULL,              -- 남은 대표 lot id
  reason     TEXT NOT NULL,              -- 'cross_source_dupe' 등
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lot_redirects_to ON lot_redirects(to_id);
