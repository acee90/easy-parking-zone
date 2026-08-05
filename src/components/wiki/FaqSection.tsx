import { generateFaqItems } from '@/lib/faq-generator'
import type { ParkingLot } from '@/types/parking'

interface FaqSectionProps {
  lot: ParkingLot
  relatedLots: ParkingLot[]
}

export function FaqSection({ lot, relatedLots }: FaqSectionProps) {
  const items = generateFaqItems(lot, relatedLots)
  if (items.length < 3) return null

  return (
    // 페이지 최하단 독립 섹션. 상세 시트 안에 있을 때는 구분선만 썼지만
    // 이제 자체 표면을 갖는다.
    <section aria-labelledby="faq-heading" className="rounded-2xl bg-white p-5 md:p-6">
      <h2 id="faq-heading" className="mb-3 text-xl font-bold tracking-tight">
        자주 묻는 질문
      </h2>
      <dl className="divide-y divide-zinc-100">
        {items.map((item) => (
          <div key={item.question} className="py-3.5 first:pt-0 last:pb-0">
            <dt className="text-sm font-semibold text-zinc-900">{item.question}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-zinc-600">{item.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
