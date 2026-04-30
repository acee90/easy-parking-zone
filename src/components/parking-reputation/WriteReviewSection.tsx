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
      <h3 className="mb-4 text-xl font-bold tracking-normal text-zinc-950">내 평가 남기기</h3>
      <ReviewForm parkingLotId={lotId} onSubmitted={onSubmitted} />
    </section>
  )
}
