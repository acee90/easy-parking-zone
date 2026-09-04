/**
 * 파이프라인 품질 검수 리포트 — 규칙은 docs/references/pipeline-quality-check.md
 *
 * 이 스크립트는 **판정하지 않는다.** 판정에 필요한 숫자와 표본을 뽑을 뿐이다.
 * 임계값 대비 판정은 리포트에 같이 찍되, 최종 결론(필터 강화 / refine 강화 / 수집 확대)은
 * 표본 라벨링 결과를 사람이 합쳐서 낸다.
 *
 * 왜 표본까지 뽑는가: 수율·백로그는 SQL 로 세지만 "이 근거가 유의미한가"는 읽어야 안다.
 * 특히 **탈락분 표본**이 핵심이다 — 통과분만 보면 false positive 만 보이고,
 * 좋은 글을 버리고 있는지(false negative)는 영영 모른다.
 * 탈락 행은 크론이 2시간 안에 지우므로 raw-retention.ts 가 1%를 30일간 남긴다.
 *
 * Usage:
 *   bun run scripts/pipeline-quality-report.ts --remote --days=7 --sample=30 --out=data/pipeline-qa
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { d1Query, isRemote } from './lib/d1'

const args = process.argv.slice(2)
const DAYS = parseInt(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? '7', 10)
const SAMPLE = parseInt(args.find((a) => a.startsWith('--sample='))?.split('=')[1] ?? '30', 10)
const OUT_DIR = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'data/pipeline-qa'

const today = new Date().toISOString().slice(0, 10)
const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10)

/** 임계값. 근거는 docs/references/pipeline-quality-check.md 의 「기준선」 절. */
const T = {
  fullTextOkRate: 0.9,
  filterPassRateMin: 0.1,
  filterPassRateMax: 0.25,
  postDropRate: 0.2,
  matchBacklogHours: 24,
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`
}
/** 표본이 없으면 판정하지 않는다 — 0건을 'OK'로 찍으면 지표가 죽은 걸 못 본다. */
function verdict(ok: boolean, hasData = true): string {
  if (!hasData) return '- (데이터 없음)'
  return ok ? 'OK' : '⚠️'
}
function table(rows: string[][]): string {
  if (rows.length === 0) return '(데이터 없음)\n'
  const head = rows[0]
  const body = rows.slice(1)
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const out: string[] = []
  out.push(`# 파이프라인 품질 검수 — ${today} (최근 ${DAYS}일, ${isRemote ? 'remote' : 'local'})`)
  out.push('\n규칙: `docs/references/pipeline-quality-check.md`\n')

  // ── 1. 수집량·수율 (일별 카운터, 0056) ──
  const daily = d1Query<{ metric: string; n: number }>(
    `SELECT metric, SUM(count) AS n FROM pipeline_daily_stats
      WHERE day >= '${since}' GROUP BY metric ORDER BY metric`,
  )
  const m = Object.fromEntries(daily.map((r) => [r.metric, r.n])) as Record<string, number>
  const crawled = Object.entries(m)
    .filter(([k]) => k.startsWith('crawl:'))
    .reduce((a, [, v]) => a + v, 0)
  const ftOk = m['fulltext:ok'] ?? 0
  const ftFail = m['fulltext:failed'] ?? 0
  const fPass = m['filter:pass'] ?? 0
  const fDrop = m['filter:drop'] ?? 0

  out.push('## 1. 수집량·수율\n')
  if (daily.length === 0) {
    out.push(
      `카운터 없음. \`pipeline_daily_stats\`(0056)는 2026-09-04 신설이라 그 이전 기간은 비어 있다.\n`,
    )
  }
  out.push(
    table([
      ['지표', '값', '임계값', '판정'],
      ['크롤 유입', `${crawled}건`, '-', '-'],
      [
        '본문 성공률',
        pct(ftOk, ftOk + ftFail),
        `≥ ${T.fullTextOkRate * 100}%`,
        verdict(ftOk / (ftOk + ftFail) >= T.fullTextOkRate, ftOk + ftFail > 0),
      ],
      [
        '필터 통과율',
        pct(fPass, fPass + fDrop),
        `${T.filterPassRateMin * 100}~${T.filterPassRateMax * 100}%`,
        verdict(
          fPass / (fPass + fDrop) >= T.filterPassRateMin &&
            fPass / (fPass + fDrop) <= T.filterPassRateMax,
          fPass + fDrop > 0,
        ),
      ],
      ['매칭 산출', `${m['match:sources'] ?? 0}건 → ${m['match:links'] ?? 0} 링크`, '-', '-'],
      ['원장 삭제', `${m['purge:raw_rows'] ?? 0}행`, '-', '-'],
    ]),
  )
  out.push('')

  // ── 2. 백로그·지연 ──
  const backlog = d1Query<{ stage: string; n: number; oldest: string }>(
    `SELECT '본문 대기' AS stage, COUNT(*) AS n, COALESCE(MIN(crawled_at),'-') AS oldest
       FROM web_sources_raw WHERE full_text_status = 'pending'
     UNION ALL
     SELECT '필터 대기', COUNT(*), COALESCE(MIN(crawled_at),'-')
       FROM web_sources_raw WHERE ai_filtered_at IS NULL AND full_text_status = 'ok'
        AND source != 'youtube_video'
     UNION ALL
     SELECT '매칭 대기', COUNT(*), COALESCE(MIN(ai_filtered_at),'-')
       FROM web_sources_raw WHERE filter_passed = 1 AND matched_at IS NULL
     UNION ALL
     SELECT 'youtube 미판정(수동)', COUNT(*), COALESCE(MIN(crawled_at),'-')
       FROM web_sources_raw WHERE source = 'youtube_video' AND filter_passed IS NULL`,
  )
  out.push('## 2. 백로그·지연\n')
  out.push(
    table([['단계', '대기', '최고령'], ...backlog.map((r) => [r.stage, `${r.n}건`, r.oldest])]),
  )
  out.push('')

  // ── 3. 사후 탈락률 — 필터 누수의 1급 지표 ──
  //
  // 룰 필터와 매칭을 통과해 web_sources 까지 들어온 뒤 FILTER_V2 가 버린 비율이다.
  // 이 값이 높다는 건 상류 필터가 새고 있다는 뜻이다 (= 필터 강화 신호).
  // 전체 기간으로 보면 룰이 없던 시절 행이 섞이므로 **최근 유입분**을 따로 본다.
  const v2All = d1Query<{ evaluated: number; dropped: number }>(
    `SELECT COUNT(*) AS evaluated, SUM(CASE WHEN filter_passed_v2 = 0 THEN 1 ELSE 0 END) AS dropped
       FROM web_sources WHERE filter_passed_v2 IS NOT NULL`,
  )[0]
  const v2Recent = d1Query<{ evaluated: number; dropped: number }>(
    `SELECT COUNT(*) AS evaluated, SUM(CASE WHEN filter_passed_v2 = 0 THEN 1 ELSE 0 END) AS dropped
       FROM web_sources WHERE filter_passed_v2 IS NOT NULL AND matched_at >= '${since}'`,
  )[0]
  const reasons = d1Query<{ reason: string; n: number }>(
    `SELECT COALESCE(filter_v2_reason,'-') AS reason, COUNT(*) AS n
       FROM web_sources WHERE filter_passed_v2 = 0 GROUP BY 1 ORDER BY n DESC LIMIT 10`,
  )
  const recentRate = v2Recent.evaluated ? v2Recent.dropped / v2Recent.evaluated : 0
  out.push('## 3. 사후 탈락률 (필터 누수)\n')
  out.push(
    table([
      ['구간', '평가', '탈락', '비율', '임계값', '판정'],
      [
        '전체',
        `${v2All.evaluated}`,
        `${v2All.dropped}`,
        pct(v2All.dropped, v2All.evaluated),
        '-',
        '-',
      ],
      [
        `최근 ${DAYS}일`,
        `${v2Recent.evaluated}`,
        `${v2Recent.dropped}`,
        pct(v2Recent.dropped, v2Recent.evaluated),
        `≤ ${T.postDropRate * 100}%`,
        verdict(recentRate <= T.postDropRate, v2Recent.evaluated > 0),
      ],
    ]),
  )
  out.push('\n탈락 사유 (전체 누적)\n')
  out.push(table([['사유', '건수'], ...reasons.map((r) => [r.reason, String(r.n)])]))
  out.push('')

  // ── 4. 커버리지 ──
  const cov = d1Query<{ k: string; n: number }>(
    `SELECT '근거 보유 lot' AS k, COUNT(DISTINCT parking_lot_id) AS n FROM web_sources
     UNION ALL SELECT '근거 3건 이상 lot', COUNT(*) FROM (
       SELECT parking_lot_id FROM web_sources WHERE filter_passed_v2 IS NOT 0
        GROUP BY parking_lot_id HAVING COUNT(*) >= 3)
     UNION ALL SELECT '종합요약 보유 lot', COUNT(*) FROM parking_lot_stats
       WHERE ai_summary IS NOT NULL AND ai_summary != ''
     UNION ALL SELECT '요약 대기(stale)', COUNT(*) FROM parking_lot_stats WHERE ai_summary_stale = 1
     UNION ALL SELECT '전체 주차장', COUNT(*) FROM parking_lots`,
  )
  out.push('## 4. 커버리지\n')
  out.push(table([['항목', '수'], ...cov.map((r) => [r.k, r.n.toLocaleString()])]))
  out.push('')

  // ── 5. 표본 추출 ──
  //
  // 라벨링은 Haiku 가 한다 (docs 의 「표본 검수」 절에 루브릭·프롬프트).
  // 사람은 라벨 불일치 건과 경계 사례만 본다.
  const passedSample = d1Query<Record<string, string>>(
    `SELECT ws.id, ws.parking_lot_id, p.name AS lot_name, p.address, ws.source,
            ws.title, ws.source_url, substr(ws.content, 1, 400) AS excerpt
       FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id
      WHERE ws.matched_at >= '${since}'
      ORDER BY ws.id DESC LIMIT ${SAMPLE}`,
  )
  const rejectedSample = d1Query<Record<string, string>>(
    `SELECT r.id, r.source, r.title, r.source_url, r.filter_removed_by, r.filter_tier,
            substr(b.body, 1, 400) AS excerpt
       FROM web_sources_raw r LEFT JOIN web_sources_raw_body b ON b.raw_id = r.id
      WHERE r.filter_passed = 0
      ORDER BY r.id DESC LIMIT ${SAMPLE}`,
  )
  const summarySample = d1Query<Record<string, string>>(
    `SELECT s.parking_lot_id, p.name AS lot_name, p.address, s.reliability, s.web_count,
            s.ai_summary
       FROM parking_lot_stats s JOIN parking_lots p ON p.id = s.parking_lot_id
      WHERE s.ai_summary IS NOT NULL AND s.ai_summary != ''
      ORDER BY s.ai_summary_updated_at DESC LIMIT ${Math.ceil(SAMPLE / 2)}`,
  )

  const dump = (name: string, rows: Record<string, string>[], note: string) => {
    const path = join(OUT_DIR, `${today}-${name}.md`)
    const body = rows
      .map((r, i) =>
        [
          `### ${i + 1}. ${r.title ?? r.lot_name ?? r.parking_lot_id}`,
          ...Object.entries(r).map(
            ([k, v]) => `- **${k}**: ${String(v ?? '').replace(/\n/g, ' ')}`,
          ),
        ].join('\n'),
      )
      .join('\n\n')
    writeFileSync(path, `# ${name} (${today}, ${rows.length}건)\n\n${note}\n\n${body}\n`)
    return path
  }

  const files = [
    dump('sample-passed', passedSample, '판정: 이 글이 **이 주차장의 주차 경험**을 말하는가?'),
    dump(
      'sample-rejected',
      rejectedSample,
      '판정: 이 글을 버린 게 맞는가? (살릴 만한 주차 정보가 있으면 오폐기)',
    ),
    dump('sample-summary', summarySample, '판정: 요약이 근거와 일치하고 사실인가?'),
  ]

  out.push('## 5. 표본\n')
  out.push(files.map((f) => `- \`${f}\``).join('\n'))
  out.push('\n라벨링 절차와 루브릭은 규칙 문서의 「표본 검수」 절을 따른다.\n')

  const reportPath = join(OUT_DIR, `${today}-report.md`)
  writeFileSync(reportPath, `${out.join('\n')}\n`)
  console.log(`리포트: ${reportPath}`)
  for (const f of files) console.log(`표본:   ${f}`)
}

main()
