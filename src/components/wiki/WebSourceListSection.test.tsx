import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WebSourceListSection, type WebSourceRef } from './WebSourceListSection'

const sources: WebSourceRef[] = [
  {
    id: 1,
    title: '롯데백화점 미아점 주차 후기',
    sourceUrl: 'https://blog.naver.com/post/1',
    host: 'blog.naver.com',
    publishedAt: '2025-04-12',
    author: '동네탐험가',
  },
  {
    id: 2,
    title: '미아사거리 주차 꿀팁',
    sourceUrl: 'https://cafe.naver.com/post/2',
    host: 'cafe.naver.com',
  },
]

describe('WebSourceListSection', () => {
  it('출처가 없으면 아무것도 그리지 않는다', () => {
    const { container } = render(<WebSourceListSection sources={[]} excludedCount={3} />)
    expect(container.firstChild).toBeNull()
  })

  it('기본은 접힌 상태라 목록이 보이지 않는다', () => {
    render(<WebSourceListSection sources={sources} excludedCount={0} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('펼치면 제목·도메인·날짜·링크만 나오고 원문은 나오지 않는다', () => {
    render(<WebSourceListSection sources={sources} excludedCount={0} />)
    fireEvent.click(screen.getByRole('button'))

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0].getAttribute('href')).toBe('https://blog.naver.com/post/1')
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')

    expect(screen.getByText('blog.naver.com · 2025-04-12 · 동네탐험가')).toBeTruthy()
    // 날짜·작성자가 없으면 빈 칸이나 구분점을 남기지 않는다
    expect(screen.getByText('cafe.naver.com')).toBeTruthy()
  })

  it('제외된 정보 모음 사이트 수가 0이면 안내 문구를 붙이지 않는다', () => {
    const { rerender } = render(<WebSourceListSection sources={sources} excludedCount={0} />)
    expect(screen.queryByText(/정보 모음 사이트/)).toBeNull()

    rerender(<WebSourceListSection sources={sources} excludedCount={4} />)
    expect(screen.getByText(/정보 모음 사이트/)).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
  })
})
