-- Track D 수동 큐레이션: 11 lot
-- 정적 정보 (운영시간, 요금, 무료여부, 위치) + lot 본질 컨텍스트 기반.
-- web_sources 부족·부재로 자동 생성 불가했던 lot.

-- 1. 광주광역시문화예술회관 주차장 (광주 북구, 무료, 09:00-22:30)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-1019490575',
  '광주광역시문화예술회관에 부설된 무료 노외 주차장입니다. 공연이나 전시 관람객을 위해 운영되며 매일 오전 9시부터 밤 10시 30분까지 이용 가능합니다.',
  '전 차종 무료로 이용 가능합니다.',
  '공연 시작 1시간 전후로 진입 차량이 집중되므로 여유 있게 도착하시기를 권장합니다.',
  '만차 시 인근 광주북구청 일대의 공영주차장 또는 북문대로변 노상 구간을 활용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 2. 광주광역시 남구청 주차장 (광주 남구, 30분/500원, 평일 08:00-18:00)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-26558103',
  '광주광역시 남구청 청사에 부설된 관공서 주차장으로 민원 방문객 위주로 이용됩니다. 평일 오전 8시부터 오후 6시까지 운영하며 주말과 공휴일에는 운영하지 않습니다.',
  '기본 30분 500원이며 시간 비례로 추가 요금이 부과됩니다.',
  '평일 오전 민원 시간대(9~11시)에 진입 차량이 몰리는 편입니다. 주말 방문 시 운영하지 않으니 주의해야 합니다.',
  '주말이나 야간에는 인근 봉선동 공영주차장 또는 노상 구간을 이용하시기 바랍니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 3. 신성주차장 (전주시 완산구 전라감영길, 유료 노외)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-10529803',
  '전주 한옥마을 인근 전라감영길 도보권에 위치한 유료 노외 주차장입니다. 한옥마을과 객사 일대를 도보로 둘러볼 때 이용하기 편리합니다.',
  NULL,
  '주말과 공휴일에는 한옥마을 관광객으로 혼잡하므로 오전 일찍 진입하시기를 권장합니다.',
  '만차 시 전주공영주차장(한옥마을공영) 또는 풍남문 인근 공영주차장을 활용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 4. 노상주차장 남부터미널옆 (서울 서초구, 5분/300원, 24시간)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-27020725',
  '서울 남부버스터미널 옆 효령로변에 위치한 24시간 운영 노상주차장입니다. 터미널 이용객과 인근 상권 방문객이 단기 정차용으로 많이 활용합니다.',
  '5분당 300원으로 시간당 약 3,600원이 부과되어 단기 정차 위주로 적합합니다. 장시간 주차 시 비용 부담이 큽니다.',
  '터미널 이용객이 많은 출퇴근 및 주말 시간대는 빈자리 회전이 빠릅니다. 노상 구간 특성상 차폭이 좁을 수 있어 주의가 필요합니다.',
  '장시간 주차가 필요하면 남부터미널 부설주차장이나 인근 공영주차장을 이용하시기 바랍니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 5. SK하이닉스고담 주차장 (경기 이천시, 60분/3000원, 24시간)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-24727669',
  '경기 이천시 대산로의 SK하이닉스 사업장 인근에 위치한 주차장으로 24시간 운영됩니다. 사업장 방문객이나 인근 상권 이용자 위주로 활용됩니다.',
  '1시간 3,000원으로 일반 공영주차장 대비 다소 높은 편입니다.',
  NULL,
  '사업장 출입은 별도 사전 등록이 필요할 수 있으니 방문 전 사업장에 문의하시기 바랍니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 6. 일림산용추계곡 제1주차장 (전남 보성군, 시즌성 관광지)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-20579168',
  '전남 보성군 일림산 용추계곡 입구에 위치한 시즌성 관광지 주차장입니다. 봄 진달래 군락과 여름 계곡 피서철에 방문객이 집중됩니다.',
  NULL,
  '4~5월 진달래 절정기와 7~8월 피서철 주말에는 매우 혼잡합니다. 오전 일찍 도착하시기를 권장합니다.',
  '만차 시 인근 보성차밭 또는 웅치면 일대의 노상 구간을 이용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 7. 흥덕보건소 앞 임시공영주차장 (청주시 흥덕구, 무료, 24시간)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-893365533',
  '청주시 흥덕구 복대동 흥덕보건소 앞에 위치한 무료 임시공영주차장입니다. 보건소 이용객 및 인근 상권 방문객이 주로 이용하며 24시간 개방됩니다.',
  '전 차종 무료로 이용 가능합니다.',
  '보건소 진료 시간(평일 오전)에 진입 차량이 일시적으로 몰릴 수 있습니다. 임시 주차장 특성상 향후 시설 변경 가능성이 있어 방문 전 확인을 권장합니다.',
  '만차 시 인근 복대동 공영주차장이나 현대백화점 충청점 일대의 부설주차장을 활용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 8. 익산역 서부주차장 (전북 익산시, 무료)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-26776045',
  '익산역(KTX·새마을·무궁화 정차) 서편에 위치한 무료 노외 주차장입니다. 철도 이용객의 환승 주차 및 단기 픽업·드롭 용도로 활용됩니다.',
  '전 차종 무료로 이용 가능합니다.',
  '주말과 명절 연휴 등 철도 수요 집중 시기에는 매우 혼잡합니다. 평일 출퇴근 시간대에도 통근 이용객으로 빈자리 확보가 어려울 수 있습니다.',
  '만차 시 익산역 동편의 공영주차장 또는 동부역광장 주변 노상 구간을 활용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 9. 군산짬뽕특화거리 주차장 (전북 군산시, 무료 노외)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-2144576177',
  '군산 짬뽕특화거리 도보권에 위치한 무료 노외 주차장입니다. 짬뽕 명소가 밀집된 동령길 일대를 도보로 이용하기 편리합니다.',
  '전 차종 무료로 이용 가능합니다.',
  '주말 점심(11시~14시) 시간대에는 짬뽕거리 방문객으로 매우 혼잡합니다. 회전이 느리니 평일 또는 이른 시간을 권장합니다.',
  '만차 시 군산근대문화거리 공영주차장이나 인근 노상 구간을 활용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 10. 율하 타임스퀘어 주차장 (대구 동구, 32면, 30분/400원, daily_max 4000)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-2088759031',
  '대구 동구 율하지구에 위치한 32면 규모의 상가 부설 주차장입니다. 율하 타임스퀘어 상가 이용객 중심으로 운영되며 매일 오전 9시부터 저녁 7시 30분까지 이용 가능합니다.',
  '기본 30분 400원이며 추가 10분당 200원, 일 최대 4,000원이 적용됩니다.',
  '주말 식사 시간대(점심·저녁)에 회전이 느릴 수 있습니다. 상가 영업 종료(19:30) 후에는 진입이 제한되니 시간을 확인하시기 바랍니다.',
  '만차 시 인근 율하지구 상가 부설주차장 또는 율하역 공영주차장을 활용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;

-- 11. 킨텍스 임시주차장 T4 (일산서구 대화동, 무료, 08:00-18:30)
INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_summary_updated_at, ai_tip_updated_at)
VALUES ('KA-1087416858',
  '킨텍스(KINTEX) 전시장 운영을 위한 임시 주차장(T4)입니다. 대형 전시·박람회 개최 시 본 주차장과 부설주차장의 만차를 분산하기 위해 운영되며 평일과 주말 모두 오전 8시부터 저녁 6시 30분까지 이용 가능합니다.',
  '전 차종 무료로 이용 가능합니다.',
  '대형 박람회 첫날과 주말 오전에는 매우 혼잡합니다. 일찍 도착하거나 대중교통(킨텍스역) 이용을 권장합니다. 임시 주차장 특성상 행사 일정에 따라 운영 여부가 달라질 수 있으니 사전 확인이 필요합니다.',
  '만차 시 킨텍스 제2전시장 부설주차장이나 인근 일산호수공원 주차장을 활용할 수 있습니다.',
  datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary, ai_tip_pricing = excluded.ai_tip_pricing,
  ai_tip_visit = excluded.ai_tip_visit, ai_tip_alternative = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at, ai_tip_updated_at = excluded.ai_tip_updated_at;
