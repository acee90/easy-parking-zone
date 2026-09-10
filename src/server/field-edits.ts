import { env } from 'cloudflare:workers'
import { createServerFn } from '@tanstack/react-start'
import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db'
import { createAuth } from '@/lib/auth'
import {
  type FieldGroup,
  type FieldPayload,
  isFieldGroup,
  isFieldGroupEmpty,
  validateFieldPayload,
} from '@/lib/lot-field-groups'
import { resolveTransition, SAME_IP_COOLDOWN_SQL } from '@/lib/lot-field-transitions'
import { checkRateLimit, getClientIP } from '@/server/rate-limit'
import type { ParkingLot } from '@/types/parking'

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function getSessionUserId(request: Request): Promise<string | null> {
  try {
    const auth = createAuth()
    const session = await auth.api.getSession({ headers: request.headers })
    return session?.user?.id ?? null
  } catch {
    return null
  }
}

export interface SubmitFieldEditInput {
  parkingLotId: string
  fieldGroup: string
  payload: unknown
  sourceNote?: string
}

export interface SubmitFieldEditResult {
  /** 'applied' 면 화면에 바로 섰다. 'pending' 이면 관리자 확인 대기 */
  status: 'applied' | 'pending'
}

/**
 * 기본정보 제보.
 *
 * 비로그인도 받는다. 결손이 2만 건대라 로그인 벽을 세우면 채워질 일이 없고,
 * 모든 제보가 행으로 남아 되돌릴 수 있다. 대신 IP rate limit 과 같은 칸 재제출 간격을 둔다.
 */
export const submitFieldEdit = createServerFn({ method: 'POST' })
  .inputValidator((input: SubmitFieldEditInput): SubmitFieldEditInput => {
    if (!input.parkingLotId || typeof input.parkingLotId !== 'string') {
      throw new Error('주차장을 찾을 수 없습니다')
    }
    if (!isFieldGroup(input.fieldGroup)) throw new Error('알 수 없는 항목입니다')
    if (input.sourceNote && input.sourceNote.length > 200) {
      throw new Error('근거는 200자까지 적을 수 있습니다')
    }
    return input
  })
  .handler(async ({ data, request }): Promise<SubmitFieldEditResult> => {
    await checkRateLimit(
      env.RATE_LIMITER_EDIT,
      request,
      '제보가 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
    )

    const group = data.fieldGroup as FieldGroup
    // 클라이언트를 믿지 않는다 — 저장되는 건 이 함수를 통과한 값뿐이다
    const payload: FieldPayload = validateFieldPayload(group, data.payload)

    const db = getDb()

    const lotRows = await db.all(sql`SELECT * FROM parking_lots WHERE id = ${data.parkingLotId}`)
    if (lotRows.length === 0) throw new Error('주차장을 찾을 수 없습니다')

    const userId = request ? await getSessionUserId(request) : null
    const ipHash = request ? await hashIP(getClientIP(request)) : null

    if (ipHash) {
      // 비교를 **SQL 안에서** 한다. `created_at` 은 `datetime('now')` 가 만든
      // `2026-09-10 00:54:12` 인데 JS 의 `toISOString()` 은 `...T00:44:12.345Z` 라
      // 문자열 비교가 10번째 글자(' ' vs 'T')에서 갈려 쿨다운이 한 번도 안 걸렸다.
      const recent = await db.all(
        sql`SELECT id FROM lot_field_edits
            WHERE ip_hash = ${ipHash}
              AND parking_lot_id = ${data.parkingLotId}
              AND field_group = ${group}
              AND created_at > datetime('now', ${SAME_IP_COOLDOWN_SQL})
            LIMIT 1`,
      )
      if (recent.length > 0) {
        throw new Error('방금 이 항목을 제보했습니다. 10분 뒤에 다시 시도해 주세요.')
      }
    }

    return await insertEdit({
      db,
      lotRow: lotRows[0] as Record<string, unknown>,
      lotId: data.parkingLotId,
      group,
      payload,
      sourceNote: data.sourceNote?.trim() || null,
      userId,
      ipHash,
      retryOnConflict: true,
    })
  })

/** 원본 row 를 `isFieldGroupEmpty` 가 읽는 모양으로 좁힌다 (표시 판정과 같은 규칙을 쓰려고) */
function rowToEmptinessProbe(row: Record<string, unknown>): ParkingLot {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    totalSpaces: num(row.total_spaces),
    pricing: {
      isFree: row.is_free === 1 || row.is_free === true,
      baseTime: num(row.base_time),
      baseFee: num(row.base_fee),
      extraTime: num(row.extra_time),
      extraFee: num(row.extra_fee),
      dailyMax: row.daily_max == null ? undefined : num(row.daily_max),
    },
    operatingHours: {
      weekday: { start: str(row.weekday_start), end: str(row.weekday_end) },
      saturday: { start: str(row.saturday_start), end: str(row.saturday_end) },
      holiday: { start: str(row.holiday_start), end: str(row.holiday_end) },
    },
  } as ParkingLot
}

async function insertEdit({
  db,
  lotRow,
  lotId,
  group,
  payload,
  sourceNote,
  userId,
  ipHash,
  retryOnConflict,
}: {
  db: ReturnType<typeof getDb>
  lotRow: Record<string, unknown>
  lotId: string
  group: FieldGroup
  payload: FieldPayload
  sourceNote: string | null
  userId: string | null
  ipHash: string | null
  retryOnConflict: boolean
}): Promise<SubmitFieldEditResult> {
  const activeRows = (await db.all(
    sql`SELECT id, status FROM lot_field_edits
        WHERE parking_lot_id = ${lotId} AND field_group = ${group}
          AND status IN ('applied', 'verified')
        LIMIT 1`,
  )) as unknown as Array<{ id: number; status: string }>

  const active = activeRows[0] ?? null
  const activeStatus =
    active?.status === 'verified' ? 'verified' : active?.status === 'applied' ? 'applied' : null

  const decision = resolveTransition({
    activeStatus,
    baseIsEmpty: isFieldGroupEmpty(rowToEmptinessProbe(lotRow), group),
  })

  const insert = db.insert(schema.lotFieldEdits).values({
    parkingLotId: lotId,
    fieldGroup: group,
    payload: JSON.stringify(payload),
    status: decision.nextStatus,
    baseHadValue: decision.baseHadValue ? 1 : 0,
    authorUserId: userId,
    ipHash,
    sourceNote,
  })

  try {
    if (decision.supersedeActive && active) {
      // 덮어쓰기와 삽입은 한 배치로 — 따로 돌리면 사이에서 실패했을 때
      // 서 있던 값만 내려가고 새 값이 안 서서 칸이 도로 비어 버린다
      await db.batch([
        db
          .update(schema.lotFieldEdits)
          .set({ status: 'superseded' })
          .where(eq(schema.lotFieldEdits.id, active.id)),
        insert,
      ])
    } else {
      await insert
    }
  } catch (err) {
    // 같은 빈 칸에 두 사람이 동시에 제보하면 부분 유니크 인덱스가 두 번째를 막는다.
    // 한 번만 다시 읽고 시도한다 — 그때는 앞사람 값이 applied 로 서 있으니 덮어쓰기가 된다
    if (retryOnConflict && String(err).includes('UNIQUE')) {
      return await insertEdit({
        db,
        lotRow,
        lotId,
        group,
        payload,
        sourceNote,
        userId,
        ipHash,
        retryOnConflict: false,
      })
    }
    throw err
  }

  return { status: decision.nextStatus }
}
