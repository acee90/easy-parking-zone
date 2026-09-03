import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EvaluationSection, type WebSentiment } from './EvaluationSection'

const sentiment: WebSentiment = {
  average: 4.2,
  count: 12,
  buckets: { good: 8, neutral: 3, bad: 1 },
  tags: [
    { key: 'wide', label: '자리가 넓다', polarity: 'good', count: 5 },
    { key: 'narrow-entry', label: '입구가 좁다', polarity: 'bad', count: 2 },
  ],
}

describe('EvaluationSection', () => {
  it('별점도 후기 분위기도 없으면 아무것도 그리지 않는다', () => {
    const { container } = render(
      <EvaluationSection userScore={null} userCount={0} sentiment={null} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('읽은 글이 0건이면 태그가 있어도 그리지 않는다', () => {
    const { container } = render(
      <EvaluationSection
        userScore={null}
        userCount={0}
        sentiment={{ ...sentiment, count: 0, buckets: { good: 0, neutral: 0, bad: 0 } }}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('웹 후기 분위기는 별 아이콘도 N/5 숫자도 쓰지 않는다', () => {
    const { container } = render(
      <EvaluationSection userScore={null} userCount={0} sentiment={sentiment} />,
    )
    // 별점 칸이 비어 있으므로 노란 별이 하나라도 있으면 분위기 칸이 별을 쓴 것이다
    expect(container.querySelectorAll('.fill-yellow-400')).toHaveLength(0)
    expect(container.textContent).not.toContain('4.2')
    expect(container.textContent).not.toContain('/5')
    expect(screen.getByText('좋다는 평이 많음')).toBeTruthy()
  })

  it('후기가 3건 미만이면 분위기 막대를 그리지 않는다', () => {
    render(
      <EvaluationSection
        userScore={null}
        userCount={0}
        sentiment={{ ...sentiment, count: 2, buckets: { good: 2, neutral: 0, bad: 0 } }}
      />,
    )
    expect(screen.getByText('아직 분위기를 판단하기 어렵습니다')).toBeTruthy()
    expect(screen.queryByText('좋다는 평이 많음')).toBeNull()
    expect(screen.queryByText('좋았다')).toBeNull()
  })

  it('후기가 3건 미만이어도 자주 나온 말은 보여준다', () => {
    render(
      <EvaluationSection
        userScore={null}
        userCount={0}
        sentiment={{ ...sentiment, count: 2, buckets: { good: 2, neutral: 0, bad: 0 } }}
      />,
    )
    expect(screen.getByText('후기에서 자주 나온 말')).toBeTruthy()
    expect(screen.getByText('자리가 넓다')).toBeTruthy()
  })

  it('분위기 막대는 건수 비율만큼 채운다', () => {
    const { container } = render(
      <EvaluationSection
        userScore={null}
        userCount={0}
        sentiment={{ ...sentiment, count: 4, buckets: { good: 2, neutral: 1, bad: 1 } }}
      />,
    )
    const bars = container.querySelectorAll<HTMLElement>('.rounded-full[style]')
    expect(bars[0].style.width).toBe('50%')
    expect(bars[1].style.width).toBe('25%')
    expect(bars[2].style.width).toBe('25%')
  })

  it('이용자 별점은 별과 숫자, 이용자 수를 함께 보여준다', () => {
    render(<EvaluationSection userScore={4.5} userCount={7} sentiment={null} />)
    expect(screen.getByText('4.5')).toBeTruthy()
    expect(screen.getByText(/이용자 7명/)).toBeTruthy()
  })

  it('평가가 없으면 별을 0개로 그리지 않고 안내만 남긴다', () => {
    render(<EvaluationSection userScore={null} userCount={0} sentiment={sentiment} />)
    expect(screen.getByText('아직 남겨진 평가가 없습니다')).toBeTruthy()
  })
})
