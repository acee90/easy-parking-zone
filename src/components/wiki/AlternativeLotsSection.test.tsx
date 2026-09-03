import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

// 라우터 컨텍스트 없이 렌더하려고 Link만 <a>로 바꿔 끼운다
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string
    params: { slug: string }
    children: ReactNode
    className?: string
  }) => (
    <a href={to.replace('$slug', params.slug)} {...rest}>
      {children}
    </a>
  ),
}))

const { AlternativeLotsSection } = await import('./AlternativeLotsSection')
type AlternativeLot = Parameters<typeof AlternativeLotsSection>[0]['items'][number]

const base: AlternativeLot = {
  name: '미아사거리 공영주차장',
  mentionCount: 4,
  matchedLotId: null,
  matchedLotName: null,
  isFree: null,
  reason: '만차 시 대안으로 자주 언급',
}

describe('AlternativeLotsSection', () => {
  it('항목이 없으면 아무것도 그리지 않는다', () => {
    const { container } = render(<AlternativeLotsSection items={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('언급 0건짜리만 있으면 그리지 않는다', () => {
    const { container } = render(<AlternativeLotsSection items={[{ ...base, mentionCount: 0 }]} />)
    expect(container.firstChild).toBeNull()
  })

  it('매칭되지 않은 이름은 링크로 만들지 않는다', () => {
    render(<AlternativeLotsSection items={[base]} />)
    expect(screen.getByText('미아사거리 공영주차장')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('후기 4건')).toBeTruthy()
  })

  it('매칭된 항목은 상세페이지로 연결하고 무료 표시를 붙인다', () => {
    render(
      <AlternativeLotsSection
        items={[
          {
            ...base,
            matchedLotId: 'KA-1000006682',
            matchedLotName: '미아사거리역 공영주차장',
            isFree: true,
          },
        ]}
      />,
    )
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/wiki/미아사거리역-공영주차장-KA-1000006682')
    expect(screen.getByText('무료')).toBeTruthy()
  })
})
