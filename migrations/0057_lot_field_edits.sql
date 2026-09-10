-- 주차장 기본정보 유저 제보 (요금 / 운영시간 / 주차면)
--
-- 나무위키식 편집: 비어 있는 정보는 유저가 바로 채우고, 관리자가 확인(pick)하면 잠긴다.
--
-- ## 왜 parking_lots 를 직접 안 고치나
--
-- 세 동기화 스크립트가 전부 `ON CONFLICT(id) DO UPDATE SET <모든 컬럼> = excluded.*` 다
-- (sync-public-data.ts:256, sync-modu.ts:227, sync-hiparking.ts:99).
-- parking_lots 에 유저 값을 써 넣으면 다음 동기화에서 조용히 날아간다.
-- 그래서 제보는 이 테이블에 따로 살고, 읽을 때 원본 위에 얹는다.
--
-- ## 상태
--
--   applied    화면에 반영 중 (원본이 비어 있어서 즉시 반영됐다). 「유저제보」 배지가 붙는다
--   pending    승인 대기 (원본에 값이 있거나 이미 verified 라 바로 반영하지 않는다)
--   verified   관리자가 확인함. 배지 없이 원본과 같은 무게로 그린다. 이후 제보는 pending 으로만
--   rejected   관리자 반려
--   superseded 다른 유저가 덮어씀
--
-- FK 를 걸지 않는다 — content_reports 와 같은 선택이다. 0051 에서 FK 를 떼어낸 이유와 같고
-- (MODU 중복 정리처럼) lot 이 지워질 때 제보가 삭제를 막으면 안 된다.
CREATE TABLE IF NOT EXISTS lot_field_edits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id   TEXT NOT NULL,
  -- 'fee' | 'hours' | 'spaces'. 컬럼 단위가 아니라 묶음 단위다 —
  -- is_free 와 base_fee 를 따로 받으면 "무료인데 시간당 2,000원" 같은 모순이 생긴다
  field_group      TEXT NOT NULL,
  -- 그룹의 컬럼들을 담은 JSON. 스키마는 src/lib/lot-field-groups.ts 가 소유한다
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL,
  -- 제출 시점에 원본(또는 앞선 제보)에 값이 있었나. 나중에 판정을 재현·감사할 때 쓴다
  base_had_value   INTEGER NOT NULL DEFAULT 0,
  author_user_id   TEXT,
  ip_hash          TEXT,
  -- 제보자가 적은 근거 ("현장 요금표 확인" 등). 선택 입력
  source_note      TEXT,
  admin_note       TEXT,
  reviewed_by      TEXT,
  reviewed_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lot_field_edits_lot ON lot_field_edits(parking_lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_field_edits_status ON lot_field_edits(status);

-- 한 주차장의 한 그룹에 **화면에 서는 행은 최대 하나**.
-- 동시 제출이 겹치면 두 번째 INSERT 가 여기서 막힌다 (서버가 한 번 재시도한다).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lot_field_edits_active
  ON lot_field_edits(parking_lot_id, field_group)
  WHERE status IN ('applied', 'verified');

-- 같은 IP 가 같은 칸을 연달아 뒤집는 걸 막을 때 쓰는 조회 경로
CREATE INDEX IF NOT EXISTS idx_lot_field_edits_ip_recent
  ON lot_field_edits(ip_hash, parking_lot_id, field_group, created_at);
