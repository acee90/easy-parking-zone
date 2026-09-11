import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createReview = vi.fn()
const track = vi.fn()
vi.mock('@/server/reviews', () => ({ createReview: (...a: unknown[]) => createReview(...a) }))
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }))

import { QuickRating } from './QuickRating'

describe('QuickRating', () => {
  beforeEach(() => {
    createReview.mockReset()
    track.mockReset()
  })

  it('별만 골라서는 등록되지 않는다 — 확인 버튼을 한 번 더 눌러야 한다', () => {
    render(<QuickRating parkingLotId="KA-1" event="inline_rating_submitted" />)
    expect(screen.queryByRole('button', { name: /점 등록$/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '3.5점' }))

    expect(screen.getByRole('button', { name: '3.5점 등록' })).toBeTruthy()
    expect(createReview).not.toHaveBeenCalled()
  })

  it('등록하면 총점 하나를 다섯 항목에 넣어 보내고 이벤트를 남긴다', async () => {
    createReview.mockResolvedValue({ ok: true })
    const onDone = vi.fn()
    render(<QuickRating parkingLotId="KA-1" event="review_prompt_rated" onDone={onDone} />)

    fireEvent.click(screen.getByRole('button', { name: '4점' }))
    fireEvent.click(screen.getByRole('button', { name: '4점 등록' }))

    await waitFor(() => expect(screen.getByText(/고맙습니다/)).toBeTruthy())
    expect(createReview).toHaveBeenCalledWith({
      data: {
        parkingLotId: 'KA-1',
        entryScore: 4,
        spaceScore: 4,
        passageScore: 4,
        exitScore: 4,
        overallScore: 4,
      },
    })
    expect(track).toHaveBeenCalledWith('review_prompt_rated', { parking_lot_id: 'KA-1', score: 4 })
    expect(onDone).toHaveBeenCalled()
  })

  it('서버가 거절하면(24시간 제한 등) 입력 상태로 돌아가고 이벤트는 남기지 않는다', async () => {
    createReview.mockRejectedValue(new Error('24시간 내에 같은 주차장에 이미 리뷰를 남겼습니다'))
    render(<QuickRating parkingLotId="KA-1" event="inline_rating_submitted" />)

    fireEvent.click(screen.getByRole('button', { name: '2점' }))
    fireEvent.click(screen.getByRole('button', { name: '2점 등록' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '2점 등록' })).toBeTruthy())
    expect(screen.queryByText(/고맙습니다/)).toBeNull()
    expect(track).not.toHaveBeenCalled()
  })
})
