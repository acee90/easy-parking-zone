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
    <section aria-labelledby="faq-heading" className="border-t pt-8 pb-4">
      <h2 id="faq-heading" className="mb-5 text-xl font-bold">
        자주 묻는 질문
      </h2>
      <dl className="space-y-4">
        {items.map((item) => (
          <div key={item.question} className="rounded-xl border bg-white p-5">
            <dt className="text-sm font-semibold text-zinc-900">{item.question}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-zinc-600">{item.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
