-- SEO용 실용 팁 3종 (parking_lot_stats에 저장, curation_reason과 분리)
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_pricing TEXT;
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_visit TEXT;
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_alternative TEXT;
ALTER TABLE parking_lot_stats ADD COLUMN ai_tip_updated_at TEXT;
