import { describe, expect, it } from 'vitest'
import { type ReviewRow, rowToReview, validateScore } from './transforms'

// ============================================================
// rowToReview — DB row → UserReview 변환 (Drizzle 전환 후 동일 출력 보장)
// ============================================================

function makeRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 1,
    user_id: null,
    guest_nickname: '테스터',
    entry_score: 3,
    space_score: 4,
    passage_score: 2,
    exit_score: 5,
    overall_score: 3,
    comment: '괜찮은 주차장',
    visited_at: '2025-01-15',
    created_at: '2025-01-20T10:00:00',
    user_name: null,
    user_image: null,
    source_type: null,
    source_url: null,
    ...overrides,
  }
}

describe('rowToReview', () => {
  it('비회원 리뷰를 올바르게 변환', () => {
    const row = makeRow()
    const result = rowToReview(row, null)

    expect(result).toEqual({
      id: 1,
      author: {
        type: 'guest',
        nickname: '테스터',
        profileImage: undefined,
      },
      scores: { entry: 3, space: 4, passage: 2, exit: 5, overall: 3 },
      comment: '괜찮은 주차장',
      visitedAt: '2025-01-15',
      createdAt: '2025-01-20T10:00:00',
      isMine: false,
      sourceType: undefined,
      sourceUrl: undefined,
    })
  })

  it('회원 리뷰를 올바르게 변환', () => {
    const row = makeRow({
      user_id: 'user_123',
      guest_nickname: null,
      user_name: '홍길동',
      user_image: 'https://example.com/photo.jpg',
    })
    const result = rowToReview(row, 'user_123')

    expect(result.author).toEqual({
      type: 'member',
      nickname: '홍길동',
      profileImage: 'https://example.com/photo.jpg',
    })
    expect(result.isMine).toBe(true)
  })

  it('다른 사람의 회원 리뷰는 isMine=false', () => {
    const row = makeRow({ user_id: 'user_123', user_name: '홍길동' })
    const result = rowToReview(row, 'user_456')
    expect(result.isMine).toBe(false)
  })

  it('비로그인 상태에서 회원 리뷰는 isMine=false', () => {
    const row = makeRow({ user_id: 'user_123', user_name: '홍길동' })
    const result = rowToReview(row, null)
    expect(result.isMine).toBe(false)
  })

  it("user_name이 null이면 '사용자' 기본값", () => {
    const row = makeRow({ user_id: 'user_123', user_name: null })
    const result = rowToReview(row, null)
    expect(result.author.nickname).toBe('사용자')
  })

  it("guest_nickname이 null이면 '익명' 기본값", () => {
    const row = makeRow({ guest_nickname: null })
    const result = rowToReview(row, null)
    expect(result.author.nickname).toBe('익명')
  })

  it('comment/visitedAt null이면 undefined', () => {
    const row = makeRow({ comment: null, visited_at: null })
    const result = rowToReview(row, null)
    expect(result.comment).toBeUndefined()
    expect(result.visitedAt).toBeUndefined()
  })

  it('source_type/source_url 설정', () => {
    const row = makeRow({
      source_type: 'clien',
      source_url: 'https://clien.net/review/123',
    })
    const result = rowToReview(row, null)
    expect(result.sourceType).toBe('clien')
    expect(result.sourceUrl).toBe('https://clien.net/review/123')
  })

  it('user_image가 null이면 profileImage undefined', () => {
    const row = makeRow({ user_id: 'user_123', user_image: null })
    const result = rowToReview(row, null)
    expect(result.author.profileImage).toBeUndefined()
  })
})

// ============================================================
// validateScore
// ============================================================

describe('validateScore', () => {
  it('0.5 ~ 5.0 0.5 단위 정상값을 허용', () => {
    expect(validateScore(0.5)).toBe(true)
    expect(validateScore(1)).toBe(true)
    expect(validateScore(1.5)).toBe(true)
    expect(validateScore(2.5)).toBe(true)
    expect(validateScore(3.5)).toBe(true)
    expect(validateScore(4.5)).toBe(true)
    expect(validateScore(5)).toBe(true)
  })

  it('범위 밖 값을 거부', () => {
    expect(validateScore(0)).toBe(false)
    expect(validateScore(0.4)).toBe(false)
    expect(validateScore(5.5)).toBe(false)
    expect(validateScore(6)).toBe(false)
    expect(validateScore(-1)).toBe(false)
  })

  it('0.5 단위가 아닌 소수를 거부', () => {
    expect(validateScore(1.1)).toBe(false)
    expect(validateScore(2.3)).toBe(false)
    expect(validateScore(3.7)).toBe(false)
  })

  it('문자열/null/undefined/NaN을 거부', () => {
    expect(validateScore('3')).toBe(false)
    expect(validateScore(null)).toBe(false)
    expect(validateScore(undefined)).toBe(false)
    expect(validateScore(Number.NaN)).toBe(false)
    expect(validateScore(Number.POSITIVE_INFINITY)).toBe(false)
  })
})
