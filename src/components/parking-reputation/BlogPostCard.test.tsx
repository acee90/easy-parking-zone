import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BlogPost } from '@/types/parking'
import { BlogPostCard } from './BlogPostCard'

vi.mock('@/components/ReportDialog', () => ({
  ReportButton: () => null,
}))

const basePost: BlogPost = {
  id: 1,
  title: '롯데백화점 미아점 주차 후기',
  snippet: '지하 3층까지 주차장이 있고 주말에는 지상 진입이 혼잡했습니다.',
  sourceUrl: 'https://example.com/post',
  source: 'naver_blog',
  author: '작성자',
}

function renderCard(post: BlogPost) {
  return render(<BlogPostCard post={post} lotId="KA-1" />)
}

describe('BlogPostCard 본문 렌더', () => {
  it('요약이 있으면 요약과 핵심 요약 라벨을 보여준다', () => {
    renderCard({ ...basePost, summary: '기본 30분 무료이고 이후 10분당 1,000원입니다.' })
    expect(screen.getByText('핵심 요약')).toBeTruthy()
    expect(screen.getByText(/기본 30분 무료/)).toBeTruthy()
    expect(screen.queryByText(/지하 3층까지/)).toBeNull()
  })

  it('요약이 없으면 스니펫으로 폴백하고 라벨은 숨긴다', () => {
    renderCard(basePost)
    expect(screen.queryByText('핵심 요약')).toBeNull()
    expect(screen.getByText(/지하 3층까지/)).toBeTruthy()
  })

  // 운영 D1에 ai_summary='' 인 행이 376건 있었고, 그중 373건은 스니펫이 멀쩡한데도
  // `summary ?? snippet`이 ''를 통과시켜 본문이 통째로 가려졌다.
  it('요약이 빈 문자열이어도 스니펫으로 폴백한다', () => {
    renderCard({ ...basePost, summary: '' })
    expect(screen.queryByText('핵심 요약')).toBeNull()
    expect(screen.getByText(/지하 3층까지/)).toBeTruthy()
  })

  it('요약이 공백뿐이어도 스니펫으로 폴백한다', () => {
    renderCard({ ...basePost, summary: '   \n  ' })
    expect(screen.queryByText('핵심 요약')).toBeNull()
    expect(screen.getByText(/지하 3층까지/)).toBeTruthy()
  })

  it('요약과 스니펫이 모두 없으면 본문 영역을 렌더하지 않는다', () => {
    const { container } = renderCard({ ...basePost, snippet: '', summary: '' })
    expect(screen.queryByText('핵심 요약')).toBeNull()
    expect(container.querySelector('p.line-clamp-3')).toBeNull()
  })
})
