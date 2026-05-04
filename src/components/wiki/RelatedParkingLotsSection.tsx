import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { getDifficultyColor, getDifficultyLabel, getDistance } from '@/lib/geo-utils'
import { formatDistanceLabel } from '@/lib/parking-display'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

export function RelatedParkingLotsSection({ lot, lots }: { lot: ParkingLot; lots: ParkingLot[] }) {
  if (lots.length === 0) return null

  return (
    <section className="rounded-xl border bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-bold">주변 주차장</h2>
        <Badge variant="secondary" className="text-xs">
          {lots.length}곳
        </Badge>
      </div>
      <div className="divide-y">
        {lots.map((related) => {
          const distance = getDistance(lot.lat, lot.lng, related.lat, related.lng)
          return (
            <Link
              key={related.id}
              to="/wiki/$slug"
              params={{ slug: makeParkingSlug(related.name, related.id) }}
              className="flex items-center gap-2 py-2.5 text-sm transition-colors hover:text-blue-600"
            >
              <span
                className={`size-2.5 shrink-0 rounded-full ${getDifficultyColor(related.difficulty.score)}`}
                aria-hidden="true"
              />
              <span className="sr-only">{getDifficultyLabel(related.difficulty.score)}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{related.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {formatDistanceLabel(distance)}
                </span>
                {related.totalSpaces > 0 && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                    {related.totalSpaces}면
                  </span>
                )}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          )
        })}
      </div>
    </section>
  )
}
