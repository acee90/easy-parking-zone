import { createServerFn } from '@tanstack/react-start'
import { getDb, schema } from '@/db'
import 'drizzle-orm'

// --- IP hashing (reuse pattern from reviews.ts) ---

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function getClientIP(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

// --- Types ---

export type ReportTargetType = 'web_source' | 'media' | 'review'

const WEB_SOURCE_REASONS = [
  'wrong_link',
  'advertisement',
  'inaccurate',
  'broken_link',
  'duplicate',
  'inappropriate',
  'other',
] as const

const REVIEW_REASONS = ['fake_review', 'abusive', 'spam', 'wrong_parking', 'other'] as const

const MEDIA_REASONS = [
  'wrong_link',
  'advertisement',
  'broken_link',
  'inappropriate',
  'other',
] as const

const VALID_REASONS: Record<ReportTargetType, readonly string[]> = {
  web_source: WEB_SOURCE_REASONS,
  media: MEDIA_REASONS,
  review: REVIEW_REASONS,
}

interface CreateReportInput {
  targetType: ReportTargetType
  targetId: number
  parkingLotId: string
  reason: string
  detail?: string
}

/** 콘텐츠 신고 생성 (비로그인 가능) */
export const createContentReport = createServerFn({ method: 'POST' })
  .inputValidator((input: CreateReportInput): CreateReportInput => {
    const validTypes: ReportTargetType[] = ['web_source', 'media', 'review']
    if (!validTypes.includes(input.targetType)) throw new Error('잘못된 신고 유형')
    if (!input.targetId || !input.parkingLotId) throw new Error('필수 값 누락')

    const allowed = VALID_REASONS[input.targetType]
    if (!allowed.includes(input.reason)) throw new Error('잘못된 신고 사유')

    if (input.reason === 'other' && (!input.detail || input.detail.trim().length < 2)) {
      throw new Error('기타 사유를 입력해주세요')
    }

    return input
  })
  .handler(async ({ data, request }) => {
    if (!request) throw new Error('서버 요청 필요')

    const db = getDb()
    const ipHash = await hashIP(getClientIP(request))

    // UNIQUE(target_type, target_id, ip_hash) 제약으로 중복 방지 (TOCTOU 안전)
    try {
      await db.insert(schema.contentReports).values({
        targetType: data.targetType,
        targetId: data.targetId,
        parkingLotId: data.parkingLotId,
        reason: data.reason,
        detail: data.detail?.trim() || null,
        ipHash,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('UNIQUE constraint failed')) {
        throw Object.assign(new Error('이미 신고한 콘텐츠입니다'), { code: 'DUPLICATE_REPORT' })
      }
      throw e
    }

    return { ok: true }
  })

/** 신고 사유 목록 조회 (클라이언트용) */
export const getReportReasons = createServerFn({ method: 'GET' })
  .inputValidator((input: { targetType: ReportTargetType }) => input)
  .handler(async ({ data }) => {
    const REASON_LABELS: Record<string, string> = {
      // 웹소스/미디어 공통
      wrong_link: '잘못된 주차장에 연결됨',
      advertisement: '광고/홍보글',
      inaccurate: '부정확한 정보',
      broken_link: '링크 깨짐/접근 불가',
      duplicate: '중복 콘텐츠',
      inappropriate: '부적절한 콘텐츠',
      // 리뷰
      fake_review: '허위/조작 리뷰',
      abusive: '욕설/비방',
      spam: '광고/스팸',
      wrong_parking: '잘못된 주차장 리뷰',
      // 공통
      other: '기타',
    }

    const reasons = VALID_REASONS[data.targetType]
    return reasons.map((code) => ({
      code,
      label: REASON_LABELS[code] ?? code,
    }))
  })
