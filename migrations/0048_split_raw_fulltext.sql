-- web_sources_raw.full_text 를 별도 테이블 web_sources_raw_body 로 분리한다.
--
-- 배경 (2026-08-19 실측):
--   본문(평균 11,773자)과 원장 컬럼이 같은 페이지를 공유하면, purge로 본문만 비워도
--   SQLite는 페이지를 반납하지 않아 원장 행이 페이지에 듬성듬성 남는다.
--   실측 결과 원장 행 1건이 2.05KB를 점유(압축 시 0.08KB) — 96%가 찌꺼기였다.
--   본문을 별도 테이블로 분리하면 purge가 DELETE가 되어 페이지가 통째로 freelist에
--   반납되고 재사용되며, 원장 테이블은 영구히 조밀하게 유지된다.
--   대조 실험(5,000행 x 3사이클): 통합 30.8MB vs 분리 1.2MB (26배).
--
-- 이 마이그레이션은 전부 저비용 연산이다 (테이블 재작성 없음):
--   CREATE / INSERT(본문 보유 행만) / UPDATE(본문 보유 행만 NULL화)
--
-- `web_sources_raw.full_text` 컬럼 자체의 DROP은 여기서 하지 않는다.
--   572k행/1.2GB 테이블에 ALTER TABLE DROP COLUMN을 걸면 전 행 재작성이라 D1에서 위험하다.
--   컬럼 제거는 신규 DB 재구축(docs/exec-plans/d1-free-tier-migration.md Phase 2) 때
--   신규 스키마로 자연히 처리한다. 그때까지 컬럼은 전부 NULL 상태로 남는다.

CREATE TABLE IF NOT EXISTS web_sources_raw_body (
  raw_id INTEGER PRIMARY KEY,
  body   TEXT NOT NULL
);

-- 기존 본문 이관 (본문 보유 행만 — 현재 remote 기준 약 2만 행)
INSERT OR IGNORE INTO web_sources_raw_body (raw_id, body)
  SELECT id, full_text
  FROM web_sources_raw
  WHERE full_text IS NOT NULL AND length(full_text) > 0;

-- 원장에서 본문 제거 (컬럼은 남지만 값은 전부 NULL)
UPDATE web_sources_raw SET full_text = NULL WHERE full_text IS NOT NULL;
