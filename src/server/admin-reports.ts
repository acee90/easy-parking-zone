import { createServerFn } from '@tanstack/react-start'
import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db'
import { createAuth } from '@/lib/auth'

// --- Auth helpers (same pattern as admin.ts) ---

const isDev = process.env.NODE_ENV === 'development'

async function requireAdmin(request: Request) {
  if (isDev) return 'dev-admin'

  const auth = createAuth()
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) throw new Error('로그인 필요')

  const db = getDb()
  const user = await db
    .select({ isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .get()

  if (!user?.isAdmin) throw new Error('관리자 권한 필요')
  return session.user.id
}

// --- Types ---

export type ReportStatus = 'pending' | 'resolved' | 'dismissed' | 'all'
export type ReportTargetFilter = 'web_source' | 'media' | 'review' | 'all'

export interface AdminReportItem {
  id: number
  targetType: string
  targetId: number
  parkingLotId: string
  parkingLotName: string
  reason: string
  detail: string | null
  status: string
  targetTitle: string | null
  targetUrl: string | null
  createdAt: string
  resolvedAt: string | null
}

// --- Server functions ---

/** 신고 목록 조회 */
export const fetchContentReports = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      status?: ReportStatus
      targetType?: ReportTargetFilter
      page?: number
      limit?: number
    }) => input,
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error('서버 요청 필요')
    await requireAdmin(request)

    const ALLOWED_STATUSES = ['pending', 'resolved', 'dismissed', 'all'] as const
    const ALLOWED_TYPES = ['web_source', 'media', 'review', 'all'] as const
    const { status = 'pending', targetType = 'all', page = 1 } = data
    const limit = Math.min(data.limit ?? 30, 100)
    const offset = (page - 1) * limit

    if (!ALLOWED_STATUSES.includes(status as (typeof ALLOWED_STATUSES)[number]))
      throw new Error('잘못된 status')
    if (!ALLOWED_TYPES.includes(targetType as (typeof ALLOWED_TYPES)[number]))
      throw new Error('잘못된 targetType')

    const db = getDb()

    const conditions: string[] = []
    if (status !== 'all') conditions.push(`cr.status = '${status}'`)
    if (targetType !== 'all') conditions.push(`cr.target_type = '${targetType}'`)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRows = await db.all(
      sql.raw(`SELECT COUNT(*) as total FROM content_reports cr ${where}`),
    )
    const total = (countRows[0] as { total: number } | undefined)?.total ?? 0

    const rows = await db.all(
      sql`SELECT cr.id, cr.target_type, cr.target_id, cr.parking_lot_id,
              p.name as lot_name, cr.reason, cr.detail, cr.status,
              cr.created_at, cr.resolved_at,
              CASE
                WHEN cr.target_type = 'web_source' THEN ws.title
                WHEN cr.target_type = 'media' THEN pm.title
                WHEN cr.target_type = 'review' THEN ur.comment
              END as target_title,
              CASE
                WHEN cr.target_type = 'web_source' THEN ws.source_url
                WHEN cr.target_type = 'media' THEN pm.url
                WHEN cr.target_type = 'review' THEN ur.source_url
              END as target_url
       FROM content_reports cr
       LEFT JOIN parking_lots p ON p.id = cr.parking_lot_id
       LEFT JOIN web_sources ws ON cr.target_type = 'web_source' AND ws.id = cr.target_id
       LEFT JOIN parking_media pm ON cr.target_type = 'media' AND pm.id = cr.target_id
       LEFT JOIN user_reviews ur ON cr.target_type = 'review' AND ur.id = cr.target_id
       ${sql.raw(where)}
       ORDER BY cr.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
    )

    const items: AdminReportItem[] = (
      rows as unknown as {
        id: number
        target_type: string
        target_id: number
        parking_lot_id: string
        lot_name: string
        reason: string
        detail: string | null
        status: string
        target_title: string | null
        target_url: string | null
        created_at: string
        resolved_at: string | null
      }[]
    ).map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      parkingLotId: r.parking_lot_id,
      parkingLotName: r.lot_name ?? '',
      reason: r.reason,
      detail: r.detail,
      status: r.status,
      targetTitle: r.target_title,
      targetUrl: r.target_url,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }))

    return { items, total, page, limit }
  })

/** 신고 통계 */
export const fetchReportStats = createServerFn({ method: 'GET' }).handler(async ({ request }) => {
  if (!request) throw new Error('서버 요청 필요')
  await requireAdmin(request)

  const db = getDb()
  const stats = await db.all(
    sql`SELECT status, COUNT(*) as cnt FROM content_reports GROUP BY status`,
  )

  const counts: Record<string, number> = { pending: 0, resolved: 0, dismissed: 0 }
  let total = 0
  for (const r of stats as unknown as { status: string; cnt: number }[]) {
    counts[r.status] = r.cnt
    total += r.cnt
  }

  return { total, counts }
})

/** 신고 처리: 승인 (콘텐츠 숨김/삭제) */
export const resolveReport = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { reportId: number; action: 'resolve' | 'dismiss'; adminNote?: string }) => input,
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error('서버 요청 필요')
    const adminId = await requireAdmin(request)

    const db = getDb()

    const report = await db
      .select()
      .from(schema.contentReports)
      .where(eq(schema.contentReports.id, data.reportId))
      .get()

    if (!report) throw new Error('신고를 찾을 수 없습니다')

    // 승인 시 대상 콘텐츠 처리
    if (data.action === 'resolve') {
      if (report.targetType === 'web_source') {
        // 신고 승인: web_sources에서 제거
        await db.delete(schema.webSources).where(eq(schema.webSources.id, report.targetId))
      } else if (report.targetType === 'media') {
        await db.delete(schema.parkingMedia).where(eq(schema.parkingMedia.id, report.targetId))
      } else if (report.targetType === 'review') {
        await db.delete(schema.userReviews).where(eq(schema.userReviews.id, report.targetId))
      }
    }

    // 신고 상태 업데이트
    await db
      .update(schema.contentReports)
      .set({
        status: data.action === 'resolve' ? 'resolved' : 'dismissed',
        adminNote: data.adminNote?.trim() || null,
        resolvedBy: adminId,
        resolvedAt: sql`datetime('now')`,
      })
      .where(eq(schema.contentReports.id, data.reportId))

    return { ok: true }
  })
