import { Badge } from '@/components/ui/badge'
import type { NearbyPlaceInfo } from '@/types/parking'

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  cafe: { icon: '☕', label: '카페' },
  restaurant: { icon: '🍽️', label: '맛집' },
  park: { icon: '🌳', label: '공원' },
  tourist: { icon: '🎫', label: '관광' },
  market: { icon: '🛒', label: '시장' },
  hospital: { icon: '🏥', label: '병원' },
  etc: { icon: '📍', label: '기타' },
}

export function NearbyPlacesSection({ places }: { places: NearbyPlaceInfo[] }) {
  if (places.length === 0) return null

  return (
    <section className="bg-white rounded-xl border p-5 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold">여기 주차하고 가볼 곳</h2>
          <Badge variant="secondary" className="text-xs">
            {places.length}곳
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          자체 주차가 어려워 이 주차장을 이용하면 좋은 주변 장소
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2 gap-3">
        {places.map((place) => {
          const meta = CATEGORY_META[place.category] ?? CATEGORY_META.etc
          return (
            <div
              key={place.id}
              className="flex items-start gap-3 rounded-lg border p-3 hover:bg-gray-50 transition-colors overflow-hidden"
            >
              {place.thumbnailUrl ? (
                <img
                  src={place.thumbnailUrl}
                  alt={place.name}
                  className="size-14 rounded-lg object-cover shrink-0"
                  loading="lazy"
                />
              ) : (
                <span className="size-14 rounded-lg bg-gray-100 flex items-center justify-center text-xl shrink-0">
                  {meta.icon}
                </span>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-base font-semibold">{place.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{meta.label}</span>
                </div>
                {place.tip && (
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground line-clamp-1">
                    {place.tip}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {place.mentionCount}개 블로그에서 언급
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
