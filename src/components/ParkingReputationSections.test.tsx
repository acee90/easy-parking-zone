import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ParkingReputationSections } from './ParkingReputationSections'

vi.mock('@/server/parking', () => ({
  fetchTabCounts: vi.fn(() => Promise.resolve({ reviews: 0, blog: 0, media: 0 })),
}))
vi.mock('./parking-reputation/ReviewSection', () => ({ ReviewSection: () => <div>REVIEWS</div> }))
vi.mock('./parking-reputation/WriteReviewSection', () => ({
  WriteReviewSection: () => <div>WRITE</div>,
}))
vi.mock('./parking-reputation/MediaSection', () => ({ MediaSection: () => <div>MEDIA</div> }))
vi.mock('./parking-reputation/RelatedWebsitesSection', () => ({
  RelatedWebsitesSection: () => <div>BLOG</div>,
}))

const ZERO = { reviews: 0, blog: 0, media: 0 }
const shown = () =>
  ['REVIEWS', 'WRITE', 'MEDIA', 'BLOG'].filter((t) => screen.queryByText(t) !== null)

describe('ParkingReputationSections 빈 섹션 접기 (D-3)', () => {
  it('개수를 받기 전에는 아무것도 그리지 않는다', () => {
    const { container } = render(
      <ParkingReputationSections lotId="a" expanded initialTabCounts={ZERO} countsReady={false} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('리뷰·영상·글이 모두 0이면 한 줄 안내 + 작성 폼만', () => {
    render(<ParkingReputationSections lotId="a" expanded initialTabCounts={ZERO} countsReady />)
    expect(screen.queryByText(/아직 모인 리뷰·영상·블로그 글이 없어요/)).not.toBeNull()
    expect(shown()).toEqual(['WRITE'])
  })

  it('하나라도 있으면 지금 배치 그대로', () => {
    render(
      <ParkingReputationSections
        lotId="a"
        expanded
        initialTabCounts={{ reviews: 0, blog: 3, media: 0 }}
        countsReady
      />,
    )
    expect(shown()).toEqual(['REVIEWS', 'WRITE', 'MEDIA', 'BLOG'])
  })

  it('countsReady 를 안 넘기면 예전처럼 전부 그린다', () => {
    render(<ParkingReputationSections lotId="a" expanded initialTabCounts={ZERO} />)
    expect(shown()).toEqual(['REVIEWS', 'WRITE', 'MEDIA', 'BLOG'])
  })

  it('sections 를 지정한 화면(위키 상세)은 접지 않는다', () => {
    render(
      <ParkingReputationSections
        lotId="a"
        expanded
        initialTabCounts={ZERO}
        countsReady
        sections={['reviews', 'write']}
      />,
    )
    expect(shown()).toEqual(['REVIEWS', 'WRITE'])
  })
})
