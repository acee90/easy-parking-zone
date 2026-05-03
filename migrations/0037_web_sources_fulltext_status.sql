-- #140 Phase B-1: full_text fetch status tracking
-- 기존 컬럼: full_text TEXT, full_text_length INTEGER (migration 0024 보유, 평균 0자 = 미사용)
-- 본 마이그레이션은 fetch 상태 추적 컬럼 추가만.
ALTER TABLE web_sources ADD COLUMN full_text_status TEXT DEFAULT 'pending';
ALTER TABLE web_sources ADD COLUMN full_text_fetched_at TEXT;

-- 배치 처리 시 pending row 빠르게 찾기 위한 복합 인덱스
CREATE INDEX IF NOT EXISTS idx_ws_fulltext_status ON web_sources(full_text_status, source);
