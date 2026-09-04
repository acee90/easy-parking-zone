/**
 * 파이프라인 단계별 일일 카운터 기록 (0056)
 *
 * 크론이 종결 raw 를 지우기 시작하면서 "어제 몇 건 들어왔고 몇 건이 탈락했나"를
 * DB 에서 셀 수 없게 됐다 — web_sources 에는 살아남은 것만 남는다.
 * 품질 검수(docs/references/pipeline-quality-check.md)가 딛고 설 바닥이 필요해서 만든다.
 *
 * 기록 시점은 크론 한 회차의 **끝**이다. 회차가 중간에 잘리면(2026-09-04 06:00 UTC
 * `canceled` 실측) 그 회차 카운터는 통째로 유실된다. 단계마다 쓰면 유실은 줄지만
 * D1 왕복이 회당 6번 늘어난다 — 검수는 일 단위 추세를 보는 일이라 회차 하나가 빠져도
 * 판단이 뒤집히지 않는다. 정확한 회차 추적이 필요해지면 그때 단계별 flush 로 바꾼다.
 */

/** 지표 이름은 `단계:구분` 형태로 통일한다. 새 지표는 마이그레이션 없이 추가된다. */
export type PipelineMetric = string

export async function recordDailyStats(
  db: D1Database,
  counts: Readonly<Record<PipelineMetric, number>>,
): Promise<number> {
  const entries = Object.entries(counts).filter(([, n]) => n > 0)
  if (entries.length === 0) return 0

  await db.batch(
    entries.map(([metric, n]) =>
      db
        .prepare(
          `INSERT INTO pipeline_daily_stats (day, metric, count)
             VALUES (date('now'), ?1, ?2)
           ON CONFLICT(day, metric) DO UPDATE SET count = count + ?2`,
        )
        .bind(metric, n),
    ),
  )
  return entries.length
}
