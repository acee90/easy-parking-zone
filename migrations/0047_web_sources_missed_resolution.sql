-- missed 후보 해소 상태 추적
-- web_sources_missed는 증거 보존 테이블 — 삭제 대신 resolution_status로 처리 상태를 남긴다.
-- 상태값:
--   rejected_noise        : 장소명이 일반명/지역명/페이지·서비스명/추출 파편 (lot 아님)
--   resolved_existing_lot : 장소검색 결과가 기존 parking_lots와 좌표 중복 → 해당 lot에 재연결
--   rejected_no_place     : 장소검색 주차장 결과 없음
--   review_required       : 신규 후보가 여러 개라 자동 확정 불가
--   resolved_new_lot      : 신규 lot 생성 후 web_sources로 승격 (후속 단계)
--   NULL                  : 미해소 (active 진짜 missed = 신규 lot 후보)
ALTER TABLE web_sources_missed ADD COLUMN resolution_status TEXT;
ALTER TABLE web_sources_missed ADD COLUMN resolved_parking_lot_id TEXT REFERENCES parking_lots(id);
ALTER TABLE web_sources_missed ADD COLUMN resolved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_missed_resolution_status
  ON web_sources_missed(resolution_status);
