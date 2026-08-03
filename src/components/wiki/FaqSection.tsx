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
    <section aria-labelledby="faq-heading" className="mt-6 border-t border-zinc-100 pt-6">
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
