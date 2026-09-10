import { createServerFn } from '@tanstack/react-start'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db'
import { createAuth } from '@/lib/auth'
import { type FieldGroup, isFieldGroup } from '@/lib/lot-field-groups'

// 관리자 확인은 **모듈 안에 둔다**. 다른 모듈에서 export 해 오면 이 파일을 import 하는
// 라우트를 통해 `@/db`·`@/lib/auth` 가 클라이언트 번들로 끌려 들어가 빌드가 깨진다
// (admin-reports.ts 가 같은 이유로 복사본을 갖고 있다).
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

export type EditReviewStatus = 'pending' | 'applied' | 'verified' | 'rejected' | 'superseded'

export interface AdminFieldEditItem {
  id: number
  parkingLotId: string
  lotName: string | null
  fieldGroup: FieldGroup
  payload: string
  status: string
  baseHadValue: number
  sourceNote: string | null
  authorUserId: string | null
  createdAt: string
  adminNote: string | null
}

const PAGE_SIZE = 30

/** 관리자 큐. 기본은 승인 대기(pending), 그 다음이 즉시 반영 중(applied) */
export const fetchFieldEdits = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      status?: EditReviewStatus
      page?: number
    }): { status: EditReviewStatus; page: number } => ({
      status: input.status ?? 'pending',
      page: Math.max(1, input.page ?? 1),
    }),
  )
  .handler(async ({ data, request }) => {
    await requireAdmin(request)
    const db = getDb()
    const offset = (data.page - 1) * PAGE_SIZE

    const rows = (await db.all(
      sql`SELECT e.id, e.parking_lot_id, p.name AS lot_name, e.field_group, e.payload,
                 e.status, e.base_had_value, e.source_note, e.author_user_id,
                 e.created_at, e.admin_note
          FROM lot_field_edits e
          LEFT JOIN parking_lots p ON p.id = e.parking_lot_id
          WHERE e.status = ${data.status}
          ORDER BY e.created_at DESC
          LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    )) as unknown as Array<Record<string, unknown>>

    const countRows = (await db.all(
      sql`SELECT status, COUNT(*) AS n FROM lot_field_edits GROUP BY status`,
    )) as unknown as Array<{ status: string; n: number }>

    const counts: Record<string, number> = {}
    for (const r of countRows) counts[r.status] = Number(r.n)

    const items: AdminFieldEditItem[] = rows
      .filter((r) => isFieldGroup(r.field_group))
      .map((r) => ({
        id: Number(r.id),
        parkingLotId: String(r.parking_lot_id),
        lotName: (r.lot_name as string | null) ?? null,
        fieldGroup: r.field_group as FieldGroup,
        payload: String(r.payload),
        status: String(r.status),
        baseHadValue: Number(r.base_had_value ?? 0),
        sourceNote: (r.source_note as string | null) ?? null,
        authorUserId: (r.author_user_id as string | null) ?? null,
        createdAt: String(r.created_at),
        adminNote: (r.admin_note as string | null) ?? null,
      }))

    return { items, counts, page: data.page, pageSize: PAGE_SIZE }
  })

export interface ReviewFieldEditInput {
  id: number
  action: 'pick' | 'reject'
  adminNote?: string
}

/**
 * 제보 검수.
 *
 * `pick` 은 그 값을 확정(`verified`)한다 — 이후 같은 칸의 제보는 즉시 반영되지 않고
 * 승인 큐로만 들어간다. 같은 칸에 서 있던 다른 행은 내린다(그룹당 활성 행은 하나).
 *
 * `reject` 는 되돌린다. 즉시 반영 중이던 값을 반려하면 그 칸은 다시 「정보 없음」이 된다.
 */
export const reviewFieldEdit = createServerFn({ method: 'POST' })
  .inputValidator((input: ReviewFieldEditInput): ReviewFieldEditInput => {
    if (!Number.isInteger(input.id)) throw new Error('잘못된 대상')
    if (input.action !== 'pick' && input.action !== 'reject') throw new Error('잘못된 동작')
    return input
  })
  .handler(async ({ data, request }) => {
    const adminUserId = await requireAdmin(request)
    const db = getDb()

    const rows = (await db.all(
      sql`SELECT id, parking_lot_id, field_group, status FROM lot_field_edits WHERE id = ${data.id}`,
    )) as unknown as Array<{
      id: number
      parking_lot_id: string
      field_group: string
      status: string
    }>
    const target = rows[0]
    if (!target) throw new Error('제보를 찾을 수 없습니다')

    const now = new Date().toISOString()
    const adminNote = data.adminNote?.trim() || null

    if (data.action === 'reject') {
      await db
        .update(schema.lotFieldEdits)
        .set({ status: 'rejected', reviewedBy: adminUserId, reviewedAt: now, adminNote })
        .where(eq(schema.lotFieldEdits.id, data.id))
      return { ok: true, status: 'rejected' as const }
    }

    // pick — 같은 칸에 서 있던 다른 행을 먼저 내리고 이 행을 세운다.
    // 부분 유니크 인덱스가 활성 행을 하나로 강제하므로 순서를 지켜야 한다
    await db.batch([
      db
        .update(schema.lotFieldEdits)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(schema.lotFieldEdits.parkingLotId, target.parking_lot_id),
            eq(schema.lotFieldEdits.fieldGroup, target.field_group),
            inArray(schema.lotFieldEdits.status, ['applied', 'verified']),
          ),
        ),
      db
        .update(schema.lotFieldEdits)
        .set({ status: 'verified', reviewedBy: adminUserId, reviewedAt: now, adminNote })
        .where(eq(schema.lotFieldEdits.id, data.id)),
    ])

    return { ok: true, status: 'verified' as const }
  })

/** 관리자 화면 배지용 — 대기 건수 */
export const fetchFieldEditStats = createServerFn({ method: 'GET' }).handler(
  async ({ request }) => {
    await requireAdmin(request)
    const db = getDb()
    const rows = await db
      .select({ status: schema.lotFieldEdits.status, n: sql<number>`COUNT(*)` })
      .from(schema.lotFieldEdits)
      .groupBy(schema.lotFieldEdits.status)
      .all()
    const counts: Record<string, number> = {}
    for (const r of rows) counts[r.status] = Number(r.n)
    return { counts }
  },
)
