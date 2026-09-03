import { ReviewForm } from './ReviewForm'

interface WriteReviewSectionProps {
  lotId: string
  onSubmitted: () => void
  className?: string
}

/** 리뷰 작성 전용 섹션. ReviewSection 아래에 배치하여 "다른 리뷰 → 내 차례" 흐름 유도 */
export function WriteReviewSection({ lotId, onSubmitted, className }: WriteReviewSectionProps) {
  return (
    <section className={className}>
      <h2 className="m-0 mb-[11px] text-[17px] font-extrabold tracking-[-0.015em] text-ink">
        내 평가 남기기
      </h2>
      <ReviewForm parkingLotId={lotId} onSubmitted={onSubmitted} />
    </section>
  )
}
